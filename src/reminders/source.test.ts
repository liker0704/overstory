/**
 * Tests for createReminderSource.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEventStore } from "../events/store.ts";
import { computeScore } from "../health/score.ts";
import type { HealthSignals } from "../health/types.ts";
import { createMailStore } from "../mail/store.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { createReminderSource } from "./source.ts";

/** Build a HealthSignals object with all-healthy defaults. */
function healthySignals(overrides: Partial<HealthSignals> = {}): HealthSignals {
	return {
		totalActiveSessions: 4,
		stalledSessions: 0,
		zombieSessions: 0,
		bootingSessions: 0,
		workingSessions: 4,
		runtimeSwapCount: 0,
		totalSessionsRecorded: 10,
		completedSessionsRecorded: 10,
		mergeSuccessCount: 5,
		mergeTotalCount: 5,
		averageDurationMs: 60_000,
		costPerCompletedTask: 0.1,
		doctorFailCount: 0,
		doctorWarnCount: 0,
		completionRate: 1.0,
		stalledRate: 0.0,
		mergeSuccessRate: 1.0,
		openBreakerCount: 0,
		activeRetryCount: 0,
		recentRerouteCount: 0,
		lowestHeadroomPercent: null,
		criticalHeadroomCount: 0,
		activeMissionCount: 0,
		architectureMdExists: false,
		testPlanExists: false,
		holdoutChecksFailed: 0,
		collectedAt: new Date().toISOString(),
		...overrides,
	};
}

describe("createReminderSource", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "reminder-source-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("source name is temporal-reminders", () => {
		const source = createReminderSource(tempDir);
		expect(source.name).toBe("temporal-reminders");
	});

	it("returns empty array when DB files do not exist", () => {
		const source = createReminderSource(tempDir);
		const score = computeScore(healthySignals());
		expect(source.collect(score)).toEqual([]);
	});

	it("returns empty array when stores have no data", () => {
		// Create real empty stores — no signals, no policies trigger
		const metricsStore = createMetricsStore(path.join(tempDir, "metrics.db"));
		metricsStore.close();
		const mailStore = createMailStore(path.join(tempDir, "mail.db"));
		mailStore.close();
		const eventStore = createEventStore(path.join(tempDir, "events.db"));
		eventStore.close();

		const source = createReminderSource(tempDir);
		const score = computeScore(healthySignals());
		expect(source.collect(score)).toEqual([]);
	});

	it("returns recommendations when a policy detects issues", () => {
		// Create real stores and insert a stale escalation message
		const metricsStore = createMetricsStore(path.join(tempDir, "metrics.db"));
		metricsStore.close();
		const mailStore = createMailStore(path.join(tempDir, "mail.db"));
		mailStore.insert({
			id: "msg-test-esc-001",
			from: "worker-agent",
			to: "lead-agent",
			subject: "Escalation: blocked",
			body: "I am blocked on a dependency.",
			type: "escalation",
			priority: "high",
			threadId: null,
		});
		mailStore.close();
		const eventStore = createEventStore(path.join(tempDir, "events.db"));
		eventStore.close();

		// Use staleEscalationMaxAgeMs: 0 so any freshly inserted message is immediately stale
		const source = createReminderSource(tempDir, { staleEscalationMaxAgeMs: 0 });
		const score = computeScore(healthySignals());
		const recs = source.collect(score);

		const rec = recs.find((r) => r.factor === "reminder_stale_escalations");
		expect(rec).toBeDefined();
		expect(rec?.source).toBe("temporal-reminders");
	});

	it("catches errors and returns empty array", () => {
		// Write garbage bytes to the DB files so SQLite open throws
		writeFileSync(path.join(tempDir, "metrics.db"), "not a sqlite database");
		writeFileSync(path.join(tempDir, "mail.db"), "not a sqlite database");
		writeFileSync(path.join(tempDir, "events.db"), "not a sqlite database");

		const source = createReminderSource(tempDir);
		const score = computeScore(healthySignals());
		// Should not throw — errors are caught and empty array returned
		expect(source.collect(score)).toEqual([]);
	});
});
