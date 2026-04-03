import type { HeadroomStore } from "./types.ts";

export interface HeadroomGuardResult {
	allowed: boolean;
	reason?: string;
}

export interface SpawnGuardPolicy {
	pauseThresholdPercent: number;
	blockSpawnsOnPause: boolean;
}

/** Capabilities that are never throttled (priority 0). */
const PERSISTENT_CAPABILITIES = new Set([
	"coordinator",
	"coordinator-mission",
	"coordinator-mission-assess",
	"coordinator-mission-direct",
	"coordinator-mission-planned",
	"mission-analyst",
	"execution-director",
	"monitor",
]);

/** Capabilities that are throttled last (priority 1). */
const LOW_PRIORITY_CAPABILITIES = new Set(["lead", "upstream-merge-lead"]);

/**
 * Returns the throttle priority for a capability.
 * 0 = never throttle, 1 = throttle last, 2 = throttle first.
 */
export function getSpawnThrottlePriority(capability: string): number {
	if (PERSISTENT_CAPABILITIES.has(capability)) return 0;
	if (LOW_PRIORITY_CAPABILITIES.has(capability)) return 1;
	return 2;
}

/**
 * Checks whether headroom allows a new agent spawn.
 * Returns allowed=true if the spawn should proceed, allowed=false with a reason if blocked.
 */
export function checkHeadroomForSpawn(
	store: HeadroomStore,
	capability: string,
	runtimeName: string,
	policy: SpawnGuardPolicy,
): HeadroomGuardResult {
	// If blocking is disabled, always allow.
	if (!policy.blockSpawnsOnPause) {
		return { allowed: true };
	}

	// Persistent capabilities are never blocked.
	if (getSpawnThrottlePriority(capability) === 0) {
		return { allowed: true };
	}

	const snapshot = store.get(runtimeName);

	// No snapshot or unavailable state → no data to block on.
	if (snapshot === null || snapshot.state === "unavailable") {
		return { allowed: true };
	}

	// Missing or zero limit → no meaningful data to block on.
	if (
		snapshot.requestsRemaining === null ||
		snapshot.requestsLimit === null ||
		snapshot.requestsLimit === 0
	) {
		return { allowed: true };
	}

	const headroomPercent = (snapshot.requestsRemaining / snapshot.requestsLimit) * 100;

	if (headroomPercent < policy.pauseThresholdPercent) {
		return {
			allowed: false,
			reason:
				`Headroom critically low for runtime "${runtimeName}": ` +
				`${headroomPercent.toFixed(1)}% remaining (threshold: ${policy.pauseThresholdPercent}%). ` +
				`Spawning blocked for non-persistent agents.`,
		};
	}

	return { allowed: true };
}
