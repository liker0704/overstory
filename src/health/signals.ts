/**
 * Health signal collection from Overstory data stores.
 *
 * NOTE: This is a stub file created by health-cli-builder to satisfy TypeScript
 * during parallel development. The authoritative implementation lives in
 * health-core-builder's worktree and will supersede this at merge time.
 */

import type { HealthSignal, SignalCollectorOptions } from "./types.ts";

/**
 * Collect health signals from all available Overstory data sources.
 *
 * Sources: SessionStore, MetricsStore, EventStore, and DoctorChecks.
 * Returns an empty array if no data is available (fresh install).
 */
export function collectSignals(_opts: SignalCollectorOptions): HealthSignal[] {
	// Stub implementation — replaced by health-core-builder at merge time.
	return [];
}
