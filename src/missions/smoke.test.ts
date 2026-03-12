/**
 * Smoke tests for mission lifecycle and prompt selection.
 *
 * Uses real bun:sqlite with temp files for lifecycle tests.
 * Prompt selection tests are pure functions — no DB needed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMissionCapability } from "../agents/manifest.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import type { MissionStore } from "../types.ts";
import { createMissionStore } from "./store.ts";

let tempDir: string;
let store: MissionStore;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "overstory-smoke-test-"));
	const dbPath = join(tempDir, "sessions.db");
	store = createMissionStore(dbPath);
});

afterEach(async () => {
	store.close();
	await cleanupTempDir(tempDir);
});

describe("mission smoke tests", () => {
	describe("mission lifecycle", () => {
		test("mission start creates mission with correct defaults", () => {
			const mission = store.create({
				id: "mission-smoke-001",
				slug: "smoke-mission",
				objective: "Smoke test the mission lifecycle",
			});

			expect(mission.id).toBe("mission-smoke-001");
			expect(mission.slug).toBe("smoke-mission");
			expect(mission.objective).toBe("Smoke test the mission lifecycle");
			expect(mission.state).toBe("active");
			expect(mission.phase).toBe("planning");
			expect(mission.pendingUserInput).toBe(false);
			expect(mission.reopenCount).toBe(0);
			expect(mission.runId).toBeNull();
			expect(mission.createdAt).toBeTruthy();
			expect(mission.updatedAt).toBeTruthy();
		});

		test("mission status reads back correctly after creation", () => {
			store.create({ id: "mission-smoke-002", slug: "smoke-status", objective: "Status check" });
			const fetched = store.getById("mission-smoke-002");
			expect(fetched).not.toBeNull();
			expect(fetched?.state).toBe("active");
			expect(fetched?.phase).toBe("planning");
		});

		test("mission stop sets terminal state", () => {
			store.create({ id: "mission-smoke-003", slug: "smoke-stop", objective: "Stop test" });
			store.updateState("mission-smoke-003", "completed");
			const result = store.getById("mission-smoke-003");
			expect(result?.state).toBe("completed");
			expect(store.getActive()).toBeNull();
		});

		test("mission list returns missions after completion", () => {
			store.create({ id: "mission-smoke-004", slug: "smoke-list-a", objective: "List test A" });
			store.create({ id: "mission-smoke-005", slug: "smoke-list-b", objective: "List test B" });
			store.updateState("mission-smoke-004", "completed");

			const all = store.list();
			expect(all.length).toBeGreaterThanOrEqual(2);

			const completed = store.list({ state: "completed" });
			expect(completed.some((m) => m.id === "mission-smoke-004")).toBe(true);

			const active = store.list({ state: "active" });
			expect(active.some((m) => m.id === "mission-smoke-005")).toBe(true);
		});

		test("mission show retrieves by id and slug", () => {
			store.create({ id: "mission-smoke-006", slug: "smoke-show", objective: "Show test" });

			const byId = store.getById("mission-smoke-006");
			expect(byId).not.toBeNull();
			expect(byId?.slug).toBe("smoke-show");

			const bySlug = store.getBySlug("smoke-show");
			expect(bySlug).not.toBeNull();
			expect(bySlug?.id).toBe("mission-smoke-006");
		});

		test("freeze and unfreeze cycle works correctly", () => {
			store.create({
				id: "mission-smoke-007",
				slug: "smoke-freeze",
				objective: "Freeze/unfreeze test",
			});

			store.freeze("mission-smoke-007", "question", "thread-xyz");
			const frozen = store.getById("mission-smoke-007");
			expect(frozen?.state).toBe("frozen");
			expect(frozen?.pendingUserInput).toBe(true);
			expect(frozen?.pendingInputKind).toBe("question");
			expect(frozen?.pendingInputThreadId).toBe("thread-xyz");
			expect(frozen?.firstFreezeAt).not.toBeNull();

			store.unfreeze("mission-smoke-007");
			const unfrozen = store.getById("mission-smoke-007");
			expect(unfrozen?.state).toBe("active");
			expect(unfrozen?.pendingUserInput).toBe(false);
			expect(unfrozen?.pendingInputKind).toBeNull();
			expect(unfrozen?.reopenCount).toBe(1);
		});

		test("phase transitions update correctly", () => {
			store.create({
				id: "mission-smoke-008",
				slug: "smoke-phase",
				objective: "Phase transition test",
			});

			store.updatePhase("mission-smoke-008", "scouting");
			expect(store.getById("mission-smoke-008")?.phase).toBe("scouting");

			store.updatePhase("mission-smoke-008", "building");
			expect(store.getById("mission-smoke-008")?.phase).toBe("building");

			store.updatePhase("mission-smoke-008", "done");
			expect(store.getById("mission-smoke-008")?.phase).toBe("done");
		});
	});

	describe("prompt selection", () => {
		test("resolveMissionCapability returns coordinator-mission when mission active", () => {
			expect(resolveMissionCapability("coordinator", true)).toBe("coordinator-mission");
		});

		test("resolveMissionCapability returns lead-mission when mission active", () => {
			expect(resolveMissionCapability("lead", true)).toBe("lead-mission");
		});

		test("resolveMissionCapability returns original capability when no mission", () => {
			expect(resolveMissionCapability("coordinator", false)).toBe("coordinator");
			expect(resolveMissionCapability("lead", false)).toBe("lead");
		});

		test("resolveMissionCapability passes through non-variant capabilities unchanged", () => {
			expect(resolveMissionCapability("builder", true)).toBe("builder");
			expect(resolveMissionCapability("reviewer", true)).toBe("reviewer");
			expect(resolveMissionCapability("merger", true)).toBe("merger");
		});

		test("resolveMissionCapability handles scout, builder, reviewer unchanged even with mission", () => {
			expect(resolveMissionCapability("scout", true)).toBe("scout");
			expect(resolveMissionCapability("builder", true)).toBe("builder");
			expect(resolveMissionCapability("reviewer", true)).toBe("reviewer");
		});
	});
});
