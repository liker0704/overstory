/**
 * Health recommendation engine.
 *
 * Selects the single highest-priority improvement recommendation based on
 * the computed HealthScore. Rules are deterministic and require no LLM.
 *
 * Selection strategy
 * ------------------
 * Each factor has a rule that fires when the factor score falls below a
 * threshold. Rules are sorted by: priority descending, then by weighted
 * contribution ascending (most impactful low-scoring factor wins).
 *
 * If no factor breaches its threshold, selectRecommendation returns null
 * (the swarm is operating well and no specific improvement is urgent).
 */

import type { HealthFactor, HealthRecommendation, HealthScore } from "./types.ts";

/** Priority ordering for sorting. */
const PRIORITY_ORDER: Record<HealthRecommendation["priority"], number> = {
	critical: 4,
	high: 3,
	medium: 2,
	low: 1,
};

/**
 * A rule associates a factor name and score threshold with a recommendation factory.
 * The factory receives the matching factor so it can include specific numbers.
 */
interface RecommendationRule {
	factor: string;
	/** Rule fires when the factor score is below this threshold. */
	threshold: number;
	priority: HealthRecommendation["priority"];
	build: (factor: HealthFactor) => Omit<HealthRecommendation, "priority" | "factor">;
}

/** All recommendation rules, ordered loosely by severity. */
const RULES: RecommendationRule[] = [
	// --- zombie_count ---
	{
		factor: "zombie_count",
		threshold: 100,
		priority: "critical",
		build: (f) => ({
			title: "Clean up zombie agents",
			whyNow: `${f.details.replace("detected", "are consuming resources without doing work")}. Zombies block worktree slots and skew health metrics.`,
			expectedImpact:
				"Free worktree slots, eliminate false-positive stall signals, and recover accurate session counts.",
			action:
				"Run `ov clean --agent <name>` for each zombie, or `ov worktree clean --completed` to batch-remove finished worktrees.",
			verificationStep:
				"Run `ov status` and confirm zombie count is 0. Re-run `ov health` to verify score improvement.",
		}),
	},

	// --- doctor_failures (fail count ≥ 2 → critical) ---
	{
		factor: "doctor_failures",
		threshold: 55,
		priority: "critical",
		build: (f) => ({
			title: "Fix critical doctor check failures",
			whyNow: `${f.details}. Unresolved infrastructure failures will cause agent spawn failures and data loss.`,
			expectedImpact:
				"Restore reliable agent spawning, database access, and merge pipeline integrity.",
			action:
				"Run `ov doctor --fix` to auto-fix fixable issues, then `ov doctor` to review remaining failures manually.",
			verificationStep:
				"Run `ov doctor` and confirm all checks show status pass or warn. Re-run `ov health`.",
		}),
	},

	// --- doctor_failures (warn only) ---
	{
		factor: "doctor_failures",
		threshold: 85,
		priority: "medium",
		build: (f) => ({
			title: "Address doctor check warnings",
			whyNow: `${f.details}. Warnings indicate degraded conditions that may escalate to failures under load.`,
			expectedImpact: "Prevent warnings from becoming failures during a busy run.",
			action: "Run `ov doctor --verbose` to see all warnings, then address them one by one.",
			verificationStep:
				"Run `ov doctor` and confirm warning count has decreased. Re-run `ov health`.",
		}),
	},

	// --- stalled_rate ---
	{
		factor: "stalled_rate",
		threshold: 80,
		priority: "high",
		build: (f) => ({
			title: "Reduce stalled agent rate",
			whyNow: `${f.details}. Stalled agents hold worktrees and consume orchestrator attention without making progress.`,
			expectedImpact:
				"Faster task throughput, reduced watchdog noise, and lower overall session cost.",
			action:
				"Run `ov inspect <agent>` on each stalled agent to diagnose the cause. Common fixes: increase `watchdog.staleThresholdMs` if tasks legitimately take longer, or check for provider rate limits with `ov status`.",
			verificationStep:
				"Run `ov status` and confirm stalled count has dropped. Monitor `ov dashboard` for new stalls over the next run.",
		}),
	},

	// --- completion_rate ---
	{
		factor: "completion_rate",
		threshold: 75,
		priority: "high",
		build: (f) => ({
			title: "Investigate low task completion rate",
			whyNow: `${f.details}. Tasks that do not complete waste agent cost and leave work in a partially-done state.`,
			expectedImpact:
				"Higher task throughput, lower cost-per-outcome, and fewer orphaned branches.",
			action:
				"Run `ov errors` to see recent agent errors. Run `ov replay` to review failed session timelines. Check if specs are ambiguous or file scopes are too broad.",
			verificationStep:
				"Track completion rate over the next two runs using `ov health`. Target ≥ 80%.",
		}),
	},

	// --- merge_quality ---
	{
		factor: "merge_quality",
		threshold: 80,
		priority: "high",
		build: (f) => ({
			title: "Reduce merge conflicts",
			whyNow: `${f.details}. High conflict rates slow the merge pipeline and require expensive AI resolution or manual intervention.`,
			expectedImpact:
				"Faster merge throughput and lower reliance on AI-resolve and reimagine tiers.",
			action:
				"Review overlapping file scopes across concurrent agents. Use `ov worktree list` to identify agents editing the same files. Split large tasks into smaller, non-overlapping scopes.",
			verificationStep:
				"Run `ov merge --dry-run` before the next batch and confirm fewer predicted conflicts. Check merge_quality factor in `ov health`.",
		}),
	},

	// --- runtime_stability ---
	{
		factor: "runtime_stability",
		threshold: 70,
		priority: "medium",
		build: (f) => ({
			title: "Investigate frequent runtime swaps",
			whyNow: `${f.details}. Runtime swaps signal provider instability and can disrupt agent context continuity.`,
			expectedImpact:
				"More predictable agent behaviour and reduced session overhead from swap/resume cycles.",
			action:
				"Run `ov costs --by-capability` to see which capabilities are swapping most. Check provider status and consider adjusting `rateLimit.behavior` in config.yaml from 'swap' to 'wait' if rate limits are transient.",
			verificationStep:
				"Run `ov health` after the next run and confirm runtime_stability score has improved.",
		}),
	},

	// --- completion_rate (low-severity warning) ---
	{
		factor: "completion_rate",
		threshold: 90,
		priority: "low",
		build: (f) => ({
			title: "Monitor task completion trend",
			whyNow: `${f.details}. Completion rate is slightly below ideal — worth tracking before it degrades further.`,
			expectedImpact: "Early detection prevents a small dip from becoming a systemic problem.",
			action: "Run `ov errors --limit 5` to spot any recurring error patterns across agents.",
			verificationStep: "Compare completion rate in `ov health` across the next three runs.",
		}),
	},

	// --- resilience ---
	{
		factor: "resilience",
		threshold: 70,
		priority: "high",
		build: (f) => ({
			title: "Investigate open circuit breakers",
			whyNow: `${f.details}. Open breakers prevent task dispatch to affected capabilities.`,
			expectedImpact: "Restore full capability coverage and unblock pending tasks.",
			action:
				"Run `ov status` to see which breakers are open. Check provider health and error patterns. Consider adjusting `resilience.circuitBreaker.failureThreshold` in config.yaml if breakers are tripping too aggressively.",
			verificationStep:
				"Run `ov health` and confirm resilience score has improved. Check `ov status` for breaker state.",
		}),
	},
];

