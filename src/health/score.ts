/**
 * Health score computation.
 *
 * Converts raw HealthSignals into a weighted HealthScore.
 *
 * Score model
 * -----------
 * Seven factors, each scored 0–100, combined via fixed weights that sum to 1.0.
 * The overall score is the weighted sum. A letter grade is derived from thresholds.
 *
 * Factor             Weight  Description
 * ────────────────── ──────  ──────────────────────────────────────────────────
 * completion_rate    0.20    % of recorded sessions that completed
 * stalled_rate       0.18    % of active sessions that are stalled (inverted)
 * zombie_count       0.13    Raw zombie count (penalised on a curve)
 * doctor_failures    0.18    Doctor check failure count (penalised per failure)
 * merge_quality      0.10    % of merges that resolved cleanly
 * runtime_stability  0.08    Runtime swap rate (inverted)
 * resilience         0.13    Circuit breaker and retry health
 *
 * Grade thresholds: A ≥ 85, B ≥ 70, C ≥ 55, D ≥ 40, F < 40.
 *
 * Design principles:
 * - Transparent: every factor has a documented formula.
 * - Stable:      no random components; same inputs → same output.
 * - Explainable: each factor carries a plain-language details string.
 * - Decomposable: callers can inspect individual factors to drive recommendations.
 */

import type { HealthFactor, HealthGrade, HealthScore, HealthSignals } from "./types.ts";

/** Factor weight definitions. Must sum to 1.0. */
const FACTOR_WEIGHTS = {
	completion_rate: 0.2,
	stalled_rate: 0.18,
	zombie_count: 0.13,
	doctor_failures: 0.18,
	merge_quality: 0.1,
	runtime_stability: 0.08,
	resilience: 0.13,
} as const satisfies Record<string, number>;

/** Grade thresholds (inclusive lower bound). */
const GRADE_THRESHOLDS: Array<{ min: number; grade: HealthGrade }> = [
	{ min: 85, grade: "A" },
	{ min: 70, grade: "B" },
	{ min: 55, grade: "C" },
	{ min: 40, grade: "D" },
	{ min: 0, grade: "F" },
];

/**
 * Clamp a value to the range [0, 100].
 */
function clamp100(value: number): number {
	return Math.max(0, Math.min(100, value));
}

/**
 * Derive a letter grade from a 0–100 score.
 */
function deriveGrade(overall: number): HealthGrade {
	for (const { min, grade } of GRADE_THRESHOLDS) {
		if (overall >= min) {
			return grade;
		}
	}
	return "F";
}

/**
 * Score the completion rate factor.
 * Perfect (1.0) = 100. Each percent below 100% loses 1 point, scaled.
 */
function scoreCompletionRate(signals: HealthSignals): HealthFactor {
	const { completionRate, completedSessionsRecorded, totalSessionsRecorded } = signals;
	const score = clamp100(Math.round(completionRate * 100));
	const details =
		totalSessionsRecorded === 0
			? "No sessions recorded — defaulting to 100"
			: `${completedSessionsRecorded}/${totalSessionsRecorded} sessions completed (${score}%)`;

	return {
		name: "completion_rate",
		label: "Completion Rate",
		score,
		weight: FACTOR_WEIGHTS.completion_rate,
		contribution: score * FACTOR_WEIGHTS.completion_rate,
		details,
	};
}

/**
 * Score the stalled rate factor.
 * 0% stalled = 100. Each percent stalled loses 2 points.
 */
function scoreStalledRate(signals: HealthSignals): HealthFactor {
	const { stalledRate, stalledSessions, totalActiveSessions } = signals;
	// 0% stalled → 100, 50% stalled → 0
	const score = clamp100(Math.round((1 - stalledRate * 2) * 100));
	const details =
		totalActiveSessions === 0
			? "No active sessions"
			: `${stalledSessions}/${totalActiveSessions} active sessions are stalled (${Math.round(stalledRate * 100)}%)`;

	return {
		name: "stalled_rate",
		label: "Stalled Rate",
		score,
		weight: FACTOR_WEIGHTS.stalled_rate,
		contribution: score * FACTOR_WEIGHTS.stalled_rate,
		details,
	};
}

