import type { AgentIdentity } from "../agents/types.ts";

// === Run (Coordinator Session Grouping) ===

/** Status of a run (coordinator session grouping agents). */
export type RunStatus = "active" | "completed" | "failed" | "stopped";

/** A run groups all agents spawned from one coordinator session. */
export interface Run {
	id: string; // Format: run-{ISO timestamp}
	startedAt: string;
	completedAt: string | null;
	agentCount: number;
	coordinatorSessionId: string | null;
	coordinatorName: string | null; // which coordinator owns this run
	status: RunStatus;
}

/** Input for creating a new run. */
export type InsertRun = Omit<Run, "completedAt" | "agentCount" | "coordinatorName"> & {
	agentCount?: number;
	/** Which coordinator owns this run. Defaults to null when not provided. */
	coordinatorName?: string | null;
};

/** Interface for run management operations. */
export interface RunStore {
	/** Create a new run. */
	createRun(run: InsertRun): void;
	/** Get a run by ID, or null if not found. */
	getRun(id: string): Run | null;
	/** Get the most recently started active run. */
	getActiveRun(): Run | null;
	/** Get the most recently started active run for a specific coordinator. */
	getActiveRunForCoordinator(coordinatorName: string): Run | null;
	/** List runs, optionally limited. */
	listRuns(opts?: { limit?: number; status?: RunStatus }): Run[];
	/** Increment agent count for a run. */
	incrementAgentCount(runId: string): void;
	/** Complete a run (set status and completedAt). */
	completeRun(runId: string, status: "completed" | "failed" | "stopped"): void;
	/** Reactivate a stopped/failed run (set status back to 'active', clear completedAt). */
	reactivateRun(runId: string): void;
	/** Close the store (if standalone — in practice may share DB with SessionStore). */
	close(): void;
}

// === Session Lifecycle (Checkpoint / Handoff / Continuity) ===

/**
 * Snapshot of agent progress, saved before compaction or handoff.
 * Stored as JSON in .overstory/agents/{name}/checkpoint.json.
 */
export interface SessionCheckpoint {
	agentName: string;
	taskId: string;
	sessionId: string; // The AgentSession.id that created this checkpoint
	timestamp: string; // ISO
	progressSummary: string; // Human-readable summary of work done so far
	filesModified: string[]; // Paths modified since session start
	currentBranch: string;
	pendingWork: string; // What remains to be done
	mulchDomains: string[]; // Domains the agent has been working in
}

/**
 * Record of a session handoff — when one session ends and another picks up.
 */
export interface SessionHandoff {
	fromSessionId: string;
	toSessionId: string | null; // null until the new session starts
	checkpoint: SessionCheckpoint;
	reason: "compaction" | "crash" | "manual" | "timeout" | "rate_limit_swap";
	handoffAt: string; // ISO timestamp
}

/**
 * Three-layer model for agent persistence.
 * Session = ephemeral Claude runtime
 * Sandbox = git worktree (persists across sessions)
 * Identity = permanent agent record (persists across assignments)
 */
export interface AgentLayers {
	identity: AgentIdentity;
	sandbox: {
		worktreePath: string;
		branchName: string;
		taskId: string;
	};
	session: {
		id: string;
		pid: number | null;
		tmuxSession: string;
		startedAt: string;
		checkpoint: SessionCheckpoint | null;
	} | null; // null when sandbox exists but no active session
}

// === Session Insight Analysis ===

/** A single structured insight extracted from a completed session. */
export interface SessionInsight {
	/** Mulch record type for this insight. */
	type: "pattern" | "convention" | "failure";
	/** Mulch domain this insight belongs to. */
	domain: string;
	/** Human-readable description of the insight. */
	description: string;
	/** Tags for mulch record categorization. */
	tags: string[];
}

/** Aggregated tool usage profile for a session. */
export interface ToolProfile {
	topTools: Array<{ name: string; count: number; avgMs: number }>;
	totalToolCalls: number;
	errorCount: number;
}

/** File edit frequency profile for a session. */
export interface FileProfile {
	/** Files edited more than once, sorted by edit count descending. */
	hotFiles: Array<{ path: string; editCount: number }>;
	totalEdits: number;
}

/** Complete insight analysis result for a completed session. */
export interface InsightAnalysis {
	insights: SessionInsight[];
	toolProfile: ToolProfile;
	fileProfile: FileProfile;
}
