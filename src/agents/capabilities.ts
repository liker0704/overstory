/**
 * Single source of truth for persistent agent capabilities.
 *
 * Persistent agents run as long-lived interactive sessions (coordinator, monitor, etc.).
 * They are exempt from stale/zombie time-based detection and auto-completion on session-end.
 * Only tmux/pid liveness checks apply to them.
 *
 * Previously duplicated in 5 files with inconsistent entries.
 * All other files MUST import from here — do NOT duplicate.
 */

export const PERSISTENT_CAPABILITIES: ReadonlySet<string> = new Set([
	"coordinator",
	"coordinator-mission",
	"coordinator-mission-assess",
	"coordinator-mission-direct",
	"coordinator-mission-planned",
	"mission-analyst",
	"execution-director",
	"monitor",
	"plan-review-lead",
	"architecture-review-lead",
]);

/**
 * Check if a capability is persistent (long-running, exempt from
 * stale/zombie time-based detection and auto-completion).
 */
export function isPersistentCapability(capability: string): boolean {
	return PERSISTENT_CAPABILITIES.has(capability);
}