/**
 * Score the zombie count factor.
 * 0 zombies = 100. Penalty curve: 1→70, 2→40, 3+→0.
 */
function scoreZombieCount(signals: HealthSignals): HealthFactor {
	const { zombieSessions } = signals;
	let score: number;
	if (zombieSessions === 0) {
		score = 100;
	} else if (zombieSessions === 1) {
		score = 70;
	} else if (zombieSessions === 2) {
		score = 40;
	} else {
		score = 0;
	}
	const details =
		zombieSessions === 0
			? "No zombie agents"
			: `${zombieSessions} zombie agent${zombieSessions > 1 ? "s" : ""} detected`;

	return {
		name: "zombie_count",
		label: "Zombie Agents",
		score,
		weight: FACTOR_WEIGHTS.zombie_count,
		contribution: score * FACTOR_WEIGHTS.zombie_count,
		details,
	};
}

/**
 * Score the doctor failures factor.
 * 0 failures = 100. Each failure costs 15 points; each warning costs 5 points.
 * Floor at 0.
 */
function scoreDoctorFailures(signals: HealthSignals): HealthFactor {
	const { doctorFailCount, doctorWarnCount } = signals;
	const score = clamp100(100 - doctorFailCount * 15 - doctorWarnCount * 5);
	let details: string;
	if (doctorFailCount === 0 && doctorWarnCount === 0) {
		details = "No doctor failures or warnings";
	} else {
		const parts: string[] = [];
		if (doctorFailCount > 0)
			parts.push(`${doctorFailCount} failure${doctorFailCount > 1 ? "s" : ""}`);
		if (doctorWarnCount > 0)
			parts.push(`${doctorWarnCount} warning${doctorWarnCount > 1 ? "s" : ""}`);
		details = `Doctor checks: ${parts.join(", ")}`;
	}

	return {
		name: "doctor_failures",
		label: "Doctor Failures",
		score,
		weight: FACTOR_WEIGHTS.doctor_failures,
		contribution: score * FACTOR_WEIGHTS.doctor_failures,
		details,
	};
}

/**
 * Score the merge quality factor.
 * 100% clean merges = 100. Scales linearly with success rate.
 */
function scoreMergeQuality(signals: HealthSignals): HealthFactor {
	const { mergeSuccessRate, mergeSuccessCount, mergeTotalCount } = signals;
	const score = clamp100(Math.round(mergeSuccessRate * 100));
	const details =
		mergeTotalCount === 0
			? "No merges recorded — defaulting to 100"
			: `${mergeSuccessCount}/${mergeTotalCount} merges resolved cleanly (${score}%)`;

	return {
		name: "merge_quality",
		label: "Merge Quality",
		score,
		weight: FACTOR_WEIGHTS.merge_quality,
		contribution: score * FACTOR_WEIGHTS.merge_quality,
		details,
	};
}

/**
 * Score the runtime stability factor.
 * No swaps = 100. Each swapped session out of total sessions costs points.
 * Swap rate ≥ 25% = 0.
 */
function scoreRuntimeStability(signals: HealthSignals): HealthFactor {
	const { runtimeSwapCount, totalSessionsRecorded } = signals;
	let score: number;
	let details: string;

	if (totalSessionsRecorded === 0 || runtimeSwapCount === 0) {
		score = 100;
		details =
			runtimeSwapCount === 0
				? "No runtime swaps recorded"
				: "No sessions recorded — defaulting to 100";
	} else {
		const swapRate = runtimeSwapCount / totalSessionsRecorded;
		// 0% swap → 100, 25% swap → 0 (linear scale)
		score = clamp100(Math.round((1 - swapRate / 0.25) * 100));
		details = `${runtimeSwapCount}/${totalSessionsRecorded} sessions required a runtime swap (${Math.round(swapRate * 100)}%)`;
	}

	return {
		name: "runtime_stability",
		label: "Runtime Stability",
		score,
		weight: FACTOR_WEIGHTS.runtime_stability,
		contribution: score * FACTOR_WEIGHTS.runtime_stability,
		details,
	};
}

/**
 * Score the resilience factor.
 * 100 base, -30 per open breaker, -10 per active retry. Floor at 0.
 */
