import { describe, expect, it } from "bun:test";
import type { AgentSession } from "../agents/types.ts";
import { computeHeadroomPercent, evaluateThrottlePolicy } from "./throttle.ts";
import type { ThrottlePolicy } from "./throttle-types.ts";
import type { HeadroomSnapshot } from "./types.ts";

// === Test helpers ===

function makeSnapshot(overrides: Partial<HeadroomSnapshot> = {}): HeadroomSnapshot {
	return {
		state: "exact",
		requestsRemaining: 50,
		requestsLimit: 100,
		tokensRemaining: null,
		tokensLimit: null,
		windowResetsAt: null,
		capturedAt: new Date().toISOString(),
		runtime: "claude",
		message: "test",
		...overrides,
	};
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: "sess-1",
		agentName: "test-agent",
		capability: "builder",
		runtime: "claude",
		worktreePath: "/tmp/test",
		branchName: "test-branch",
		taskId: "test-task",
		tmuxSession: "test-session",
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
		runtimeSessionId: null,
		transcriptPath: null,
		originalRuntime: null,
		statusLine: null,
		...overrides,
	};
}

const defaultPolicy: ThrottlePolicy = {
	slowThresholdPercent: 20,
	pauseThresholdPercent: 10,
	blockSpawnsOnPause: true,
};

// === computeHeadroomPercent ===

describe("computeHeadroomPercent", () => {
	it("returns request-based percent when available", () => {
		const snap = makeSnapshot({ requestsRemaining: 75, requestsLimit: 100 });
		expect(computeHeadroomPercent(snap)).toBe(75);
	});

	it("falls back to token percent when requests null", () => {
		const snap = makeSnapshot({
			requestsRemaining: null,
			requestsLimit: null,
			tokensRemaining: 40,
			tokensLimit: 200,
		});
		expect(computeHeadroomPercent(snap)).toBe(20);
	});

	it("returns null when both are null", () => {
		const snap = makeSnapshot({
			requestsRemaining: null,
			requestsLimit: null,
			tokensRemaining: null,
			tokensLimit: null,
		});
		expect(computeHeadroomPercent(snap)).toBeNull();
	});

	it("returns null when limits are 0", () => {
		const snap = makeSnapshot({
			requestsRemaining: 0,
			requestsLimit: 0,
			tokensRemaining: 0,
			tokensLimit: 0,
		});
		expect(computeHeadroomPercent(snap)).toBeNull();
	});
});

// === evaluateThrottlePolicy ===

describe("evaluateThrottlePolicy", () => {
	it("returns empty array when headroom above thresholds", () => {
		const snapshots = [makeSnapshot({ requestsRemaining: 80, requestsLimit: 100 })];
		const sessions = [makeSession()];
		const actions = evaluateThrottlePolicy(snapshots, sessions, defaultPolicy);
		expect(actions).toEqual([]);
	});

	it("returns slow actions for priority-2 agents when below slow threshold", () => {
		// 15% is below slow (20) but above pause (10)
		const snapshots = [makeSnapshot({ requestsRemaining: 15, requestsLimit: 100 })];
		const sessions = [makeSession({ capability: "builder" })]; // priority 2
		const actions = evaluateThrottlePolicy(snapshots, sessions, defaultPolicy);
		expect(actions).toHaveLength(1);
		expect(actions[0]?.level).toBe("slow");
		expect(actions[0]?.targetAgent).toBe("test-agent");
		expect(actions[0]?.reason).toContain("slow threshold 20%");
	});

	it("returns pause actions for priority 1+2 agents when below pause threshold", () => {
		// 5% is below pause threshold (10)
		const snapshots = [makeSnapshot({ requestsRemaining: 5, requestsLimit: 100 })];
		const sessions = [
			makeSession({ agentName: "lead-agent", capability: "lead" }), // priority 1
			makeSession({ agentName: "builder-agent", capability: "builder" }), // priority 2
		];
		const actions = evaluateThrottlePolicy(snapshots, sessions, defaultPolicy);
		expect(actions).toHaveLength(2);
		expect(actions.every((a) => a.level === "pause")).toBe(true);
		expect(actions.map((a) => a.targetAgent)).toEqual(
			expect.arrayContaining(["lead-agent", "builder-agent"]),
		);
	});

	it("never includes priority-0 agents", () => {
		const snapshots = [makeSnapshot({ requestsRemaining: 5, requestsLimit: 100 })];
		const sessions = [
			makeSession({ agentName: "coord", capability: "coordinator" }), // priority 0
			makeSession({ agentName: "builder-agent", capability: "builder" }), // priority 2
		];
		const actions = evaluateThrottlePolicy(snapshots, sessions, defaultPolicy);
		expect(actions.find((a) => a.targetAgent === "coord")).toBeUndefined();
		expect(actions.find((a) => a.targetAgent === "builder-agent")).toBeDefined();
	});

	it("skips unavailable snapshots", () => {
		const snapshots = [makeSnapshot({ state: "unavailable" })];
		const sessions = [makeSession()];
		const actions = evaluateThrottlePolicy(snapshots, sessions, defaultPolicy);
		expect(actions).toEqual([]);
	});

	it("appends (estimated) to reason for estimated state", () => {
		const snapshots = [
			makeSnapshot({ state: "estimated", requestsRemaining: 5, requestsLimit: 100 }),
		];
		const sessions = [makeSession({ capability: "builder" })];
		const actions = evaluateThrottlePolicy(snapshots, sessions, defaultPolicy);
		expect(actions).toHaveLength(1);
		expect(actions[0]?.reason).toContain("(estimated)");
	});

	it("returns empty array with no sessions", () => {
		const snapshots = [makeSnapshot({ requestsRemaining: 5, requestsLimit: 100 })];
		const actions = evaluateThrottlePolicy(snapshots, [], defaultPolicy);
		expect(actions).toEqual([]);
	});

	it("handles multiple runtimes independently", () => {
		const snapshots = [
			// claude is below pause threshold
			makeSnapshot({ runtime: "claude", requestsRemaining: 5, requestsLimit: 100 }),
			// codex is above thresholds
			makeSnapshot({ runtime: "codex", requestsRemaining: 80, requestsLimit: 100 }),
		];
		const sessions = [makeSession({ capability: "builder" })];
		const actions = evaluateThrottlePolicy(snapshots, sessions, defaultPolicy);
		// Only claude triggers a pause, codex is fine
		expect(actions.filter((a) => a.runtime === "claude")).toHaveLength(1);
		expect(actions.filter((a) => a.runtime === "codex")).toHaveLength(0);
	});
});
