// === Event Store (Observability) ===

/** Event types for agent activity tracking. */
export type EventType =
	| "tool_start"
	| "tool_end"
	| "session_start"
	| "session_end"
	| "mail_sent"
	| "mail_received"
	| "spawn"
	| "error"
	| "custom"
	| "turn_start"
	| "turn_end"
	| "progress"
	| "result"
	| "mission"
	| "engine_gate_entered"
	| "engine_nudge_sent"
	| "engine_agent_respawned"
	| "engine_gate_advanced"
	| "engine_ws_status_updated"
	| "engine_mission_suspended";

/** Severity levels for events. */
export type EventLevel = "debug" | "info" | "warn" | "error";

/** All valid event level strings as a runtime array for CHECK constraint generation. */
export const EVENT_LEVELS: readonly EventLevel[] = ["debug", "info", "warn", "error"] as const;

/** An event as stored in the SQLite events table. */
export interface StoredEvent {
	id: number;
	runId: string | null;
	agentName: string;
	sessionId: string | null;
	eventType: EventType;
	toolName: string | null;
	toolArgs: string | null;
	toolDurationMs: number | null;
	level: EventLevel;
	data: string | null;
	createdAt: string;
}

/** Input for inserting a new event (id and createdAt are auto-generated). */
export type InsertEvent = Omit<StoredEvent, "id" | "createdAt">;

/** Options for filtering event queries. */
export interface EventQueryOptions {
	limit?: number;
	since?: string; // ISO timestamp
	until?: string; // ISO timestamp
	level?: EventLevel;
}

/** Tool usage statistics returned by getToolStats. */
export interface ToolStats {
	toolName: string;
	count: number;
	avgDurationMs: number;
	maxDurationMs: number;
}

/** Interface for the SQLite-backed event store. */
export interface EventStore {
	/** Insert a new event. Returns the auto-generated row ID. */
	insert(event: InsertEvent): number;
	/** Find the most recent unmatched tool_start for correlation. Returns start ID and duration. */
	correlateToolEnd(
		agentName: string,
		toolName: string,
	): { startId: number; durationMs: number } | null;
	/** Get events for a specific agent. */
	getByAgent(agentName: string, opts?: EventQueryOptions): StoredEvent[];
	/** Get events for a specific run. */
	getByRun(runId: string, opts?: EventQueryOptions): StoredEvent[];
	/** Get error-level events. */
	getErrors(opts?: EventQueryOptions): StoredEvent[];
	/** Get a timeline of events with required options. */
	getTimeline(opts: EventQueryOptions & { since: string }): StoredEvent[];
	/** Get aggregated tool usage statistics. */
	getToolStats(opts?: { agentName?: string; since?: string }): ToolStats[];
	/** Delete events matching criteria. Returns number of rows deleted. */
	purge(opts: { all?: boolean; olderThanMs?: number; agentName?: string }): number;
	/** Close the database connection. */
	close(): void;
}
