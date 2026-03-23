import type { HealthRecommendation } from "../health/types.ts";
import {
	DEFAULT_REMINDER_CONFIG,
	type ReminderConfig,
	type ReminderPolicy,
	type TemporalSignals,
} from "./types.ts";

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function normalizeKey(event: { data: string | null; toolName: string | null }): string {
	const raw = event.data ?? event.toolName ?? "";
	return raw
		.toLowerCase()
		.replace(UUID_PATTERN, "")
		.replace(/^[^:]*:/, "")
		.trim();
}

export const errorRecurrencePolicy: ReminderPolicy = {
	name: "reminder_error_recurrence",

	evaluate(signals: TemporalSignals, config?: ReminderConfig): HealthRecommendation[] {
		const minCount =
			config?.errorRecurrenceMinCount ?? DEFAULT_REMINDER_CONFIG.errorRecurrenceMinCount;

		const groups = new Map<string, number>();
		for (const event of signals.recentEvents) {
			const key = normalizeKey(event);
			if (key) {
				groups.set(key, (groups.get(key) ?? 0) + 1);
			}
		}

		const results: HealthRecommendation[] = [];
		for (const [key, count] of groups) {
			if (count >= minCount) {
				results.push({
					title: "Recurring error pattern detected",
					whyNow: `Error "${key}" occurred ${count} times in the lookback window.`,
					expectedImpact: "Fixing recurring errors will reduce agent failures and retries.",
					action: `Search logs for this pattern: \`ov logs --level error | grep "${key.slice(0, 40)}"\``,
					verificationStep: "After the fix, verify the error does not reappear in the next window.",
					priority: "high",
					factor: "reminder_error_recurrence",
					source: "temporal-reminders",
				});
			}
		}

		return results;
	},
};
