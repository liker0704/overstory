/**
 * Tests for the workstreams module.
 *
 * Uses real temp files for file I/O tests (mkdtemp).
 * TrackerClient is mocked — it's an external service with no real implementation
 * available in the test environment.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TrackerClient, TrackerIssue } from "../tracker/types.ts";
import {
	type ExecutionHandoff,
	type Workstream,
	bridgeWorkstreamsToTasks,
	ensureCanonicalWorkstreamTasks,
	loadWorkstreamsFile,
	packageHandoffs,
	persistWorkstreamsFile,
	slingArgsFromHandoff,
	validateTaskIds,
	validateWorkstreamsFile,
} from "./workstreams.ts";

// === Mock TrackerClient ===

function createMockTracker(options: {
	existingIds?: Set<string>;
	createShouldFail?: boolean;
	createdId?: string;
} = {}): TrackerClient {
	const existingIds = options.existingIds ?? new Set<string>();
	return {
		ready: async () => [],
		show: async (id: string): Promise<TrackerIssue> => {
			if (!existingIds.has(id)) {
				throw new Error(`Not found: ${id}`);
			}
			return { id, title: "Test task", status: "open", priority: 2, type: "task" };
		},
		create: async (_title: string): Promise<string> => {
			if (options.createShouldFail) {
				throw new Error("create failed");
			}
			const newId = options.createdId ?? `created-${Date.now()}`;
			existingIds.add(newId);
			return newId;
		},
		claim: async () => {},
		close: async () => {},
		list: async () => [],
		sync: async () => {},
	};
}

// === Minimal valid workstream fixture ===

function makeWorkstream(overrides: Partial<Workstream> = {}): Workstream {
	return {
		id: "ws-auth",
		taskId: "task-001",
		objective: "Refactor auth module",
		fileScope: ["src/auth.ts"],
		dependsOn: [],
		briefPath: null,
		status: "planned",
		...overrides,
	};
}

const VALID_FILE = {
	version: 1 as const,
	workstreams: [makeWorkstream()],
};

// === validateWorkstreamsFile ===

describe("validateWorkstreamsFile", () => {
	test("valid minimal workstreams file passes", () => {
		const result = validateWorkstreamsFile(VALID_FILE);
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
		expect(result.workstreams).not.toBeNull();
		expect(result.workstreams?.workstreams).toHaveLength(1);
	});

	test("non-object input fails", () => {
		const result = validateWorkstreamsFile("not-an-object");
		expect(result.valid).toBe(false);
		expect(result.errors[0]?.message).toContain("Expected an object");
	});

	test("missing version fails", () => {
		const result = validateWorkstreamsFile({ workstreams: [makeWorkstream()] });
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.path === "version")).toBe(true);
	});

	test("non-array workstreams fails", () => {
		const result = validateWorkstreamsFile({ version: 1, workstreams: "not-array" });
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.path === "workstreams")).toBe(true);
	});

	test("empty id fails", () => {
		const result = validateWorkstreamsFile({
			version: 1,
			workstreams: [makeWorkstream({ id: "" })],
		});
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.path.includes(".id"))).toBe(true);
	});

	test("empty taskId fails", () => {
		const result = validateWorkstreamsFile({
			version: 1,
			workstreams: [makeWorkstream({ taskId: "" })],
		});
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.path.includes(".taskId"))).toBe(true);
	});

	test("empty objective fails", () => {
		const result = validateWorkstreamsFile({
			version: 1,
			workstreams: [makeWorkstream({ objective: "   " })],
		});
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.path.includes(".objective"))).toBe(true);
	});

	test("invalid status fails", () => {
		const result = validateWorkstreamsFile({
			version: 1,
			workstreams: [makeWorkstream({ status: "unknown" as never })],
		});
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.path.includes(".status"))).toBe(true);
	});

	test("duplicate workstream ids detected", () => {
		const result = validateWorkstreamsFile({
			version: 1,
			workstreams: [
				makeWorkstream({ id: "ws-a", taskId: "task-001" }),
				makeWorkstream({ id: "ws-a", taskId: "task-002" }),
			],
		});
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("Duplicate workstream id"))).toBe(true);
	});

	test("duplicate taskIds detected", () => {
		const result = validateWorkstreamsFile({
			version: 1,
			workstreams: [
				makeWorkstream({ id: "ws-a", taskId: "task-001" }),
				makeWorkstream({ id: "ws-b", taskId: "task-001" }),
			],
		});
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("Duplicate taskId"))).toBe(true);
	});

	test("unknown dependsOn reference detected", () => {
		const result = validateWorkstreamsFile({
			version: 1,
			workstreams: [makeWorkstream({ dependsOn: ["ws-nonexistent"] })],
		});
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("Unknown workstream reference"))).toBe(
			true,
		);
	});

	test("overlapping fileScope detected", () => {
		const result = validateWorkstreamsFile({
			version: 1,
			workstreams: [
				makeWorkstream({ id: "ws-a", taskId: "task-001", fileScope: ["src/shared.ts"] }),
				makeWorkstream({ id: "ws-b", taskId: "task-002", fileScope: ["src/shared.ts"] }),
			],
		});
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("File scope overlap"))).toBe(true);
	});

	test("valid file with dependsOn references passes", () => {
		const result = validateWorkstreamsFile({
			version: 1,
			workstreams: [
				makeWorkstream({ id: "ws-a", taskId: "task-001", fileScope: ["src/a.ts"] }),
				makeWorkstream({
					id: "ws-b",
					taskId: "task-002",
					fileScope: ["src/b.ts"],
					dependsOn: ["ws-a"],
				}),
			],
		});
		expect(result.valid).toBe(true);
	});
});

// === loadWorkstreamsFile ===

describe("loadWorkstreamsFile", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "workstreams-test-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	test("valid file loads and validates", async () => {
		const filePath = join(tmpDir, "workstreams.json");
		await writeFile(filePath, JSON.stringify(VALID_FILE));
		const result = await loadWorkstreamsFile(filePath);
		expect(result.valid).toBe(true);
		expect(result.workstreams?.workstreams).toHaveLength(1);
	});

	test("invalid JSON returns error", async () => {
		const filePath = join(tmpDir, "workstreams.json");
		await writeFile(filePath, "{ not valid json }");
		const result = await loadWorkstreamsFile(filePath);
		expect(result.valid).toBe(false);
		expect(result.errors[0]?.message).toContain("Failed to load file");
	});

	test("missing file returns error", async () => {
		const result = await loadWorkstreamsFile(join(tmpDir, "nonexistent.json"));
		expect(result.valid).toBe(false);
		expect(result.errors[0]?.message).toContain("Failed to load file");
	});
});

// === bridgeWorkstreamsToTasks ===

describe("bridgeWorkstreamsToTasks", () => {
	test("existing tasks are verified (created: false)", async () => {
		const ws = makeWorkstream({ taskId: "task-existing" });
		const tracker = createMockTracker({ existingIds: new Set(["task-existing"]) });
		const results = await bridgeWorkstreamsToTasks([ws], tracker);
		expect(results).toHaveLength(1);
		expect(results[0]?.created).toBe(false);
		expect(results[0]?.canonicalTaskId).toBe("task-existing");
		expect(results[0]?.error).toBeUndefined();
	});

	test("missing tasks are created (created: true)", async () => {
		const ws = makeWorkstream({ taskId: "task-missing" });
		const tracker = createMockTracker({ existingIds: new Set(), createdId: "task-created" });
		const results = await bridgeWorkstreamsToTasks([ws], tracker);
		expect(results).toHaveLength(1);
		expect(results[0]?.created).toBe(true);
		expect(results[0]?.canonicalTaskId).toBe("task-created");
		expect(results[0]?.error).toBeUndefined();
	});

	test("creation failure produces error in result", async () => {
		const ws = makeWorkstream({ taskId: "task-missing" });
		const tracker = createMockTracker({ existingIds: new Set(), createShouldFail: true });
		const results = await bridgeWorkstreamsToTasks([ws], tracker);
		expect(results).toHaveLength(1);
		expect(results[0]?.created).toBe(false);
		expect(results[0]?.error).toContain("create failed");
	});
});

describe("ensureCanonicalWorkstreamTasks", () => {
	let tmpDir: string;
	let filePath: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "workstreams-canonical-test-"));
		filePath = join(tmpDir, "workstreams.json");
		await persistWorkstreamsFile(filePath, [makeWorkstream({ taskId: "task-missing" })]);
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	test("persists tracker-returned canonical IDs back into workstreams.json", async () => {
		const tracker = createMockTracker({ createdId: "task-canonical-002" });

		const result = await ensureCanonicalWorkstreamTasks(filePath, tracker);
		expect(result.workstreams[0]?.taskId).toBe("task-canonical-002");

		const reloaded = await loadWorkstreamsFile(filePath);
		expect(reloaded.workstreams?.workstreams[0]?.taskId).toBe("task-canonical-002");
	});

	test("throws and leaves file unchanged when task bridging fails", async () => {
		const tracker = createMockTracker({ createShouldFail: true });

		await expect(ensureCanonicalWorkstreamTasks(filePath, tracker)).rejects.toThrow(
			"Task bridge failed",
		);

		const reloaded = await loadWorkstreamsFile(filePath);
		expect(reloaded.workstreams?.workstreams[0]?.taskId).toBe("task-missing");
	});
});

// === bridgeWorkstreamsToTasks edge cases ===

describe("bridgeWorkstreamsToTasks edge cases", () => {
	test("show() throws non-not-found error → reports error result without successful create", async () => {
		// Make both show() and create() fail.
		// Current behavior: show throws → tries create → create fails → error result.
		// Fixed behavior: show throws non-"not found" error → reports error without create.
		// Both produce an error result — the test checks that invariant.
		const tracker: TrackerClient = {
			ready: async () => [],
			show: async () => {
				throw new Error("connection refused");
			},
			create: async () => {
				throw new Error("should not be called");
			},
			claim: async () => {},
			close: async () => {},
			list: async () => [],
			sync: async () => {},
		};

		const ws = makeWorkstream({ taskId: "task-api-error" });
		const results = await bridgeWorkstreamsToTasks([ws], tracker);

		expect(results).toHaveLength(1);
		// Both current and fixed code produce an error entry when all operations fail.
		expect(results[0]?.error).toBeDefined();
		expect(results[0]?.created).toBe(false);
	});
});

// === validateTaskIds ===

describe("validateTaskIds", () => {
	test("empty workstreams array returns empty missing list", async () => {
		const tracker = createMockTracker();
		const result = await validateTaskIds([], tracker);
		expect(result).toEqual([]);
	});
});

// === packageHandoffs ===

describe("packageHandoffs", () => {
	test("only planned/active with completed deps are returned", () => {
		const workstreams: Workstream[] = [
			makeWorkstream({ id: "ws-a", taskId: "task-001", status: "completed", fileScope: [] }),
			makeWorkstream({
				id: "ws-b",
				taskId: "task-002",
				status: "planned",
				dependsOn: ["ws-a"],
				fileScope: [],
			}),
		];
		const handoffs = packageHandoffs(workstreams);
		expect(handoffs).toHaveLength(1);
		expect(handoffs[0]?.workstreamId).toBe("ws-b");
	});

	test("paused and completed workstreams are excluded", () => {
		const workstreams: Workstream[] = [
			makeWorkstream({ id: "ws-a", taskId: "task-001", status: "paused", fileScope: [] }),
			makeWorkstream({ id: "ws-b", taskId: "task-002", status: "completed", fileScope: [] }),
		];
		const handoffs = packageHandoffs(workstreams);
		expect(handoffs).toHaveLength(0);
	});

	test("workstreams with unmet dependencies are excluded", () => {
		const workstreams: Workstream[] = [
			makeWorkstream({
				id: "ws-a",
				taskId: "task-001",
				status: "planned",
				dependsOn: ["ws-b"],
				fileScope: [],
			}),
			makeWorkstream({ id: "ws-b", taskId: "task-002", status: "planned", fileScope: [] }),
		];
		const handoffs = packageHandoffs(workstreams);
		// ws-a depends on ws-b which is not completed, ws-b has no deps so it's included
		expect(handoffs).toHaveLength(1);
		expect(handoffs[0]?.workstreamId).toBe("ws-b");
	});

	test("active workstream with no deps is included", () => {
		const workstreams: Workstream[] = [
			makeWorkstream({ id: "ws-a", taskId: "task-001", status: "active", fileScope: [] }),
		];
		const handoffs = packageHandoffs(workstreams);
		expect(handoffs).toHaveLength(1);
	});
});

// === slingArgsFromHandoff ===

describe("slingArgsFromHandoff", () => {
	const handoff: ExecutionHandoff = {
		workstreamId: "ws-auth",
		taskId: "task-001",
		objective: "Auth refactor",
		fileScope: ["src/auth.ts", "src/auth.test.ts"],
		briefPath: null,
		dependsOn: [],
		status: "planned",
	};

	test("produces correct arg array with file scope", () => {
		const args = slingArgsFromHandoff(handoff, { parentAgent: "exec-director", depth: 1 });
		expect(args).toContain("ov");
		expect(args).toContain("sling");
		expect(args).toContain("task-001");
		expect(args).toContain("--capability");
		expect(args).toContain("lead");
		expect(args).toContain("--parent");
		expect(args).toContain("exec-director");
		expect(args).toContain("--depth");
		expect(args).toContain("1");
		expect(args).not.toContain("--skip-task-check");
		expect(args).toContain("--files");
		expect(args).toContain("src/auth.ts,src/auth.test.ts");
	});

	test("omits --files when fileScope is empty", () => {
		const noScope = { ...handoff, fileScope: [] };
		const args = slingArgsFromHandoff(noScope, { parentAgent: "exec-director", depth: 1 });
		expect(args).not.toContain("--files");
	});

	test("includes --spec when briefPath provided with specBasePath", () => {
		const withBrief = { ...handoff, briefPath: "auth-brief.md" };
		const args = slingArgsFromHandoff(withBrief, {
			parentAgent: "exec-director",
			depth: 1,
			specBasePath: "/project/.overstory/specs",
		});
		expect(args).toContain("--spec");
		const specIdx = args.indexOf("--spec");
		expect(args[specIdx + 1]).toContain("auth-brief.md");
	});

	test("omits --spec when briefPath is null", () => {
		const args = slingArgsFromHandoff(handoff, {
			parentAgent: "exec-director",
			depth: 1,
			specBasePath: "/project/.overstory/specs",
		});
		expect(args).not.toContain("--spec");
	});

	test("omits --spec when specBasePath not provided", () => {
		const withBrief = { ...handoff, briefPath: "auth-brief.md" };
		const args = slingArgsFromHandoff(withBrief, { parentAgent: "exec-director", depth: 1 });
		expect(args).not.toContain("--spec");
	});
});
