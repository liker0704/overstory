/**
 * Tests for mission-layer pause/resume.
 *
 * Uses real bun:sqlite with temp files for MissionStore. No mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import type { InsertMission, Mission, MissionStore } from "../types.ts";
import {
	getPausedWorkstreamCount,
	isWorkstreamPaused,
	pauseWorkstream,
	resumeWorkstream,
} from "./pause.ts";
import { createMissionStore } from "./store.ts";

let tempDir: string;
let store: MissionStore;
const MISSION_ID = "mission-001";

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "overstory-pause-test-"));
	store = createMissionStore(join(tempDir, "sessions.db"));
	const mission: InsertMission = {
		id: MISSION_ID,
		slug: "test-mission",
		objective: "Test pause/resume",
	};
	store.create(mission);
});

afterEach(async () => {
	store.close();
	await cleanupTempDir(tempDir);
});

/** Get mission, throwing if not found — avoids non-null assertions in tests. */
function getMission(): Mission {
	const m = store.getById(MISSION_ID);
	if (!m) throw new Error(`Mission ${MISSION_ID} not found`);
	return m;
}

// === getPausedWorkstreamCount ===

describe("getPausedWorkstreamCount", () => {
	test("returns 0 for mission with no paused workstreams", () => {
		expect(getPausedWorkstreamCount(getMission())).toBe(0);
	});

	test("returns correct count after pausing", () => {
		pauseWorkstream(store, MISSION_ID, "ws-auth");
		pauseWorkstream(store, MISSION_ID, "ws-payments");
		expect(getPausedWorkstreamCount(getMission())).toBe(2);
	});
});

// === isWorkstreamPaused ===

describe("isWorkstreamPaused", () => {
	test("returns false for unpassed workstream", () => {
		expect(isWorkstreamPaused(getMission(), "ws-auth")).toBe(false);
	});

	test("returns true after workstream is paused", () => {
		pauseWorkstream(store, MISSION_ID, "ws-auth");
		expect(isWorkstreamPaused(getMission(), "ws-auth")).toBe(true);
	});

	test("returns false for other workstreams when one is paused", () => {
		pauseWorkstream(store, MISSION_ID, "ws-auth");
		expect(isWorkstreamPaused(getMission(), "ws-payments")).toBe(false);
	});
});

// === pauseWorkstream ===

describe("pauseWorkstream", () => {
	test("adds workstream to pausedWorkstreamIds", () => {
		const result = pauseWorkstream(store, MISSION_ID, "ws-auth");
		expect(result.missionId).toBe(MISSION_ID);
		expect(result.workstreamId).toBe("ws-auth");
		expect(result.alreadyPaused).toBe(false);
		expect(result.pausedWorkstreamCount).toBe(1);
	});

	test("idempotent — pausing twice reports alreadyPaused", () => {
		pauseWorkstream(store, MISSION_ID, "ws-auth");
		const result = pauseWorkstream(store, MISSION_ID, "ws-auth");
		expect(result.alreadyPaused).toBe(true);
		expect(result.pausedWorkstreamCount).toBe(1);
	});

	test("can pause multiple distinct workstreams", () => {
		pauseWorkstream(store, MISSION_ID, "ws-auth");
		const result = pauseWorkstream(store, MISSION_ID, "ws-payments");
		expect(result.alreadyPaused).toBe(false);
		expect(result.pausedWorkstreamCount).toBe(2);
	});

	test("throws when mission not found", () => {
		expect(() => pauseWorkstream(store, "nonexistent", "ws-auth")).toThrow("Mission not found");
	});

	test("accepts optional reason without error", () => {
		expect(() =>
			pauseWorkstream(store, MISSION_ID, "ws-auth", "waiting for upstream task"),
		).not.toThrow();
	});

	test("wires reason to store.updatePauseReason when provided", () => {
		pauseWorkstream(store, MISSION_ID, "ws-auth", "waiting for upstream task");
		expect(getMission().pauseReason).toBe("waiting for upstream task");
	});

	test("does not update pauseReason when reason is omitted", () => {
		pauseWorkstream(store, MISSION_ID, "ws-auth");
		expect(getMission().pauseReason).toBeNull();
	});

	test("persists to store", () => {
		pauseWorkstream(store, MISSION_ID, "ws-auth");
		expect(getMission().pausedWorkstreamIds).toContain("ws-auth");
	});
});

// === resumeWorkstream ===

describe("resumeWorkstream", () => {
	test("removes workstream from pausedWorkstreamIds", () => {
		pauseWorkstream(store, MISSION_ID, "ws-auth");
		const result = resumeWorkstream(store, MISSION_ID, "ws-auth");
		expect(result.missionId).toBe(MISSION_ID);
		expect(result.workstreamId).toBe("ws-auth");
		expect(result.wasNotPaused).toBe(false);
		expect(result.pausedWorkstreamCount).toBe(0);
	});

	test("idempotent — resuming non-paused workstream reports wasNotPaused", () => {
		const result = resumeWorkstream(store, MISSION_ID, "ws-auth");
		expect(result.wasNotPaused).toBe(true);
		expect(result.pausedWorkstreamCount).toBe(0);
	});

	test("only removes the specified workstream", () => {
		pauseWorkstream(store, MISSION_ID, "ws-auth");
		pauseWorkstream(store, MISSION_ID, "ws-payments");
		resumeWorkstream(store, MISSION_ID, "ws-auth");
		const mission = getMission();
		expect(mission.pausedWorkstreamIds).not.toContain("ws-auth");
		expect(mission.pausedWorkstreamIds).toContain("ws-payments");
	});

	test("throws when mission not found", () => {
		expect(() => resumeWorkstream(store, "nonexistent", "ws-auth")).toThrow("Mission not found");
	});

	test("persists removal to store", () => {
		pauseWorkstream(store, MISSION_ID, "ws-auth");
		resumeWorkstream(store, MISSION_ID, "ws-auth");
		expect(getMission().pausedWorkstreamIds).not.toContain("ws-auth");
	});
});

// === round-trip ===

describe("pause/resume round-trip", () => {
	test("pause then resume leaves list empty", () => {
		pauseWorkstream(store, MISSION_ID, "ws-auth");
		resumeWorkstream(store, MISSION_ID, "ws-auth");
		expect(getMission().pausedWorkstreamIds).toEqual([]);
	});
});
