/**
 * Maps capability to throttle priority number.
 * Lower number = higher priority (throttled last).
 *
 * Priority 0 (never throttle): coordinator, coordinator-mission[-assess|-direct|-planned], mission-analyst, execution-director, monitor
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

import { PERSISTENT_CAPABILITIES } from "../agents/capabilities.ts";
