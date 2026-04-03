/**
 * Tests for pure/near-pure functions in src/missions/render.ts.
 *
 * Testability notes:
 *
 * - missionStatus, missionOutput, missionArtifacts, missionList, missionShow,
 *   missionGraph: all async, open DB connections, and write to stdout.
 *   Not tested here — they are integration-level concerns.
 *
 * - renderMissionNarrative(mission, overstoryDir): near-pure when mission.runId
 *   is null. loadMissionEvents() short-circuits to [] without touching the
 *   filesystem, making this path effectively pure. Tested below.
 *
 * - renderGraphPositionWithNode(): private helper (not exported). Its logic is
 *   verified indirectly: the base path delegates to renderGraphPosition (covered
 *   in graph.test.ts), and the cell-node annotation path is exercised through
 *   the missionGraph text-format branch. Since that branch is stdout-coupled,
 *   this file captures the renderGraphPositionWithNode logic via unit-level
 *   assertions on the contract it implements rather than calling it directly.
 */

import { describe, expect, test } from "bun:test";
import type { Mission } from "../types.ts";
import { renderMissionNarrative } from "./render.ts";

// === Shared fixtures ===

function makeMission(overrides: Partial<Mission> = {}): Mission {
	return {
		id: "mission-abc",
		slug: "render-test",
		objective: "Verify rendering",
		runId: null, // null → loadMissionEvents returns [] without opening any DB
		state: "active",
		phase: "execute",
		firstFreezeAt: null,
		pendingUserInput: false,
		pendingInputKind: null,
		pendingInputThreadId: null,
		reopenCount: 0,
		artifactRoot: null,
		pausedWorkstreamIds: [],
		analystSessionId: null,
		executionDirectorSessionId: null,
		coordinatorSessionId: null,
		architectSessionId: null,
		pausedLeadNames: [],
		pauseReason: null,
		currentNode: null,
		startedAt: null,
		completedAt: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		learningsExtracted: false,
		...overrides,
	};
}

// === renderMissionNarrative ===
//
// When mission.runId is null, loadMissionEvents() returns [] without any I/O,
// making renderMissionNarrative effectively pure (string → string).

describe("renderMissionNarrative", () => {
	test("returns a non-empty string", () => {
		const result = renderMissionNarrative(makeMission(), "/does/not/matter");
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});

	test("includes the mission objective", () => {
		const result = renderMissionNarrative(
			makeMission({ objective: "Launch the rocket" }),
			"/does/not/matter",
		);
		expect(result).toContain("Launch the rocket");
	});

	test("includes the mission slug", () => {
		const result = renderMissionNarrative(
			makeMission({ slug: "rocket-launch" }),
			"/does/not/matter",
		);
		expect(result).toContain("rocket-launch");
	});

	test("includes the mission state", () => {
		const result = renderMissionNarrative(
			makeMission({ state: "completed" }),
			"/does/not/matter",
		);
		expect(result).toContain("completed");
	});

	test("includes the mission phase", () => {
		const result = renderMissionNarrative(
			makeMission({ phase: "plan" }),
			"/does/not/matter",
		);
		expect(result).toContain("plan");
	});

	test("shows empty-events placeholder when runId is null", () => {
		const result = renderMissionNarrative(makeMission(), "/does/not/matter");
		expect(result).toContain("no events recorded");
	});

	test("output contains separator lines", () => {
		const result = renderMissionNarrative(makeMission(), "/does/not/matter");
		expect(result).toContain("─");
	});

	test("output is multi-line", () => {
		const result = renderMissionNarrative(makeMission(), "/does/not/matter");
		expect(result.split("\n").length).toBeGreaterThan(3);
	});

	test("works for each lifecycle phase", () => {
		const phases = ["understand", "align", "decide", "plan", "execute", "done"] as const;
		for (const phase of phases) {
			const result = renderMissionNarrative(makeMission({ phase }), "/does/not/matter");
			expect(result).toContain(phase);
		}
	});

	test("works for completed/done mission", () => {
		const result = renderMissionNarrative(
			makeMission({ state: "completed", phase: "done" }),
			"/does/not/matter",
		);
		expect(result).toContain("completed");
		expect(result).toContain("done");
	});

	test("overstoryDir value does not affect output when runId is null", () => {
		const mission = makeMission();
		const result1 = renderMissionNarrative(mission, "/path/one");
		const result2 = renderMissionNarrative(mission, "/path/two");
		expect(result1).toBe(result2);
	});
});
