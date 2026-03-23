/**
 * Eval report renderer: produces human-readable eval run reports.
 */

import { chalk } from "../logging/color.ts";
import { formatDuration } from "../logging/format.ts";
import { renderHeader } from "../logging/theme.ts";
import type { EvalResult, ProbabilisticEvalResult } from "./types.ts";

/**
 * Render a full human-readable report for an eval result.
 */
export function renderReport(result: EvalResult): string {
	const lines: string[] = [];

	lines.push(renderHeader(`Eval Run: ${result.runId}`));
	lines.push(`Scenario:  ${result.scenarioName}`);
	lines.push(`Duration:  ${formatDuration(result.durationMs)}`);
	const resultLabel = result.passed ? chalk.green.bold("PASS") : chalk.red.bold("FAIL");
	lines.push(`Result:    ${resultLabel}`);
	if (result.timedOut) {
		lines.push(chalk.yellow("  (timed out)"));
	}
	lines.push("");

	const m = result.metrics;
	lines.push(chalk.bold("Metrics:"));
	lines.push(`  Agents spawned:    ${m.totalAgents}`);
	lines.push(`  Completed:         ${m.completedAgents}`);
	lines.push(`  Zombies:           ${m.zombieCount}`);
	lines.push(`  Stall rate:        ${(m.stallRate * 100).toFixed(1)}%`);
	lines.push(`  Merge success:     ${m.mergeSuccessCount}`);
	lines.push(`  Merge conflicts:   ${m.mergeConflictCount}`);
	lines.push(`  Queue pending:     ${m.mergeQueuePending}`);
	lines.push(`  Tasks completed:   ${m.tasksCompleted}`);
	lines.push(`  Nudges sent:       ${m.nudgesSent}`);
	lines.push(`  Runtime swaps:     ${m.runtimeSwaps}`);
	lines.push(`  Median duration:   ${formatDuration(m.medianSessionDurationMs)}`);
	lines.push(`  Estimated cost:    $${m.estimatedCostUsd.toFixed(2)}`);
	lines.push("");

	lines.push(chalk.bold("Assertions:"));
	for (const assertion of result.assertions) {
		const icon = assertion.passed ? chalk.green("✓") : chalk.red("✗");
		const label = assertion.assertion.label ?? assertion.assertion.kind;
		lines.push(`  ${icon} ${label}: ${assertion.message}`);
	}

	return lines.join("\n");
}

/**
 * Render a single summary line for an eval result.
 * Format: [PASS|FAIL] <runId> <scenarioName> <duration>
 */
export function renderSummaryLine(result: EvalResult): string {
	const status = result.passed ? chalk.green.bold("PASS") : chalk.red.bold("FAIL");
	const duration = formatDuration(result.durationMs);
	return `[${status}] ${result.runId} ${result.scenarioName} ${duration}`;
}

/**
 * Render a full human-readable report for a probabilistic eval result.
 */
export function renderProbabilisticReport(result: ProbabilisticEvalResult): string {
	const lines: string[] = [];

	lines.push(renderHeader(`Probabilistic Eval Run: ${result.runId}`));
	lines.push(`Scenario:   ${result.scenarioName}`);
	lines.push(`Duration:   ${formatDuration(result.totalDurationMs)}`);
	lines.push(`Trials:     ${result.config.count}`);
	const resultLabel = result.passed ? chalk.green.bold("PASS") : chalk.red.bold("FAIL");
	lines.push(`Result:     ${resultLabel}`);
	lines.push("");

	lines.push(chalk.bold("Trial Summary:"));
	lines.push(
		`  ${"#".padEnd(4)} ${"Result".padEnd(8)} ${"Duration".padEnd(12)} ${"Agents".padEnd(8)} Cost`,
	);
	for (const trial of result.trials) {
		const trialResult = trial.evalResult;
		const trialStatus = trialResult.passed ? chalk.green("PASS") : chalk.red("FAIL");
		const trialDuration = formatDuration(trialResult.durationMs);
		const trialAgents = String(trialResult.metrics.totalAgents);
		const trialCost = `$${trialResult.metrics.estimatedCostUsd.toFixed(2)}`;
		lines.push(
			`  ${String(trial.trialIndex).padEnd(4)} ${trialStatus.padEnd(8)} ${trialDuration.padEnd(12)} ${trialAgents.padEnd(8)} ${trialCost}`,
		);
	}
	lines.push("");

	const s = result.aggregateStats;
	const m = s.metrics;
	lines.push(chalk.bold("Aggregate Stats:"));
	const dur = m.durationMs;
	const cost = m.estimatedCostUsd;
	const agents = m.totalAgents;
	const stall = m.stallRate;
	if (dur !== undefined) {
		lines.push(
			`  Duration:    mean=${formatDuration(dur.mean)}  median=${formatDuration(dur.median)}  p95=${formatDuration(dur.p95)}`,
		);
	}
	if (cost !== undefined) {
		lines.push(
			`  Cost:        mean=$${cost.mean.toFixed(2)}  median=$${cost.median.toFixed(2)}  p95=$${cost.p95.toFixed(2)}`,
		);
	}
	if (agents !== undefined) {
		lines.push(
			`  Agents:      mean=${agents.mean.toFixed(1)}  median=${agents.median}  p95=${agents.p95}`,
		);
	}
	if (stall !== undefined) {
		lines.push(
			`  Stall rate:  mean=${(stall.mean * 100).toFixed(1)}%  median=${(stall.median * 100).toFixed(1)}%  p95=${(stall.p95 * 100).toFixed(1)}%`,
		);
	}
	lines.push("");

	lines.push(chalk.bold("Stochastic Assertions:"));
	for (const assertion of result.stochasticAssertions) {
		const icon = assertion.passed ? chalk.green("✓") : chalk.red("✗");
		lines.push(`  ${icon} ${assertion.label}: ${assertion.message}`);
	}

	return lines.join("\n");
}

/**
 * Render a single summary line for a probabilistic eval result.
 * Format: [PASS|FAIL] <runId> <scenarioName> <totalDuration> (N trials, X% pass)
 */
export function renderProbabilisticSummaryLine(result: ProbabilisticEvalResult): string {
	const status = result.passed ? chalk.green.bold("PASS") : chalk.red.bold("FAIL");
	const duration = formatDuration(result.totalDurationMs);
	const passPercent = (result.aggregateStats.successRatio * 100).toFixed(0);
	return `[${status}] ${result.runId} ${result.scenarioName} ${duration} (${result.config.count} trials, ${passPercent}% pass)`;
}
