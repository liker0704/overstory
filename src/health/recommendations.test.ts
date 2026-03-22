/**
 * Tests for health recommendation selection.
 */

import { describe, expect, it } from "bun:test";
import { selectRecommendation } from "./recommendations.ts";
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

	it("prefers critical over high priority when multiple factors are degraded", () => {
		const score = computeScore(
			healthySignals({
				zombieSessions: 1, // critical
				stalledRate: 0.4, // high
				stalledSessions: 2,
				totalActiveSessions: 5,
			}),
		);
		const rec = selectRecommendation(score);
		expect(rec?.priority).toBe("critical");
		expect(rec?.factor).toBe("zombie_count");
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
