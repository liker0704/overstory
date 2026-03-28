import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHeadroomStore } from "../headroom/store.ts";
import type { HeadroomStore } from "../headroom/types.ts";
import type { HealthScore } from "../health/types.ts";
import type { MergeQueue } from "../merge/queue.ts";
import { createMergeQueue } from "../merge/queue.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { SessionStore } from "../sessions/store.ts";
import type { AgentSession } from "../types.ts";
import { collectParallelismContext } from "./signals.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeHealthScore(overall = 85, grade: HealthScore["grade"] = "A"): HealthScore {
	const now = new Date().toISOString();
	return {
		overall,
		grade,
		factors: [],
		collectedAt: now,
		signals: {
			totalActiveSessions: 0,
			stalledSessions: 0,
			zombieSessions: 0,
			bootingSessions: 0,
			workingSessions: 0,
			runtimeSwapCount: 0,
			totalSessionsRecorded: 0,
			completedSessionsRecorded: 0,
			mergeSuccessCount: 0,
			mergeTotalCount: 0,
			averageDurationMs: 0,
			costPerCompletedTask: null,
			doctorFailCount: 0,
			doctorWarnCount: 0,
			completionRate: 1,
			stalledRate: 0,
			mergeSuccessRate: 1,
			openBreakerCount: 0,
			activeRetryCount: 0,
			recentRerouteCount: 0,
			lowestHeadroomPercent: null,
			criticalHeadroomCount: 0,
			activeMissionCount: 0,
			collectedAt: now,
		},
	};
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: "session-001",
		agentName: "test-agent",
		capability: "builder",
		runtime: "claude",
		worktreePath: "/tmp/worktrees/test-agent",
		branchName: "overstory/test-agent/task-1",
		taskId: "task-1",
		tmuxSession: "overstory-test-agent",
		state: "working",
		pid: null,
		parentAgent: null,
		depth: 1,
		runId: null,
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		escalationLevel: 0,
		stalledSince: null,
		rateLimitedSince: null,
		rateLimitResumesAt: null,
		runtimeSessionId: null,
		transcriptPath: null,
		originalRuntime: null,
		statusLine: null,
		...overrides,
	};
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe("collectParallelismContext", () => {
	let tempDir: string;
	let sessionStore: SessionStore;
	let headroomStore: HeadroomStore;
	let mergeQueue: MergeQueue;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "ov-signals-test-"));
		const { store } = openSessionStore(tempDir);
		sessionStore = store;
		headroomStore = createHeadroomStore(join(tempDir, "headroom.db"));
		mergeQueue = createMergeQueue(join(tempDir, "merge-queue.db"));
	});

	afterEach(async () => {
		sessionStore.close();
		headroomStore.close();
		mergeQueue.close();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("happy path: all stores return data → fully populated context", () => {
		// Insert two active sessions (one stalled, one working)
		sessionStore.upsert(makeSession({ agentName: "worker-1", id: "s-1", state: "working" }));
		sessionStore.upsert(makeSession({ agentName: "worker-2", id: "s-2", state: "stalled" }));

		// Insert a fresh headroom snapshot with 60% requests remaining
		const now = new Date().toISOString();
		headroomStore.upsert({
			runtime: "claude",
			state: "exact",
			capturedAt: now,
			requestsRemaining: 60,
			requestsLimit: 100,
			tokensRemaining: null,
			tokensLimit: null,
			windowResetsAt: null,
			message: "60% remaining",
		});

		// Enqueue one pending merge entry
		mergeQueue.enqueue({
			branchName: "feature/test",
			taskId: "task-1",
			agentName: "worker-1",
			filesModified: ["src/foo.ts"],
		});

		const result = collectParallelismContext({
			sessionStore,
			healthScore: makeHealthScore(85, "A"),
			headroomStore,
			mergeQueue,
			evaluationIntervalMs: 60_000,
			readyTaskCount: 5,
			inProgressCount: 2,
		});

		expect(result.healthScore).toBe(85);
		expect(result.healthGrade).toBe("A");
		expect(result.headroomPercent).toBeCloseTo(60);
		expect(result.mergeQueueDepth).toBe(1);
		expect(result.activeWorkers).toBe(2);
		expect(result.stalledWorkers).toBe(1);
		expect(result.readyTaskCount).toBe(5);
		expect(result.inProgressCount).toBe(2);
		expect(result.collectedAt).toBeString();
	});

	test("missing headroom data: no snapshots → headroomPercent is null", () => {
		const result = collectParallelismContext({
			sessionStore,
			healthScore: makeHealthScore(),
			headroomStore,
			mergeQueue,
			evaluationIntervalMs: 60_000,
		});

		expect(result.headroomPercent).toBeNull();
	});

	test("stale headroom: capturedAt older than 2×evaluationIntervalMs → headroomPercent is null", () => {
		const evaluationIntervalMs = 60_000; // 1 minute
		// Snapshot captured 3 minutes ago (> 2 × 1 min)
		const staleAt = new Date(Date.now() - 3 * 60_000).toISOString();
		headroomStore.upsert({
			runtime: "claude",
			state: "exact",
			capturedAt: staleAt,
			requestsRemaining: 80,
			requestsLimit: 100,
			tokensRemaining: null,
			tokensLimit: null,
			windowResetsAt: null,
			message: "stale snapshot",
		});

		const result = collectParallelismContext({
			sessionStore,
			healthScore: makeHealthScore(),
			headroomStore,
			mergeQueue,
			evaluationIntervalMs,
		});

		expect(result.headroomPercent).toBeNull();
	});

	test("empty merge queue: no pending entries → mergeQueueDepth is 0", () => {
		const result = collectParallelismContext({
			sessionStore,
			healthScore: makeHealthScore(),
			headroomStore,
			mergeQueue,
			evaluationIntervalMs: 60_000,
		});

		expect(result.mergeQueueDepth).toBe(0);
	});

	test("no active sessions: activeWorkers is 0, stalledWorkers is 0", () => {
		const result = collectParallelismContext({
			sessionStore,
			healthScore: makeHealthScore(),
			headroomStore,
			mergeQueue,
			evaluationIntervalMs: 60_000,
		});

		expect(result.activeWorkers).toBe(0);
		expect(result.stalledWorkers).toBe(0);
	});

	test("store throws error: safe defaults applied", () => {
		// Create throwing store proxies that implement the store interfaces
		const throwingSessionStore: SessionStore = {
			...sessionStore,
			getActive(): AgentSession[] {
				throw new Error("DB unavailable");
			},
		};

		const throwingHeadroomStore: HeadroomStore = {
			...headroomStore,
			getAll() {
				throw new Error("DB unavailable");
			},
		};

		const throwingMergeQueue: MergeQueue = {
			...mergeQueue,
			list() {
				throw new Error("DB unavailable");
			},
		};

		const result = collectParallelismContext({
			sessionStore: throwingSessionStore,
			healthScore: makeHealthScore(70, "B"),
			headroomStore: throwingHeadroomStore,
			mergeQueue: throwingMergeQueue,
			evaluationIntervalMs: 60_000,
		});

		expect(result.healthScore).toBe(70);
		expect(result.healthGrade).toBe("B");
		expect(result.headroomPercent).toBeNull();
		expect(result.mergeQueueDepth).toBe(0);
		expect(result.activeWorkers).toBe(0);
		expect(result.stalledWorkers).toBe(0);
		expect(result.readyTaskCount).toBeNull();
		expect(result.inProgressCount).toBeNull();
	});

	test("missing beads data: readyTaskCount and inProgressCount default to null", () => {
		const result = collectParallelismContext({
			sessionStore,
			healthScore: makeHealthScore(),
			headroomStore,
			mergeQueue,
			evaluationIntervalMs: 60_000,
		});

		expect(result.readyTaskCount).toBeNull();
		expect(result.inProgressCount).toBeNull();
	});
});
