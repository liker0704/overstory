/**
 * Tests for src/commands/review.ts
 *
 * Includes both command registration checks and functional CLI execution
 * against temp on-disk stores.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ensureMissionArtifacts } from "../missions/context.ts";
import { createMissionStore } from "../missions/store.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import { createReviewCommand } from "./review.ts";

describe("createReviewCommand", () => {
	test("returns a command named 'review'", () => {
		const cmd = createReviewCommand();
		expect(cmd.name()).toBe("review");
	});

	test("has description", () => {
		const cmd = createReviewCommand();
		expect(cmd.description()).toBeTruthy();
	});

	test("has 'sessions' subcommand", () => {
		const cmd = createReviewCommand();
		const sub = cmd.commands.find((c) => c.name() === "sessions");
		expect(sub).toBeDefined();
	});

	test("has 'session' subcommand with argument", () => {
		const cmd = createReviewCommand();
		const sub = cmd.commands.find((c) => c.name() === "session");
		expect(sub).toBeDefined();
	});

	test("has 'handoffs' subcommand", () => {
		const cmd = createReviewCommand();
		const sub = cmd.commands.find((c) => c.name() === "handoffs");
		expect(sub).toBeDefined();
	});

	test("has 'specs' subcommand", () => {
		const cmd = createReviewCommand();
		const sub = cmd.commands.find((c) => c.name() === "specs");
		expect(sub).toBeDefined();
	});

	test("has 'missions' subcommand", () => {
		const cmd = createReviewCommand();
		const sub = cmd.commands.find((c) => c.name() === "missions");
		expect(sub).toBeDefined();
	});

	test("has 'mission' subcommand with argument", () => {
		const cmd = createReviewCommand();
		const sub = cmd.commands.find((c) => c.name() === "mission");
		expect(sub).toBeDefined();
	});

	test("has 'stale' subcommand", () => {
		const cmd = createReviewCommand();
		const sub = cmd.commands.find((c) => c.name() === "stale");
		expect(sub).toBeDefined();
	});

	test("sessions subcommand has --recent option", () => {
		const cmd = createReviewCommand();
		const sub = cmd.commands.find((c) => c.name() === "sessions");
		const opts = sub?.options ?? [];
		const recentOpt = opts.find((o) => o.long === "--recent");
		expect(recentOpt).toBeDefined();
	});

	test("sessions subcommand has --json option", () => {
		const cmd = createReviewCommand();
		const sub = cmd.commands.find((c) => c.name() === "sessions");
		const opts = sub?.options ?? [];
		const jsonOpt = opts.find((o) => o.long === "--json");
		expect(jsonOpt).toBeDefined();
	});

	test("specs subcommand has --json option", () => {
		const cmd = createReviewCommand();
		const sub = cmd.commands.find((c) => c.name() === "specs");
		const opts = sub?.options ?? [];
		const jsonOpt = opts.find((o) => o.long === "--json");
		expect(jsonOpt).toBeDefined();
	});

	test("stale subcommand has --json option", () => {
		const cmd = createReviewCommand();
		const sub = cmd.commands.find((c) => c.name() === "stale");
		const opts = sub?.options ?? [];
		const jsonOpt = opts.find((o) => o.long === "--json");
		expect(jsonOpt).toBeDefined();
	});

	test("missions subcommand has --recent option", () => {
		const cmd = createReviewCommand();
		const sub = cmd.commands.find((c) => c.name() === "missions");
		const opts = sub?.options ?? [];
		const recentOpt = opts.find((o) => o.long === "--recent");
		expect(recentOpt).toBeDefined();
	});

	test("mission subcommand has --json option", () => {
		const cmd = createReviewCommand();
		const sub = cmd.commands.find((c) => c.name() === "mission");
		const opts = sub?.options ?? [];
		const jsonOpt = opts.find((o) => o.long === "--json");
		expect(jsonOpt).toBeDefined();
	});

	test("has exactly 7 subcommands", () => {
		const cmd = createReviewCommand();
		expect(cmd.commands).toHaveLength(7);
	});
});

describe("review command functional mission flows", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalWrite: typeof process.stdout.write;
	let output: string;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		await mkdir(join(tempDir, ".overstory"), { recursive: true });
		originalCwd = process.cwd();
		process.chdir(tempDir);

		output = "";
		originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			output += String(chunk);
			return true;
		}) as typeof process.stdout.write;
	});

	afterEach(async () => {
		process.stdout.write = originalWrite;
		process.chdir(originalCwd);
		await cleanupTempDir(tempDir);
	});

	async function seedTerminalMission(opts: {
		id: string;
		slug: string;
		state: "completed" | "stopped";
	}): Promise<void> {
		const dbPath = join(tempDir, ".overstory", "sessions.db");
		const missionStore = createMissionStore(dbPath);
		try {
			const mission = missionStore.create({
				id: opts.id,
				slug: opts.slug,
				objective: `Review ${opts.slug} mission output`,
				runId: `run-${opts.id}`,
				artifactRoot: join(tempDir, ".overstory", "missions", opts.id),
				startedAt: "2026-03-13T00:00:00.000Z",
			});
			await ensureMissionArtifacts(mission);
			if (opts.state === "completed") {
				missionStore.completeMission(opts.id);
			} else {
				missionStore.updateState(opts.id, "stopped");
				missionStore.updatePhase(opts.id, "done");
			}
		} finally {
			missionStore.close();
		}
	}

	test("review missions --json executes command action and returns terminal missions", async () => {
		await seedTerminalMission({ id: "mission-001", slug: "review-alpha", state: "completed" });
		await seedTerminalMission({ id: "mission-002", slug: "review-beta", state: "stopped" });

		const cmd = createReviewCommand();
		await cmd.parseAsync(["missions", "--json"], { from: "user" });

		const parsed = JSON.parse(output.trim()) as {
			command: string;
			missions: Array<{ mission: { id: string; slug: string; state: string } }>;
		};
		expect(parsed.command).toBe("review");
		expect(parsed.missions).toHaveLength(2);
		expect(parsed.missions.map((entry) => entry.mission.slug)).toContain("review-alpha");
		expect(parsed.missions.map((entry) => entry.mission.slug)).toContain("review-beta");
	});

		test("review mission <slug> --json resolves by slug and executes analyzer", async () => {
			await seedTerminalMission({ id: "mission-010", slug: "review-slug", state: "completed" });

			const cmd = createReviewCommand();
			await cmd.parseAsync(["mission", "review-slug", "--json"], { from: "user" });

			const parsed = JSON.parse(output.trim()) as {
				command: string;
				mission: { id: string; slug: string };
				record: { subjectType: string; subjectId: string; overallScore: number };
			};
			expect(parsed.command).toBe("review");
			expect(parsed.mission.slug).toBe("review-slug");
			expect(parsed.record.subjectType).toBe("mission");
			expect(parsed.record.subjectId).toBe("mission-010");
			expect(parsed.record.overallScore).toBeGreaterThanOrEqual(0);
		});

		test("review mission <id> --json resolves by id and executes analyzer", async () => {
			await seedTerminalMission({ id: "mission-011", slug: "review-by-id", state: "stopped" });

			const cmd = createReviewCommand();
			await cmd.parseAsync(["mission", "mission-011", "--json"], { from: "user" });

			const parsed = JSON.parse(output.trim()) as {
				command: string;
				mission: { id: string; slug: string };
				record: { subjectType: string; subjectId: string; overallScore: number };
			};
			expect(parsed.command).toBe("review");
			expect(parsed.mission.id).toBe("mission-011");
			expect(parsed.mission.slug).toBe("review-by-id");
			expect(parsed.record.subjectType).toBe("mission");
			expect(parsed.record.subjectId).toBe("mission-011");
			expect(parsed.record.overallScore).toBeGreaterThanOrEqual(0);
		});

		test("review missions --json returns empty list when no terminal missions exist", async () => {
			const cmd = createReviewCommand();
			await cmd.parseAsync(["missions", "--json"], { from: "user" });

		const parsed = JSON.parse(output.trim()) as { missions: unknown[] };
		expect(parsed.missions).toEqual([]);
	});
});
