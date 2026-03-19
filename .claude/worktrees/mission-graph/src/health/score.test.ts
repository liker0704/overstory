/**
 * Tests for health score computation.
 *
 * Tests use synthetic HealthSignals to exercise each factor formula
 * and the overall score/grade derivation independently.
 */

import { describe, expect, it } from "bun:test";
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
		collectedAt: new Date().toISOString(),
		...overrides,
	};
}

describe("computeScore", () => {
	it("returns overall 100 and grade A for a perfect swarm", () => {
		const score = computeScore(healthySignals());
		expect(score.overall).toBe(100);
		expect(score.grade).toBe("A");
	});

	it("includes all six factors", () => {
		const score = computeScore(healthySignals());
		const names = score.factors.map((f) => f.name);
		expect(names).toContain("completion_rate");
		expect(names).toContain("stalled_rate");
		expect(names).toContain("zombie_count");
		expect(names).toContain("doctor_failures");
		expect(names).toContain("merge_quality");
		expect(names).toContain("runtime_stability");
		expect(names).toHaveLength(6);
	});

	it("factor weights sum to 1.0", () => {
		const score = computeScore(healthySignals());
		const totalWeight = score.factors.reduce((sum, f) => sum + f.weight, 0);
		expect(totalWeight).toBeCloseTo(1.0);
	});

	describe("completion_rate factor", () => {
		it("scores 50 when half of sessions completed", () => {
			const score = computeScore(
				healthySignals({
					completionRate: 0.5,
					completedSessionsRecorded: 5,
					totalSessionsRecorded: 10,
				}),
			);
			const factor = score.factors.find((f) => f.name === "completion_rate");
			expect(factor?.score).toBe(50);
		});

		it("scores 100 when no sessions recorded", () => {
			const score = computeScore(
				healthySignals({
					completionRate: 1.0,
					completedSessionsRecorded: 0,
					totalSessionsRecorded: 0,
				}),
			);
			const factor = score.factors.find((f) => f.name === "completion_rate");
			expect(factor?.score).toBe(100);
		});
	});

	describe("stalled_rate factor", () => {
		it("scores 100 when no active sessions are stalled", () => {
			const score = computeScore(healthySignals({ stalledRate: 0, stalledSessions: 0 }));
			const factor = score.factors.find((f) => f.name === "stalled_rate");
			expect(factor?.score).toBe(100);
		});

		it("scores 0 when half or more of active sessions are stalled", () => {
			const score = computeScore(
				healthySignals({ stalledRate: 0.5, stalledSessions: 2, totalActiveSessions: 4 }),
			);
			const factor = score.factors.find((f) => f.name === "stalled_rate");
			expect(factor?.score).toBe(0);
		});

		it("scores proportionally between 0 and 1", () => {
			const score = computeScore(
				healthySignals({ stalledRate: 0.25, stalledSessions: 1, totalActiveSessions: 4 }),
			);
			const factor = score.factors.find((f) => f.name === "stalled_rate");
			expect(factor?.score).toBe(50);
		});
	});

	describe("zombie_count factor", () => {
		it("scores 100 with 0 zombies", () => {
			const score = computeScore(healthySignals({ zombieSessions: 0 }));
			const factor = score.factors.find((f) => f.name === "zombie_count");
			expect(factor?.score).toBe(100);
		});

		it("scores 70 with 1 zombie", () => {
			const score = computeScore(healthySignals({ zombieSessions: 1 }));
			const factor = score.factors.find((f) => f.name === "zombie_count");
			expect(factor?.score).toBe(70);
		});

		it("scores 40 with 2 zombies", () => {
			const score = computeScore(healthySignals({ zombieSessions: 2 }));
			const factor = score.factors.find((f) => f.name === "zombie_count");
			expect(factor?.score).toBe(40);
		});

		it("scores 0 with 3+ zombies", () => {
			const score = computeScore(healthySignals({ zombieSessions: 5 }));
			const factor = score.factors.find((f) => f.name === "zombie_count");
			expect(factor?.score).toBe(0);
		});
	});

	describe("doctor_failures factor", () => {
		it("scores 100 with 0 failures and 0 warnings", () => {
			const score = computeScore(healthySignals({ doctorFailCount: 0, doctorWarnCount: 0 }));
			const factor = score.factors.find((f) => f.name === "doctor_failures");
			expect(factor?.score).toBe(100);
		});

		it("loses 15 points per failure", () => {
			const score = computeScore(healthySignals({ doctorFailCount: 2, doctorWarnCount: 0 }));
			const factor = score.factors.find((f) => f.name === "doctor_failures");
			expect(factor?.score).toBe(70);
		});

		it("loses 5 points per warning", () => {
			const score = computeScore(healthySignals({ doctorFailCount: 0, doctorWarnCount: 4 }));
			const factor = score.factors.find((f) => f.name === "doctor_failures");
			expect(factor?.score).toBe(80);
		});

		it("floors at 0", () => {
			const score = computeScore(healthySignals({ doctorFailCount: 10, doctorWarnCount: 0 }));
			const factor = score.factors.find((f) => f.name === "doctor_failures");
			expect(factor?.score).toBe(0);
		});
	});

	describe("merge_quality factor", () => {
		it("scores 100 when no merges recorded", () => {
			const score = computeScore(
				healthySignals({ mergeSuccessRate: 1.0, mergeSuccessCount: 0, mergeTotalCount: 0 }),
			);
			const factor = score.factors.find((f) => f.name === "merge_quality");
			expect(factor?.score).toBe(100);
		});

		it("scores proportionally with merge success rate", () => {
			const score = computeScore(
				healthySignals({
					mergeSuccessRate: 0.6,
					mergeSuccessCount: 3,
					mergeTotalCount: 5,
				}),
			);
			const factor = score.factors.find((f) => f.name === "merge_quality");
			expect(factor?.score).toBe(60);
		});
	});

	describe("runtime_stability factor", () => {
		it("scores 100 when no swaps occurred", () => {
			const score = computeScore(healthySignals({ runtimeSwapCount: 0 }));
			const factor = score.factors.find((f) => f.name === "runtime_stability");
			expect(factor?.score).toBe(100);
		});

		it("scores 0 when swap rate is 25% or more", () => {
			const score = computeScore(
				healthySignals({
					runtimeSwapCount: 3,
					totalSessionsRecorded: 10,
				}),
			);
			const factor = score.factors.find((f) => f.name === "runtime_stability");
			// 3/10 = 30% > 25% → 0
			expect(factor?.score).toBe(0);
		});

		it("scales between 0% and 25% swaps", () => {
			const score = computeScore(
				healthySignals({
					runtimeSwapCount: 1,
					totalSessionsRecorded: 8,
				}),
			);
			const factor = score.factors.find((f) => f.name === "runtime_stability");
			// 1/8 = 12.5%, scaled: (1 - 0.125/0.25) = 0.5 → 50
			expect(factor?.score).toBe(50);
		});
	});

	describe("grade derivation", () => {
		it("assigns A for score >= 85", () => {
			expect(computeScore(healthySignals()).grade).toBe("A");
		});

		it("assigns F for degraded swarm with many failures", () => {
			const score = computeScore(
				healthySignals({
					zombieSessions: 5,
					stalledRate: 0.5,
					stalledSessions: 2,
					completionRate: 0.2,
					completedSessionsRecorded: 2,
					doctorFailCount: 4,
					mergeSuccessRate: 0.1,
				}),
			);
			expect(score.grade).toBe("F");
			expect(score.overall).toBeLessThan(40);
		});
	});

	it("overall score never exceeds 100 or falls below 0", () => {
		const highScore = computeScore(healthySignals());
		expect(highScore.overall).toBeLessThanOrEqual(100);
		expect(highScore.overall).toBeGreaterThanOrEqual(0);

		const lowScore = computeScore(
			healthySignals({
				zombieSessions: 10,
				stalledRate: 1.0,
				completionRate: 0.0,
				doctorFailCount: 20,
				mergeSuccessRate: 0.0,
				runtimeSwapCount: 100,
				totalSessionsRecorded: 100,
			}),
		);
		expect(lowScore.overall).toBeGreaterThanOrEqual(0);
	});

	it("factor contributions sum to approximately the overall score", () => {
		const signals = healthySignals({ stalledRate: 0.1, zombieSessions: 1 });
		const score = computeScore(signals);
		const sumContributions = score.factors.reduce((sum, f) => sum + f.contribution, 0);
		// Allow for rounding
		expect(Math.abs(sumContributions - score.overall)).toBeLessThanOrEqual(2);
	});
});
