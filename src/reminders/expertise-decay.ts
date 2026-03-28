import type { HealthRecommendation } from "../health/types.ts";
import {
	DEFAULT_REMINDER_CONFIG,
	type ReminderConfig,
	type ReminderPolicy,
	type TemporalSignals,
} from "./types.ts";

export const expertiseDecayPolicy: ReminderPolicy = {
	name: "reminder_expertise_decay",

	evaluate(signals: TemporalSignals, config?: ReminderConfig): HealthRecommendation[] {
		if (!signals.mulchSignals) return [];

		const threshold =
			config?.expertiseDecayThreshold ?? DEFAULT_REMINDER_CONFIG.expertiseDecayThreshold;

		const results: HealthRecommendation[] = [];

		for (const entry of signals.mulchSignals.staleCounts) {
			if (entry.before === 0) continue;
			const ratio = entry.pruned / entry.before;
			if (ratio <= threshold) continue;

			const priority: HealthRecommendation["priority"] = ratio > 0.5 ? "high" : "medium";

			results.push({
				title: `Expertise decay detected in domain "${entry.domain}"`,
				whyNow: `${(ratio * 100).toFixed(0)}% of records in "${entry.domain}" are stale (${entry.pruned} of ${entry.before}).`,
				expectedImpact: "Pruning stale records improves signal quality for future agents.",
				action: `Run \`mulch prune ${entry.domain}\` or \`mulch compact ${entry.domain}\` to remove stale records.`,
				verificationStep: `After pruning, verify with \`mulch prime ${entry.domain}\` that record count is reduced.`,
				priority,
				factor: "reminder_expertise_decay",
				source: "temporal-reminders",
			});
		}

		return results;
	},
};
