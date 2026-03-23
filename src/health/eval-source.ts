/**
 * Eval-results RecommendationSource.
 *
 * Reads the most recent eval run summary from eval-runs/ and emits
 * recommendations when assertions fail, stall rate is high, runs time out,
 * or merge conflicts are detected.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { EvalResult } from "../eval/types.ts";
import type { HealthRecommendation, HealthScore, RecommendationSource } from "./types.ts";

/**
 * Create a RecommendationSource that reads the latest eval run summary.
 *
 * Returns an empty array if no eval runs exist or any error occurs.
 */
export function createEvalSource(overstoryDir: string): RecommendationSource {
	return {
		name: "eval-results",
		collect(_score: HealthScore): HealthRecommendation[] {
			try {
				const evalRunsDir = path.join(overstoryDir, "eval-runs");
				if (!existsSync(evalRunsDir)) return [];

				const entries = readdirSync(evalRunsDir).sort();
				if (entries.length === 0) return [];

				const lastEntry = entries[entries.length - 1];
				if (lastEntry === undefined) return [];

				const summaryPath = path.join(evalRunsDir, lastEntry, "summary.json");
				if (!existsSync(summaryPath)) return [];

				const evalResult = JSON.parse(readFileSync(summaryPath, "utf-8")) as EvalResult;
				const results: HealthRecommendation[] = [];

				// Rule 1: Failed assertions
				const failedAssertions = evalResult.assertions.filter((a) => !a.passed);
				if (failedAssertions.length > 0) {
					const kinds = failedAssertions.map((a) => a.assertion.kind).join(", ");
					results.push({
						title: "Fix eval assertion failures",
						whyNow: `${failedAssertions.length} assertion(s) failed in eval run ${evalResult.runId}: ${kinds}. Failing assertions indicate the swarm is not meeting quality targets.`,
						expectedImpact:
							"Passing all assertions restores confidence in swarm correctness and unlocks clean eval runs.",
						action: `Run \`ov eval show ${evalResult.runId}\` to review failed assertions and diagnose root causes.`,
						verificationStep: `Re-run \`ov eval run\` and confirm all assertions pass.`,
						priority: "high",
						factor: "eval_assertions",
						source: "eval-results",
						sourceArtifact: evalResult.runId,
					});
				}

				// Rule 2: High stall rate
				if (evalResult.metrics.stallRate > 0.2) {
					const pct = Math.round(evalResult.metrics.stallRate * 100);
					results.push({
						title: "Investigate eval stall rate",
						whyNow: `Eval run ${evalResult.runId} had a stall rate of ${pct}%, above the 20% threshold. High stall rates waste agent budget and slow eval runs.`,
						expectedImpact: "Reducing stall rate improves eval throughput and lowers cost per run.",
						action: `Run \`ov eval show ${evalResult.runId}\` and inspect stalled agents. Check watchdog thresholds and provider rate limits.`,
						verificationStep: "Re-run eval and confirm stall rate drops below 20%.",
						priority: "medium",
						factor: "eval_stall_rate",
						source: "eval-results",
						sourceArtifact: evalResult.runId,
					});
				}

				// Rule 3: Timed out
				if (evalResult.timedOut) {
					results.push({
						title: "Investigate eval timeout",
						whyNow: `Eval run ${evalResult.runId} timed out before completing. Timeouts prevent full assertion coverage and may mask regressions.`,
						expectedImpact:
							"Completing eval runs within timeout ensures full assertion coverage and reliable quality signals.",
						action: `Run \`ov eval show ${evalResult.runId}\` to identify slow agents. Consider increasing eval timeout or reducing scenario complexity.`,
						verificationStep: "Re-run eval and confirm it completes within the timeout.",
						priority: "high",
						factor: "eval_timeout",
						source: "eval-results",
						sourceArtifact: evalResult.runId,
					});
				}

				// Rule 4: Merge conflicts
				if (evalResult.metrics.mergeConflictCount > 0) {
					results.push({
						title: "Review file scope for eval conflicts",
						whyNow: `Eval run ${evalResult.runId} produced ${evalResult.metrics.mergeConflictCount} merge conflict(s). Conflicts in eval runs indicate overlapping file scopes.`,
						expectedImpact:
							"Eliminating file scope overlaps reduces merge conflicts and speeds the merge pipeline.",
						action:
							"Review agent file scopes in the eval scenario for overlap. Use `ov worktree list` to identify concurrent agents editing the same files.",
						verificationStep:
							"Re-run eval and confirm merge conflict count is 0. Check merge_quality factor in `ov health`.",
						priority: "medium",
						factor: "eval_merge_conflicts",
						source: "eval-results",
						sourceArtifact: evalResult.runId,
					});
				}

				return results;
			} catch {
				return [];
			}
		},
	};
}
