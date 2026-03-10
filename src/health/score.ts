/**
 * Health score computation from collected signals.
 *
 * NOTE: This is a stub file created by health-cli-builder to satisfy TypeScript
 * during parallel development. The authoritative implementation lives in
 * health-core-builder's worktree and will supersede this at merge time.
 */

import type { HealthScore, HealthSignal, HealthSnapshot, SnapshotComparison } from "./types.ts";

/**
 * Compute an overall health score from a set of signals.
 * Returns a score with grade A–F based on weighted signal sub-scores.
 */
export function computeScore(signals: HealthSignal[]): HealthScore {
	const now = new Date().toISOString();

	if (signals.length === 0) {
		return {
			overall: 100,
			grade: "A",
			signals: [],
			snapshot: { overall: 100, signalValues: {}, collectedAt: now },
			collectedAt: now,
		};
	}

	// Stub: real computation in health-core-builder
	const overall = 100;
	return {
		overall,
		grade: "A",
		signals,
		snapshot: {
			overall,
			signalValues: Object.fromEntries(signals.map((s) => [s.name, s.value])),
			collectedAt: now,
		},
		collectedAt: now,
	};
}

/**
 * Compare the current snapshot against a previous baseline.
 * Returns deltas for overall score and individual signals.
 */
export function compareSnapshots(
	current: HealthSnapshot,
	previous: HealthSnapshot,
): SnapshotComparison {
	const overallDelta = current.overall - previous.overall;
	const degraded: Array<{ signal: string; delta: number }> = [];
	const improved: Array<{ signal: string; delta: number }> = [];

	for (const [name, currentVal] of Object.entries(current.signalValues)) {
		const prevVal = previous.signalValues[name];
		if (prevVal === undefined) continue;
		const delta = currentVal - prevVal;
		if (delta < 0) degraded.push({ signal: name, delta });
		else if (delta > 0) improved.push({ signal: name, delta });
	}

	return { overallDelta, degraded, improved };
}
