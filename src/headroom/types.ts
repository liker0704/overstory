export type HeadroomState = "exact" | "estimated" | "unavailable";

export interface HeadroomSnapshot {
	/** Runtime that reported this snapshot (e.g. "claude", "codex"). */
	runtime: string;
	/** Confidence level of this snapshot. */
	state: HeadroomState;
	/** ISO 8601 timestamp when this snapshot was captured. */
	capturedAt: string;
	/** Remaining requests in the current rate-limit window, or null if unknown. */
	requestsRemaining: number | null;
	/** Total requests allowed in the current window, or null if unknown. */
	requestsLimit: number | null;
	/** Remaining tokens in the current window, or null if unknown. */
	tokensRemaining: number | null;
	/** Total tokens allowed in the current window, or null if unknown. */
	tokensLimit: number | null;
	/** When the current rate-limit window resets (ISO 8601), or null if unknown. */
	windowResetsAt: string | null;
	/** Human-readable message (e.g. "75% of request quota remaining"). */
	message: string;
}

export interface HeadroomStore {
	/** Save a snapshot (upsert by runtime key). */
	upsert(snapshot: HeadroomSnapshot): void;
	/** Get the latest snapshot for a runtime, or null. */
	get(runtime: string): HeadroomSnapshot | null;
	/** Get all cached snapshots. */
	getAll(): HeadroomSnapshot[];
	/** Delete snapshots older than the given ISO timestamp. */
	pruneOlderThan(cutoff: string): number;
	/** Close the database connection. */
	close(): void;
}

export interface HeadroomConfig {
	/** Enable headroom polling. Default: true. */
	enabled?: boolean;
	/** Polling interval in milliseconds. Default: 60000 (1 minute). */
	pollIntervalMs?: number;
	/** Cache TTL in milliseconds. Default: 300000 (5 minutes). */
	cacheTtlMs?: number;
	/** Headroom percentage below which to warn. Default: 20. */
	warnThresholdPercent?: number;
	/** Headroom percentage below which to take action (throttle spawning). Default: 10. */
	criticalThresholdPercent?: number;
}
