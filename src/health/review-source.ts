/**
 * Review-quality RecommendationSource.
 *
 * Reads review data from reviews.db and emits recommendations when
 * review coverage, score, staleness, or coordination quality falls below thresholds.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { createReviewStore } from "../review/store.ts";
import type { HealthRecommendation, HealthScore, RecommendationSource } from "./types.ts";

/**
 * Create a RecommendationSource that reads from reviews.db in the given overstory directory.
 *
 * Returns an empty array if reviews.db does not exist or any error occurs.
 */
export function createReviewSource(overstoryDir: string): RecommendationSource {
	return {
		name: "review-quality",
		collect(_score: HealthScore): HealthRecommendation[] {
			const dbPath = path.join(overstoryDir, "reviews.db");
			if (!existsSync(dbPath)) return [];

			const store = createReviewStore(dbPath);
			try {
				const results: HealthRecommendation[] = [];

				const sessionSummary = store.getSummary("session");
				const specSummary = store.getSummary("spec");
				const handoffSummary = store.getSummary("handoff");
				const missionSummary = store.getSummary("mission");

				// Rule 1: No reviews at all
				if (sessionSummary.totalReviewed === 0 && specSummary.totalReviewed === 0) {
					results.push({
						title: "Run initial quality reviews",
						whyNow:
							"No reviews have been run yet. Without baseline quality data, degraded agent output goes undetected.",
						expectedImpact:
							"Establish a quality baseline and surface early issues in session and spec quality.",
						action: "Run `ov review sessions` and `ov review specs` to generate initial reviews.",
						verificationStep: "Run `ov review sessions` and confirm review count > 0.",
						priority: "medium",
						factor: "review_coverage",
						source: "review-quality",
						sourceArtifact: "none",
					});
				}

				// Rule 2: Low session review score
				if (sessionSummary.totalReviewed > 0 && sessionSummary.averageScore < 60) {
					results.push({
						title: "Improve session quality",
						whyNow: `Session average review score is ${Math.round(sessionSummary.averageScore)}/100, below the 60-point threshold. Low session quality signals poor task execution.`,
						expectedImpact:
							"Higher-quality sessions improve task completion rates and reduce agent rework.",
						action:
							"Run `ov review sessions --verbose` to identify low-scoring sessions. Review agent specs and file scopes for clarity.",
						verificationStep:
							"Re-run `ov review sessions` after improvements and confirm average score ≥ 60.",
						priority: "high",
						factor: "review_session_quality",
						source: "review-quality",
						sourceArtifact: "session",
					});
				}

				// Rule 3: Low spec review score
				if (specSummary.totalReviewed > 0 && specSummary.averageScore < 60) {
					results.push({
						title: "Improve spec quality",
						whyNow: `Spec average review score is ${Math.round(specSummary.averageScore)}/100, below the 60-point threshold. Unclear specs cause agent confusion and wasted work.`,
						expectedImpact:
							"Better specs reduce rework, improve completion rates, and lower agent cost.",
						action:
							"Run `ov review specs --verbose` to identify low-scoring specs. Rewrite ambiguous objectives and tighten file scopes.",
						verificationStep:
							"Re-run `ov review specs` after improvements and confirm average score ≥ 60.",
						priority: "high",
						factor: "review_spec_quality",
						source: "review-quality",
						sourceArtifact: "spec",
					});
				}

				// Rule 4: High staleness (> 50% stale for any subject type with reviews)
				const allSummaries = [sessionSummary, specSummary, handoffSummary, missionSummary];
				let highestStaleRatio = 0;
				let highestStaleType: string = "session";
				for (const summary of allSummaries) {
					if (summary.totalReviewed === 0) continue;
					const ratio = summary.staleCount / summary.totalReviewed;
					if (ratio > highestStaleRatio) {
						highestStaleRatio = ratio;
						highestStaleType = summary.subjectType;
					}
				}
				if (highestStaleRatio > 0.5) {
					results.push({
						title: "Re-run stale reviews",
						whyNow: `More than 50% of ${highestStaleType} reviews are stale. Stale reviews no longer reflect current artifact state and may mask regressions.`,
						expectedImpact:
							"Fresh reviews surface current quality issues and ensure recommendations are actionable.",
						action: `Run \`ov review ${highestStaleType}s\` to refresh stale reviews.`,
						verificationStep:
							"Run `ov review stale` and confirm stale count has decreased significantly.",
						priority: "medium",
						factor: "review_staleness",
						source: "review-quality",
						sourceArtifact: highestStaleType,
					});
				}

				// Rule 5: Low coordination-fit (avg of coordination-fit dimension scores in session reviews < 50)
				const recentSessionReviews = sessionSummary.recentReviews;
				if (recentSessionReviews.length > 0) {
					let coordTotal = 0;
					let coordCount = 0;
					for (const review of recentSessionReviews) {
						for (const dim of review.dimensions) {
							if (dim.dimension === "coordination-fit") {
								coordTotal += dim.score;
								coordCount++;
							}
						}
					}
					if (coordCount > 0 && coordTotal / coordCount < 50) {
						results.push({
							title: "Improve coordination patterns",
							whyNow: `Average coordination-fit score across recent session reviews is ${Math.round(coordTotal / coordCount)}/100. Poor coordination increases merge conflicts and agent blocking.`,
							expectedImpact:
								"Better coordination reduces merge conflicts, agent blocking, and wasted parallel work.",
							action:
								"Review agent communication patterns with `ov review sessions --verbose`. Consider splitting overlapping file scopes.",
							verificationStep:
								"Re-run session reviews after coordination improvements and confirm coordination-fit score ≥ 50.",
							priority: "medium",
							factor: "review_coordination",
							source: "review-quality",
							sourceArtifact: "session",
						});
					}
				}

				return results;
			} finally {
				store.close();
			}
		},
	};
}
