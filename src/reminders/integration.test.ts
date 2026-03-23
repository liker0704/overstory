import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEventStore } from "../events/store.ts";
import type { EventStore } from "../events/types.ts";
import type { HealthSignals } from "../health/types.ts";
import type { MailStore } from "../mail/store.ts";
import { createMailStore } from "../mail/store.ts";
import type { MetricsStore } from "../metrics/store.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { completionTrendPolicy } from "./completion-trend.ts";
import { errorRecurrencePolicy } from "./error-recurrence.ts";
import { collectTemporalSignals } from "./signals.ts";
import type { ReminderConfig } from "./types.ts";

describe("reminders integration", () => {
	let tmpDir: string;
	let metricsStore: MetricsStore;
	let mailStore: MailStore;
	let eventStore: EventStore;

	beforeEach(() => {
		tmpDir = mkdtempSync(path.join(os.tmpdir(), "ov-reminder-integ-"));
		metricsStore = createMetricsStore(path.join(tmpDir, "metrics.db"));
		mailStore = createMailStore(path.join(tmpDir, "mail.db"));
		eventStore = createEventStore(path.join(tmpDir, "events.db"));
	});

	afterEach(() => {
		metricsStore.close();
		mailStore.close();
		eventStore.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("completion trend policy fires when recent sessions degrade", () => {
		const now = Date.now();
		// Earlier half: 4 sessions, all completed
		for (let i = 0; i < 4; i++) {
			metricsStore.recordSession({
				agentName: `builder-${i}`,
				taskId: `task-${i}`,
				capability: "builder",
				startedAt: new Date(now - 20000 + i * 1000).toISOString(),
				completedAt: new Date(now - 19000 + i * 1000).toISOString(),
				durationMs: 1000,
				exitCode: 0,
				mergeResult: null,
				parentAgent: null,
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				estimatedCostUsd: null,
				modelUsed: null,
				runId: null,
			});
		}
		// Recent half: 4 sessions, only 1 completed (75% failure = 0.75 degradation from 1.0)
		for (let i = 4; i < 8; i++) {
			metricsStore.recordSession({
				agentName: `builder-${i}`,
				taskId: `task-${i}`,
				capability: "builder",
				startedAt: new Date(now - 10000 + i * 1000).toISOString(),
				completedAt: i === 4 ? new Date(now - 9000 + i * 1000).toISOString() : null,
				durationMs: i === 4 ? 1000 : 0,
				exitCode: i === 4 ? 0 : null,
				mergeResult: null,
				parentAgent: null,
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				estimatedCostUsd: null,
				modelUsed: null,
				runId: null,
			});
		}

		const config: ReminderConfig = { lookbackWindowMs: 86400000 };
		const signals = collectTemporalSignals({ metricsStore, mailStore, eventStore }, config);

		expect(signals.recentSessions.length).toBe(8);

		const recs = completionTrendPolicy.evaluate(signals, config);
		expect(recs.length).toBeGreaterThanOrEqual(1);
		expect(recs[0]?.factor).toBe("reminder_completion_trend");
		expect(recs[0]?.source).toBe("temporal-reminders");
	});

	test("error recurrence policy fires on repeated errors", () => {
		// Insert 5 identical error events (above default minCount of 3)
		for (let i = 0; i < 5; i++) {
			eventStore.insert({
				runId: null,
				agentName: "builder-x",
				sessionId: null,
				eventType: "error",
				toolName: "Bash",
				toolArgs: null,
				toolDurationMs: null,
				level: "error",
				data: "connection refused: database timeout",
			});
		}

		const config: ReminderConfig = { lookbackWindowMs: 86400000 };
		const signals = collectTemporalSignals({ metricsStore, mailStore, eventStore }, config);

		expect(signals.recentEvents.length).toBe(5);

		const recs = errorRecurrencePolicy.evaluate(signals, config);
		expect(recs.length).toBeGreaterThanOrEqual(1);
		expect(recs[0]?.factor).toBe("reminder_error_recurrence");
	});

	test("no recommendations when data is healthy", () => {
		const now = Date.now();
		// 8 sessions, all completed
		for (let i = 0; i < 8; i++) {
			metricsStore.recordSession({
				agentName: `builder-${i}`,
				taskId: `task-${i}`,
				capability: "builder",
				startedAt: new Date(now - 20000 + i * 1000).toISOString(),
				completedAt: new Date(now - 19000 + i * 1000).toISOString(),
				durationMs: 1000,
				exitCode: 0,
				mergeResult: null,
				parentAgent: null,
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				estimatedCostUsd: null,
				modelUsed: null,
				runId: null,
			});
		}

		const config: ReminderConfig = { lookbackWindowMs: 86400000 };
		const signals = collectTemporalSignals({ metricsStore, mailStore, eventStore }, config);
		const trendRecs = completionTrendPolicy.evaluate(signals, config);
		const errorRecs = errorRecurrencePolicy.evaluate(signals, config);

		expect(trendRecs).toEqual([]);
		expect(errorRecs).toEqual([]);
	});

	test("config overrides change policy sensitivity", () => {
		const now = Date.now();
		// 4 earlier completed, 4 recent with 2 completed (50% vs 100% = 0.5 degradation)
		for (let i = 0; i < 4; i++) {
			metricsStore.recordSession({
				agentName: `builder-${i}`,
				taskId: `task-${i}`,
				capability: "builder",
				startedAt: new Date(now - 20000 + i * 1000).toISOString(),
				completedAt: new Date(now - 19000 + i * 1000).toISOString(),
				durationMs: 1000,
				exitCode: 0,
				mergeResult: null,
				parentAgent: null,
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				estimatedCostUsd: null,
				modelUsed: null,
				runId: null,
			});
		}
		for (let i = 4; i < 8; i++) {
			metricsStore.recordSession({
				agentName: `builder-${i}`,
				taskId: `task-${i}`,
				capability: "builder",
				startedAt: new Date(now - 10000 + i * 1000).toISOString(),
				completedAt: i < 6 ? new Date(now - 9000 + i * 1000).toISOString() : null,
				durationMs: i < 6 ? 1000 : 0,
				exitCode: i < 6 ? 0 : null,
				mergeResult: null,
				parentAgent: null,
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				estimatedCostUsd: null,
				modelUsed: null,
				runId: null,
			});
		}

		const signals = collectTemporalSignals(
			{ metricsStore, mailStore, eventStore },
			{ lookbackWindowMs: 86400000 },
		);

		// With high threshold (0.6), 0.5 degradation should NOT trigger
		const highThreshold = completionTrendPolicy.evaluate(signals, {
			completionTrendThreshold: 0.6,
		});
		expect(highThreshold).toEqual([]);

		// With low threshold (0.1), 0.5 degradation SHOULD trigger
		const lowThreshold = completionTrendPolicy.evaluate(signals, {
			completionTrendThreshold: 0.1,
		});
		expect(lowThreshold.length).toBeGreaterThanOrEqual(1);
	});

	test("createReminderSource produces recommendations from real stores", async () => {
		// This test validates the full source.ts pipeline with real file-based stores
		const { createReminderSource } = await import("./source.ts");
		const now = Date.now();

		// Populate with degraded data
		for (let i = 0; i < 4; i++) {
			metricsStore.recordSession({
				agentName: `builder-${i}`,
				taskId: `task-${i}`,
				capability: "builder",
				startedAt: new Date(now - 20000 + i * 1000).toISOString(),
				completedAt: new Date(now - 19000 + i * 1000).toISOString(),
				durationMs: 1000,
				exitCode: 0,
				mergeResult: null,
				parentAgent: null,
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				estimatedCostUsd: null,
				modelUsed: null,
				runId: null,
			});
		}
		for (let i = 4; i < 8; i++) {
			metricsStore.recordSession({
				agentName: `builder-${i}`,
				taskId: `task-${i}`,
				capability: "builder",
				startedAt: new Date(now - 10000 + i * 1000).toISOString(),
				completedAt: null,
				durationMs: 0,
				exitCode: null,
				mergeResult: null,
				parentAgent: null,
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				estimatedCostUsd: null,
				modelUsed: null,
				runId: null,
			});
		}

		// Close the in-test stores so createReminderSource can open its own
		metricsStore.close();
		mailStore.close();
		eventStore.close();

		const source = createReminderSource(tmpDir);
		const recs = source.collect({
			overall: 75,
			grade: "B" as const,
			factors: [],
			collectedAt: new Date().toISOString(),
			signals: {} as unknown as HealthSignals,
		});

		expect(recs.length).toBeGreaterThanOrEqual(1);

		// Re-open for afterEach cleanup
		metricsStore = createMetricsStore(path.join(tmpDir, "metrics.db"));
		mailStore = createMailStore(path.join(tmpDir, "mail.db"));
		eventStore = createEventStore(path.join(tmpDir, "events.db"));
	});
});
