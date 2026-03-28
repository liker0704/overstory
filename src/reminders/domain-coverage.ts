import type { HealthRecommendation } from "../health/types.ts";
import {
	DEFAULT_REMINDER_CONFIG,
	type ReminderConfig,
	type ReminderPolicy,
	type TemporalSignals,
} from "./types.ts";

export const domainCoveragePolicy: ReminderPolicy = {
	name: "reminder_domain_coverage",

	evaluate(signals: TemporalSignals, config?: ReminderConfig): HealthRecommendation[] {
		if (!signals.mulchSignals) return [];

		const lookbackWindowMs = config?.lookbackWindowMs ?? DEFAULT_REMINDER_CONFIG.lookbackWindowMs;
		const collectedAtMs = new Date(signals.collectedAt).getTime();

		const results: HealthRecommendation[] = [];

		for (const domain of signals.mulchSignals.domains) {
			const lastUpdatedMs = new Date(domain.lastUpdated).getTime();
			const ageMs = collectedAtMs - lastUpdatedMs;
			if (ageMs <= lookbackWindowMs) continue;

			const ageHours = (ageMs / 3600000).toFixed(1);

			results.push({
				title: `Domain "${domain.name}" expertise is stale`,
				whyNow: `Domain "${domain.name}" has not been updated in ${ageHours}h (${domain.recordCount} records).`,
				expectedImpact: "Reviewing stale domains ensures agents have current expertise.",
				action: `Run \`mulch prime ${domain.name}\` to review and refresh domain expertise.`,
				verificationStep: `After review, update outdated records so domain lastUpdated advances.`,
				priority: "low",
				factor: "reminder_domain_coverage",
				source: "temporal-reminders",
			});
		}

		return results;
	},
};
