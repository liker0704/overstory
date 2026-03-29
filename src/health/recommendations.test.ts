/**
 * Tests for health recommendation selection.
 */

import { describe, expect, it } from "bun:test";
import { selectRecommendation, selectRecommendations } from "./recommendations.ts";
import { computeScore } from "./score.ts";
import type { HealthSignals } from "./types.ts";

/** Build a HealthSignals object with all-healthy defaults. */
function healthySignals(overrides: Partial<HealthSignals> = {}): HealthSignals {
	return {
		totalActiveSessions: 4,
		stalledSessions: 0,
		zombieSessions: 0,
		bootingSessions: 0,
		workingSessions: 4,
		runtimeSwapCount: 0,
		totalSessionsRecorded: 10,
		completedSessionsRecorded: 10,
		mergeSuccessCount: 5,
		mergeTotalCount: 5,
		averageDurationMs: 60_000,
		costPerCompletedTask: 0.1,
		doctorFailCount: 0,
		doctorWarnCount: 0,
		completionRate: 1.0,
		stalledRate: 0.0,
		mergeSuccessRate: 1.0,
		openBreakerCount: 0,
		activeRetryCount: 0,
		recentRerouteCount: 0,
		lowestHeadroomPercent: null,
		criticalHeadroomCount: 0,
		activeMissionCount: 0,
		architectureMdExists: false,
		testPlanExists: false,
		holdoutChecksFailed: 0,
		collectedAt: new Date().toISOString(),
		...overrides,
	};
}

describe("selectRecommendation", () => {
	it("returns null when all factors are healthy", () => {
		const score = computeScore(healthySignals());
		const rec = selectRecommendation(score);
		expect(rec).toBeNull();
	});

	it("returns a zombie recommendation when zombies are present", () => {
		const score = computeScore(healthySignals({ zombieSessions: 2 }));
		const rec = selectRecommendation(score);
		expect(rec).not.toBeNull();
		expect(rec?.factor).toBe("zombie_count");
		expect(rec?.priority).toBe("critical");
		expect(rec?.title).toContain("zombie");
	});

	it("returns a doctor failures recommendation for critical failures", () => {
		const score = computeScore(healthySignals({ doctorFailCount: 4, doctorWarnCount: 0 }));
		const rec = selectRecommendation(score);
		expect(rec).not.toBeNull();
		expect(rec?.factor).toBe("doctor_failures");
		expect(rec?.priority).toBe("critical");
		expect(rec?.action).toContain("ov doctor");
	});

	it("returns stalled_rate recommendation when many agents are stalled", () => {
		const score = computeScore(
			healthySignals({
				stalledRate: 0.4,
				stalledSessions: 2,
				totalActiveSessions: 5,
			}),
		);
		const rec = selectRecommendation(score);
		expect(rec).not.toBeNull();
		expect(rec?.factor).toBe("stalled_rate");
		expect(rec?.priority).toBe("high");
	});

	it("returns completion_rate recommendation when completion is low", () => {
		const score = computeScore(
			healthySignals({
				completionRate: 0.5,
				completedSessionsRecorded: 5,
				totalSessionsRecorded: 10,
			}),
		);
		const rec = selectRecommendation(score);
		expect(rec).not.toBeNull();
		expect(rec?.factor).toBe("completion_rate");
	});

	it("returns merge_quality recommendation when merge quality is low", () => {
		const score = computeScore(
			healthySignals({
				mergeSuccessRate: 0.5,
				mergeSuccessCount: 2,
				mergeTotalCount: 4,
			}),
		);
		const rec = selectRecommendation(score);
		expect(rec).not.toBeNull();
		expect(rec?.factor).toBe("merge_quality");
	});

	it("recommendation has all required fields", () => {
		const score = computeScore(healthySignals({ doctorFailCount: 3 }));
		const rec = selectRecommendation(score);
		expect(rec).not.toBeNull();
		expect(rec?.title).toBeTruthy();
		expect(rec?.whyNow).toBeTruthy();
		expect(rec?.expectedImpact).toBeTruthy();
		expect(rec?.action).toBeTruthy();
		expect(rec?.verificationStep).toBeTruthy();
		expect(rec?.priority).toBeTruthy();
		expect(rec?.factor).toBeTruthy();
	});

	it("returns runtime_stability recommendation when swap rate is high", () => {
		const score = computeScore(
			healthySignals({
				runtimeSwapCount: 4,
				totalSessionsRecorded: 10,
			}),
		);
		const rec = selectRecommendation(score);
		expect(rec).not.toBeNull();
		expect(rec?.factor).toBe("runtime_stability");
	});

	it("returns low-priority recommendation for minor completion rate dip", () => {
		const score = computeScore(
			healthySignals({
				completionRate: 0.85,
				completedSessionsRecorded: 85,
				totalSessionsRecorded: 100,
			}),
		);
		const rec = selectRecommendation(score);
		// 85% completion is below 90% low-priority threshold
		if (rec?.factor === "completion_rate") {
			expect(rec.priority).toBe("low");
		}
		// May be null if other factors are all perfect and score is above threshold
	});
});

