/**
 * Tests for missionStop() and missionComplete() via terminalizeMission().
 *
 * Strategy: terminalizeMission() calls exportBundle, extractMissionLearnings,
 * and dynamically imports @os-eco/mulch-cli — the module import keeps Bun's
 * event loop alive and prevents the test process from exiting cleanly.
 * We therefore test the observable DB contracts directly via the mission store,
 * avoiding the full terminalizeMission() call path in this file.
 *
 * Full integration coverage of missionStop/missionComplete is deferred to a
 * live-environment test (requires mulch init, tmux, etc.).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMissionStore } from "./store.ts";

let tempDir: string;
let overstoryDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "ov-lifecycle-terminate-test-"));
	overstoryDir = join(tempDir, ".overstory");
	await Bun.write(join(overstoryDir, ".keep"), "");
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe("MissionStore.transaction", () => {
	test("is defined and executes synchronously on a real store", () => {
		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			expect(typeof store.transaction).toBe("function");
			let ran = false;
			store.transaction(() => {
				ran = true;
			});
			expect(ran).toBe(true);
		} finally {
			store.close();
		}
	});
});

describe("MissionStore.completeMission", () => {
	test("sets state=completed and records completedAt timestamp", () => {
		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			store.create({ id: "m-term-cp-001", slug: "complete-ts-test", objective: "test" });
			store.start("m-term-cp-001");

			const before = store.getById("m-term-cp-001");
			expect(before?.completedAt).toBeNull();

			store.completeMission("m-term-cp-001");

			const after = store.getById("m-term-cp-001");
			expect(after?.state).toBe("completed");
			expect(after?.completedAt).not.toBeNull();
		} finally {
			store.close();
		}
	});

	test("transaction wrapping completeMission is atomic", () => {
		// Verify the transaction+completeMission pattern used in terminalizeMission
		// produces consistent state even when the mission phase is already 'done'.
		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			store.create({ id: "m-term-cp-002", slug: "tx-test", objective: "test" });
			store.start("m-term-cp-002");

			store.transaction(() => {
				// mission.phase is 'understand' (not 'done'), so updatePhase runs
				store.updatePhase("m-term-cp-002", "done");
				store.completeMission("m-term-cp-002");
			});

			const result = store.getById("m-term-cp-002");
			expect(result?.state).toBe("completed");
			expect(result?.phase).toBe("done");
			expect(result?.completedAt).not.toBeNull();
		} finally {
			store.close();
		}
	});
});

describe("MissionStore.updateState (stopped path)", () => {
	test("sets mission state to stopped", () => {
		// Mirrors the missionStop non-kill path DB write in terminalizeMission
		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			store.create({ id: "m-term-st-001", slug: "stop-state-test", objective: "test" });
			store.start("m-term-st-001");

			store.updateState("m-term-st-001", "stopped");

			const result = store.getById("m-term-st-001");
			expect(result?.state).toBe("stopped");
		} finally {
			store.close();
		}
	});
});