function scoreResilience(signals: HealthSignals): HealthFactor {
	const { openBreakerCount, activeRetryCount } = signals;
	const score = clamp100(100 - openBreakerCount * 30 - activeRetryCount * 10);
	let details: string;
	if (openBreakerCount === 0 && activeRetryCount === 0) {
		details = "No resilience issues";
	} else {
		const parts: string[] = [];
		if (openBreakerCount > 0)
			parts.push(`${openBreakerCount} open breaker${openBreakerCount > 1 ? "s" : ""}`);
		if (activeRetryCount > 0)
			parts.push(`${activeRetryCount} active retr${activeRetryCount > 1 ? "ies" : "y"}`);
		details = parts.join(", ");
	}
	return {
		name: "resilience",
		label: "Resilience",
		score,
		weight: FACTOR_WEIGHTS.resilience,
		contribution: score * FACTOR_WEIGHTS.resilience,
		details,
	};
}

/** Rebalanced weights when architecture_quality is active. */
const WEIGHTS_WITH_ARCH = {
	completion_rate: 0.18,
	stalled_rate: 0.16,
	zombie_count: 0.11,
	doctor_failures: 0.16,
	merge_quality: 0.09,
	runtime_stability: 0.07,
	resilience: 0.11,
	architecture_quality: 0.12,
} as const;

/**
 * Score the architecture quality factor.
 * Only included when an active mission exists. Starting score = 100, deductions applied.
 */
function scoreArchitectureQuality(signals: HealthSignals): HealthFactor {
	let score = 100;
	const issues: string[] = [];

	if (!signals.architectureMdExists) {
		score -= 15;
		issues.push("no architecture.md");
	}
	if (!signals.testPlanExists) {
		score -= 15;
		issues.push("no test-plan");
	}
	if (signals.holdoutChecksFailed > 0) {
		const penalty = Math.min(30, signals.holdoutChecksFailed * 10);
		score -= penalty;
		issues.push(`${signals.holdoutChecksFailed} holdout checks failed`);
	}

	return {
		name: "architecture_quality",
		label: "Architecture Quality",
		score: clamp100(score),
		weight: WEIGHTS_WITH_ARCH.architecture_quality,
		contribution: clamp100(score) * WEIGHTS_WITH_ARCH.architecture_quality,
		details: issues.length === 0 ? "All architecture checks passing" : issues.join("; "),
	};
}

/**
 * Compute a HealthScore from collected signals.
 *
 * @param signals  Raw signals from collectSignals().
 * @returns        A HealthScore with overall score, grade, and factor breakdown.
 */
export function computeScore(signals: HealthSignals): HealthScore {
	const hasMission = signals.activeMissionCount > 0;
	const weights = hasMission ? WEIGHTS_WITH_ARCH : FACTOR_WEIGHTS;

	const factors: HealthFactor[] = [
		{
			...scoreCompletionRate(signals),
			weight: weights.completion_rate,
			contribution: scoreCompletionRate(signals).score * weights.completion_rate,
		},
		{
			...scoreStalledRate(signals),
			weight: weights.stalled_rate,
			contribution: scoreStalledRate(signals).score * weights.stalled_rate,
		},
		{
			...scoreZombieCount(signals),
			weight: weights.zombie_count,
			contribution: scoreZombieCount(signals).score * weights.zombie_count,
		},
		{
			...scoreDoctorFailures(signals),
			weight: weights.doctor_failures,
			contribution: scoreDoctorFailures(signals).score * weights.doctor_failures,
		},
		{
			...scoreMergeQuality(signals),
			weight: weights.merge_quality,
			contribution: scoreMergeQuality(signals).score * weights.merge_quality,
		},
		{
			...scoreRuntimeStability(signals),
			weight: weights.runtime_stability,
			contribution: scoreRuntimeStability(signals).score * weights.runtime_stability,
		},
		{
			...scoreResilience(signals),
			weight: weights.resilience,
			contribution: scoreResilience(signals).score * weights.resilience,
		},
		...(hasMission ? [scoreArchitectureQuality(signals)] : []),
	];

	const overall = clamp100(Math.round(factors.reduce((sum, f) => sum + f.contribution, 0)));
	const grade = deriveGrade(overall);

	return {
		overall,
		grade,
		factors,
		collectedAt: signals.collectedAt,
		signals,
	};
}
