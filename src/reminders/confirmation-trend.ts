import type { HealthRecommendation } from "../health/types.ts";
import {
	DEFAULT_REMINDER_CONFIG,
	type ReminderConfig,
	type ReminderPolicy,
	type TemporalSignals,
} from "./types.ts";

export const confirmationTrendPolicy: ReminderPolicy = {
	name: "reminder_confirmation_trend",

	evaluate(signals: TemporalSignals, config?: ReminderConfig): HealthRecommendation[] {
		if (!signals.mulchSignals) return [];

		const minSuccessRate =
			config?.confirmationTrendMinSuccessRate ??
			DEFAULT_REMINDER_CONFIG.confirmationTrendMinSuccessRate;
		const minFailures =
			config?.confirmationTrendMinFailures ?? DEFAULT_REMINDER_CONFIG.confirmationTrendMinFailures;

		const results: HealthRecommendation[] = [];

		for (const record of signals.mulchSignals.recordsWithOutcomes) {
			const failureCount = Math.round(record.outcomeCount * (1 - record.successRate));
			if (failureCount < minFailures) continue;
			if (record.successRate >= minSuccessRate) continue;

			const priority: HealthRecommendation["priority"] =
				record.successRate === 0 ? "high" : "medium";

			results.push({
				title: `Low confirmation rate for "${record.classification}" records in "${record.domain}"`,
				whyNow: `Records in "${record.domain}" (${record.classification}) have a ${(record.successRate * 100).toFixed(0)}% success rate across ${record.outcomeCount} outcomes.`,
				expectedImpact: "Reviewing and correcting poorly-confirmed records reduces agent errors.",
				action: `Review outcome history for "${record.domain}" ${record.classification} records with \`mulch query ${record.domain}\`.`,
				verificationStep:
					"After reviewing, update or archive low-confidence records to raise success rate.",
				priority,
				factor: "reminder_confirmation_trend",
				source: "temporal-reminders",
			});
		}

		return results;
	},
};
