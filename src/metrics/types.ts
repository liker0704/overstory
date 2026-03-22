import type { ResolutionTier } from "../merge/types.ts";

// === Metrics ===

export interface SessionMetrics {
	agentName: string;
	taskId: string;
	capability: string;
	startedAt: string;
	completedAt: string | null;
	durationMs: number;
	exitCode: number | null;
	mergeResult: ResolutionTier | null;
	parentAgent: string | null;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	estimatedCostUsd: number | null;
	modelUsed: string | null;
	runId: string | null;
}

/** A point-in-time token usage snapshot for a running agent session. */
export interface TokenSnapshot {
	agentName: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	estimatedCostUsd: number | null;
	modelUsed: string | null;
	createdAt: string;
	runId: string | null;
}
