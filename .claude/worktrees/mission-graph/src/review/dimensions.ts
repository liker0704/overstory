/**
 * Review dimension definitions and scoring helpers.
 */

import type { DimensionScore, ReviewDimension } from "./types.ts";

// === Dimension Registry ===

interface DimensionMeta {
	key: ReviewDimension;
	label: string;
	description: string;
}

/** All six review dimensions with display metadata. */
export const REVIEW_DIMENSIONS: DimensionMeta[] = [
	{
		key: "clarity",
		label: "Clarity",
		description: "How clear and unambiguous is the artifact?",
	},
	{
		key: "actionability",
		label: "Actionability",
		description: "Can someone act on this without further clarification?",
	},
	{
		key: "completeness",
		label: "Completeness",
		description: "Are all expected sections/fields present?",
	},
	{
		key: "signal-to-noise",
		label: "Signal-to-Noise",
		description: "How much useful information vs filler?",
	},
	{
		key: "correctness-confidence",
		label: "Correctness Confidence",
		description: "How confident can we be in the accuracy?",
	},
	{
		key: "coordination-fit",
		label: "Coordination Fit",
		description: "Does this fit the swarm coordination model?",
	},
];

// === Scoring Helpers ===

/**
 * Score presence of items: how many of the expected items are present.
 *
 * @param present - Number of items present.
 * @param expected - Total number of expected items.
 * @returns Score 0–100. Returns 100 if expected is 0.
 */
export function scorePresence(present: number, expected: number): number {
	if (expected === 0) return 100;
	return Math.min(100, Math.max(0, Math.round((present / expected) * 100)));
}

/**
 * Score the quality of a text artifact based on heuristic signals.
 *
 * Scoring breakdown (max 100):
 * - length > 0:       20 pts
 * - length > 50:      10 pts
 * - list markers:     15 pts
 * - section headers:  15 pts
 * - multiple lines:   10 pts
 * - no excessive rep: 10 pts
 * - concrete refs:    20 pts
 *
 * @param text - The text to score.
 * @returns Score 0–100.
 */
export function scoreTextQuality(text: string): number {
	if (text.length === 0) return 0;

	let score = 0;

	// length > 0: 20 pts
	score += 20;

	// length > 50: 10 pts
	if (text.length > 50) score += 10;

	// list markers (-, *, numbered): 15 pts
	if (/^[\s]*[-*]|\d+\./m.test(text)) score += 15;

	// section headers (# or ##): 15 pts
	if (/^#{1,3}\s/m.test(text)) score += 15;

	// multiple lines: 10 pts
	if (/\n/.test(text)) score += 10;

	// no excessive repetition: 10 pts
	// Check if any word (4+ chars) appears more than 5 times
	const words = text.toLowerCase().match(/\b\w{4,}\b/g) ?? [];
	const freq: Record<string, number> = {};
	for (const w of words) {
		freq[w] = (freq[w] ?? 0) + 1;
	}
	const hasExcessiveRep = Object.values(freq).some((count) => count > 5);
	if (!hasExcessiveRep) score += 10;

	// concrete refs (file paths, commands): 20 pts
	if (/src\/|\.ts\b|\.json\b|`[^`]+`|\/[a-z]/.test(text)) score += 20;

	return Math.min(100, score);
}

/**
 * Compute the overall review score as the simple average of dimension scores.
 *
 * @param dimensions - Array of dimension scores.
 * @returns Average score rounded to nearest integer. Returns 0 for empty array.
 */
export function computeOverallScore(dimensions: DimensionScore[]): number {
	if (dimensions.length === 0) return 0;
	const sum = dimensions.reduce((acc, d) => acc + d.score, 0);
	return Math.round(sum / dimensions.length);
}
