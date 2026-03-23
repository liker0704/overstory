import { existsSync } from "node:fs";
import path from "node:path";
import { createEventStore } from "../events/store.ts";
import type { HealthRecommendation, HealthScore, RecommendationSource } from "../health/types.ts";
import { createMailStore } from "../mail/store.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { completionTrendPolicy } from "./completion-trend.ts";
import { errorRecurrencePolicy } from "./error-recurrence.ts";
import { escalationResponseRatePolicy } from "./escalation-response-rate.ts";
import { mergeConflictsPolicy } from "./merge-conflicts.ts";
import { collectTemporalSignals } from "./signals.ts";
import { staleEscalationsPolicy } from "./stale-escalations.ts";
import type { ReminderConfig, ReminderPolicy } from "./types.ts";

const ALL_POLICIES: ReminderPolicy[] = [
	completionTrendPolicy,
	mergeConflictsPolicy,
	errorRecurrencePolicy,
	staleEscalationsPolicy,
	escalationResponseRatePolicy,
];

export function createReminderSource(
	overstoryDir: string,
	config?: ReminderConfig,
): RecommendationSource {
	return {
		name: "temporal-reminders",
		collect(_score: HealthScore): HealthRecommendation[] {
			try {
				const metricsDb = path.join(overstoryDir, "metrics.db");
				const mailDb = path.join(overstoryDir, "mail.db");
				const eventsDb = path.join(overstoryDir, "events.db");

				if (!existsSync(metricsDb) || !existsSync(mailDb) || !existsSync(eventsDb)) {
					return [];
				}

				const metricsStore = createMetricsStore(metricsDb);
				const mailStore = createMailStore(mailDb);
				const eventStore = createEventStore(eventsDb);

				try {
					const signals = collectTemporalSignals({ metricsStore, mailStore, eventStore }, config);

					const results: HealthRecommendation[] = [];
					for (const policy of ALL_POLICIES) {
						const recs = policy.evaluate(signals, config);
						for (const rec of recs) {
							results.push(rec);
						}
					}
					return results;
				} finally {
					metricsStore.close();
					mailStore.close();
					eventStore.close();
				}
			} catch {
				return [];
			}
		},
	};
}
