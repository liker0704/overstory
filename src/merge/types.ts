// === Merge Queue ===

export type ResolutionTier = "clean-merge" | "auto-resolve" | "ai-resolve" | "reimagine";

export interface MergeEntry {
	branchName: string;
	taskId: string;
	missionId?: string | null;
	/** Workstream this merge belongs to. When populated, the merge pipeline
	 * updates `workstream_status` on success — the SSOT for gate evaluators. */
	workstreamId?: string | null;
	agentName: string;
	filesModified: string[];
	enqueuedAt: string;
	status: "pending" | "merging" | "merged" | "conflict" | "failed" | "compat_failed";
	resolvedTier: ResolutionTier | null;
	compatReportPath?: string | null;
}

export interface MergeResult {
	entry: MergeEntry;
	success: boolean;
	tier: ResolutionTier;
	conflictFiles: string[];
	errorMessage: string | null;
	/** Warnings about files where auto-resolve was skipped to prevent content loss. */
	warnings: string[];
}

/** Parsed conflict pattern from a single mulch record. */
export interface ParsedConflictPattern {
	tier: ResolutionTier;
	success: boolean;
	files: string[];
	agent: string;
	branch: string;
}

/** Historical conflict data assembled from mulch search results. */
export interface ConflictHistory {
	/** Tiers to skip based on historical failure rates for these files. */
	skipTiers: ResolutionTier[];
	/** Descriptions of past successful resolutions for AI prompt enrichment. */
	pastResolutions: string[];
	/** Files predicted to conflict based on historical patterns. */
	predictedConflictFiles: string[];
}
