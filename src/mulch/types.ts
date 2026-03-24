// === Mulch CLI Results ===

/** Mulch status result (domain statistics). */
export interface MulchStatus {
	domains: Array<{ name: string; recordCount: number; lastUpdated: string }>;
}

/** Result from mulch diff command. */
export interface MulchDiffResult {
	success: boolean;
	command: string;
	since: string;
	domains: string[];
	message: string;
}

/** Result from mulch learn command. */
export interface MulchLearnResult {
	success: boolean;
	command: string;
	changedFiles: string[];
	suggestedDomains: string[];
	unmatchedFiles: string[];
}

/** Result from mulch prune command. */
export interface MulchPruneResult {
	success: boolean;
	command: string;
	dryRun: boolean;
	totalPruned: number;
	results: Array<{
		domain: string;
		pruned: number;
		records: string[];
	}>;
}

/** Health check result from mulch doctor. */
export interface MulchDoctorResult {
	success: boolean;
	command: string;
	checks: Array<{
		name: string;
		status: "pass" | "warn" | "fail";
		message: string;
		fixable: boolean;
		details: string[];
	}>;
	summary: {
		pass: number;
		warn: number;
		fail: number;
	};
}

/** Ready records result from mulch ready. */
export interface MulchReadyResult {
	success: boolean;
	command: string;
	count: number;
	entries: Array<{
		domain: string;
		id: string;
		type: string;
		recorded_at: string;
		summary: string;
		record: Record<string, unknown>;
	}>;
}

/** Result from mulch compact command. */
export interface MulchCompactResult {
	success: boolean;
	command: string;
	action: string;
	candidates?: Array<{
		domain: string;
		type: string;
		records: Array<{
			id: string;
			summary: string;
			recorded_at: string;
		}>;
	}>;
	compacted?: Array<{
		domain: string;
		type: string;
		before: number;
		after: number;
		recordIds: string[];
	}>;
	message?: string;
}

// === Semantic Search Types ===

/** Embedding provider backend. */
export type EmbeddingProvider = "sentence-transformers" | "openai" | "ollama";

/** Options for semantic search. */
export interface SemanticSearchOptions {
	domain?: string;
	topK?: number;
	hybrid?: boolean;
}

/** A single semantic search result with scores. */
export interface SemanticSearchResult {
	record: Record<string, unknown>;
	semanticScore: number;
	bm25Score?: number;
	combinedScore?: number;
}

/** Status of embedding coverage. */
export interface EmbedStatus {
	totalRecords: number;
	embeddedRecords: number;
	staleRecords: number;
	domains: Array<{
		name: string;
		total: number;
		embedded: number;
		stale: number;
	}>;
}
