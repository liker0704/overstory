import { describe, expect, it } from "bun:test";
import type { SessionMetrics } from "../metrics/types.ts";
import { mergeConflictsPolicy } from "./merge-conflicts.ts";
import type { TemporalSignals } from "./types.ts";

function makeSession(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
	return {
		agentName: "agent-1",
		taskId: "task-1",
		capability: "builder",
		startedAt: new Date().toISOString(),
		completedAt: null,
		durationMs: 1000,
		exitCode: null,
		mergeResult: null,
		parentAgent: null,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		estimatedCostUsd: null,
		modelUsed: null,
		runId: null,
		...overrides,
	};
}

function emptySignals(): TemporalSignals {
	return {
		recentSessions: [],
		recentMessages: [],
		recentEvents: [],
		collectedAt: new Date().toISOString(),
	};
}

describe("mergeConflictsPolicy", () => {
	it("returns [] when no sessions", () => {
		expect(mergeConflictsPolicy.evaluate(emptySignals())).toEqual([]);
	});

	it("returns [] when only one session", () => {
		const signals = {
			...emptySignals(),
			recentSessions: [makeSession({ mergeResult: "clean-merge" })],
		};
		expect(mergeConflictsPolicy.evaluate(signals)).toEqual([]);
	});

	it("returns [] when no merges in either half", () => {
		const t = Date.now();
		const signals: TemporalSignals = {
			...emptySignals(),
			recentSessions: [
				makeSession({ startedAt: new Date(t - 4000).toISOString(), mergeResult: null }),
				makeSession({ startedAt: new Date(t - 3000).toISOString(), mergeResult: null }),
				makeSession({ startedAt: new Date(t - 2000).toISOString(), mergeResult: null }),
				makeSession({ startedAt: new Date(t - 1000).toISOString(), mergeResult: null }),
			],
		};
		expect(mergeConflictsPolicy.evaluate(signals)).toEqual([]);
	});

	it("returns [] when threshold not breached", () => {
		// Earlier: 0/2 conflict = 0%, Recent: 0/2 conflict = 0%. No increase.
		const t = Date.now();
		const signals: TemporalSignals = {
			...emptySignals(),
			recentSessions: [
				makeSession({ startedAt: new Date(t - 4000).toISOString(), mergeResult: "clean-merge" }),
				makeSession({ startedAt: new Date(t - 3000).toISOString(), mergeResult: "clean-merge" }),
				makeSession({ startedAt: new Date(t - 2000).toISOString(), mergeResult: "clean-merge" }),
				makeSession({ startedAt: new Date(t - 1000).toISOString(), mergeResult: "clean-merge" }),
			],
		};
		expect(mergeConflictsPolicy.evaluate(signals)).toEqual([]);
	});

	it("returns recommendation when conflict rate increases above threshold", () => {
		// Earlier: 0 conflicts. Recent: 2/2 = 100% conflict. Increase=1.0 > 0.25
		const t = Date.now();
		const signals: TemporalSignals = {
			...emptySignals(),
			recentSessions: [
				makeSession({ startedAt: new Date(t - 4000).toISOString(), mergeResult: "clean-merge" }),
				makeSession({ startedAt: new Date(t - 3000).toISOString(), mergeResult: "clean-merge" }),
				makeSession({ startedAt: new Date(t - 2000).toISOString(), mergeResult: "auto-resolve" }),
				makeSession({ startedAt: new Date(t - 1000).toISOString(), mergeResult: "auto-resolve" }),
			],
		};
		const results = mergeConflictsPolicy.evaluate(signals);
		expect(results).toHaveLength(1);
		expect(results[0]?.factor).toBe("reminder_merge_conflicts");
		expect(results[0]?.priority).toBe("medium");
		expect(results[0]?.source).toBe("temporal-reminders");
	});

	it("excludes null mergeResult from rate calculation", () => {
		// Earlier half has null + conflict. Recent has null + clean.
		// Earlier: [null, "auto-resolve"] → with-merge=[auto-resolve], conflict=1/1=1.0
		// Recent: [null, "clean-merge"] → with-merge=[clean-merge], conflict=0/1=0
		// Increase = 0-1 = -1 → not fired
		const t = Date.now();
		const signals: TemporalSignals = {
			...emptySignals(),
			recentSessions: [
				makeSession({ startedAt: new Date(t - 4000).toISOString(), mergeResult: null }),
				makeSession({ startedAt: new Date(t - 3000).toISOString(), mergeResult: "auto-resolve" }),
				makeSession({ startedAt: new Date(t - 2000).toISOString(), mergeResult: null }),
				makeSession({ startedAt: new Date(t - 1000).toISOString(), mergeResult: "clean-merge" }),
			],
		};
		expect(mergeConflictsPolicy.evaluate(signals)).toEqual([]);
	});
});
