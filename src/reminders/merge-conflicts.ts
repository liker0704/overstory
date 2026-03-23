import type { HealthRecommendation } from "../health/types.ts";
import {
	DEFAULT_REMINDER_CONFIG,
	type ReminderConfig,
	type ReminderPolicy,
	type TemporalSignals,
} from "./types.ts";

function conflictRate(sessions: { mergeResult: string | null }[]): number {
	const withMerge = sessions.filter((s) => s.mergeResult !== null);
	if (withMerge.length === 0) return 0;
	const nonClean = withMerge.filter((s) => s.mergeResult !== "clean-merge");
	return nonClean.length / withMerge.length;
}

export const mergeConflictsPolicy: ReminderPolicy = {
	name: "reminder_merge_conflicts",

	evaluate(signals: TemporalSignals, config?: ReminderConfig): HealthRecommendation[] {
		const threshold =
			config?.mergeConflictThreshold ?? DEFAULT_REMINDER_CONFIG.mergeConflictThreshold;

		const sorted = [...signals.recentSessions].sort((a, b) =>
			a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0,
		);

		if (sorted.length < 2) return [];

		const mid = Math.floor(sorted.length / 2);
		const earlier = sorted.slice(0, mid);
		const recent = sorted.slice(mid);

		const earlierWithMerge = earlier.filter((s) => s.mergeResult !== null);
		const recentWithMerge = recent.filter((s) => s.mergeResult !== null);

		if (earlierWithMerge.length === 0 || recentWithMerge.length === 0) return [];

		const earlierConflictRate = conflictRate(earlier);
		const recentConflictRate = conflictRate(recent);
		const increase = recentConflictRate - earlierConflictRate;

		if (increase <= threshold) return [];

		return [
			{
				title: "Merge conflict rate is increasing",
				whyNow: `Merge conflict rate increased by ${(increase * 100).toFixed(0)}% in the recent half of the lookback window.`,
				expectedImpact:
					"Reducing conflicts will speed up delivery and reduce manual resolution work.",
				action:
					"Review overlapping file scopes across active tasks. Run `ov status` to check for agents working on the same files.",
				verificationStep:
					"After scoping adjustments, verify next merge window shows lower conflict rate.",
				priority: "medium",
				factor: "reminder_merge_conflicts",
				source: "temporal-reminders",
			},
		];
	},
};
