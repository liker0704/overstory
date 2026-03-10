/**
 * Shared types for the health scoring and recommendation system.
 *
 * NOTE: This is a stub file created by health-cli-builder to satisfy TypeScript
 * during parallel development. The authoritative implementation lives in
 * health-core-builder's worktree and will supersede this at merge time.
 */

/** Category of improvement recommendation. */
export type RecommendationCategory =
	| "config-tuning"
	| "watchdog-tuning"
	| "merge-pipeline"
	| "coordinator-dispatch"
	| "runtime-routing"
	| "provider-auth"
	| "observability";

/** A single scored signal contributing to the health score. */
export interface HealthSignal {
	/** Short identifier for this signal (e.g. "completion_rate"). */
	name: string;
	/** Raw value (0.0–1.0 or higher for counts). */
	value: number;
	/** Weight of this signal in the overall score (0.0–1.0). */
	weight: number;
	/** Computed sub-score for this signal (0–100). */
	score: number;
	/** Origin subsystem for this signal. */
	source: string;
	/** Human-readable explanation of what this signal measures. */
	description: string;
}

/** Overall health score with grade and signal breakdown. */
export interface HealthScore {
	/** Overall score 0–100. */
	overall: number;
	/** Letter grade: A, B, C, D, or F. */
	grade: "A" | "B" | "C" | "D" | "F";
	/** Individual signal scores, sorted worst-first. */
	signals: HealthSignal[];
	/** Snapshot for historical comparison. */
	snapshot: HealthSnapshot;
	/** ISO 8601 timestamp when the score was computed. */
	collectedAt: string;
}

/** Compact snapshot suitable for persisting and comparing across runs. */
export interface HealthSnapshot {
	/** Overall score 0–100. */
	overall: number;
	/** Raw signal values keyed by signal name. */
	signalValues: Record<string, number>;
	/** ISO 8601 timestamp. */
	collectedAt: string;
}

/** Comparison of current snapshot against a previous one. */
export interface SnapshotComparison {
	/** Delta in overall score (positive = improvement). */
	overallDelta: number;
	/** Signals that got worse since the baseline. */
	degraded: Array<{ signal: string; delta: number }>;
	/** Signals that improved since the baseline. */
	improved: Array<{ signal: string; delta: number }>;
}

/** A prioritized improvement recommendation. */
export interface HealthRecommendation {
	/** Short title for the recommendation. */
	title: string;
	/** Category of the recommendation. */
	category: RecommendationCategory;
	/** Why this recommendation is relevant now. */
	whyNow: string;
	/** Expected improvement from acting on this. */
	expectedImpact: string;
	/** Concrete action to take. */
	action: string;
	/** How to verify the action worked. */
	verification: string;
	/** The driving signal name (optional). */
	signal?: string;
	/** Numeric priority (lower = higher priority). */
	priority: number;
}

/** Options for collecting health signals. */
export interface SignalCollectorOptions {
	/** Absolute path to the .overstory/ directory. */
	overstoryDir: string;
	/** Loaded overstory config. */
	config: import("../types.ts").OverstoryConfig;
	/** Optional run ID to scope signals to a specific run. */
	runId?: string;
}
