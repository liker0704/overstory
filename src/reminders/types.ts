import type { StoredEvent } from "../events/types.ts";
import type { HealthRecommendation } from "../health/types.ts";
import type { MailMessage } from "../mail/types.ts";
import type { SessionMetrics } from "../metrics/types.ts";

/** Temporal signals collected from recent system activity. */
export interface TemporalSignals {
	recentSessions: SessionMetrics[];
	recentMessages: MailMessage[];
	recentEvents: StoredEvent[];
	/** ISO timestamp when signals were collected. */
	collectedAt: string;
}

/** Configuration for reminder policy evaluation. All fields are optional with defaults. */
export interface ReminderConfig {
	/** Lookback window in milliseconds. Default: 86400000 (24h). */
	lookbackWindowMs?: number;
	/** Completion rate degradation threshold (0.0–1.0). Default: 0.15. */
	completionTrendThreshold?: number;
	/** Conflict rate increase threshold (0.0–1.0). Default: 0.25. */
	mergeConflictThreshold?: number;
	/** Minimum error occurrences to trigger recurrence alert. Default: 3. */
	errorRecurrenceMinCount?: number;
	/** Max age in milliseconds before escalation is considered stale. Default: 14400000 (4h). */
	staleEscalationMaxAgeMs?: number;
	/** Minimum escalation response rate (0.0–1.0). Default: 0.5. */
	escalationResponseMinRate?: number;
}

/** Default values for all ReminderConfig fields. */
export const DEFAULT_REMINDER_CONFIG: Required<ReminderConfig> = {
	lookbackWindowMs: 86400000,
	completionTrendThreshold: 0.15,
	mergeConflictThreshold: 0.25,
	errorRecurrenceMinCount: 3,
	staleEscalationMaxAgeMs: 14400000,
	escalationResponseMinRate: 0.5,
};

/** A reminder policy evaluates temporal signals and produces health recommendations. */
export interface ReminderPolicy {
	name: string;
	evaluate(signals: TemporalSignals, config?: ReminderConfig): HealthRecommendation[];
}
