import { describe, expect, it } from "bun:test";
import type { EventStore, StoredEvent } from "../events/types.ts";
import type { MailStore } from "../mail/store.ts";
import type { MetricsStore } from "../metrics/store.ts";
import type { SessionMetrics } from "../metrics/types.ts";
import { collectTemporalSignals } from "./signals.ts";

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

function makeEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
	return {
		id: 1,
		runId: null,
		agentName: "agent-1",
		sessionId: null,
		eventType: "error",
		toolName: null,
		toolArgs: null,
		toolDurationMs: null,
		level: "error",
		data: "some error",
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

function makeMetricsStore(sessions: SessionMetrics[]): MetricsStore {
	return {
		recordSession: () => {},
		getRecentSessions: () => sessions,
		getSessionsByAgent: () => [],
		getSessionsByRun: () => [],
		getSessionsByTask: () => [],
		getAverageDuration: () => 0,
		countSessions: () => sessions.length,
		purge: () => 0,
		recordSnapshot: () => {},
		getLatestSnapshots: () => [],
		getLatestSnapshotTime: () => null,
		purgeSnapshots: () => 0,
		close: () => {},
	} as unknown as MetricsStore;
}

function makeMailStore(): MailStore {
	return {
		getAll: () => [],
	} as unknown as MailStore;
}

function makeEventStore(errors: StoredEvent[]): EventStore {
	return {
		getErrors: () => errors,
	} as unknown as EventStore;
}

describe("collectTemporalSignals", () => {
	it("returns empty signals when stores are empty", () => {
		const signals = collectTemporalSignals({
			metricsStore: makeMetricsStore([]),
			mailStore: makeMailStore(),
			eventStore: makeEventStore([]),
		});
		expect(signals.recentSessions).toHaveLength(0);
		expect(signals.recentMessages).toHaveLength(0);
		expect(signals.recentEvents).toHaveLength(0);
		expect(signals.collectedAt).toBeTruthy();
	});

	it("filters sessions outside the lookback window", () => {
		const old = makeSession({ startedAt: new Date(Date.now() - 48 * 3600000).toISOString() });
		const recent = makeSession({ startedAt: new Date().toISOString() });
		const signals = collectTemporalSignals(
			{
				metricsStore: makeMetricsStore([old, recent]),
				mailStore: makeMailStore(),
				eventStore: makeEventStore([]),
			},
			{ lookbackWindowMs: 86400000 },
		);
		expect(signals.recentSessions).toHaveLength(1);
		expect(signals.recentSessions[0]?.startedAt).toBe(recent.startedAt);
	});

	it("includes sessions within the lookback window", () => {
		const s1 = makeSession({ startedAt: new Date(Date.now() - 1000).toISOString() });
		const s2 = makeSession({ startedAt: new Date(Date.now() - 2000).toISOString() });
		const signals = collectTemporalSignals(
			{
				metricsStore: makeMetricsStore([s1, s2]),
				mailStore: makeMailStore(),
				eventStore: makeEventStore([]),
			},
			{ lookbackWindowMs: 86400000 },
		);
		expect(signals.recentSessions).toHaveLength(2);
	});

	it("filters events outside lookback window", () => {
		const old = makeEvent({ createdAt: new Date(Date.now() - 48 * 3600000).toISOString() });
		const recent = makeEvent({ createdAt: new Date().toISOString() });
		const signals = collectTemporalSignals(
			{
				metricsStore: makeMetricsStore([]),
				mailStore: makeMailStore(),
				eventStore: makeEventStore([old, recent]),
			},
			{ lookbackWindowMs: 86400000 },
		);
		expect(signals.recentEvents).toHaveLength(1);
	});
});
