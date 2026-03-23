import type { HealthRecommendation } from "../health/types.ts";
import {
	DEFAULT_REMINDER_CONFIG,
	type ReminderConfig,
	type ReminderPolicy,
	type TemporalSignals,
} from "./types.ts";

export const escalationResponseRatePolicy: ReminderPolicy = {
	name: "reminder_escalation_response_rate",

	evaluate(signals: TemporalSignals, config?: ReminderConfig): HealthRecommendation[] {
		const minRate =
			config?.escalationResponseMinRate ?? DEFAULT_REMINDER_CONFIG.escalationResponseMinRate;

		const escalations = signals.recentMessages.filter(
			(m) => m.type === "escalation" || m.type === "decision_gate",
		);

		if (escalations.length < 2) return [];

		const respondedIds = new Set(
			signals.recentMessages
				.filter((m) => m.type === "worker_done" || m.type === "result")
				.filter((m) => m.threadId !== null)
				.map((m) => m.threadId as string),
		);

		const responded = escalations.filter((e) => respondedIds.has(e.id)).length;
		const rate = responded / escalations.length;

		if (rate >= minRate) return [];

		return [
			{
				title: "Low escalation response rate",
				whyNow: `Only ${(rate * 100).toFixed(0)}% of escalations received a worker_done or result reply (${responded}/${escalations.length}).`,
				expectedImpact:
					"Improving response rate ensures agents receive the guidance they need to proceed.",
				action: "Check open escalations with `ov mail list` and reply to pending ones.",
				verificationStep:
					"After replying, verify response rate improves in the next evaluation window.",
				priority: "medium",
				factor: "reminder_escalation_response_rate",
				source: "temporal-reminders",
			},
		];
	},
};
