/**
 * Tests for the GitHub auto-pull poller.
 *
 * Uses real SQLite mail.db in temp directories.
 * GitHub API calls (gh CLI) are injected via the GhRunner interface.
 */

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createMailStore } from "../mail/store.ts";
import {
	type GhRawIssue,
	type GhRunner,
	type PollerTickResult,
	runPollerTick,
} from "./github-poller.ts";
import type { GitHubPollerConfig } from "../types.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "autopull-test-"));
	await mkdir(join(tmpDir, ".overstory"), { recursive: true });
	// Initialise an empty mail.db so the poller can write to it
	const mailStore = createMailStore(join(tmpDir, ".overstory", "mail.db"));
	mailStore.close();
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<GitHubPollerConfig> = {}): GitHubPollerConfig {
	return {
		pollIntervalMs: 30_000,
		readyLabel: "ov-ready",
		activeLabel: "ov-active",
		maxConcurrent: 5,
		...overrides,
	};
}

function makeIssue(number: number, title = `Issue ${number}`): GhRawIssue {
	return {
		number,
		title,
		state: "OPEN",
		labels: [{ name: "ov-ready" }],
		assignees: [],
		body: "",
	};
}

/**
 * Build a GhRunner mock from a handler map.
 * Keys match the first argument after "issue" (e.g., "list", "edit").
 */
