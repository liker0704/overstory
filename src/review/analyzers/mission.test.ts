/**
 * Tests for mission analyzer.
 *
 * Pure function tests — no mocks, no I/O.
 */

import { describe, expect, test } from "bun:test";
import type { Mission } from "../../types.ts";
import { analyzeMission, type MissionReviewInput } from "./mission.ts";

function makeMission(overrides?: Partial<Mission>): Mission {
	return {
		id: "mission-test-001",
		slug: "test-mission",
		objective: "Implement the full review contour for missions in the overstory system",
		runId: "run-001",
		state: "completed",
		phase: "done",
		firstFreezeAt: null,
		pendingUserInput: false,
		pendingInputKind: null,
		pendingInputThreadId: null,
		reopenCount: 0,
		artifactRoot: ".overstory/missions/test-mission",
		pausedWorkstreamIds: [],
		analystSessionId: "analyst-001",
		executionDirectorSessionId: "exec-001",
		coordinatorSessionId: null,
		pausedLeadNames: [],
		pauseReason: null,
		currentNode: null,
		startedAt: null,
		completedAt: null,
		createdAt: "2026-03-12T00:00:00.000Z",
		updatedAt: "2026-03-12T12:00:00.000Z",
		...overrides,
	};
}

function makeInput(overrides?: Partial<MissionReviewInput>): MissionReviewInput {
	return {
		mission: makeMission(),
		eventCount: 100,
		errorCount: 2,
		agentCount: 5,
		completedSessionCount: 8,
		totalSessionCount: 10,
		hasBundleExport: true,
		artifactFileCount: 6,
		metricsCount: 3,
		narrativeEntryCount: 12,
		durationMs: 3600000,
		...overrides,
	};
}

describe("analyzeMission", () => {
	test("well-formed completed mission returns high scores (all dimensions > 60)", () => {
		const result = analyzeMission(makeInput());
		for (const dim of result.dimensions) {
			expect(dim.score).toBeGreaterThan(60);
		}
	});

	test("returns InsertReviewRecord with subjectType mission", () => {
		const result = analyzeMission(makeInput());
		expect(result.subjectType).toBe("mission");
		expect(result.subjectId).toBe("mission-test-001");
		expect(result.reviewerSource).toBe("deterministic");
	});

	test("all 6 dimensions present in output", () => {
		const result = analyzeMission(makeInput());
		expect(result.dimensions).toHaveLength(6);
		const dims = result.dimensions.map((d) => d.dimension);
		expect(dims).toContain("clarity");
		expect(dims).toContain("actionability");
		expect(dims).toContain("completeness");
		expect(dims).toContain("signal-to-noise");
		expect(dims).toContain("correctness-confidence");
		expect(dims).toContain("coordination-fit");
	});

	test("overallScore is between 0 and 100", () => {
		const result = analyzeMission(makeInput());
		expect(result.overallScore).toBeGreaterThanOrEqual(0);
		expect(result.overallScore).toBeLessThanOrEqual(100);
	});

	test("mission with no events and no sessions returns low completeness and correctness", () => {
		const result = analyzeMission(
			makeInput({
				eventCount: 0,
				errorCount: 0,
				totalSessionCount: 0,
				completedSessionCount: 0,
				hasBundleExport: false,
				mission: makeMission({ phase: "execute", state: "active" }),
			}),
		);

		const completeness = result.dimensions.find((d) => d.dimension === "completeness");
		const correctness = result.dimensions.find((d) => d.dimension === "correctness-confidence");

		expect(completeness?.score).toBeLessThanOrEqual(50);
		expect(correctness?.score).toBeLessThanOrEqual(50);
	});

	test("mission with high error rate returns low signal-to-noise", () => {
		const result = analyzeMission(
			makeInput({
				eventCount: 100,
				errorCount: 80,
			}),
		);

		const signalNoise = result.dimensions.find((d) => d.dimension === "signal-to-noise");
		expect(signalNoise?.score).toBeLessThan(40);
	});

	test("high error rate adds a note", () => {
		const result = analyzeMission(
			makeInput({
				eventCount: 100,
				errorCount: 50,
			}),
		);
		expect(result.notes.some((n) => n.includes("error rate"))).toBe(true);
	});

	test("no bundle export adds a note", () => {
		const result = analyzeMission(makeInput({ hasBundleExport: false }));
		expect(result.notes.some((n) => n.includes("bundle"))).toBe(true);
	});

	test("high reopenCount adds a note", () => {
		const result = analyzeMission(makeInput({ mission: makeMission({ reopenCount: 5 }) }));
		expect(result.notes.some((n) => n.includes("reopened"))).toBe(true);
	});

	test("low reopenCount gives signal-to-noise bonus", () => {
		// Use some errors so the base score isn't already at cap (100)
		const lowReopen = analyzeMission(
			makeInput({ mission: makeMission({ reopenCount: 0 }), eventCount: 100, errorCount: 10 }),
		);
		const highReopen = analyzeMission(
			makeInput({ mission: makeMission({ reopenCount: 5 }), eventCount: 100, errorCount: 10 }),
		);
		const lowScore =
			lowReopen.dimensions.find((d) => d.dimension === "signal-to-noise")?.score ?? 0;
		const highScore =
			highReopen.dimensions.find((d) => d.dimension === "signal-to-noise")?.score ?? 0;
		expect(lowScore).toBeGreaterThan(highScore);
	});

	test("invalid slug reduces clarity score", () => {
		const result = analyzeMission(makeInput({ mission: makeMission({ slug: "INVALID SLUG!" }) }));
		const clarity = result.dimensions.find((d) => d.dimension === "clarity");
		expect(clarity?.score).toBeLessThan(100);
	});

	test("short objective reduces clarity score", () => {
		const result = analyzeMission(makeInput({ mission: makeMission({ objective: "Short" }) }));
		const clarity = result.dimensions.find((d) => d.dimension === "clarity");
		expect(clarity?.score).toBeLessThan(100);
	});

	test("actionability is 0 when non-terminal state and no artifactRoot", () => {
		const result = analyzeMission(
			makeInput({
				mission: makeMission({ state: "active", artifactRoot: null }),
				artifactFileCount: 0,
			}),
		);
		const actionability = result.dimensions.find((d) => d.dimension === "actionability");
		expect(actionability?.score).toBe(0);
	});

	test("coordination-fit penalizes excessive agents", () => {
		const result = analyzeMission(makeInput({ agentCount: 25, metricsCount: 0 }));
		const coord = result.dimensions.find((d) => d.dimension === "coordination-fit");
		expect(coord?.score).toBeLessThanOrEqual(50);
	});

	test("missing artifacts, narrative, and metrics add notes", () => {
		const result = analyzeMission(
			makeInput({
				artifactFileCount: 1,
				metricsCount: 0,
				narrativeEntryCount: 0,
			}),
		);

		expect(result.notes.some((note) => note.includes("artifacts"))).toBe(true);
		expect(result.notes.some((note) => note.includes("narrative"))).toBe(true);
		expect(result.notes.some((note) => note.includes("metrics"))).toBe(true);
	});
});
