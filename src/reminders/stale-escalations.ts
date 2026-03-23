import type { HealthRecommendation } from "../health/types.ts";
import {
	DEFAULT_REMINDER_CONFIG,
	type ReminderConfig,
	type ReminderPolicy,
	type TemporalSignals,
} from "./types.ts";

const EIGHT_HOURS_MS = 28800000;

export const staleEscalationsPolicy: ReminderPolicy = {
	name: "reminder_stale_escalations",

	evaluate(signals: TemporalSignals, config?: ReminderConfig): HealthRecommendation[] {
		const maxAgeMs =
			config?.staleEscalationMaxAgeMs ?? DEFAULT_REMINDER_CONFIG.staleEscalationMaxAgeMs;
		const collectedAtMs = new Date(signals.collectedAt).getTime();

		const escalations = signals.recentMessages.filter(
			(m) => m.type === "escalation" || m.type === "decision_gate",
		);

		const repliedIds = new Set(
			signals.recentMessages.filter((m) => m.threadId !== null).map((m) => m.threadId as string),
		);

		const results: HealthRecommendation[] = [];

		for (const esc of escalations) {
			if (repliedIds.has(esc.id)) continue;

			const ageMs = collectedAtMs - new Date(esc.createdAt).getTime();
			if (ageMs <= maxAgeMs) continue;

			const priority: HealthRecommendation["priority"] =
				ageMs > EIGHT_HOURS_MS ? "critical" : "high";

			const ageHours = (ageMs / 3600000).toFixed(1);

			results.push({
				title: "Unanswered escalation is stale",
				whyNow: `Escalation from "${esc.from}" (subject: "${esc.subject}") has been waiting ${ageHours}h without a reply.`,
				expectedImpact: "Responding unblocks blocked agents and restores swarm throughput.",
				action: `Reply to the escalation: \`ov mail reply ${esc.id} --body "..."\``,
				verificationStep: "After replying, confirm the agent resumes work via `ov status`.",
				priority,
				factor: "reminder_stale_escalations",
				source: "temporal-reminders",
			});
		}

		return results;
	},
};
