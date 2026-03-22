/**
 * Health signal collection.
 *
 * Gathers raw operational data from:
 * - SessionStore  (current agent states)
 * - MetricsStore  (historical session metrics)
 * - DoctorChecks  (pre-run diagnostic results, optional)
 *
 * All store access is wrapped in try/catch — missing or corrupt
 * databases return safe zero-value defaults so the scorer can
 * still produce a result.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHeadroomStore } from "../headroom/store.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { createResilienceStore } from "../resilience/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { CollectSignalsParams, HealthSignals } from "./types.ts";

/**
 * Collect health signals from the .overstory/ directory.
 *
 * @param params.overstoryDir  Absolute path to the .overstory/ directory.
 * @param params.doctorChecks  Optional pre-run doctor check results.
 *                             Defaults to an empty array (no doctor data).
 */
export function collectSignals(params: CollectSignalsParams): HealthSignals {
	const { overstoryDir, doctorChecks = [] } = params;
	const collectedAt = new Date().toISOString();

	// --- Doctor diagnostics ---
	const doctorFailCount = doctorChecks.filter((c) => c.status === "fail").length;
	const doctorWarnCount = doctorChecks.filter((c) => c.status === "warn").length;

	// --- Session state (from SessionStore) ---
	let totalActiveSessions = 0;
	let stalledSessions = 0;
	let zombieSessions = 0;
	let bootingSessions = 0;
	let workingSessions = 0;
	let runtimeSwapCount = 0;

	const sessionsDb = join(overstoryDir, "sessions.db");
	if (existsSync(sessionsDb)) {
		try {
			const { store } = openSessionStore(overstoryDir);
			const allSessions = store.getAll();
			for (const session of allSessions) {
				if (session.state === "stalled") {
					stalledSessions++;
				} else if (session.state === "zombie") {
					zombieSessions++;
				} else if (session.state === "booting") {
					bootingSessions++;
				} else if (session.state === "working") {
					workingSessions++;
				}
				if (session.originalRuntime !== null) {
					runtimeSwapCount++;
				}
			}
			totalActiveSessions = store.getActive().length;
			store.close();
		} catch {
			// DB unavailable — leave session counts at 0
		}
	}

	// --- Historical metrics (from MetricsStore) ---
	let totalSessionsRecorded = 0;
	let completedSessionsRecorded = 0;
	let mergeSuccessCount = 0;
	let mergeTotalCount = 0;
	let averageDurationMs = 0;
	let costPerCompletedTask: number | null = null;

	const metricsDb = join(overstoryDir, "metrics.db");
	if (existsSync(metricsDb)) {
		try {
			const store = createMetricsStore(metricsDb);
			const allSessions = store.getRecentSessions(10_000);

			totalSessionsRecorded = allSessions.length;

			const completed = allSessions.filter((s) => s.completedAt !== null);
			completedSessionsRecorded = completed.length;

			averageDurationMs = Math.round(store.getAverageDuration());

			const withMerge = allSessions.filter((s) => s.mergeResult !== null);
			mergeTotalCount = withMerge.length;
			mergeSuccessCount = withMerge.filter(
				(s) => s.mergeResult === "clean-merge" || s.mergeResult === "auto-resolve",
			).length;

			// Average cost per completed task (only for sessions with recorded cost)
			const withCost = completed.filter(
				(s) => s.estimatedCostUsd !== null && s.estimatedCostUsd > 0,
			);
			if (withCost.length > 0) {
				const totalCost = withCost.reduce((sum, s) => sum + (s.estimatedCostUsd ?? 0), 0);
				costPerCompletedTask = totalCost / withCost.length;
			}

			store.close();
		} catch {
			// DB unavailable — leave metric counts at 0
		}
	}

	// --- Resilience state (from ResilienceStore) ---
	let openBreakerCount = 0;
	let activeRetryCount = 0;
	let recentRerouteCount = 0;

	const resilienceDb = join(overstoryDir, "resilience.db");
	if (existsSync(resilienceDb)) {
		try {
			const store = createResilienceStore(resilienceDb);
			const breakers = store.listOpenBreakers();
			openBreakerCount = breakers.filter((b) => b.state === "open").length;
			const retries = store.getPendingRetries(1000);
			activeRetryCount = retries.length;
			// Count reroutes from retry records with probe tasks in last hour
			// (approximation — exact reroute count would need dedicated tracking)
			recentRerouteCount = 0; // Safe default; will improve with reroute store
			store.close();
		} catch {
			// DB unavailable
		}
	}

	// --- Headroom / quota state (from HeadroomStore) ---
	let lowestHeadroomPercent: number | null = null;
	let criticalHeadroomCount = 0;

	const headroomDb = join(overstoryDir, "headroom.db");
	if (existsSync(headroomDb)) {
		try {
			const store = createHeadroomStore(headroomDb);
			const snapshots = store.getAll();
			const CRITICAL_THRESHOLD = 10; // matches HeadroomConfig default
			for (const snap of snapshots) {
				if (
					snap.requestsRemaining !== null &&
					snap.requestsLimit !== null &&
					snap.requestsLimit > 0
				) {
					const pct = (snap.requestsRemaining / snap.requestsLimit) * 100;
					if (lowestHeadroomPercent === null || pct < lowestHeadroomPercent) {
						lowestHeadroomPercent = pct;
					}
					if (pct < CRITICAL_THRESHOLD) {
						criticalHeadroomCount++;
					}
				}
			}
			store.close();
		} catch {
			// DB unavailable
		}
	}

	// --- Computed rates ---

	// No sessions recorded → assume healthy (no evidence of failure)
	const completionRate =
		totalSessionsRecorded > 0 ? completedSessionsRecorded / totalSessionsRecorded : 1.0;

	// No active sessions → stalled rate is 0
	const stalledRate = totalActiveSessions > 0 ? stalledSessions / totalActiveSessions : 0.0;

	// No merges recorded → assume healthy
	const mergeSuccessRate = mergeTotalCount > 0 ? mergeSuccessCount / mergeTotalCount : 1.0;

	return {
		totalActiveSessions,
		stalledSessions,
		zombieSessions,
		bootingSessions,
		workingSessions,
		runtimeSwapCount,
		totalSessionsRecorded,
		completedSessionsRecorded,
		mergeSuccessCount,
		mergeTotalCount,
		averageDurationMs,
		costPerCompletedTask,
		doctorFailCount,
		doctorWarnCount,
		completionRate,
		stalledRate,
		mergeSuccessRate,
		openBreakerCount,
		activeRetryCount,
		recentRerouteCount,
		lowestHeadroomPercent,
		criticalHeadroomCount,
		collectedAt,
	};
}
