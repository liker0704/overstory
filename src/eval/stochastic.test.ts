import { describe, expect, test } from "bun:test";
import { evaluateStochasticAssertions } from "./stochastic.ts";
import type { AggregateStats, Assertion, EvalContext, EvalResult, TrialResult } from "./types.ts";

function makeAggregateStats(overrides: Partial<AggregateStats> = {}): AggregateStats {
	return {
		trialCount: 5,
		passCount: 4,
		failCount: 1,
		successRatio: 0.8,
		timeoutCount: 0,
		metrics: {
			durationMs: {
				mean: 200000,
				median: 200000,
				min: 100000,
				max: 400000,
				p5: 110000,
				p95: 350000,
				stddev: 80000,
			},
		},
		...overrides,
	};
}

function makeTrialResult(trialIndex: number, events: EvalContext["events"] = []): TrialResult {
	const result: EvalResult = {
		runId: `run-${trialIndex}`,
		scenarioName: "test",
		scenarioPath: "/tmp/test",
		startedAt: "2026-01-01T00:00:00Z",
		completedAt: "2026-01-01T00:05:00Z",
		durationMs: 300000,
		metrics: {
			totalAgents: 1,
			completedAgents: 1,
			zombieCount: 0,
			stallCount: 0,
			stallRate: 0,
			mergeSuccessCount: 1,
			mergeConflictCount: 0,
			mergeQueuePending: 0,
			tasksCompleted: 1,
			durationMs: 300000,
			totalInputTokens: 1000,
			totalOutputTokens: 500,
			estimatedCostUsd: 0.01,
			nudgesSent: 0,
			runtimeSwaps: 0,
			medianSessionDurationMs: 300000,
		},
		assertions: [],
		passed: true,
		timedOut: false,
		context: { metrics: {} as EvalContext["metrics"], events, mailMessages: [], missionEvents: [] },
	};
	return { trialIndex, evalResult: result };
}

describe("evaluateStochasticAssertions", () => {
	describe("success_ratio", () => {
		test("passes at boundary", () => {
			const assertion: Assertion = { kind: "success_ratio", expected: 0.8 };
			const stats = makeAggregateStats({ successRatio: 0.8 });
			const results = evaluateStochasticAssertions([assertion], stats, []);
			expect(results[0]?.passed).toBe(true);
			expect(results[0]?.actual).toBe(0.8);
		});

		test("fails below threshold", () => {
			const assertion: Assertion = { kind: "success_ratio", expected: 0.8 };
			const stats = makeAggregateStats({ successRatio: 0.79 });
			const results = evaluateStochasticAssertions([assertion], stats, []);
			expect(results[0]?.passed).toBe(false);
			expect(results[0]?.actual).toBe(0.79);
		});
	});

	describe("percentile_bound", () => {
		test("passes when p95 <= expected", () => {
			const assertion: Assertion = {
				kind: "percentile_bound",
				expected: 300000,
				metric: "durationMs",
				percentile: 95,
			};
			const stats = makeAggregateStats({
				metrics: {
					durationMs: {
						mean: 200000,
						median: 200000,
						min: 100000,
						max: 400000,
						p5: 110000,
						p95: 250000,
						stddev: 80000,
					},
				},
			});
			const results = evaluateStochasticAssertions([assertion], stats, []);
			expect(results[0]?.passed).toBe(true);
			expect(results[0]?.actual).toBe(250000);
		});

		test("fails when p95 > expected", () => {
			const assertion: Assertion = {
				kind: "percentile_bound",
				expected: 300000,
				metric: "durationMs",
				percentile: 95,
			};
			const stats = makeAggregateStats({
				metrics: {
					durationMs: {
						mean: 200000,
						median: 200000,
						min: 100000,
						max: 400000,
						p5: 110000,
						p95: 350000,
						stddev: 80000,
					},
				},
			});
			const results = evaluateStochasticAssertions([assertion], stats, []);
			expect(results[0]?.passed).toBe(false);
			expect(results[0]?.actual).toBe(350000);
		});

		test("fails with 'not found' message for missing metric", () => {
			const assertion: Assertion = {
				kind: "percentile_bound",
				expected: 300000,
				metric: "nonexistent",
				percentile: 95,
			};
			const stats = makeAggregateStats();
			const results = evaluateStochasticAssertions([assertion], stats, []);
			expect(results[0]?.passed).toBe(false);
			expect(results[0]?.message).toContain("not found");
		});
	});

	describe("max_retry_frequency", () => {
		test("passes when ratio <= expected", () => {
			const assertion: Assertion = {
				kind: "max_retry_frequency",
				expected: 0.2,
				selector: { eventType: "error" },
			};
			const trials = [
				makeTrialResult(0, [
					{
						id: 1,
						runId: null,
						agentName: "agent-1",
						sessionId: null,
						eventType: "error",
						toolName: null,
						toolArgs: null,
						toolDurationMs: null,
						level: "error",
						data: null,
						createdAt: "2026-01-01T00:00:00Z",
					},
				]),
				makeTrialResult(1, []),
				makeTrialResult(2, []),
				makeTrialResult(3, []),
				makeTrialResult(4, []),
			];
			const results = evaluateStochasticAssertions([assertion], makeAggregateStats(), trials);
			expect(results[0]?.passed).toBe(true);
			expect(results[0]?.actual).toBe(0.2);
		});

		test("fails when ratio > expected", () => {
			const assertion: Assertion = {
				kind: "max_retry_frequency",
				expected: 0.2,
				selector: { eventType: "error" },
			};
			const trials = [
				makeTrialResult(0, [
					{
						id: 1,
						runId: null,
						agentName: "agent-1",
						sessionId: null,
						eventType: "error",
						toolName: null,
						toolArgs: null,
						toolDurationMs: null,
						level: "error",
						data: null,
						createdAt: "2026-01-01T00:00:00Z",
					},
				]),
				makeTrialResult(1, [
					{
						id: 2,
						runId: null,
						agentName: "agent-2",
						sessionId: null,
						eventType: "error",
						toolName: null,
						toolArgs: null,
						toolDurationMs: null,
						level: "error",
						data: null,
						createdAt: "2026-01-01T00:00:00Z",
					},
				]),
				makeTrialResult(2, []),
				makeTrialResult(3, []),
				makeTrialResult(4, []),
			];
			const results = evaluateStochasticAssertions([assertion], makeAggregateStats(), trials);
			expect(results[0]?.passed).toBe(false);
			expect(results[0]?.actual).toBe(0.4);
		});

		test("edge case: 0 trials passes with ratio 0", () => {
			const assertion: Assertion = {
				kind: "max_retry_frequency",
				expected: 0.2,
				selector: { eventType: "error" },
			};
			const results = evaluateStochasticAssertions([assertion], makeAggregateStats(), []);
			expect(results[0]?.passed).toBe(true);
			expect(results[0]?.actual).toBe(0);
		});
	});

	test("uses label when provided", () => {
		const assertion: Assertion = {
			kind: "success_ratio",
			expected: 0.8,
			label: "Custom label",
		};
		const stats = makeAggregateStats({ successRatio: 0.9 });
		const results = evaluateStochasticAssertions([assertion], stats, []);
		expect(results[0]?.label).toBe("Custom label");
	});
});
