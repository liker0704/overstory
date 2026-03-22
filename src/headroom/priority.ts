/**
 * Maps capability to throttle priority number.
 * Lower number = higher priority (throttled last).
 *
 * Priority 0 (never throttle): coordinator, coordinator-mission, mission-analyst, execution-director, monitor
 * Priority 1 (throttle last): lead, upstream-merge-lead
 * Priority 2 (throttle first): builder, scout, merger, reviewer, any other
 */
export function getThrottlePriority(capability: string): number {
	if (PERSISTENT_CAPABILITIES.has(capability)) {
		return 0;
	}
	if (capability === "lead" || capability === "upstream-merge-lead") {
		return 1;
	}
	return 2;
}

/**
 * Capabilities that are persistent (long-running).
 * Reuse the same concept as src/watchdog/health.ts PERSISTENT_CAPABILITIES.
 * The set includes: coordinator, coordinator-mission, mission-analyst, execution-director, monitor
 */
export const PERSISTENT_CAPABILITIES: ReadonlySet<string> = new Set([
	"coordinator",
	"coordinator-mission",
	"mission-analyst",
	"execution-director",
	"monitor",
]);
