import { computeHeadroomPercent } from "../headroom/throttle.ts";
import type { HeadroomStore } from "../headroom/types.ts";
import type { HealthScore } from "../health/types.ts";
import type { MergeQueue } from "../merge/queue.ts";
import type { SessionStore } from "../sessions/store.ts";
import type { ParallelismContext } from "./types.ts";

export interface CollectParallelismParams {
	sessionStore: SessionStore;
	healthScore: HealthScore;
	headroomStore: HeadroomStore;
	mergeQueue: MergeQueue;
	evaluationIntervalMs: number;
	readyTaskCount?: number | null;
	inProgressCount?: number | null;
}

/**
 * Collect current parallelism signals for adaptive scaling decisions.
 *
 * Each store access is wrapped in try/catch — a broken or missing store
 * returns a safe zero/null default so the caller can still act.
 */
export function collectParallelismContext(params: CollectParallelismParams): ParallelismContext {
	const { sessionStore, healthScore, headroomStore, mergeQueue, evaluationIntervalMs } = params;

	const collectedAt = new Date().toISOString();

	// --- Headroom percent (min across all valid runtimes) ---
	let headroomPercent: number | null = null;
	try {
		const snapshots = headroomStore.getAll();
		let minHeadroom: number | null = null;
		let mostRecentCapturedAt: number | null = null;

		for (const snap of snapshots) {
			if (snap.state === "unavailable") continue;
			const pct = computeHeadroomPercent(snap);
			if (pct === null) continue;

			const capturedMs = new Date(snap.capturedAt).getTime();
			if (mostRecentCapturedAt === null || capturedMs > mostRecentCapturedAt) {
				mostRecentCapturedAt = capturedMs;
			}
			if (minHeadroom === null || pct < minHeadroom) {
				minHeadroom = pct;
			}
		}

		if (mostRecentCapturedAt === null) {
			// No valid snapshots
			headroomPercent = null;
		} else if (Date.now() - mostRecentCapturedAt > 2 * evaluationIntervalMs) {
			// Stale data — don't trust it for scaling decisions
			headroomPercent = null;
		} else {
			headroomPercent = minHeadroom;
		}
	} catch {
		headroomPercent = null;
	}

	// --- Merge queue depth ---
	let mergeQueueDepth = 0;
	try {
		mergeQueueDepth = mergeQueue.list("pending").length;
	} catch {
		mergeQueueDepth = 0;
	}

	// --- Active / stalled / rate-limited workers ---
	let activeWorkers = 0;
	let stalledWorkers = 0;
	let rateLimitedAgents = 0;
	try {
		const active = sessionStore.getActive();
		activeWorkers = active.length;
		stalledWorkers = active.filter((s) => s.state === "stalled").length;
		rateLimitedAgents = active.filter(
			(s) => "rateLimitedSince" in s && s.rateLimitedSince !== null,
		).length;
	} catch {
		activeWorkers = 0;
		stalledWorkers = 0;
		rateLimitedAgents = 0;
	}

	return {
		healthScore: healthScore.overall,
		healthGrade: healthScore.grade,
		headroomPercent,
		mergeQueueDepth,
		activeWorkers,
		stalledWorkers,
		rateLimitedAgents,
		readyTaskCount: params.readyTaskCount ?? null,
		inProgressCount: params.inProgressCount ?? null,
		collectedAt,
	};
}
