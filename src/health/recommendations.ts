/**
 * Recommendation engine for the health improvement loop.
 *
 * NOTE: This is a stub file created by health-cli-builder to satisfy TypeScript
 * during parallel development. The authoritative implementation lives in
 * health-core-builder's worktree and will supersede this at merge time.
 */

import type { OverstoryConfig } from "../types.ts";
import type { HealthRecommendation, HealthScore } from "./types.ts";

/**
 * Generate prioritized recommendations from the current health score.
 * Returns recommendations sorted by priority (ascending = highest priority first).
 * Returns an empty array when all signals are healthy.
 */
export function generateRecommendations(
	_score: HealthScore,
	_config: OverstoryConfig,
): HealthRecommendation[] {
	// Stub implementation — replaced by health-core-builder at merge time.
	return [];
}