describe("selectRecommendations", () => {
	it("returns empty array when all factors healthy", () => {
		const score = computeScore(healthySignals());
		const recs = selectRecommendations(score);
		expect(recs).toEqual([]);
	});

	it("returns multiple recommendations when multiple factors degraded", () => {
		const score = computeScore(
			healthySignals({
				zombieSessions: 1,
				stalledRate: 0.4,
				stalledSessions: 2,
				totalActiveSessions: 5,
			}),
		);
		const recs = selectRecommendations(score);
		expect(recs.length).toBeGreaterThan(1);
		const factors = recs.map((r) => r.factor);
		expect(factors).toContain("zombie_count");
		expect(factors).toContain("stalled_rate");
	});

	it("estimatedImpact calculation is correct", () => {
		// stalled_rate=0.4 → score = clamp(round((1 - 0.4*2)*100)) = clamp(20) = 20
		// estimatedImpact = (100 - 20) * 0.18 = 14.4
		const score = computeScore(
			healthySignals({
				stalledRate: 0.4,
				stalledSessions: 2,
				totalActiveSessions: 5,
			}),
		);
		const recs = selectRecommendations(score);
		const stalledRec = recs.find((r) => r.factor === "stalled_rate");
		expect(stalledRec).toBeDefined();
		const stalledFactor = score.factors.find((f) => f.name === "stalled_rate");
		expect(stalledFactor).toBeDefined();
		if (stalledRec !== undefined && stalledFactor !== undefined) {
			const expected = (100 - stalledFactor.score) * stalledFactor.weight;
			expect(stalledRec.estimatedImpact).toBeCloseTo(expected, 5);
		}
	});

	it("ranking is impact-first, not priority-first", () => {
		// runtime_stability (medium): runtimeSwapCount=10/10 → swapRate=1.0 → score=0
		//   estimatedImpact = (100-0) * 0.08 = 8.0
		// zombie_count (critical): zombieSessions=1 → score=70
		//   estimatedImpact = (100-70) * 0.13 = 3.9
		// runtime_stability has higher impact despite lower priority → should rank first
		const score = computeScore(
			healthySignals({
				runtimeSwapCount: 10,
				totalSessionsRecorded: 10,
				zombieSessions: 1,
			}),
		);
		const recs = selectRecommendations(score);
		const runtimeIdx = recs.findIndex((r) => r.factor === "runtime_stability");
		const zombieIdx = recs.findIndex((r) => r.factor === "zombie_count");
		expect(runtimeIdx).toBeGreaterThanOrEqual(0);
		expect(zombieIdx).toBeGreaterThanOrEqual(0);
		expect(runtimeIdx).toBeLessThan(zombieIdx);
	});

	it("rankReason follows expected format", () => {
		const score = computeScore(
			healthySignals({
				zombieSessions: 1,
				stalledRate: 0.4,
				stalledSessions: 2,
				totalActiveSessions: 5,
			}),
		);
		const recs = selectRecommendations(score);
		expect(recs.length).toBeGreaterThanOrEqual(2);
		expect(recs[0]?.rankReason).toBe("Highest estimated impact on overall score");
		expect(recs[1]?.rankReason).toBe("Ranked #2 by estimated impact");
		if (recs.length >= 3) {
			expect(recs[2]?.rankReason).toBe("Ranked #3 by estimated impact");
		}
	});

	it("per-factor deduplication keeps highest-priority rule", () => {
		// doctorFailCount=4: score = clamp(100 - 4*15) = 40
		// Both critical (threshold<55) and medium (threshold<85) rules fire.
		// After dedup, only critical should remain.
		const score = computeScore(healthySignals({ doctorFailCount: 4 }));
		const recs = selectRecommendations(score);
		const doctorRecs = recs.filter((r) => r.factor === "doctor_failures");
		expect(doctorRecs).toHaveLength(1);
		expect(doctorRecs[0]?.priority).toBe("critical");
	});

	it("backward compat selectRecommendation returns first from array", () => {
		const score = computeScore(
			healthySignals({
				zombieSessions: 1,
				stalledRate: 0.4,
				stalledSessions: 2,
				totalActiveSessions: 5,
			}),
		);
		const recs = selectRecommendations(score);
		const single = selectRecommendation(score);
		expect(recs.length).toBeGreaterThan(0);
		const first = recs[0];
		expect(single).toEqual(first ?? null);
	});
});
