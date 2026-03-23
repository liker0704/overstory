import type { HealthRecommendation } from "../health/types.ts";
import {
	DEFAULT_REMINDER_CONFIG,
	type ReminderConfig,
	type ReminderPolicy,
	type TemporalSignals,
} from "./types.ts";

function completionRate(sessions: { completedAt: string | null }[]): number {
	if (sessions.length === 0) return 1;
	return sessions.filter((s) => s.completedAt !== null).length / sessions.length;
}

export const completionTrendPolicy: ReminderPolicy = {
	name: "reminder_completion_trend",

	evaluate(signals: TemporalSignals, config?: ReminderConfig): HealthRecommendation[] {
		const threshold =
			config?.completionTrendThreshold ?? DEFAULT_REMINDER_CONFIG.completionTrendThreshold;

		const sorted = [...signals.recentSessions].sort((a, b) =>
			a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0,
		);

		if (sorted.length < 4) return [];

		const mid = Math.floor(sorted.length / 2);
		const earlier = sorted.slice(0, mid);
		const recent = sorted.slice(mid);

		if (earlier.length < 2 || recent.length < 2) return [];

		const earlierRate = completionRate(earlier);
		const recentRate = completionRate(recent);
		const degradation = earlierRate - recentRate;

		if (degradation <= threshold) return [];

		const priority: HealthRecommendation["priority"] = degradation > 0.3 ? "high" : "medium";

		return [
			{
				title: "Completion rate is declining",
				whyNow: `Session completion rate dropped by ${(degradation * 100).toFixed(0)}% in the recent half of the lookback window compared to the earlier half.`,
				expectedImpact: "Identifying the root cause will reduce abandoned sessions.",
				action:
					"Run `ov errors` to check for recurring failures. Review recent agent logs with `ov logs --level error`.",
				verificationStep:
					"After addressing root cause, verify next window shows stable or improved completion rate.",
				priority,
				factor: "reminder_completion_trend",
				source: "temporal-reminders",
			},
		];
	},
};
