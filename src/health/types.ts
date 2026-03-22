/**
 * Types for the overstory health scoring and recommendation system.
 *
 * The health system converts raw telemetry (sessions, metrics, doctor checks)
 * into an operational score and a prioritized improvement recommendation.
 */

import type { DoctorCheck } from "../doctor/types.ts";

// === Signals ===

/**
 * Raw signals collected from overstory data stores.
 *
 * Gathered by collectSignals() from SessionStore, MetricsStore, and
 * optional pre-run doctor check results.
 */
export interface HealthSignals {
	// --- Current session state (from SessionStore) ---
	/** Agents currently in booting, working, or stalled state. */
	totalActiveSessions: number;
	/** Active agents in stalled state. */
	stalledSessions: number;
	/** Agents in zombie state (dead process, not yet cleaned up). */
	zombieSessions: number;
	/** Active agents in booting state. */
	bootingSessions: number;
	/** Active agents in working state. */
	workingSessions: number;
	/** Agents that have had their runtime swapped (originalRuntime !== null). */
	runtimeSwapCount: number;

	// --- Historical metrics (from MetricsStore) ---
	/** Total recorded sessions (all time). */
	totalSessionsRecorded: number;
	/** Sessions that completed (completedAt !== null). */
	completedSessionsRecorded: number;
	/** Merges that resolved via clean-merge or auto-resolve. */
	mergeSuccessCount: number;
	/** Total sessions with a non-null mergeResult. */
	mergeTotalCount: number;
	/** Average session duration in milliseconds (0 if no completed sessions). */
	averageDurationMs: number;
	/** Average cost per completed task in USD, or null if no cost data. */
	costPerCompletedTask: number | null;

	// --- Doctor diagnostics (passed in from caller) ---
	/** Number of doctor checks that returned status "fail". */
	doctorFailCount: number;
	/** Number of doctor checks that returned status "warn". */
	doctorWarnCount: number;

	// --- Computed rates ---
	/** Fraction of recorded sessions that completed (0.0–1.0). Default 1.0 if no data. */
	completionRate: number;
	/** Fraction of active sessions that are stalled (0.0–1.0). */
	stalledRate: number;
	/** Fraction of merges that succeeded cleanly (0.0–1.0). Default 1.0 if no merges. */
	mergeSuccessRate: number;

	// --- Resilience state ---
	/** Number of circuit breakers currently in open state. */
	openBreakerCount: number;
	/** Number of tasks currently being retried (outcome = 'pending'). */
	activeRetryCount: number;
	/** Number of reroutes in the last hour. */
	recentRerouteCount: number;

	/** ISO 8601 timestamp when signals were collected. */
	collectedAt: string;
}

// === Score ===

/**
 * A single weighted contributor to the overall health score.
 *
 * Each factor has an independent 0–100 score and a weight.
 * The overall score is the sum of (score × weight) across all factors.
 */
export interface HealthFactor {
	/** Machine-readable key (e.g. "completion_rate"). */
	name: string;
	/** Human-readable display label (e.g. "Completion Rate"). */
	label: string;
	/** Factor score from 0 (worst) to 100 (best). */
	score: number;
	/** Weight (0.0–1.0). All factor weights sum to 1.0. */
	weight: number;
	/** Weighted contribution: score × weight (before summing to overall). */
	contribution: number;
	/** One-line human-readable explanation of why this score was assigned. */
	details: string;
}

/** Letter grade derived from the overall health score. */
export type HealthGrade = "A" | "B" | "C" | "D" | "F";

/**
 * The overall operational health score with a factor breakdown.
 *
 * overall = sum(factor.contribution) for all factors.
 * grade is derived from the overall score.
 */
export interface HealthScore {
	/** Overall score from 0 (worst) to 100 (best). */
	overall: number;
	/** Letter grade: A ≥ 85, B ≥ 70, C ≥ 55, D ≥ 40, F < 40. */
	grade: HealthGrade;
	/** Individual factor scores with weights and explanations. */
	factors: HealthFactor[];
	/** ISO 8601 timestamp when the score was computed. */
	collectedAt: string;
	/** The raw signals used to compute this score. */
	signals: HealthSignals;
}

// === Recommendations ===

/**
 * A single prioritized improvement recommendation.
 *
 * Recommendations are rule-based and deterministic — no LLM required.
 * The recommendation engine selects the highest-priority action based
 * on which factor is most degraded.
 */
export interface HealthRecommendation {
	/** Short title (imperative, < 60 chars). */
	title: string;
	/** Why this improvement matters now (1–2 sentences). */
	whyNow: string;
	/** Expected operational impact if addressed. */
	expectedImpact: string;
	/** Concrete action to take (command, config change, or workflow step). */
	action: string;
	/** How to verify the improvement was effective. */
	verificationStep: string;
	/** Urgency level. */
	priority: "low" | "medium" | "high" | "critical";
	/** Key of the HealthFactor that triggered this recommendation. */
	factor: string;
}

// === Snapshot ===

/**
 * A timestamped health snapshot for historical comparison.
 *
 * Saved to .overstory/health/ for diff-on-demand comparisons.
 */
export interface HealthSnapshot {
	/** The computed score at snapshot time. */
	score: HealthScore;
	/** The top recommendation at snapshot time, or null if score is perfect. */
	recommendation: HealthRecommendation | null;
	/** ISO 8601 timestamp when this snapshot was saved. */
	savedAt: string;
}

// === Parameters ===

/** Parameters for collectSignals(). */
export interface CollectSignalsParams {
	/** Absolute path to the .overstory/ directory. */
	overstoryDir: string;
	/**
	 * Pre-run doctor check results.
	 * If omitted, doctor signals default to 0 failures and 0 warnings.
	 * Pass results from the doctor module to enable doctor-based factors.
	 */
	doctorChecks?: DoctorCheck[];
}
