/**
 * Human-readable rendering for ov health and ov next-improvement output.
 *
 * Follows the visual conventions in src/logging/theme.ts and ecosystem.ts:
 * - brand.bold() for headers
 * - color.green/yellow/red for status
 * - muted() for secondary text
 * - thickSeparator() between sections
 */

import { accent, brand, color, muted } from "../logging/color.ts";
import { thickSeparator } from "../logging/theme.ts";
import type {
	HealthRecommendation,
	HealthScore,
	HealthSignal,
	RecommendationCategory,
	SnapshotComparison,
} from "./types.ts";

// === Grade coloring ===

function gradeColor(grade: HealthScore["grade"]): string {
	switch (grade) {
		case "A":
		case "B":
			return color.green(grade);
		case "C":
			return color.yellow(grade);
		case "D":
		case "F":
			return color.red(grade);
	}
}

function scoreColor(score: number): (s: string) => string {
	if (score >= 80) return color.green;
	if (score >= 60) return color.yellow;
	return color.red;
}

// === Score bar ===

const BAR_WIDTH = 16;

function scoreBar(score: number): string {
	const filled = Math.round((score / 100) * BAR_WIDTH);
	const empty = BAR_WIDTH - filled;
	const bar = "\u2588".repeat(filled) + "\u2591".repeat(empty);
	return scoreColor(score)(bar);
}

// === Category label ===

function categoryLabel(category: RecommendationCategory): string {
	const labels: Record<RecommendationCategory, string> = {
		"config-tuning": "Config Tuning",
		"watchdog-tuning": "Watchdog Tuning",
		"merge-pipeline": "Merge Pipeline",
		"coordinator-dispatch": "Coordinator/Dispatch",
		"runtime-routing": "Runtime Routing",
		"provider-auth": "Provider/Auth",
		observability: "Observability",
	};
	return labels[category] ?? category;
}

function categoryColor(category: RecommendationCategory): (s: string) => string {
	switch (category) {
		case "config-tuning":
		case "watchdog-tuning":
			return color.cyan;
		case "merge-pipeline":
			return color.magenta;
		case "coordinator-dispatch":
			return color.blue;
		case "runtime-routing":
			return color.yellow;
		case "provider-auth":
			return color.red;
		case "observability":
			return color.green;
		default:
			return color.white;
	}
}

// === Signal table ===

function renderSignalRow(signal: HealthSignal): void {
	const bar = scoreBar(signal.score);
	const scorePart = scoreColor(signal.score)(`${String(Math.round(signal.score)).padStart(3)}/100`);
	const namePart = color.bold(signal.name.replace(/_/g, " "));
	const descPart = muted(signal.description);
	process.stdout.write(`  ${bar} ${scorePart}  ${namePart}\n`);
	process.stdout.write(`                        ${descPart}\n`);
}

// === Public render functions ===

/**
 * Render the full health score with factor breakdown.
 *
 * Output format:
 *   Swarm Health
 *   ══════...
 *   Overall: 87/100  Grade: B
 *   [signal rows sorted worst-first]
 */
export function renderHealthScore(score: HealthScore): void {
	const w = process.stdout.write.bind(process.stdout);

	w(`${brand.bold("Swarm Health")}\n`);
	w(`${thickSeparator()}\n`);
	w("\n");

	// Overall line
	const overall = scoreColor(score.overall)(`${score.overall}/100`);
	const grade = gradeColor(score.grade);
	w(`  Overall: ${overall}  Grade: ${grade}\n`);
	w("\n");

	if (score.signals.length === 0) {
		w(`  ${muted("No signal data available — run some agents to populate metrics.")}\n`);
		w("\n");
		return;
	}

	// Signal breakdown, worst-first
	w(`  ${color.bold("Signal Breakdown")}  ${muted(`(${score.signals.length} signals)`)}\n`);
	w("\n");

	const sorted = [...score.signals].sort((a, b) => a.score - b.score);
	for (const signal of sorted) {
		renderSignalRow(signal);
		w("\n");
	}

	// Collected timestamp
	const ts = new Date(score.collectedAt).toLocaleTimeString();
	w(`  ${muted(`Collected at ${ts}`)}\n`);
}

/**
 * Render a single recommendation.
 *
 * Output format:
 *   [1] Title
 *   Category: ...
 *   Why now: ...
 *   Impact:  ...
 *   Action:  ...
 *   Verify:  ...
 */
export function renderRecommendation(rec: HealthRecommendation, index: number): void {
	const w = process.stdout.write.bind(process.stdout);
	const catFn = categoryColor(rec.category);
	const catLabel = categoryLabel(rec.category);

	w(`  ${accent(`[${index}]`)} ${color.bold(rec.title)}\n`);
	w(`       ${muted("Category:")} ${catFn(catLabel)}\n`);
	w(`       ${muted("Why now:")} ${rec.whyNow}\n`);
	w(`       ${muted("Impact:")}  ${color.green(rec.expectedImpact)}\n`);
	w(`       ${muted("Action:")}  ${rec.action}\n`);
	w(`       ${muted("Verify:")}  ${muted(rec.verification)}\n`);
}

/**
 * Render a snapshot comparison (current vs previous).
 *
 * Output format:
 *   Comparison vs previous snapshot
 *   Overall: +5 (improved) / -3 (degraded) / 0 (unchanged)
 *   Degraded: signal_name (-12)
 *   Improved: signal_name (+8)
 */
export function renderComparison(comparison: SnapshotComparison): void {
	const w = process.stdout.write.bind(process.stdout);

	w(`\n${brand.bold("Comparison vs Previous Snapshot")}\n`);
	w(`${thickSeparator()}\n`);
	w("\n");

	const delta = comparison.overallDelta;
	let deltaStr: string;
	if (delta > 0) {
		deltaStr = color.green(`+${delta} (improved)`);
	} else if (delta < 0) {
		deltaStr = color.red(`${delta} (degraded)`);
	} else {
		deltaStr = muted("0 (unchanged)");
	}
	w(`  Overall delta: ${deltaStr}\n`);
	w("\n");

	if (comparison.degraded.length > 0) {
		w(`  ${color.red("Degraded signals:")}\n`);
		for (const { signal, delta: d } of comparison.degraded) {
			w(`    ${color.red("↓")} ${signal.replace(/_/g, " ")} ${muted(`(${d.toFixed(2)})`)}\n`);
		}
		w("\n");
	}

	if (comparison.improved.length > 0) {
		w(`  ${color.green("Improved signals:")}\n`);
		for (const { signal, delta: d } of comparison.improved) {
			w(`    ${color.green("↑")} ${signal.replace(/_/g, " ")} ${muted(`(+${d.toFixed(2)})`)}\n`);
		}
		w("\n");
	}

	if (comparison.degraded.length === 0 && comparison.improved.length === 0) {
		w(`  ${muted("No signal changes since last snapshot.")}\n`);
		w("\n");
	}
}
