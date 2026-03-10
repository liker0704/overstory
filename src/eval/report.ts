/**
 * Eval report renderer: produces human-readable eval run reports.
 */

import { chalk } from "../logging/color.ts";
import { formatDuration } from "../logging/format.ts";
import { renderHeader } from "../logging/theme.ts";
import type { EvalResult } from "./types.ts";

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
