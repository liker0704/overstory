import type { EventStore } from "../events/types.ts";
import type { MailStore } from "../mail/store.ts";
import type { MetricsStore } from "../metrics/store.ts";
import { DEFAULT_REMINDER_CONFIG, type ReminderConfig, type TemporalSignals } from "./types.ts";

/**
 * Collect temporal signals from recent system activity.
 *
 * Bounded-approximation tradeoff: we fetch a hard cap (1000 sessions, 500 messages,
 * 500 events) and then filter by the lookback window. This is cheaper than a
 * time-range query on large tables but may miss data if volume exceeds the cap
 * within the lookback window. 24h windows at normal swarm throughput are well within
 * these limits.
 */
export function collectTemporalSignals(
	deps: {
		metricsStore: MetricsStore;
		mailStore: MailStore;
		eventStore: EventStore;
	},
	config?: ReminderConfig,
): TemporalSignals {
	const lookbackWindowMs = config?.lookbackWindowMs ?? DEFAULT_REMINDER_CONFIG.lookbackWindowMs;
	const collectedAt = new Date().toISOString();
	const windowStart = new Date(Date.now() - lookbackWindowMs).toISOString();

	const allSessions = deps.metricsStore.getRecentSessions(1000);
	const recentSessions = allSessions.filter((s) => s.startedAt >= windowStart);

	const allMessages = deps.mailStore.getAll({ limit: 500 });
	const recentMessages = allMessages.filter((m) => m.createdAt >= windowStart);

	const allErrors = deps.eventStore.getErrors({ limit: 500 });
	const recentEvents = allErrors.filter((e) => e.createdAt >= windowStart);

	return { recentSessions, recentMessages, recentEvents, collectedAt };
}
