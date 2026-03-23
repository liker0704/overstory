/**
 * Probabilistic eval runner: executes multiple trials and aggregates statistics.
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { runEval } from "./runner.ts";
import type {
	AggregateStats,
	EvalMetrics,
	EvalRunConfig,
	MetricAggregate,
	ProbabilisticConfig,
	ProbabilisticEvalResult,
	TrialResult,
} from "./types.ts";

/** Compute a percentile value using linear interpolation on a sorted array. */
export function computePercentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	if (sorted.length === 1) return sorted[0] ?? 0;
	const index = (p / 100) * (sorted.length - 1);
	const lower = Math.floor(index);
	const upper = Math.ceil(index);
	if (lower === upper) return sorted[lower] ?? 0;
	const lowerVal = sorted[lower] ?? 0;
	const upperVal = sorted[upper] ?? 0;
	return lowerVal + (upperVal - lowerVal) * (index - lower);
}

/** Compute population standard deviation. */
export function computeStddev(values: number[], mean: number): number {
	if (values.length === 0) return 0;
	const sumSquaredDiff = values.reduce((acc, v) => acc + (v - mean) ** 2, 0);
	return Math.sqrt(sumSquaredDiff / values.length);
}

/** Compute aggregate statistics for a single numeric metric across trials. */
function aggregateMetric(values: number[]): MetricAggregate {
	if (values.length === 0) {
		return { mean: 0, median: 0, min: 0, max: 0, p5: 0, p95: 0, stddev: 0 };
	}
	const sorted = [...values].sort((a, b) => a - b);
	const sum = values.reduce((acc, v) => acc + v, 0);
	const mean = sum / values.length;
	return {
		mean,
		median: computePercentile(sorted, 50),
		min: sorted[0] ?? 0,
		max: sorted[sorted.length - 1] ?? 0,
		p5: computePercentile(sorted, 5),
		p95: computePercentile(sorted, 95),
		stddev: computeStddev(values, mean),
	};
}

/** Numeric field names of EvalMetrics. */
const EVAL_METRICS_KEYS: (keyof EvalMetrics)[] = [
	"totalAgents",
	"completedAgents",
	"zombieCount",
	"stallCount",
	"stallRate",
	"mergeSuccessCount",
	"mergeConflictCount",
	"mergeQueuePending",
	"tasksCompleted",
	"durationMs",
	"totalInputTokens",
	"totalOutputTokens",
	"estimatedCostUsd",
	"nudgesSent",
	"runtimeSwaps",
	"medianSessionDurationMs",
];

/** Compute aggregate statistics from a set of trial results. */
export function computeAggregateStats(trials: TrialResult[]): AggregateStats {
	const trialCount = trials.length;
	if (trialCount === 0) {
		const emptyMetrics: Record<string, MetricAggregate> = {};
		for (const key of EVAL_METRICS_KEYS) {
			emptyMetrics[key] = { mean: 0, median: 0, min: 0, max: 0, p5: 0, p95: 0, stddev: 0 };
		}
		return {
			trialCount: 0,
			passCount: 0,
			failCount: 0,
			successRatio: 0,
			timeoutCount: 0,
			metrics: emptyMetrics,
		};
	}

	let passCount = 0;
	let failCount = 0;
	let timeoutCount = 0;

	for (const trial of trials) {
		if (trial.evalResult.timedOut) {
			timeoutCount++;
		}
		if (trial.evalResult.passed) {
			passCount++;
		} else {
			failCount++;
		}
	}

	const metricValues: Record<string, number[]> = {};
	for (const key of EVAL_METRICS_KEYS) {
		metricValues[key] = trials.map((t) => t.evalResult.metrics[key]);
	}

	const metrics: Record<string, MetricAggregate> = {};
	for (const key of EVAL_METRICS_KEYS) {
		metrics[key] = aggregateMetric(metricValues[key] ?? []);
	}

	return {
		trialCount,
		passCount,
		failCount,
		successRatio: passCount / trialCount,
		timeoutCount,
		metrics,
	};
}

/** Run multiple eval trials and aggregate results. */
export async function runProbabilisticEval(
	config: EvalRunConfig,
	probabilisticConfig: ProbabilisticConfig,
): Promise<ProbabilisticEvalResult> {
	const startedAt = new Date().toISOString();
	const startMs = Date.now();
	const { count } = probabilisticConfig;
	const trials: TrialResult[] = [];

	for (let i = 0; i < count; i++) {
		const trialRunId = `${config.runId}-trial-${i}`;
		const trialFixturePath = `${tmpdir()}/ov-eval-${trialRunId}`;
		mkdirSync(trialFixturePath, { recursive: true });

		const evalResult = await runEval({
			...config,
			runId: trialRunId,
			fixtureRepoPath: trialFixturePath,
		});

		trials.push({ trialIndex: i, evalResult });
	}

	const completedAt = new Date().toISOString();
	const totalDurationMs = Date.now() - startMs;
	const aggregateStats = computeAggregateStats(trials);

	return {
		runId: config.runId,
		scenarioName: config.scenario.name,
		scenarioPath: config.scenarioPath,
		startedAt,
		completedAt,
		totalDurationMs,
		config: probabilisticConfig,
		trials,
		aggregateStats,
		stochasticAssertions: [],
		passed: true,
	};
}