function buildGhRunner(handlers: Record<string, (args: string[]) => { stdout: string; exitCode: number }>): GhRunner {
	return async (args) => {
		// args[0] = "issue", args[1] = subcommand
		const sub = args[1] ?? "";
		const handler = handlers[sub];
		if (!handler) return { stdout: "", exitCode: 0 };
		return handler(args);
	};
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("runPollerTick", () => {
	test("dispatches a new ready issue", async () => {
		const issue = makeIssue(42, "Add feature X");
		const gh = buildGhRunner({
			list: (args) => {
				// Return ready issues when queried with readyLabel; empty for activeLabel pruning
				if (args.includes("ov-ready")) {
					return { stdout: JSON.stringify([issue]), exitCode: 0 };
				}
				return { stdout: "[]", exitCode: 0 };
			},
			edit: () => ({ stdout: "", exitCode: 0 }),
		});

		const result = await runPollerTick(makeConfig(), tmpDir, tmpDir, gh);

		expect(result.dispatched).toBe(1);
		expect(result.skipped).toBe(0);
		expect(result.errors).toHaveLength(0);

		// State file should record the dispatched issue
		const stateFile = Bun.file(join(tmpDir, ".overstory", "autopull-state.json"));
		expect(await stateFile.exists()).toBe(true);
		const state = JSON.parse(await stateFile.text()) as { dispatched: Record<string, unknown> };
		expect(state.dispatched["42"]).toBeDefined();

		// Mail should be in the inbox
		const mailStore = createMailStore(join(tmpDir, ".overstory", "mail.db"));
		try {
			const msgs = mailStore.getUnread("coordinator");
			expect(msgs).toHaveLength(1);
			expect(msgs[0]?.subject).toContain("Add feature X");
			expect(msgs[0]?.from).toBe("github-autopull");
		} finally {
			mailStore.close();
		}
	});

	test("skips already-dispatched issues", async () => {
		// Pre-populate state with issue 42 as already dispatched
		const existingState = {
			dispatched: {
				"42": { taskId: "gh-42", dispatchedAt: new Date().toISOString() },
			},
		};
		await Bun.write(
			join(tmpDir, ".overstory", "autopull-state.json"),
			JSON.stringify(existingState),
		);

		const issue = makeIssue(42);
		const gh = buildGhRunner({
			list: (args) => {
				if (args.includes("ov-active")) {
					// Pruning check: issue 42 is still active
					return { stdout: JSON.stringify([{ number: 42 }]), exitCode: 0 };
				}
				return { stdout: JSON.stringify([issue]), exitCode: 0 };
			},
			edit: () => ({ stdout: "", exitCode: 0 }),
		});

		const result = await runPollerTick(makeConfig(), tmpDir, tmpDir, gh);

		expect(result.dispatched).toBe(0);
		expect(result.skipped).toBe(0); // filtered before capacity check
	});

	test("respects maxConcurrent limit", async () => {
		// Already at capacity: 2 active issues, maxConcurrent=2
		const existingState = {
			dispatched: {
				"10": { taskId: "gh-10", dispatchedAt: new Date().toISOString() },
				"11": { taskId: "gh-11", dispatchedAt: new Date().toISOString() },
			},
		};
		await Bun.write(
			join(tmpDir, ".overstory", "autopull-state.json"),
			JSON.stringify(existingState),
		);

		const gh = buildGhRunner({
			list: (args) => {
				if (args.includes("ov-active")) {
					// Both dispatched issues are still active
					return {
						stdout: JSON.stringify([{ number: 10 }, { number: 11 }]),
						exitCode: 0,
					};
				}
				// 3 new ready issues
				return {
					stdout: JSON.stringify([makeIssue(20), makeIssue(21), makeIssue(22)]),
					exitCode: 0,
				};
			},
		});

		const config = makeConfig({ maxConcurrent: 2 });
		const result = await runPollerTick(config, tmpDir, tmpDir, gh);

		expect(result.dispatched).toBe(0);
		expect(result.errors).toHaveLength(0);
	});

	test("dispatches up to remaining capacity", async () => {
		// 1 active, maxConcurrent=3 → room for 2 more
		const existingState = {
			dispatched: {
				"10": { taskId: "gh-10", dispatchedAt: new Date().toISOString() },
			},
		};
		await Bun.write(
			join(tmpDir, ".overstory", "autopull-state.json"),
			JSON.stringify(existingState),
		);

		const gh = buildGhRunner({
			list: (args) => {
				if (args.includes("ov-active")) {
					return { stdout: JSON.stringify([{ number: 10 }]), exitCode: 0 };
				}
				return {
					stdout: JSON.stringify([makeIssue(20), makeIssue(21), makeIssue(22)]),
					exitCode: 0,
				};
			},
			edit: () => ({ stdout: "", exitCode: 0 }),
		});

		const config = makeConfig({ maxConcurrent: 3 });
		const result = await runPollerTick(config, tmpDir, tmpDir, gh);

		expect(result.dispatched).toBe(2);
		expect(result.skipped).toBe(1); // 1 beyond capacity
	});

	test("prunes completed issues from dispatched state", async () => {
		// Issue 42 was dispatched but is no longer active on GitHub
		const existingState = {
			dispatched: {
				"42": { taskId: "gh-42", dispatchedAt: new Date().toISOString() },
			},
		};
		await Bun.write(
			join(tmpDir, ".overstory", "autopull-state.json"),
			JSON.stringify(existingState),
		);

		let editCalled = false;
		const gh = buildGhRunner({
			list: (args) => {
				if (args.includes("ov-active")) {
					// Issue 42 is no longer active → prune it
					return { stdout: "[]", exitCode: 0 };
				}
				// New ready issue 99
				return { stdout: JSON.stringify([makeIssue(99)]), exitCode: 0 };
			},
			edit: () => {
				editCalled = true;
				return { stdout: "", exitCode: 0 };
			},
		});

		const config = makeConfig({ maxConcurrent: 1 });
		const result = await runPollerTick(config, tmpDir, tmpDir, gh);

		// After pruning, capacity opens up for issue 99
		expect(result.dispatched).toBe(1);
		expect(editCalled).toBe(true);
	});

	test("records error when claim fails", async () => {
		const issue = makeIssue(42);
		const gh = buildGhRunner({
			list: (args) => {
				if (args.includes("ov-ready")) {
					return { stdout: JSON.stringify([issue]), exitCode: 0 };
				}
				return { stdout: "[]", exitCode: 0 };
			},
			edit: () => ({ stdout: "", exitCode: 1 }), // claim fails
		});

		const result = await runPollerTick(makeConfig(), tmpDir, tmpDir, gh);

		expect(result.dispatched).toBe(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("#42");
	});

	test("handles gh list failure gracefully", async () => {
		const gh = buildGhRunner({
			list: (args) => {
				if (args.includes("ov-active")) return { stdout: "[]", exitCode: 0 };
				return { stdout: "", exitCode: 1 }; // ready list fails
			},
		});

		const result = await runPollerTick(makeConfig(), tmpDir, tmpDir, gh);

		expect(result.dispatched).toBe(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("Failed to fetch issues");
	});

	test("passes --repo flag when owner and repo are configured", async () => {
		const capturedArgs: string[][] = [];
		const gh: GhRunner = async (args) => {
			capturedArgs.push(args);
			return { stdout: "[]", exitCode: 0 };
		};

		const config = makeConfig({ owner: "myorg", repo: "myrepo" });
		await runPollerTick(config, tmpDir, tmpDir, gh);

		const repoArgs = capturedArgs.flat();
		expect(repoArgs).toContain("--repo");
		expect(repoArgs).toContain("myorg/myrepo");
	});

	test("dispatches issue with body content", async () => {
		const issue: GhRawIssue = {
			number: 7,
			title: "Fix bug",
			state: "OPEN",
			labels: [{ name: "ov-ready" }],
			assignees: [],
			body: "Detailed description here",
		};

		const gh = buildGhRunner({
			list: (args) => {
				if (args.includes("ov-ready")) return { stdout: JSON.stringify([issue]), exitCode: 0 };
				return { stdout: "[]", exitCode: 0 };
			},
			edit: () => ({ stdout: "", exitCode: 0 }),
		});

		await runPollerTick(makeConfig(), tmpDir, tmpDir, gh);

		const mailStore = createMailStore(join(tmpDir, ".overstory", "mail.db"));
		try {
			const msgs = mailStore.getUnread("coordinator");
			expect(msgs[0]?.body).toContain("Detailed description here");
		} finally {
			mailStore.close();
		}
	});

	test("payload contains taskId and githubIssueId", async () => {
		const issue = makeIssue(55, "My task");
		const gh = buildGhRunner({
			list: (args) => {
				if (args.includes("ov-ready")) return { stdout: JSON.stringify([issue]), exitCode: 0 };
				return { stdout: "[]", exitCode: 0 };
			},
			edit: () => ({ stdout: "", exitCode: 0 }),
		});

		await runPollerTick(makeConfig(), tmpDir, tmpDir, gh);

		const mailStore = createMailStore(join(tmpDir, ".overstory", "mail.db"));
		try {
			const msgs = mailStore.getUnread("coordinator");
			const payload = JSON.parse(msgs[0]?.payload ?? "{}") as {
				taskId: string;
				githubIssueId: number;
			};
			expect(payload.taskId).toBe("gh-55");
			expect(payload.githubIssueId).toBe(55);
		} finally {
			mailStore.close();
		}
	});

	test("no-op when there are no ready issues", async () => {
		const gh = buildGhRunner({
			list: () => ({ stdout: "[]", exitCode: 0 }),
		});

		const result = await runPollerTick(makeConfig(), tmpDir, tmpDir, gh);

		expect(result.dispatched).toBe(0);
		expect(result.skipped).toBe(0);
		expect(result.errors).toHaveLength(0);
	});
});
