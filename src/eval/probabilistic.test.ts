import { describe, expect, it } from "bun:test";
import { computeAggregateStats, computePercentile, computeStddev } from "./probabilistic.ts";
import type { EvalMetrics, EvalResult, TrialResult } from "./types.ts";

function makeMetrics(overrides: Partial<EvalMetrics> = {}): EvalMetrics {
	return {
		totalAgents: 0,
		completedAgents: 0,
		zombieCount: 0,
		stallCount: 0,
		stallRate: 0,
		mergeSuccessCount: 0,
		mergeConflictCount: 0,
		mergeQueuePending: 0,
		tasksCompleted: 0,
		durationMs: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		estimatedCostUsd: 0,
		nudgesSent: 0,
		runtimeSwaps: 0,
		medianSessionDurationMs: 0,
		...overrides,
	};
}

function makeEvalResult(overrides: Partial<EvalResult> = {}): EvalResult {
	return {
		runId: "test-run",
		scenarioName: "test-scenario",
		scenarioPath: "/test/path",
		startedAt: new Date().toISOString(),
		completedAt: new Date().toISOString(),
		durationMs: 1000,
		metrics: makeMetrics(),
		assertions: [],
		passed: true,
		timedOut: false,
		...overrides,
	};
}

function makeTrial(index: number, overrides: Partial<EvalResult> = {}): TrialResult {
	return {
		trialIndex: index,
		evalResult: makeEvalResult(overrides),
	};
}

describe("computePercentile", () => {
	it("returns 0 for empty array", () => {
		expect(computePercentile([], 50)).toBe(0);
	});

	it("returns single value for 1-element array", () => {
		expect(computePercentile([42], 5)).toBe(42);
		expect(computePercentile([42], 95)).toBe(42);
		expect(computePercentile([42], 50)).toBe(42);
	});

	it("interpolates between two values", () => {
		const sorted = [0, 100];
		expect(computePercentile(sorted, 0)).toBe(0);
		expect(computePercentile(sorted, 100)).toBe(100);
		expect(computePercentile(sorted, 50)).toBe(50);
	});

	it("handles 5th and 95th percentile on many values", () => {
		const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
		const p5 = computePercentile(sorted, 5);
		const p95 = computePercentile(sorted, 95);
		expect(p5).toBeLessThan(p95);
		expect(p5).toBeGreaterThan(0);
		expect(p95).toBeLessThanOrEqual(11);
	});
});

describe("computeStddev", () => {
	it("returns 0 for empty array", () => {
		expect(computeStddev([], 0)).toBe(0);
	});

	it("returns 0 for single identical values", () => {
		expect(computeStddev([5, 5, 5], 5)).toBe(0);
	});

	it("computes population stddev", () => {
		// values [2,4,4,4,5,5,7,9], mean=5, stddev=2
		const values = [2, 4, 4, 4, 5, 5, 7, 9];
		const mean = values.reduce((a, b) => a + b, 0) / values.length;
		const stddev = computeStddev(values, mean);
		expect(Math.round(stddev * 1000) / 1000).toBe(2);
	});
});

describe("computeAggregateStats", () => {
	it("returns zeroed stats for 0 trials", () => {
		const stats = computeAggregateStats([]);
		expect(stats.trialCount).toBe(0);
		expect(stats.passCount).toBe(0);
		expect(stats.failCount).toBe(0);
		expect(stats.successRatio).toBe(0);
		expect(stats.timeoutCount).toBe(0);
		expect(stats.metrics.totalAgents).toEqual({
			mean: 0,
			median: 0,
			min: 0,
			max: 0,
			p5: 0,
			p95: 0,
			stddev: 0,
		});
	});

	it("returns single value for all percentiles when 1 trial", () => {
		const trial = makeTrial(0, { metrics: makeMetrics({ totalAgents: 5 }) });
		const stats = computeAggregateStats([trial]);
		const agg = stats.metrics.totalAgents;
		if (!agg) throw new Error("missing totalAgents aggregate");
		expect(agg.mean).toBe(5);
		expect(agg.median).toBe(5);
		expect(agg.min).toBe(5);
		expect(agg.max).toBe(5);
		expect(agg.p5).toBe(5);
		expect(agg.p95).toBe(5);
		expect(agg.stddev).toBe(0);
	});

	it("counts pass/fail correctly for multiple trials", () => {
		const trials = [
			makeTrial(0, { passed: true }),
			makeTrial(1, { passed: false }),
			makeTrial(2, { passed: true }),
			makeTrial(3, { passed: false }),
			makeTrial(4, { passed: false }),
		];
		const stats = computeAggregateStats(trials);
		expect(stats.trialCount).toBe(5);
		expect(stats.passCount).toBe(2);
		expect(stats.failCount).toBe(3);
		expect(stats.successRatio).toBeCloseTo(0.4);
	});

	it("aggregates known metric values correctly", () => {
		const trials = [
			makeTrial(0, { metrics: makeMetrics({ totalAgents: 2 }) }),
			makeTrial(1, { metrics: makeMetrics({ totalAgents: 4 }) }),
			makeTrial(2, { metrics: makeMetrics({ totalAgents: 6 }) }),
			makeTrial(3, { metrics: makeMetrics({ totalAgents: 8 }) }),
		];
		const stats = computeAggregateStats(trials);
		const agg = stats.metrics.totalAgents;
		if (!agg) throw new Error("missing totalAgents aggregate");
		expect(agg.mean).toBe(5);
		expect(agg.min).toBe(2);
		expect(agg.max).toBe(8);
		expect(agg.median).toBe(5);
	});

	it("counts timeouts", () => {
		const trials = [
			makeTrial(0, { timedOut: true, passed: false }),
			makeTrial(1, { timedOut: false, passed: true }),
			makeTrial(2, { timedOut: true, passed: false }),
		];
		const stats = computeAggregateStats(trials);
		expect(stats.timeoutCount).toBe(2);
	});

	it("handles 2-trial percentile edge case", () => {
		const trials = [
			makeTrial(0, { metrics: makeMetrics({ durationMs: 100 }) }),
			makeTrial(1, { metrics: makeMetrics({ durationMs: 200 }) }),
		];
		const stats = computeAggregateStats(trials);
		const agg = stats.metrics.durationMs;
		if (!agg) throw new Error("missing durationMs aggregate");
		expect(agg.min).toBe(100);
		expect(agg.max).toBe(200);
		expect(agg.mean).toBe(150);
		expect(agg.p5).toBeGreaterThanOrEqual(100);
		expect(agg.p95).toBeLessThanOrEqual(200);
	});
});
