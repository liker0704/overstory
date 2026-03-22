import type { AgentSession } from "../agents/types.ts";
import { getThrottlePriority } from "./priority.ts";
import type { ThrottleAction, ThrottlePolicy } from "./throttle-types.ts";
import type { HeadroomSnapshot } from "./types.ts";

/**
 * Compute headroom percentage for a snapshot.
 * Prefers request-based headroom; falls back to token-based.
 * Returns null if no valid data is available.
 */
export function computeHeadroomPercent(snapshot: HeadroomSnapshot): number | null {
	if (
		snapshot.requestsRemaining !== null &&
		snapshot.requestsLimit !== null &&
		snapshot.requestsLimit > 0
	) {
		return (snapshot.requestsRemaining / snapshot.requestsLimit) * 100;
	}
	if (
		snapshot.tokensRemaining !== null &&
		snapshot.tokensLimit !== null &&
		snapshot.tokensLimit > 0
	) {
		return (snapshot.tokensRemaining / snapshot.tokensLimit) * 100;
	}
	return null;
}

/**
 * Pure function: evaluate throttle policy against current headroom snapshots.
 * Returns a list of throttle actions to apply.
 *
 * Rules:
 * - Skip snapshots with state === 'unavailable'
 * - Skip snapshots where headroom percent is null
 * - pct < pauseThresholdPercent: pause agents with priority >= 1 (never priority 0)
 * - pct < slowThresholdPercent (but >= pause): slow agents with priority === 2 only
 * - If snapshot.state is 'estimated', append ' (estimated)' to the reason
 */
export function evaluateThrottlePolicy(
	snapshots: HeadroomSnapshot[],
	sessions: AgentSession[],
	policy: ThrottlePolicy,
): ThrottleAction[] {
	const actions: ThrottleAction[] = [];

	for (const snapshot of snapshots) {
		if (snapshot.state === "unavailable") continue;

		const pct = computeHeadroomPercent(snapshot);
		if (pct === null) continue;

		const estimatedNote = snapshot.state === "estimated" ? " (estimated)" : "";

		if (pct < policy.pauseThresholdPercent) {
			const reason = `Headroom at ${Math.round(pct)}% for ${snapshot.runtime}, below pause threshold ${policy.pauseThresholdPercent}%${estimatedNote}`;
			for (const session of sessions) {
				const priority = getThrottlePriority(session.capability);
				if (priority >= 1) {
					actions.push({
						level: "pause",
						targetAgent: session.agentName,
						reason,
						runtime: snapshot.runtime,
					});
				}
			}
		} else if (pct < policy.slowThresholdPercent) {
			const reason = `Headroom at ${Math.round(pct)}% for ${snapshot.runtime}, below slow threshold ${policy.slowThresholdPercent}%${estimatedNote}`;
			for (const session of sessions) {
				const priority = getThrottlePriority(session.capability);
				if (priority === 2) {
					actions.push({
						level: "slow",
						targetAgent: session.agentName,
						reason,
						runtime: snapshot.runtime,
					});
				}
			}
		}
	}

	return actions;
}