/**
 * Select the single highest-priority recommendation from a HealthScore.
 *
 * Returns null if all factors are healthy (no rule threshold is breached).
 *
 * @param score  A computed HealthScore from computeScore().
 */
export function selectRecommendation(score: HealthScore): HealthRecommendation | null {
	const factorMap = new Map<string, HealthFactor>(score.factors.map((f) => [f.name, f]));

	// Collect all fired rules with their associated factor and contribution
	const candidates: Array<{
		rule: RecommendationRule;
		factor: HealthFactor;
	}> = [];

	for (const rule of RULES) {
		const factor = factorMap.get(rule.factor);
		if (factor === undefined) continue;
		if (factor.score < rule.threshold) {
			candidates.push({ rule, factor });
		}
	}

	if (candidates.length === 0) {
		return null;
	}

	// Sort: priority descending, then weighted contribution ascending
	// (lower contribution = more impactful degradation to fix first)
	candidates.sort((a, b) => {
		const priorityDiff = PRIORITY_ORDER[b.rule.priority] - PRIORITY_ORDER[a.rule.priority];
		if (priorityDiff !== 0) return priorityDiff;
		return a.factor.contribution - b.factor.contribution;
	});

	const best = candidates[0];
	if (best === undefined) return null;

	const built = best.rule.build(best.factor);

	return {
		...built,
		priority: best.rule.priority,
		factor: best.rule.factor,
	};
}
