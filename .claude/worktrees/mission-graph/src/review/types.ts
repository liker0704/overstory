/**
 * Types for the overstory review contour.
 *
 * Self-contained module — all review types live here, not in src/types.ts.
 */

// === Dimension Types ===

/** The six axes along which an artifact is scored. */
export type ReviewDimension =
	| "clarity"
	| "actionability"
	| "completeness"
	| "signal-to-noise"
	| "correctness-confidence"
	| "coordination-fit";

/** The kinds of artifacts that can be reviewed. */
export type ReviewSubjectType = "session" | "handoff" | "spec" | "mission";

// === Score ===

/**
 * A score for a single review dimension.
 */
export interface DimensionScore {
	/** The dimension being scored. */
	dimension: ReviewDimension;
	/** Score from 0 (worst) to 100 (best). */
	score: number;
	/** One-line explanation of why this score was assigned. */
	details: string;
}

// === Records ===

/**
 * A completed review record for a single artifact.
 */
export interface ReviewRecord {
	/** UUID identifying this review. */
	id: string;
	/** The type of artifact reviewed. */
	subjectType: ReviewSubjectType;
	/** The identifier of the artifact (e.g. agent name, task ID, spec path). */
	subjectId: string;
	/** ISO 8601 timestamp when the review was created. */
	timestamp: string;
	/** Per-dimension scores. */
	dimensions: DimensionScore[];
	/** Weighted overall score from 0 to 100. */
	overallScore: number;
	/** Free-form notes from the reviewer. */
	notes: string[];
	/** Always "deterministic" — no LLM required for scoring. */
	reviewerSource: "deterministic";
	/** Whether this review is considered stale (subject has changed since review). */
	stale: boolean;
	/** ISO 8601 timestamp when staleness was detected, or null if not stale. */
	staleSince: string | null;
	/** Human-readable reason for staleness, or null if not stale. */
	staleReason: string | null;
}

/**
 * Snapshot of file hashes used to detect staleness.
 */
export interface StalenessState {
	/** Map from file path to its SHA-256 hex digest at capture time. */
	fileHashes: Record<string, string>;
	/** ISO 8601 timestamp when hashes were captured. */
	capturedAt: string;
}

// === Summaries ===

/**
 * Aggregated review summary for a subject type.
 */
export interface ReviewSummary {
	/** The type of artifact summarized. */
	subjectType: ReviewSubjectType;
	/** Total number of artifacts reviewed. */
	totalReviewed: number;
	/** Average overall score across all reviewed artifacts. */
	averageScore: number;
	/** Number of reviews that are currently stale. */
	staleCount: number;
	/** Most recent reviews (ordered by timestamp descending). */
	recentReviews: ReviewRecord[];
}

// === Insert ===

/**
 * Input shape for creating a new ReviewRecord (id and timestamp are assigned by store).
 */
export interface InsertReviewRecord {
	/** The type of artifact being reviewed. */
	subjectType: ReviewSubjectType;
	/** The identifier of the artifact. */
	subjectId: string;
	/** Per-dimension scores. */
	dimensions: DimensionScore[];
	/** Weighted overall score from 0 to 100. */
	overallScore: number;
	/** Free-form notes from the reviewer. */
	notes: string[];
	/** Always "deterministic" — no LLM required for scoring. */
	reviewerSource: "deterministic";
}
