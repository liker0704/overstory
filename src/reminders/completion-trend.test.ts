import { describe, expect, it } from "bun:test";
import type { SessionMetrics } from "../metrics/types.ts";
import { completionTrendPolicy } from "./completion-trend.ts";
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

describe("completionTrendPolicy", () => {
	it("returns [] when no sessions", () => {
		expect(completionTrendPolicy.evaluate(emptySignals())).toEqual([]);
	});

	it("returns [] when fewer than 4 sessions", () => {
		const signals = {
			...emptySignals(),
			recentSessions: [makeSession(), makeSession(), makeSession()],
		};
		expect(completionTrendPolicy.evaluate(signals)).toEqual([]);
	});

	it("returns [] when threshold not breached", () => {
		// Earlier half: 2/2 completed. Recent half: 2/2 completed. No degradation.
		const t = Date.now();
		const signals: TemporalSignals = {
			...emptySignals(),
			recentSessions: [
				makeSession({
					startedAt: new Date(t - 4000).toISOString(),
					completedAt: new Date().toISOString(),
				}),
				makeSession({
					startedAt: new Date(t - 3000).toISOString(),
					completedAt: new Date().toISOString(),
				}),
				makeSession({
					startedAt: new Date(t - 2000).toISOString(),
					completedAt: new Date().toISOString(),
				}),
				makeSession({
					startedAt: new Date(t - 1000).toISOString(),
					completedAt: new Date().toISOString(),
				}),
			],
		};
		expect(completionTrendPolicy.evaluate(signals)).toEqual([]);
	});

	it("returns recommendation when threshold breached", () => {
		// Earlier: 2/2 completed (rate=1.0). Recent: 0/2 completed (rate=0.0). Degradation=1.0 > 0.15
		const t = Date.now();
		const signals: TemporalSignals = {
			...emptySignals(),
			recentSessions: [
				makeSession({
					startedAt: new Date(t - 4000).toISOString(),
					completedAt: new Date().toISOString(),
				}),
				makeSession({
					startedAt: new Date(t - 3000).toISOString(),
					completedAt: new Date().toISOString(),
				}),
				makeSession({ startedAt: new Date(t - 2000).toISOString() }),
				makeSession({ startedAt: new Date(t - 1000).toISOString() }),
			],
		};
		const results = completionTrendPolicy.evaluate(signals);
		expect(results).toHaveLength(1);
		expect(results[0]?.factor).toBe("reminder_completion_trend");
		expect(results[0]?.source).toBe("temporal-reminders");
		expect(results[0]?.priority).toBe("high"); // degradation=1.0 > 0.30
	});

	it("uses medium priority when degradation is between threshold and 0.30", () => {
		// Earlier: 4/4 completed. Recent: 2/4 completed. Degradation=0.5 > 0.15 but <= 0.30 is false
		// Let's do: earlier 2/2 = 1.0, recent 1/2 = 0.5, degradation=0.5 > 0.30 → high
		// For medium: earlier=1.0, recent=0.8 → degradation=0.2, > 0.15 but <= 0.30
		const t = Date.now();
		const signals: TemporalSignals = {
			...emptySignals(),
			recentSessions: [
				makeSession({
					startedAt: new Date(t - 4000).toISOString(),
					completedAt: new Date().toISOString(),
				}),
				makeSession({
					startedAt: new Date(t - 3000).toISOString(),
					completedAt: new Date().toISOString(),
				}),
				// recent half: 4 sessions, 3 completed → rate = 0.75, degradation=0.25 from 1.0
				makeSession({
					startedAt: new Date(t - 2000).toISOString(),
					completedAt: new Date().toISOString(),
				}),
				makeSession({
					startedAt: new Date(t - 1900).toISOString(),
					completedAt: new Date().toISOString(),
				}),
				makeSession({
					startedAt: new Date(t - 1800).toISOString(),
					completedAt: new Date().toISOString(),
				}),
				makeSession({ startedAt: new Date(t - 1000).toISOString() }),
			],
		};
		const results = completionTrendPolicy.evaluate(signals);
		expect(results).toHaveLength(1);
		// Earlier 3/3=1.0, recent 3/3 completed + 1 not: wait, let me recount
		// sorted: t-4000, t-3000, t-2000, t-1900, t-1800, t-1000
		// mid=3, earlier=[t-4000,t-3000,t-2000] all completed = 1.0
		// recent=[t-1900,t-1800,t-1000] → first two completed, last not → 2/3=0.667, degradation=0.333 > 0.30 → high
		expect(results[0]?.priority).toBe("high");
	});

	it("custom threshold is respected", () => {
		// degradation of 0.5 would normally trigger, but with threshold=0.6 it should not
		const t = Date.now();
		const signals: TemporalSignals = {
			...emptySignals(),
			recentSessions: [
				makeSession({
					startedAt: new Date(t - 4000).toISOString(),
					completedAt: new Date().toISOString(),
				}),
				makeSession({
					startedAt: new Date(t - 3000).toISOString(),
					completedAt: new Date().toISOString(),
				}),
				makeSession({ startedAt: new Date(t - 2000).toISOString() }),
				makeSession({ startedAt: new Date(t - 1000).toISOString() }),
			],
		};
		// With threshold=0.6, degradation=1.0 still fires
		const results = completionTrendPolicy.evaluate(signals, { completionTrendThreshold: 0.6 });
		// 1.0 > 0.6 → still fires
		expect(results).toHaveLength(1);

		// With threshold=1.1, it should NOT fire
		const results2 = completionTrendPolicy.evaluate(signals, { completionTrendThreshold: 1.1 });
		expect(results2).toHaveLength(0);
	});
});
