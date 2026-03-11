/**
 * Tests for health signal collection.
 *
 * Uses real :memory: SQLite databases via the actual store implementations.
 * No mocks — follows the "never mock what you can use for real" philosophy.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DoctorCheck } from "../doctor/types.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { createSessionStore } from "../sessions/store.ts";
import type { AgentSession, SessionMetrics } from "../types.ts";
import { collectSignals } from "./signals.ts";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "ov-health-signals-test-"));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: "sess-1",
		agentName: "test-agent",
		capability: "builder",
		runtime: "claude",
		worktreePath: "/tmp/wt",
		branchName: "feat/test",
		taskId: "task-1",
		tmuxSession: "test-session",
		state: "working",
		pid: null,
		parentAgent: null,
		depth: 0,
		runId: null,
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		escalationLevel: 0,
		stalledSince: null,
		rateLimitedSince: null,
		runtimeSessionId: null,
		transcriptPath: null,
		originalRuntime: null,
		...overrides,
	};
}

function makeMetrics(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
	return {
		agentName: "test-agent",
		taskId: "task-1",
		capability: "builder",
		startedAt: new Date(Date.now() - 60_000).toISOString(),
		completedAt: new Date().toISOString(),
		durationMs: 60_000,
		exitCode: 0,
		mergeResult: null,
		parentAgent: null,
		inputTokens: 1000,
		outputTokens: 500,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		estimatedCostUsd: 0.1,
		modelUsed: "claude-opus-4-6",
		runId: null,
		...overrides,
	};
}

describe("collectSignals", () => {
	it("returns safe defaults when .overstory dir is empty", () => {
		const signals = collectSignals({ overstoryDir: tempDir });

		expect(signals.totalActiveSessions).toBe(0);
		expect(signals.stalledSessions).toBe(0);
		expect(signals.zombieSessions).toBe(0);
		expect(signals.doctorFailCount).toBe(0);
		expect(signals.doctorWarnCount).toBe(0);
		// No data → defaults to healthy rates
		expect(signals.completionRate).toBe(1.0);
		expect(signals.stalledRate).toBe(0.0);
		expect(signals.mergeSuccessRate).toBe(1.0);
		expect(signals.collectedAt).toBeDefined();
	});

	it("counts session states from sessions.db", () => {
		const dbPath = join(tempDir, "sessions.db");
		const store = createSessionStore(dbPath);
		store.upsert(makeSession({ agentName: "a1", state: "working" }));
		store.upsert(makeSession({ agentName: "a2", id: "s2", state: "stalled" }));
		store.upsert(makeSession({ agentName: "a3", id: "s3", state: "zombie" }));
		store.upsert(makeSession({ agentName: "a4", id: "s4", state: "completed" }));
		store.close();

		const signals = collectSignals({ overstoryDir: tempDir });

		expect(signals.workingSessions).toBe(1);
		expect(signals.stalledSessions).toBe(1);
		expect(signals.zombieSessions).toBe(1);
		// completed is not active, so totalActiveSessions = working + stalled + booting
		expect(signals.totalActiveSessions).toBe(2); // working + stalled
	});

	it("computes stalledRate from active sessions", () => {
		const dbPath = join(tempDir, "sessions.db");
		const store = createSessionStore(dbPath);
		store.upsert(makeSession({ agentName: "a1", state: "working" }));
		store.upsert(makeSession({ agentName: "a2", id: "s2", state: "stalled" }));
		store.close();

		const signals = collectSignals({ overstoryDir: tempDir });

		// 1 stalled out of 2 active = 0.5
		expect(signals.stalledRate).toBe(0.5);
	});

	it("counts runtimeSwapCount from originalRuntime field", () => {
		const dbPath = join(tempDir, "sessions.db");
		const store = createSessionStore(dbPath);
		store.upsert(makeSession({ agentName: "a1", originalRuntime: "claude" }));
		store.upsert(makeSession({ agentName: "a2", id: "s2", originalRuntime: null }));
		store.close();

		const signals = collectSignals({ overstoryDir: tempDir });

		expect(signals.runtimeSwapCount).toBe(1);
	});

	it("collects metrics from metrics.db", () => {
		const metricsDb = join(tempDir, "metrics.db");
		const store = createMetricsStore(metricsDb);
		store.recordSession(makeMetrics({ agentName: "a1", completedAt: new Date().toISOString() }));
		store.recordSession(
			makeMetrics({ agentName: "a2", taskId: "t2", completedAt: null, durationMs: 0 }),
		);
		store.close();

		const signals = collectSignals({ overstoryDir: tempDir });

		expect(signals.totalSessionsRecorded).toBe(2);
		expect(signals.completedSessionsRecorded).toBe(1);
		expect(signals.completionRate).toBeCloseTo(0.5);
	});

	it("computes mergeSuccessRate from mergeResult field", () => {
		const metricsDb = join(tempDir, "metrics.db");
		const store = createMetricsStore(metricsDb);
		store.recordSession(makeMetrics({ agentName: "a1", mergeResult: "clean-merge" }));
		store.recordSession(makeMetrics({ agentName: "a2", taskId: "t2", mergeResult: "reimagine" }));
		store.close();

		const signals = collectSignals({ overstoryDir: tempDir });

		expect(signals.mergeSuccessCount).toBe(1);
		expect(signals.mergeTotalCount).toBe(2);
		expect(signals.mergeSuccessRate).toBeCloseTo(0.5);
	});

	it("counts doctor check results from passed-in array", () => {
		const doctorChecks: DoctorCheck[] = [
			{ name: "check-a", category: "structure", status: "fail", message: "missing dir" },
			{ name: "check-b", category: "config", status: "warn", message: "optional key missing" },
			{ name: "check-c", category: "databases", status: "pass", message: "ok" },
		];

		const signals = collectSignals({ overstoryDir: tempDir, doctorChecks });

		expect(signals.doctorFailCount).toBe(1);
		expect(signals.doctorWarnCount).toBe(1);
	});

	it("computes costPerCompletedTask from completed sessions with cost data", () => {
		const metricsDb = join(tempDir, "metrics.db");
		const store = createMetricsStore(metricsDb);
		store.recordSession(
			makeMetrics({
				agentName: "a1",
				completedAt: new Date().toISOString(),
				estimatedCostUsd: 0.2,
			}),
		);
		store.recordSession(
			makeMetrics({
				agentName: "a2",
				taskId: "t2",
				completedAt: new Date().toISOString(),
				estimatedCostUsd: 0.4,
			}),
		);
		store.close();

		const signals = collectSignals({ overstoryDir: tempDir });

		expect(signals.costPerCompletedTask).toBeCloseTo(0.3);
	});
});
