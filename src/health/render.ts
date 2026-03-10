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
import type { HealthFactor, HealthRecommendation, HealthScore } from "./types.ts";

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

// === Factor row ===

function renderFactorRow(factor: HealthFactor): void {
	const bar = scoreBar(factor.score);
	const scorePart = scoreColor(factor.score)(`${String(Math.round(factor.score)).padStart(3)}/100`);
	const namePart = color.bold(factor.label);
	const descPart = muted(factor.details);
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
 *   [factor rows sorted worst-first]
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

	if (score.factors.length === 0) {
		w(`  ${muted("No factor data available — run some agents to populate metrics.")}\n`);
		w("\n");
		return;
	}

	// Factor breakdown, worst-first
	w(`  ${color.bold("Factor Breakdown")}  ${muted(`(${score.factors.length} factors)`)}\n`);
	w("\n");

	const sorted = [...score.factors].sort((a, b) => a.score - b.score);
	for (const factor of sorted) {
		renderFactorRow(factor);
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
 *   Factor:   ...
 *   Priority: ...
 *   Why now:  ...
 *   Impact:   ...
 *   Action:   ...
 *   Verify:   ...
 */
export function renderRecommendation(rec: HealthRecommendation, index: number): void {
	const w = process.stdout.write.bind(process.stdout);

	w(`  ${accent(`[${index}]`)} ${color.bold(rec.title)}\n`);
	w(`       ${muted("Factor:")}   ${rec.factor.replace(/_/g, " ")}\n`);
	w(`       ${muted("Priority:")} ${rec.priority}\n`);
	w(`       ${muted("Why now:")} ${rec.whyNow}\n`);
	w(`       ${muted("Impact:")}  ${color.green(rec.expectedImpact)}\n`);
	w(`       ${muted("Action:")}  ${rec.action}\n`);
	w(`       ${muted("Verify:")}  ${muted(rec.verificationStep)}\n`);
}
