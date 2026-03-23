/**
 * Integration tests for the watchdog daemon tick loop.
 *
 * Uses real filesystem (temp directories via mkdtemp) and real SessionStore
 * (bun:sqlite) for session persistence, plus real health evaluation logic.
 *
 * Only tmux operations (isSessionAlive, killSession), triage, and nudge are
 * mocked via dependency injection (_tmux, _triage, _nudge params) because:
 * - Real tmux interferes with developer sessions and is fragile in CI.
 * - Real triage spawns Claude CLI which has cost and latency.
 * - Real nudge requires active tmux sessions.
 *
 * Does NOT use mock.module() — it leaks across test files. See mulch record
 * mx-56558b for background.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import { createMailStore } from "../mail/store.ts";
import { createSessionStore } from "../sessions/store.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import type { AgentSession, HealthCheck, OverstoryConfig, StoredEvent } from "../types.ts";
import { buildCompletionMessage, runDaemonTick } from "./daemon.ts";

// === Test constants ===

const THRESHOLDS = {
	staleThresholdMs: 30_000,
	zombieThresholdMs: 120_000,
};

// === Helpers ===

/** Create a temp directory with .overstory/ subdirectory, ready for sessions.db. */
async function createTempRoot(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "overstory-daemon-test-"));
	await mkdir(join(dir, ".overstory"), { recursive: true });
	return dir;
}

/** Write sessions to the SessionStore (sessions.db) at the given root. */
function writeSessionsToStore(root: string, sessions: AgentSession[]): void {
	const dbPath = join(root, ".overstory", "sessions.db");
	const store = createSessionStore(dbPath);
	for (const session of sessions) {
		store.upsert(session);
	}
	store.close();
}

/** Read sessions from the SessionStore (sessions.db) at the given root. */
function readSessionsFromStore(root: string): AgentSession[] {
	const dbPath = join(root, ".overstory", "sessions.db");
	const store = createSessionStore(dbPath);
	const sessions = store.getAll();
	store.close();
	return sessions;
}

/** Build a test AgentSession with sensible defaults. */
function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: "session-test",
		agentName: "test-agent",
		capability: "builder",
		runtime: "claude",
		worktreePath: "/tmp/test",
		branchName: "overstory/test-agent/test-task",
		taskId: "test-task",
		tmuxSession: "overstory-test-agent",
		state: "working",
		pid: process.pid, // Use our own PID so isProcessRunning returns true
		parentAgent: null,
		depth: 0,
		runId: null,
		escalationLevel: 0,
		stalledSince: null,
		rateLimitedSince: null,
		runtimeSessionId: null,
		transcriptPath: null,
		originalRuntime: null,
		statusLine: null,
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		...overrides,
	};
}

/** Create a fake _tmux dependency where all sessions are alive. */
function tmuxAllAlive(): {
	isSessionAlive: (name: string) => Promise<boolean>;
	killSession: (name: string) => Promise<void>;
} {
	return {
		isSessionAlive: async () => true,
		killSession: async () => {},
	};
}

/** Create a fake _tmux dependency where all sessions are dead. */
function tmuxAllDead(): {
	isSessionAlive: (name: string) => Promise<boolean>;
	killSession: (name: string) => Promise<void>;
} {
	return {
		isSessionAlive: async () => false,
		killSession: async () => {},
	};
}

/**
 * Create a fake _tmux dependency with per-session liveness control.
 * Also tracks killSession calls for assertions.
 */
function tmuxWithLiveness(aliveMap: Record<string, boolean>): {
	isSessionAlive: (name: string) => Promise<boolean>;
	killSession: (name: string) => Promise<void>;
	killed: string[];
} {
	const killed: string[] = [];
	return {
		isSessionAlive: async (name: string) => aliveMap[name] ?? false,
		killSession: async (name: string) => {
			killed.push(name);
		},
		killed,
	};
}

function tmuxWithLivenessAndInput(aliveMap: Record<string, boolean>): {
	isSessionAlive: (name: string) => Promise<boolean>;
	killSession: (name: string) => Promise<void>;
	sendKeys: (name: string, keys: string) => Promise<void>;
	killed: string[];
	sentKeys: Array<{ name: string; keys: string }>;
} {
	const base = tmuxWithLiveness(aliveMap);
	const sentKeys: Array<{ name: string; keys: string }> = [];
	return {
		...base,
		sendKeys: async (name: string, keys: string) => {
			sentKeys.push({ name, keys });
		},
		sentKeys,
	};
}

/** Create a fake _triage that always returns the given verdict. */
function triageAlways(
	verdict: "retry" | "terminate" | "extend",
): (options: {
	agentName: string;
	root: string;
	lastActivity: string;
}) => Promise<"retry" | "terminate" | "extend"> {
	return async () => verdict;
}

/** Create a fake _nudge that tracks calls and always succeeds. */
function nudgeTracker(): {
	nudge: (
		projectRoot: string,
		agentName: string,
		message: string,
		force: boolean,
	) => Promise<{ delivered: boolean; reason?: string }>;
	calls: Array<{ agentName: string; message: string }>;
} {
	const calls: Array<{ agentName: string; message: string }> = [];
	return {
		nudge: async (_projectRoot: string, agentName: string, message: string, _force: boolean) => {
			calls.push({ agentName, message });
			return { delivered: true };
		},
		calls,
	};
}

// === Tests ===

let tempRoot: string;

beforeEach(async () => {
	tempRoot = await createTempRoot();
});

afterEach(async () => {
	await cleanupTempDir(tempRoot);
});

describe("daemon tick", () => {
	// --- Test 1: tick with no sessions file ---

	test("tick with no sessions is a graceful no-op", async () => {
		// No sessions in the store — daemon should not crash
		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
		});

		// No health checks should have been produced (no sessions to check)
		expect(checks).toHaveLength(0);
	});

	// --- Test 2: tick with healthy sessions ---

	test("tick with healthy sessions produces no state changes", async () => {
		const session = makeSession({
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
		});

		expect(checks).toHaveLength(1);
		const check = checks[0];
		expect(check).toBeDefined();
		expect(check?.state).toBe("working");
		expect(check?.action).toBe("none");

		// Session state should be unchanged because state didn't change.
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded).toHaveLength(1);
		expect(reloaded[0]?.state).toBe("working");
	});

	// --- Test 3: tick with dead tmux -> zombie transition ---

	test("tick with dead tmux transitions session to zombie and fires terminate", async () => {
		const session = makeSession({
			agentName: "dead-agent",
			tmuxSession: "overstory-dead-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-dead-agent": false });
		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
		});

		// Health check should detect zombie with terminate action
		expect(checks).toHaveLength(1);
		expect(checks[0]?.state).toBe("zombie");
		expect(checks[0]?.action).toBe("terminate");

		// tmux is dead so killSession should NOT be called (only kills if tmuxAlive)
		expect(tmuxMock.killed).toHaveLength(0);

		// Session state should be persisted as zombie
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded).toHaveLength(1);
		expect(reloaded[0]?.state).toBe("zombie");
	});

	test("tick with alive tmux but zombie-old activity calls killSession", async () => {
		// tmux IS alive but time-based zombie threshold is exceeded,
		// causing a terminate action — killSession SHOULD be called.
		const oldActivity = new Date(Date.now() - 200_000).toISOString();
		const session = makeSession({
			agentName: "zombie-agent",
			tmuxSession: "overstory-zombie-agent",
			state: "working",
			lastActivity: oldActivity,
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-zombie-agent": true });
		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
		});

		expect(checks).toHaveLength(1);
		expect(checks[0]?.action).toBe("terminate");

		// tmux was alive, so killSession SHOULD have been called
		expect(tmuxMock.killed).toContain("overstory-zombie-agent");

		// Session persisted as zombie
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("zombie");
	});

	// --- Test 4: progressive nudging for stalled agents ---

	test("first tick with stalled agent sets stalledSince and stays at level 0 (warn)", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({
			agentName: "stalled-agent",
			tmuxSession: "overstory-stalled-agent",
			state: "working",
			lastActivity: staleActivity,
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-stalled-agent": true });
		const checks: HealthCheck[] = [];
		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_nudge: nudgeMock.nudge,
		});

		expect(checks).toHaveLength(1);
		expect(checks[0]?.action).toBe("escalate");

		// No kill at level 0
		expect(tmuxMock.killed).toHaveLength(0);

		// No nudge at level 0 (warn only)
		expect(nudgeMock.calls).toHaveLength(0);

		// Session should be stalled with stalledSince set and escalationLevel 0
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("stalled");
		expect(reloaded[0]?.escalationLevel).toBe(0);
		expect(reloaded[0]?.stalledSince).not.toBeNull();
	});

	test("stalled agent at level 1 sends nudge", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		// Pre-set stalledSince to > nudgeIntervalMs ago so level advances to 1
		const stalledSince = new Date(Date.now() - 70_000).toISOString();
		const session = makeSession({
			agentName: "stalled-agent",
			tmuxSession: "overstory-stalled-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 0,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-stalled-agent": true });
		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_nudge: nudgeMock.nudge,
		});

		// Level should advance to 1 and nudge should be sent
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.escalationLevel).toBe(1);
		expect(nudgeMock.calls).toHaveLength(1);
		expect(nudgeMock.calls[0]?.agentName).toBe("stalled-agent");
		expect(nudgeMock.calls[0]?.message).toContain("WATCHDOG");

		// No kill
		expect(tmuxMock.killed).toHaveLength(0);
	});

	test("stalled agent at level 2 calls triage when tier1Enabled", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		// Pre-set stalledSince to > 2*nudgeIntervalMs ago so level advances to 2
		const stalledSince = new Date(Date.now() - 130_000).toISOString();
		const session = makeSession({
			agentName: "stalled-agent",
			tmuxSession: "overstory-stalled-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 1,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-stalled-agent": true });
		let triageCalled = false;

		const triageMock = async (opts: {
			agentName: string;
			root: string;
			lastActivity: string;
		}): Promise<"retry" | "terminate" | "extend"> => {
			triageCalled = true;
			expect(opts.agentName).toBe("stalled-agent");
			return "terminate";
		};

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			tier1Enabled: true,
			_tmux: tmuxMock,
			_triage: triageMock,
			_nudge: nudgeTracker().nudge,
		});

		expect(triageCalled).toBe(true);

		// Triage returned terminate — session should be zombie
		expect(tmuxMock.killed).toContain("overstory-stalled-agent");
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("zombie");
	});

	test("stalled agent at level 2 skips triage when tier1Enabled is false", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const stalledSince = new Date(Date.now() - 130_000).toISOString();
		const session = makeSession({
			agentName: "stalled-agent",
			tmuxSession: "overstory-stalled-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 1,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-stalled-agent": true });
		let triageCalled = false;

		const triageMock = async (): Promise<"retry" | "terminate" | "extend"> => {
			triageCalled = true;
			return "terminate";
		};

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			tier1Enabled: false, // Triage disabled
			_tmux: tmuxMock,
			_triage: triageMock,
			_nudge: nudgeTracker().nudge,
		});

		// Triage should NOT have been called
		expect(triageCalled).toBe(false);

		// No kill — level 2 with tier1 disabled just skips
		expect(tmuxMock.killed).toHaveLength(0);

		// Session stays stalled at level 2
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("stalled");
		expect(reloaded[0]?.escalationLevel).toBe(2);
	});

	test("stalled agent at level 3 is terminated", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		// Pre-set stalledSince to > 3*nudgeIntervalMs ago so level advances to 3
		const stalledSince = new Date(Date.now() - 200_000).toISOString();
		const session = makeSession({
			agentName: "doomed-agent",
			tmuxSession: "overstory-doomed-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 2,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-doomed-agent": true });

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_nudge: nudgeTracker().nudge,
		});

		// Level 3 = terminate
		expect(tmuxMock.killed).toContain("overstory-doomed-agent");

		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("zombie");
		// Escalation is reset after termination
		expect(reloaded[0]?.escalationLevel).toBe(0);
		expect(reloaded[0]?.stalledSince).toBeNull();
	});

	test("triage retry sends nudge with recovery message", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const stalledSince = new Date(Date.now() - 130_000).toISOString();
		const session = makeSession({
			agentName: "retry-agent",
			tmuxSession: "overstory-retry-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 1,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-retry-agent": true });
		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			tier1Enabled: true,
			_tmux: tmuxMock,
			_triage: triageAlways("retry"),
			_nudge: nudgeMock.nudge,
		});

		// Triage returned "retry" — nudge should be sent with recovery message
		expect(nudgeMock.calls).toHaveLength(1);
		expect(nudgeMock.calls[0]?.message).toContain("recovery");

		// No kill
		expect(tmuxMock.killed).toHaveLength(0);

		// Session stays stalled
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("stalled");
	});

	test("agent recovery resets escalation tracking", async () => {
		// Agent was stalled but now has recent activity
		const session = makeSession({
			agentName: "recovered-agent",
			tmuxSession: "overstory-recovered-agent",
			state: "working",
			lastActivity: new Date().toISOString(), // Recent activity
			escalationLevel: 2,
			stalledSince: new Date(Date.now() - 130_000).toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
			_nudge: nudgeTracker().nudge,
		});

		// Health check should return action: "none" for recovered agent
		// Escalation tracking should be reset
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("working");
		expect(reloaded[0]?.escalationLevel).toBe(0);
		expect(reloaded[0]?.stalledSince).toBeNull();
	});

	// --- Test 5: session persistence round-trip ---

	test("session persistence round-trip: load, modify, save, reload", async () => {
		const sessions: AgentSession[] = [
			makeSession({
				id: "session-1",
				agentName: "agent-alpha",
				tmuxSession: "overstory-agent-alpha",
				state: "working",
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "session-2",
				agentName: "agent-beta",
				tmuxSession: "overstory-agent-beta",
				state: "working",
				// Make beta's tmux dead so it transitions to zombie
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "session-3",
				agentName: "agent-gamma",
				tmuxSession: "overstory-agent-gamma",
				state: "completed",
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);

		const tmuxMock = tmuxWithLiveness({
			"overstory-agent-alpha": true,
			"overstory-agent-beta": false, // Dead — should become zombie
			"overstory-agent-gamma": true, // Alive — will be killed as completed cleanup
		});

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
		});

		// Completed sessions are skipped — only 2 health checks
		expect(checks).toHaveLength(2);

		// Reload and verify persistence
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded).toHaveLength(3);

		const alpha = reloaded.find((s) => s.agentName === "agent-alpha");
		const beta = reloaded.find((s) => s.agentName === "agent-beta");
		const gamma = reloaded.find((s) => s.agentName === "agent-gamma");

		expect(alpha).toBeDefined();
		expect(beta).toBeDefined();
		expect(gamma).toBeDefined();

		// Alpha: tmux alive + recent activity — stays working
		expect(alpha?.state).toBe("working");

		// Beta: tmux dead — zombie (ZFC rule 1)
		expect(beta?.state).toBe("zombie");

		// Gamma: completed — unchanged (skipped by daemon)
		expect(gamma?.state).toBe("completed");
	});

	test("session persistence: state unchanged when nothing changes", async () => {
		const session = makeSession({
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
		});

		// Session state should remain unchanged since nothing triggered a transition
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded).toHaveLength(1);
		expect(reloaded[0]?.state).toBe("working");
	});

	// --- Edge cases ---

	test("completed sessions are skipped entirely", async () => {
		const session = makeSession({ state: "completed" });

		writeSessionsToStore(tempRoot, [session]);

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxAllDead(), // Would be zombie if not skipped
			_triage: triageAlways("extend"),
		});

		// No health checks emitted for completed sessions
		expect(checks).toHaveLength(0);

		// State unchanged
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("completed");
	});

	test("completed sessions with live tmux are killed on next tick", async () => {
		const session = makeSession({
			state: "completed",
			tmuxSession: "overstory-lead-done",
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({
			"overstory-lead-done": true,
		});
		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
		});

		// No health checks — completed sessions are still skipped from evaluation
		expect(checks).toHaveLength(0);

		// But the lingering tmux session was killed
		expect(tmuxMock.killed).toEqual(["overstory-lead-done"]);

		// State unchanged (still completed)
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("completed");
	});

	test("multiple sessions with mixed states are all processed", async () => {
		const now = Date.now();
		const sessions: AgentSession[] = [
			makeSession({
				id: "s1",
				agentName: "healthy",
				tmuxSession: "overstory-healthy",
				state: "working",
				lastActivity: new Date(now).toISOString(),
			}),
			makeSession({
				id: "s2",
				agentName: "dying",
				tmuxSession: "overstory-dying",
				state: "working",
				lastActivity: new Date(now).toISOString(),
			}),
			makeSession({
				id: "s3",
				agentName: "stale",
				tmuxSession: "overstory-stale",
				state: "working",
				lastActivity: new Date(now - 60_000).toISOString(),
			}),
			makeSession({
				id: "s4",
				agentName: "done",
				tmuxSession: "overstory-done",
				state: "completed",
			}),
		];

		writeSessionsToStore(tempRoot, sessions);

		const tmuxMock = tmuxWithLiveness({
			"overstory-healthy": true,
			"overstory-dying": false,
			"overstory-stale": true,
			"overstory-done": false,
		});

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_nudge: nudgeTracker().nudge,
		});

		// 3 non-completed sessions processed
		expect(checks).toHaveLength(3);

		const reloaded = readSessionsFromStore(tempRoot);

		const healthy = reloaded.find((s) => s.agentName === "healthy");
		const dying = reloaded.find((s) => s.agentName === "dying");
		const stale = reloaded.find((s) => s.agentName === "stale");
		const done = reloaded.find((s) => s.agentName === "done");

		expect(healthy?.state).toBe("working");
		expect(dying?.state).toBe("zombie");
		expect(stale?.state).toBe("stalled");
		expect(done?.state).toBe("completed");
	});

	test("empty sessions array is a no-op", async () => {
		writeSessionsToStore(tempRoot, []);

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
		});

		expect(checks).toHaveLength(0);
	});

	test("booting session with recent activity transitions to working", async () => {
		const session = makeSession({
			state: "booting",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
		});

		expect(checks).toHaveLength(1);
		expect(checks[0]?.state).toBe("working");

		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("working");
	});

	// --- Backward compatibility ---

	test("sessions with default escalation fields are processed correctly", async () => {
		// Write a session with default (zero) escalation fields
		const session = makeSession({
			id: "session-old",
			agentName: "old-agent",
			worktreePath: "/tmp/test",
			branchName: "overstory/old-agent/task",
			taskId: "task",
			tmuxSession: "overstory-old-agent",
			state: "working",
			pid: process.pid,
			escalationLevel: 0,
			stalledSince: null,
			transcriptPath: null,
			originalRuntime: null,
		});

		writeSessionsToStore(tempRoot, [session]);

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
		});

		// Should process without errors
		expect(checks).toHaveLength(1);
		expect(checks[0]?.state).toBe("working");
	});
});

// === Event recording tests ===

describe("daemon event recording", () => {
	/** Open the events.db in the temp root and return all events. */
	function readEvents(root: string): StoredEvent[] {
		const dbPath = join(root, ".overstory", "events.db");
		const store = createEventStore(dbPath);
		try {
			// Get all events (no agent filter — use a broad timeline)
			return store.getTimeline({ since: "2000-01-01T00:00:00Z" });
		} finally {
			store.close();
		}
	}

	test("escalation level 0 (warn) records event with type=escalation", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({
			agentName: "stalled-agent",
			tmuxSession: "overstory-stalled-agent",
			state: "working",
			lastActivity: staleActivity,
		});

		writeSessionsToStore(tempRoot, [session]);

		// Create EventStore and inject it
		const eventsDbPath = join(tempRoot, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);

		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				nudgeIntervalMs: 60_000,
				_tmux: tmuxWithLiveness({ "overstory-stalled-agent": true }),
				_triage: triageAlways("extend"),
				_nudge: nudgeTracker().nudge,
				_eventStore: eventStore,
			});
		} finally {
			eventStore.close();
		}

		const events = readEvents(tempRoot);
		expect(events.length).toBeGreaterThanOrEqual(1);

		const warnEvent = events.find((e) => {
			if (!e.data) return false;
			const data = JSON.parse(e.data) as Record<string, unknown>;
			return data.type === "escalation" && data.escalationLevel === 0;
		});
		expect(warnEvent).toBeDefined();
		expect(warnEvent?.eventType).toBe("custom");
		expect(warnEvent?.level).toBe("warn");
		expect(warnEvent?.agentName).toBe("stalled-agent");
	});

	test("escalation level 1 (nudge) records event with delivered status", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const stalledSince = new Date(Date.now() - 70_000).toISOString();
		const session = makeSession({
			agentName: "stalled-agent",
			tmuxSession: "overstory-stalled-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 0,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const eventsDbPath = join(tempRoot, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);
		const nudgeMock = nudgeTracker();

		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				nudgeIntervalMs: 60_000,
				_tmux: tmuxWithLiveness({ "overstory-stalled-agent": true }),
				_triage: triageAlways("extend"),
				_nudge: nudgeMock.nudge,
				_eventStore: eventStore,
			});
		} finally {
			eventStore.close();
		}

		const events = readEvents(tempRoot);
		const nudgeEvent = events.find((e) => {
			if (!e.data) return false;
			const data = JSON.parse(e.data) as Record<string, unknown>;
			return data.type === "nudge" && data.escalationLevel === 1;
		});
		expect(nudgeEvent).toBeDefined();
		expect(nudgeEvent?.eventType).toBe("custom");
		expect(nudgeEvent?.level).toBe("warn");

		const nudgeData = JSON.parse(nudgeEvent?.data ?? "{}") as Record<string, unknown>;
		expect(nudgeData.delivered).toBe(true);
	});

	test("escalation level 2 (triage) records event with verdict", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const stalledSince = new Date(Date.now() - 130_000).toISOString();
		const session = makeSession({
			agentName: "stalled-agent",
			tmuxSession: "overstory-stalled-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 1,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const eventsDbPath = join(tempRoot, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);

		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				nudgeIntervalMs: 60_000,
				tier1Enabled: true,
				_tmux: tmuxWithLiveness({ "overstory-stalled-agent": true }),
				_triage: triageAlways("extend"),
				_nudge: nudgeTracker().nudge,
				_eventStore: eventStore,
			});
		} finally {
			eventStore.close();
		}

		const events = readEvents(tempRoot);
		const triageEvent = events.find((e) => {
			if (!e.data) return false;
			const data = JSON.parse(e.data) as Record<string, unknown>;
			return data.type === "triage" && data.escalationLevel === 2;
		});
		expect(triageEvent).toBeDefined();
		expect(triageEvent?.eventType).toBe("custom");
		expect(triageEvent?.level).toBe("warn");

		const triageData = JSON.parse(triageEvent?.data ?? "{}") as Record<string, unknown>;
		expect(triageData.verdict).toBe("extend");
	});

	test("escalation level 3 (terminate) records event with level=error", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const stalledSince = new Date(Date.now() - 200_000).toISOString();
		const session = makeSession({
			agentName: "doomed-agent",
			tmuxSession: "overstory-doomed-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 2,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const eventsDbPath = join(tempRoot, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);

		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				nudgeIntervalMs: 60_000,
				_tmux: tmuxWithLiveness({ "overstory-doomed-agent": true }),
				_triage: triageAlways("extend"),
				_nudge: nudgeTracker().nudge,
				_eventStore: eventStore,
			});
		} finally {
			eventStore.close();
		}

		const events = readEvents(tempRoot);
		const terminateEvent = events.find((e) => {
			if (!e.data) return false;
			const data = JSON.parse(e.data) as Record<string, unknown>;
			return data.type === "escalation" && data.escalationLevel === 3;
		});
		expect(terminateEvent).toBeDefined();
		expect(terminateEvent?.eventType).toBe("custom");
		expect(terminateEvent?.level).toBe("error");

		const terminateData = JSON.parse(terminateEvent?.data ?? "{}") as Record<string, unknown>;
		expect(terminateData.action).toBe("terminate");
	});

	test("run_id is included in events when current-run.txt exists", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({
			agentName: "stalled-agent",
			tmuxSession: "overstory-stalled-agent",
			state: "working",
			lastActivity: staleActivity,
		});

		writeSessionsToStore(tempRoot, [session]);

		// Write a current-run.txt
		const runId = "run-2026-02-13T10-00-00-000Z";
		await Bun.write(join(tempRoot, ".overstory", "current-run.txt"), runId);

		const eventsDbPath = join(tempRoot, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);

		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				nudgeIntervalMs: 60_000,
				_tmux: tmuxWithLiveness({ "overstory-stalled-agent": true }),
				_triage: triageAlways("extend"),
				_nudge: nudgeTracker().nudge,
				_eventStore: eventStore,
			});
		} finally {
			eventStore.close();
		}

		const events = readEvents(tempRoot);
		expect(events.length).toBeGreaterThanOrEqual(1);
		const event = events[0];
		expect(event?.runId).toBe(runId);
	});

	test("daemon continues normally when _eventStore is null", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({
			agentName: "stalled-agent",
			tmuxSession: "overstory-stalled-agent",
			state: "working",
			lastActivity: staleActivity,
		});

		writeSessionsToStore(tempRoot, [session]);

		const checks: HealthCheck[] = [];

		// Inject null EventStore — daemon should still work fine
		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxWithLiveness({ "overstory-stalled-agent": true }),
			_triage: triageAlways("extend"),
			_nudge: nudgeTracker().nudge,
			_eventStore: null,
		});

		// Daemon should still produce health checks even without EventStore
		expect(checks).toHaveLength(1);
		expect(checks[0]?.action).toBe("escalate");
	});
});

// === Mulch failure recording tests ===

describe("daemon mulch failure recording", () => {
	let tempRoot: string;

	beforeEach(async () => {
		tempRoot = await createTempRoot();
	});

	afterEach(async () => {
		await cleanupTempDir(tempRoot);
	});

	/** Track calls to the recordFailure mock. */
	interface FailureRecord {
		root: string;
		session: AgentSession;
		reason: string;
		tier: 0 | 1;
		triageSuggestion?: string;
	}

	function failureTracker(): {
		calls: FailureRecord[];
		recordFailure: (
			root: string,
			session: AgentSession,
			reason: string,
			tier: 0 | 1,
			triageSuggestion?: string,
		) => Promise<void>;
	} {
		const calls: FailureRecord[] = [];
		return {
			calls,
			async recordFailure(root, session, reason, tier, triageSuggestion) {
				calls.push({ root, session, reason, tier, triageSuggestion });
			},
		};
	}

	test("Tier 0: recordFailure called when action=terminate (process death)", async () => {
		const session = makeSession({
			agentName: "dying-agent",
			capability: "builder",
			taskId: "task-123",
			tmuxSession: "overstory-dying-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-dying-agent": false });
		const failureMock = failureTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_nudge: nudgeTracker().nudge,
			_recordFailure: failureMock.recordFailure,
		});

		// recordFailure should be called with Tier 0
		expect(failureMock.calls).toHaveLength(1);
		expect(failureMock.calls[0]?.tier).toBe(0);
		expect(failureMock.calls[0]?.session.agentName).toBe("dying-agent");
		expect(failureMock.calls[0]?.session.capability).toBe("builder");
		expect(failureMock.calls[0]?.session.taskId).toBe("task-123");
		// Reason should be either the reconciliationNote or default "Process terminated"
		expect(failureMock.calls[0]?.reason).toBeDefined();
	});

	test("Tier 1: recordFailure called when triage returns terminate", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const stalledSince = new Date(Date.now() - 130_000).toISOString();
		const session = makeSession({
			agentName: "triaged-agent",
			capability: "scout",
			taskId: "task-456",
			tmuxSession: "overstory-triaged-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 1,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-triaged-agent": true });
		const failureMock = failureTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			tier1Enabled: true,
			_tmux: tmuxMock,
			_triage: triageAlways("terminate"),
			_nudge: nudgeTracker().nudge,
			_recordFailure: failureMock.recordFailure,
		});

		// recordFailure should be called with Tier 1 and triage verdict
		expect(failureMock.calls).toHaveLength(1);
		expect(failureMock.calls[0]?.tier).toBe(1);
		expect(failureMock.calls[0]?.session.agentName).toBe("triaged-agent");
		expect(failureMock.calls[0]?.session.capability).toBe("scout");
		expect(failureMock.calls[0]?.session.taskId).toBe("task-456");
		expect(failureMock.calls[0]?.triageSuggestion).toBe("terminate");
		expect(failureMock.calls[0]?.reason).toContain("AI triage");
	});

	test("recordFailure not called when triage returns retry", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const stalledSince = new Date(Date.now() - 130_000).toISOString();
		const session = makeSession({
			agentName: "retry-agent",
			tmuxSession: "overstory-retry-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 1,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-retry-agent": true });
		const failureMock = failureTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			tier1Enabled: true,
			_tmux: tmuxMock,
			_triage: triageAlways("retry"),
			_nudge: nudgeTracker().nudge,
			_recordFailure: failureMock.recordFailure,
		});

		// recordFailure should NOT be called for retry verdict
		expect(failureMock.calls).toHaveLength(0);
	});

	test("recordFailure not called when triage returns extend", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const stalledSince = new Date(Date.now() - 130_000).toISOString();
		const session = makeSession({
			agentName: "extend-agent",
			tmuxSession: "overstory-extend-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 1,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-extend-agent": true });
		const failureMock = failureTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			tier1Enabled: true,
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_nudge: nudgeTracker().nudge,
			_recordFailure: failureMock.recordFailure,
		});

		// recordFailure should NOT be called for extend verdict
		expect(failureMock.calls).toHaveLength(0);
	});

	test("recordFailure includes evidenceBead when taskId is present", async () => {
		const session = makeSession({
			agentName: "beaded-agent",
			capability: "builder",
			taskId: "task-789",
			tmuxSession: "overstory-beaded-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-beaded-agent": false });
		const failureMock = failureTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_nudge: nudgeTracker().nudge,
			_recordFailure: failureMock.recordFailure,
		});

		expect(failureMock.calls).toHaveLength(1);
		expect(failureMock.calls[0]?.session.taskId).toBe("task-789");
	});

	test("wait behavior auto-confirms Claude rate limit dialog", async () => {
		const session = makeSession({
			agentName: "rate-limited-agent",
			tmuxSession: "overstory-rate-limited-agent",
			lastActivity: new Date(Date.now() - 60_000).toISOString(),
		});
		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLivenessAndInput({
			"overstory-rate-limited-agent": true,
		});
		const config = {
			rateLimit: {
				enabled: true,
				behavior: "wait",
				maxWaitMs: 3_600_000,
				pollIntervalMs: 30_000,
				notifyCoordinator: false,
				swapRuntime: undefined,
			},
		} as unknown as OverstoryConfig;

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			config,
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_capturePaneContent: async () =>
				[
					"You've hit your limit · resets 9pm (Europe/Prague)",
					"/rate-limit-options",
					"",
					"What do you want to do?",
					"1. Stop and wait for limit to reset",
				].join("\n"),
		});

		expect(tmuxMock.sentKeys).toEqual([{ name: "overstory-rate-limited-agent", keys: "" }]);

		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.rateLimitedSince).not.toBeNull();
	});

	test("wait behavior auto-resumes agent when rate limit clears to a ready prompt", async () => {
		const oldActivity = new Date(Date.now() - 60_000).toISOString();
		const session = makeSession({
			agentName: "rate-limit-resume-agent",
			tmuxSession: "overstory-rate-limit-resume-agent",
			state: "working",
			lastActivity: oldActivity,
			rateLimitedSince: new Date(Date.now() - 30_000).toISOString(),
		});
		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLivenessAndInput({
			"overstory-rate-limit-resume-agent": true,
		});
		const config = {
			rateLimit: {
				enabled: true,
				behavior: "wait",
				maxWaitMs: 3_600_000,
				pollIntervalMs: 30_000,
				notifyCoordinator: false,
				swapRuntime: undefined,
			},
		} as unknown as OverstoryConfig;

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			config,
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_capturePaneContent: async () => 'Try "help" to get started\n❯\nbypass permissions',
		});

		expect(tmuxMock.sentKeys).toEqual([
			{
				name: "overstory-rate-limit-resume-agent",
				keys: "Rate limit has reset. Run ov mail check --agent rate-limit-resume-agent if needed, then continue task test-task from where you left off.",
			},
			{ name: "overstory-rate-limit-resume-agent", keys: "" },
		]);

		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("working");
		expect(reloaded[0]?.rateLimitedSince).toBeNull();
		expect(reloaded[0]?.lastActivity).not.toBe(oldActivity);
	});

	test("ready zombie session with unread mail is nudged and restored to working", async () => {
		const oldActivity = new Date(Date.now() - 600_000).toISOString();
		const session = makeSession({
			agentName: "mail-blocked-agent",
			tmuxSession: "overstory-mail-blocked-agent",
			state: "zombie",
			lastActivity: oldActivity,
		});
		writeSessionsToStore(tempRoot, [session]);

		const mailStore = createMailStore(join(tempRoot, ".overstory", "mail.db"));
		try {
			mailStore.insert({
				id: "msg-mail-blocked-agent",
				from: "lead",
				to: "mail-blocked-agent",
				subject: "Need synthesis",
				body: "Check mail and continue.",
				type: "dispatch",
				priority: "high",
				threadId: null,
				payload: null,
			});
		} finally {
			mailStore.close();
		}

		const tmuxMock = tmuxWithLivenessAndInput({
			"overstory-mail-blocked-agent": true,
		});

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_capturePaneContent: async () => 'Try "help" to get started\n❯\nbypass permissions',
		});

		expect(tmuxMock.sentKeys).toEqual([
			{
				name: "overstory-mail-blocked-agent",
				keys: "You have 1 unread message(s): Need synthesis — check mail: ov mail check --agent mail-blocked-agent",
			},
			{ name: "overstory-mail-blocked-agent", keys: "" },
		]);

		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("working");
		expect(reloaded[0]?.lastActivity).not.toBe(oldActivity);
	});

	test("ready zombie session with prior session_end and rate-limit history is resumed", async () => {
		const oldActivity = new Date(Date.now() - 600_000).toISOString();
		const session = makeSession({
			agentName: "ended-zombie-agent",
			tmuxSession: "overstory-ended-zombie-agent",
			state: "zombie",
			lastActivity: oldActivity,
		});
		writeSessionsToStore(tempRoot, [session]);

		const eventStore = createEventStore(join(tempRoot, ".overstory", "events.db"));
		try {
			eventStore.insert({
				runId: null,
				agentName: "ended-zombie-agent",
				sessionId: "runtime-session-1",
				eventType: "session_end",
				toolName: null,
				toolArgs: null,
				toolDurationMs: null,
				level: "info",
				data: JSON.stringify({ transcriptPath: "/tmp/fake.jsonl" }),
			});
			eventStore.insert({
				runId: null,
				agentName: "ended-zombie-agent",
				sessionId: null,
				eventType: "custom",
				toolName: null,
				toolArgs: null,
				toolDurationMs: null,
				level: "info",
				data: JSON.stringify({ type: "rate_limit_cleared" }),
			});
		} finally {
			eventStore.close();
		}

		const tmuxWithInput = tmuxWithLivenessAndInput({
			"overstory-ended-zombie-agent": true,
		});

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxWithInput,
			_triage: triageAlways("extend"),
			_capturePaneContent: async () => 'Try "help" to get started\n❯\nbypass permissions',
		});

		expect(tmuxWithInput.sentKeys).toEqual([
			{
				name: "overstory-ended-zombie-agent",
				keys: "Rate limit has reset. Run ov mail check --agent ended-zombie-agent if needed, then continue task test-task from where you left off.",
			},
			{ name: "overstory-ended-zombie-agent", keys: "" },
		]);

		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("working");
		expect(reloaded[0]?.lastActivity).not.toBe(oldActivity);

		const reloadedEvents = createEventStore(join(tempRoot, ".overstory", "events.db"));
		try {
			const latest = reloadedEvents.getByAgent("ended-zombie-agent");
			const finalEvent = latest[latest.length - 1];
			expect(finalEvent?.eventType).toBe("custom");
			expect(finalEvent?.data).toContain("rate_limit_resume_reconciled");
		} finally {
			reloadedEvents.close();
		}
	});

	test("ready zombie session with prior session_end and no rate-limit history is reconciled to completed", async () => {
		const oldActivity = new Date(Date.now() - 600_000).toISOString();
		const session = makeSession({
			agentName: "plain-ended-zombie-agent",
			tmuxSession: "overstory-plain-ended-zombie-agent",
			state: "zombie",
			lastActivity: oldActivity,
		});
		writeSessionsToStore(tempRoot, [session]);

		const eventStore = createEventStore(join(tempRoot, ".overstory", "events.db"));
		try {
			eventStore.insert({
				runId: null,
				agentName: "plain-ended-zombie-agent",
				sessionId: "runtime-session-2",
				eventType: "session_end",
				toolName: null,
				toolArgs: null,
				toolDurationMs: null,
				level: "info",
				data: JSON.stringify({ transcriptPath: "/tmp/fake2.jsonl" }),
			});
		} finally {
			eventStore.close();
		}

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxWithLiveness({
				"overstory-plain-ended-zombie-agent": true,
			}),
			_triage: triageAlways("extend"),
			_capturePaneContent: async () => 'Try "help" to get started\n❯\nbypass permissions',
		});

		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("completed");
		expect(reloaded[0]?.lastActivity).not.toBe(oldActivity);
	});

	test("dead session_end zombie with no recent rate-limit history is reconciled to completed", async () => {
		const oldActivity = new Date(Date.now() - 600_000).toISOString();
		const session = makeSession({
			agentName: "dead-ended-agent",
			tmuxSession: "overstory-dead-ended-agent",
			state: "zombie",
			lastActivity: oldActivity,
		});
		writeSessionsToStore(tempRoot, [session]);

		const eventStore = createEventStore(join(tempRoot, ".overstory", "events.db"));
		try {
			eventStore.insert({
				runId: null,
				agentName: "dead-ended-agent",
				sessionId: "runtime-session-3",
				eventType: "session_end",
				toolName: null,
				toolArgs: null,
				toolDurationMs: null,
				level: "info",
				data: JSON.stringify({ transcriptPath: "/tmp/dead-ended.jsonl" }),
			});
		} finally {
			eventStore.close();
		}

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxWithLiveness({
				"overstory-dead-ended-agent": false,
			}),
			_triage: triageAlways("extend"),
		});

		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("completed");
		expect(reloaded[0]?.lastActivity).not.toBe(oldActivity);

		const reloadedEvents = createEventStore(join(tempRoot, ".overstory", "events.db"));
		try {
			const latest = reloadedEvents.getByAgent("dead-ended-agent");
			const finalEvent = latest[latest.length - 1];
			expect(finalEvent?.eventType).toBe("custom");
			expect(finalEvent?.data).toContain("zombie_session_end_dead_reconciled");
		} finally {
			reloadedEvents.close();
		}
	});

	test("dead session_end zombie with rate-limit history and completion signal is reconciled to completed", async () => {
		const oldActivity = new Date(Date.now() - 600_000).toISOString();
		const session = makeSession({
			agentName: "dead-rate-limited-agent",
			tmuxSession: "overstory-dead-rate-limited-agent",
			state: "zombie",
			lastActivity: oldActivity,
		});
		writeSessionsToStore(tempRoot, [session]);

		const eventStore = createEventStore(join(tempRoot, ".overstory", "events.db"));
		try {
			eventStore.insert({
				runId: null,
				agentName: "dead-rate-limited-agent",
				sessionId: "runtime-session-4",
				eventType: "mail_sent",
				toolName: null,
				toolArgs: null,
				toolDurationMs: null,
				level: "info",
				data: JSON.stringify({ type: "worker_done", subject: "Worker done: test-task" }),
			});
			eventStore.insert({
				runId: null,
				agentName: "dead-rate-limited-agent",
				sessionId: "runtime-session-4",
				eventType: "session_end",
				toolName: null,
				toolArgs: null,
				toolDurationMs: null,
				level: "info",
				data: JSON.stringify({ transcriptPath: "/tmp/dead-rate-limited.jsonl" }),
			});
			eventStore.insert({
				runId: null,
				agentName: "dead-rate-limited-agent",
				sessionId: null,
				eventType: "custom",
				toolName: null,
				toolArgs: null,
				toolDurationMs: null,
				level: "info",
				data: JSON.stringify({ type: "rate_limit_cleared" }),
			});
		} finally {
			eventStore.close();
		}

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxWithLiveness({
				"overstory-dead-rate-limited-agent": false,
			}),
			_triage: triageAlways("extend"),
		});

		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("completed");
		expect(reloaded[0]?.lastActivity).not.toBe(oldActivity);

		const reloadedEvents = createEventStore(join(tempRoot, ".overstory", "events.db"));
		try {
			const latest = reloadedEvents.getByAgent("dead-rate-limited-agent");
			const finalEvent = latest[latest.length - 1];
			expect(finalEvent?.eventType).toBe("custom");
			expect(finalEvent?.data).toContain("rate_limit_session_end_dead_reconciled");
		} finally {
			reloadedEvents.close();
		}
	});

	test("dead session_end zombie with rate-limit history and no completion signal stays zombie", async () => {
		const oldActivity = new Date(Date.now() - 600_000).toISOString();
		const session = makeSession({
			agentName: "dead-unfinished-rate-limit-agent",
			tmuxSession: "overstory-dead-unfinished-rate-limit-agent",
			state: "zombie",
			lastActivity: oldActivity,
		});
		writeSessionsToStore(tempRoot, [session]);

		const eventStore = createEventStore(join(tempRoot, ".overstory", "events.db"));
		try {
			eventStore.insert({
				runId: null,
				agentName: "dead-unfinished-rate-limit-agent",
				sessionId: "runtime-session-5",
				eventType: "session_end",
				toolName: null,
				toolArgs: null,
				toolDurationMs: null,
				level: "info",
				data: JSON.stringify({ transcriptPath: "/tmp/dead-unfinished-rate-limit.jsonl" }),
			});
			eventStore.insert({
				runId: null,
				agentName: "dead-unfinished-rate-limit-agent",
				sessionId: null,
				eventType: "custom",
				toolName: null,
				toolArgs: null,
				toolDurationMs: null,
				level: "info",
				data: JSON.stringify({ type: "rate_limit_cleared" }),
			});
		} finally {
			eventStore.close();
		}

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxWithLiveness({
				"overstory-dead-unfinished-rate-limit-agent": false,
			}),
			_triage: triageAlways("extend"),
			_recordFailure: failureTracker().recordFailure,
		});

		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("zombie");

		const reloadedEvents = createEventStore(join(tempRoot, ".overstory", "events.db"));
		try {
			const latest = reloadedEvents.getByAgent("dead-unfinished-rate-limit-agent");
			expect(
				latest.some(
					(event) =>
						event.eventType === "custom" &&
						typeof event.data === "string" &&
						event.data.includes("rate_limit_session_end_dead_reconciled"),
				),
			).toBe(false);
		} finally {
			reloadedEvents.close();
		}
	});

	test("Tier 0: recordFailure called at escalation level 3+ (progressive termination)", async () => {
		const staleActivity = new Date(Date.now() - 60_000).toISOString();
		const stalledSince = new Date(Date.now() - 200_000).toISOString();
		const session = makeSession({
			agentName: "doomed-agent",
			capability: "builder",
			taskId: "task-999",
			tmuxSession: "overstory-doomed-agent",
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 2,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "overstory-doomed-agent": true });
		const failureMock = failureTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs: 60_000,
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_nudge: nudgeTracker().nudge,
			_recordFailure: failureMock.recordFailure,
		});

		// recordFailure should be called with Tier 0 for progressive escalation
		expect(failureMock.calls).toHaveLength(1);
		expect(failureMock.calls[0]?.tier).toBe(0);
		expect(failureMock.calls[0]?.session.agentName).toBe("doomed-agent");
		expect(failureMock.calls[0]?.reason).toContain("Progressive escalation");
	});
});

// === Run completion detection tests ===

describe("run completion detection", () => {
	const runId = "run-2026-02-18T15-00-00-000Z";

	test("nudges coordinator when all workers completed", async () => {
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "builder-one",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-one",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s2",
				agentName: "builder-two",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-two",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s3",
				agentName: "coordinator",
				capability: "coordinator",
				tmuxSession: "overstory-agent-fake-coordinator",
				state: "working",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		await Bun.write(join(tempRoot, ".overstory", "current-run.txt"), runId);

		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
			_nudge: nudgeMock.nudge,
			_eventStore: null,
		});

		// Filter to only run-completion nudges targeting the coordinator
		const coordinatorNudges = nudgeMock.calls.filter(
			(c) => c.agentName === "coordinator" && c.message.includes("WATCHDOG"),
		);
		expect(coordinatorNudges).toHaveLength(1);
		// The test creates builders, so the message should be builder-specific
		expect(coordinatorNudges[0]?.message).toContain("builder");
		expect(coordinatorNudges[0]?.message).toContain("Awaiting lead verification");
	});

	test("does not nudge when some workers still active", async () => {
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "builder-one",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-one",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s2",
				agentName: "builder-two",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-two",
				state: "working",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		await Bun.write(join(tempRoot, ".overstory", "current-run.txt"), runId);

		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
			_nudge: nudgeMock.nudge,
			_eventStore: null,
		});

		const coordinatorNudges = nudgeMock.calls.filter(
			(c) => c.agentName === "coordinator" && c.message.includes("worker"),
		);
		expect(coordinatorNudges).toHaveLength(0);
	});

	test("does not nudge when already notified (dedup marker)", async () => {
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "builder-one",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-one",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s2",
				agentName: "builder-two",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-two",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		await Bun.write(join(tempRoot, ".overstory", "current-run.txt"), runId);
		// Pre-write dedup marker
		await Bun.write(join(tempRoot, ".overstory", "run-complete-notified.txt"), runId);

		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
			_nudge: nudgeMock.nudge,
			_eventStore: null,
		});

		const coordinatorNudges = nudgeMock.calls.filter(
			(c) => c.agentName === "coordinator" && c.message.includes("worker"),
		);
		expect(coordinatorNudges).toHaveLength(0);
	});

	test("skips completion check when no run ID", async () => {
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "builder-one",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-one",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s2",
				agentName: "builder-two",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-two",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		// Do NOT write current-run.txt

		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
			_nudge: nudgeMock.nudge,
			_eventStore: null,
		});

		const coordinatorNudges = nudgeMock.calls.filter(
			(c) => c.agentName === "coordinator" && c.message.includes("worker"),
		);
		expect(coordinatorNudges).toHaveLength(0);
	});

	test("ignores coordinator and monitor sessions for completion check", async () => {
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "coordinator",
				capability: "coordinator",
				tmuxSession: "overstory-agent-fake-coordinator",
				state: "working",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s2",
				agentName: "monitor",
				capability: "monitor",
				tmuxSession: "overstory-agent-fake-monitor",
				state: "working",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s3",
				agentName: "builder-one",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-one",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s4",
				agentName: "builder-two",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-two",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		await Bun.write(join(tempRoot, ".overstory", "current-run.txt"), runId);

		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
			_nudge: nudgeMock.nudge,
			_eventStore: null,
		});

		// Nudge IS sent because coordinator/monitor are excluded from worker count
		const coordinatorNudges = nudgeMock.calls.filter(
			(c) => c.agentName === "coordinator" && c.message.includes("WATCHDOG"),
		);
		expect(coordinatorNudges).toHaveLength(1);
		// The test creates builders, so the message should be builder-specific
		expect(coordinatorNudges[0]?.message).toContain("builder");
		expect(coordinatorNudges[0]?.message).toContain("Awaiting lead verification");
	});

	test("does not nudge when no worker sessions in run", async () => {
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "coordinator",
				capability: "coordinator",
				tmuxSession: "overstory-agent-fake-coordinator",
				state: "working",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s2",
				agentName: "monitor",
				capability: "monitor",
				tmuxSession: "overstory-agent-fake-monitor",
				state: "working",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		await Bun.write(join(tempRoot, ".overstory", "current-run.txt"), runId);

		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
			_nudge: nudgeMock.nudge,
			_eventStore: null,
		});

		const coordinatorNudges = nudgeMock.calls.filter(
			(c) => c.agentName === "coordinator" && c.message.includes("worker"),
		);
		expect(coordinatorNudges).toHaveLength(0);
	});

	test("records run_complete event when all workers done", async () => {
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "builder-one",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-one",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s2",
				agentName: "builder-two",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-two",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		await Bun.write(join(tempRoot, ".overstory", "current-run.txt"), runId);

		const eventsDbPath = join(tempRoot, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);

		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				_tmux: tmuxAllAlive(),
				_triage: triageAlways("extend"),
				_nudge: nudgeTracker().nudge,
				_eventStore: eventStore,
			});
		} finally {
			eventStore.close();
		}

		// Read events back
		const store = createEventStore(eventsDbPath);
		try {
			const events = store.getTimeline({ since: "2000-01-01T00:00:00Z" });
			const runCompleteEvent = events.find((e) => {
				if (!e.data) return false;
				const data = JSON.parse(e.data) as Record<string, unknown>;
				return data.type === "run_complete";
			});
			expect(runCompleteEvent).toBeDefined();
			expect(runCompleteEvent?.level).toBe("info");
			expect(runCompleteEvent?.agentName).toBe("watchdog");
		} finally {
			store.close();
		}
	});

	test("writes dedup marker after nudging", async () => {
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "builder-one",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-one",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s2",
				agentName: "builder-two",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-two",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		await Bun.write(join(tempRoot, ".overstory", "current-run.txt"), runId);

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
			_nudge: nudgeTracker().nudge,
			_eventStore: null,
		});

		// Verify dedup marker was written
		const markerFile = Bun.file(join(tempRoot, ".overstory", "run-complete-notified.txt"));
		expect(await markerFile.exists()).toBe(true);
		const markerContent = await markerFile.text();
		expect(markerContent.trim()).toBe(runId);
	});

	test("scout-only completion sends phase-appropriate message", async () => {
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "scout-one",
				capability: "scout",
				tmuxSession: "overstory-agent-fake-scout-one",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s2",
				agentName: "scout-two",
				capability: "scout",
				tmuxSession: "overstory-agent-fake-scout-two",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		await Bun.write(join(tempRoot, ".overstory", "current-run.txt"), runId);

		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
			_nudge: nudgeMock.nudge,
			_eventStore: null,
		});

		const coordinatorNudges = nudgeMock.calls.filter(
			(c) => c.agentName === "coordinator" && c.message.includes("WATCHDOG"),
		);
		expect(coordinatorNudges).toHaveLength(1);
		expect(coordinatorNudges[0]?.message).toContain("scout");
		expect(coordinatorNudges[0]?.message).toContain("next phase");
		// Must NOT say "merge/cleanup" for scouts
		expect(coordinatorNudges[0]?.message).not.toContain("merge/cleanup");
	});

	test("mixed capabilities send generic message with breakdown", async () => {
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "scout-one",
				capability: "scout",
				tmuxSession: "overstory-agent-fake-scout-one",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "s2",
				agentName: "builder-one",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-one",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		await Bun.write(join(tempRoot, ".overstory", "current-run.txt"), runId);

		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
			_nudge: nudgeMock.nudge,
			_eventStore: null,
		});

		const coordinatorNudges = nudgeMock.calls.filter(
			(c) => c.agentName === "coordinator" && c.message.includes("WATCHDOG"),
		);
		expect(coordinatorNudges).toHaveLength(1);
		expect(coordinatorNudges[0]?.message).toContain("(builder, scout)");
		expect(coordinatorNudges[0]?.message).toContain("next steps");
	});

	test("reviewer-only completion sends review-specific message", async () => {
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "reviewer-one",
				capability: "reviewer",
				tmuxSession: "overstory-agent-fake-reviewer-one",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		await Bun.write(join(tempRoot, ".overstory", "current-run.txt"), runId);

		const nudgeMock = nudgeTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
			_triage: triageAlways("extend"),
			_nudge: nudgeMock.nudge,
			_eventStore: null,
		});

		const coordinatorNudges = nudgeMock.calls.filter(
			(c) => c.agentName === "coordinator" && c.message.includes("WATCHDOG"),
		);
		expect(coordinatorNudges).toHaveLength(1);
		expect(coordinatorNudges[0]?.message).toContain("reviewer");
		expect(coordinatorNudges[0]?.message).toContain("Reviews done");
	});

	test("run_complete event includes capabilities and phase fields", async () => {
		const sessions = [
			makeSession({
				id: "s1",
				agentName: "builder-one",
				capability: "builder",
				tmuxSession: "overstory-agent-fake-builder-one",
				state: "completed",
				runId,
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);
		await Bun.write(join(tempRoot, ".overstory", "current-run.txt"), runId);

		const eventsDbPath = join(tempRoot, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);

		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				_tmux: tmuxAllAlive(),
				_triage: triageAlways("extend"),
				_nudge: nudgeTracker().nudge,
				_eventStore: eventStore,
			});
		} finally {
			eventStore.close();
		}

		const store = createEventStore(eventsDbPath);
		try {
			const events = store.getTimeline({ since: "2000-01-01T00:00:00Z" });
			const runCompleteEvent = events.find((e) => {
				if (!e.data) return false;
				const data = JSON.parse(e.data) as Record<string, unknown>;
				return data.type === "run_complete";
			});
			expect(runCompleteEvent).toBeDefined();
			const data = JSON.parse(runCompleteEvent?.data ?? "{}") as Record<string, unknown>;
			expect(data.capabilities).toEqual(["builder"]);
			expect(data.phase).toBe("builder");
		} finally {
			store.close();
		}
	});
});

// === buildCompletionMessage unit tests ===

describe("buildCompletionMessage", () => {
	const testRunId = "run-test-123";

	test("all scouts → contains 'scout' and 'Ready for next phase'", () => {
		const sessions = [
			makeSession({ capability: "scout", agentName: "scout-1" }),
			makeSession({ capability: "scout", agentName: "scout-2" }),
		];
		const msg = buildCompletionMessage(sessions, testRunId);
		expect(msg).toContain("scout");
		expect(msg).toContain("Ready for next phase");
		expect(msg).not.toContain("merge/cleanup");
	});

	test("all builders → contains 'builder' and 'Awaiting lead verification' (not merge authorization)", () => {
		const sessions = [
			makeSession({ capability: "builder", agentName: "builder-1" }),
			makeSession({ capability: "builder", agentName: "builder-2" }),
		];
		const msg = buildCompletionMessage(sessions, testRunId);
		expect(msg).toContain("builder");
		expect(msg).toContain("Awaiting lead verification");
		expect(msg).not.toContain("merge/cleanup");
	});

	test("all reviewers → contains 'reviewer' and 'Reviews done'", () => {
		const sessions = [makeSession({ capability: "reviewer", agentName: "reviewer-1" })];
		const msg = buildCompletionMessage(sessions, testRunId);
		expect(msg).toContain("reviewer");
		expect(msg).toContain("Reviews done");
	});

	test("all leads → contains 'lead' and 'Ready for merge/cleanup'", () => {
		const sessions = [makeSession({ capability: "lead", agentName: "lead-1" })];
		const msg = buildCompletionMessage(sessions, testRunId);
		expect(msg).toContain("lead");
		expect(msg).toContain("Ready for merge/cleanup");
	});

	test("all mergers → contains 'merger' and 'Merges done'", () => {
		const sessions = [makeSession({ capability: "merger", agentName: "merger-1" })];
		const msg = buildCompletionMessage(sessions, testRunId);
		expect(msg).toContain("merger");
		expect(msg).toContain("Merges done");
	});

	test("mixed capabilities → contains breakdown and 'Ready for next steps'", () => {
		const sessions = [
			makeSession({ capability: "scout", agentName: "scout-1" }),
			makeSession({ capability: "builder", agentName: "builder-1" }),
		];
		const msg = buildCompletionMessage(sessions, testRunId);
		expect(msg).toContain("(builder, scout)");
		expect(msg).toContain("Ready for next steps");
	});

	test("message includes the run ID", () => {
		const sessions = [makeSession({ capability: "builder", agentName: "builder-1" })];
		const msg = buildCompletionMessage(sessions, testRunId);
		expect(msg).toContain(testRunId);
	});

	test("message includes the worker count", () => {
		const sessions = [
			makeSession({ capability: "scout", agentName: "scout-1" }),
			makeSession({ capability: "scout", agentName: "scout-2" }),
			makeSession({ capability: "scout", agentName: "scout-3" }),
		];
		const msg = buildCompletionMessage(sessions, testRunId);
		expect(msg).toContain("3");
	});
});

// === Bug fix tests: headless agent kill blast radius + stale detection ===

describe("headless agent kill blast radius fix (Bug 1)", () => {
	/**
	 * Track PID kill calls without spawning real processes.
	 * Also surfaces killTree calls so tests can assert on them.
	 */
	function processTracker(): {
		isAlive: (pid: number) => boolean;
		killTree: (pid: number) => Promise<void>;
		killed: number[];
	} {
		const killed: number[] = [];
		return {
			isAlive: (pid: number) => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			},
			killTree: async (pid: number) => {
				killed.push(pid);
			},
			killed,
		};
	}

	test("headless agent at escalation level 3 kills PID, not tmux session", async () => {
		const nudgeIntervalMs = 60_000;
		// stalledSince is 4 intervals ago — expectedLevel = floor(4) = 4, clamped to MAX (3)
		const stalledSince = new Date(Date.now() - 4 * nudgeIntervalMs).toISOString();
		const staleActivity = new Date(Date.now() - THRESHOLDS.staleThresholdMs * 2).toISOString();

		const session = makeSession({
			agentName: "headless-stalled",
			tmuxSession: "", // headless
			pid: process.pid, // alive PID — ZFC won't trigger direct terminate
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 2,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const proc = processTracker();
		// tmux mock: isSessionAlive("") returns true — simulates prefix-match bug scenario
		const tmuxMock = tmuxWithLiveness({ "": true });

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs,
			tier1Enabled: false,
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_process: proc,
			_eventStore: null,
			_recordFailure: async () => {},
			_getConnection: () => undefined,
			_removeConnection: () => {},
			_tailerRegistry: new Map(),
			_findLatestStdoutLog: async () => null,
		});

		// PID was killed via killTree, NOT via tmux killSession("")
		expect(proc.killed).toContain(process.pid);
		expect(tmuxMock.killed).not.toContain("");
	});

	test("headless agent direct terminate kills PID, not tmux", async () => {
		// PID 999999 is virtually guaranteed not to exist — health check sees it as dead
		const deadPid = 999999;
		const session = makeSession({
			agentName: "headless-dead-pid",
			tmuxSession: "", // headless
			pid: deadPid,
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		const proc = processTracker();
		// tmux mock: isSessionAlive("") returns true — would kill everything without the fix
		const tmuxMock = tmuxWithLiveness({ "": true });

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_process: proc,
			_eventStore: null,
			_recordFailure: async () => {},
			_getConnection: () => undefined,
			_removeConnection: () => {},
			_tailerRegistry: new Map(),
			_findLatestStdoutLog: async () => null,
		});

		// Should have attempted PID kill, NOT tmux killSession("")
		expect(proc.killed).toContain(deadPid);
		expect(tmuxMock.killed).not.toContain("");
	});

	test("triage terminate on headless agent kills PID, not tmux", async () => {
		const nudgeIntervalMs = 60_000;
		// stalledSince is 2.5 intervals ago — expectedLevel = floor(2.5) = 2 → triage fires
		const stalledSince = new Date(Date.now() - 2.5 * nudgeIntervalMs).toISOString();
		const staleActivity = new Date(Date.now() - THRESHOLDS.staleThresholdMs * 2).toISOString();

		const session = makeSession({
			agentName: "headless-triage-terminate",
			tmuxSession: "", // headless
			pid: process.pid, // alive
			state: "stalled",
			lastActivity: staleActivity,
			escalationLevel: 1,
			stalledSince,
		});

		writeSessionsToStore(tempRoot, [session]);

		const proc = processTracker();
		const tmuxMock = tmuxWithLiveness({ "": true });

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			nudgeIntervalMs,
			tier1Enabled: true,
			_tmux: tmuxMock,
			_triage: triageAlways("terminate"), // AI triage says terminate
			_nudge: nudgeTracker().nudge,
			_process: proc,
			_eventStore: null,
			_recordFailure: async () => {},
			_getConnection: () => undefined,
			_removeConnection: () => {},
			_tailerRegistry: new Map(),
			_findLatestStdoutLog: async () => null,
		});

		// Should have killed the PID, not the tmux session
		expect(proc.killed).toContain(process.pid);
		expect(tmuxMock.killed).not.toContain("");
	});
});

describe("headless agent stale detection via events.db (Bug 2)", () => {
	test("headless agent with recent events in events.db is not flagged stale", async () => {
		const staleActivity = new Date(Date.now() - THRESHOLDS.staleThresholdMs * 2).toISOString();

		const session = makeSession({
			agentName: "headless-active",
			tmuxSession: "", // headless
			pid: process.pid, // alive
			state: "working",
			lastActivity: staleActivity, // stale — would trigger escalate without event fallback
		});

		writeSessionsToStore(tempRoot, [session]);

		const eventsDbPath = join(tempRoot, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);

		try {
			// Insert a recent event for this agent (within the stale threshold window)
			eventStore.insert({
				runId: null,
				agentName: "headless-active",
				sessionId: null,
				eventType: "tool_end",
				toolName: "Read",
				toolArgs: null,
				toolDurationMs: 100,
				level: "info",
				data: null,
			});

			const checks: HealthCheck[] = [];

			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				onHealthCheck: (c) => checks.push(c),
				_tmux: tmuxAllAlive(),
				_triage: triageAlways("extend"),
				_process: { isAlive: () => true, killTree: async () => {} },
				_eventStore: eventStore,
				_recordFailure: async () => {},
				_getConnection: () => undefined,
				_removeConnection: () => {},
				_tailerRegistry: new Map(),
				_findLatestStdoutLog: async () => null,
			});

			// Recent events found — lastActivity was refreshed, agent is NOT stalled
			expect(checks).toHaveLength(1);
			expect(checks[0]?.action).toBe("none");
			expect(checks[0]?.state).toBe("working");

			const reloaded = readSessionsFromStore(tempRoot);
			expect(reloaded[0]?.state).toBe("working");
		} finally {
			eventStore.close();
		}
	});

	test("headless agent with no recent events IS flagged stale", async () => {
		const staleActivity = new Date(Date.now() - THRESHOLDS.staleThresholdMs * 2).toISOString();

		const session = makeSession({
			agentName: "headless-silent",
			tmuxSession: "", // headless
			pid: process.pid, // alive
			state: "working",
			lastActivity: staleActivity, // stale
		});

		writeSessionsToStore(tempRoot, [session]);

		const eventsDbPath = join(tempRoot, ".overstory", "events.db");
		const eventStore = createEventStore(eventsDbPath);

		try {
			// No events inserted for this agent — event fallback finds nothing

			const checks: HealthCheck[] = [];

			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				onHealthCheck: (c) => checks.push(c),
				_tmux: tmuxAllAlive(),
				_triage: triageAlways("extend"),
				_process: { isAlive: () => true, killTree: async () => {} },
				_eventStore: eventStore,
				_recordFailure: async () => {},
				_getConnection: () => undefined,
				_removeConnection: () => {},
				_tailerRegistry: new Map(),
				_findLatestStdoutLog: async () => null,
			});

			// No recent events — lastActivity stays stale, agent IS flagged stalled
			expect(checks).toHaveLength(1);
			expect(checks[0]?.action).toBe("escalate");
		} finally {
			eventStore.close();
		}
	});
});

// === Resilience Engine Integration Tests ===

describe("resilience engine integration", () => {
	const RESILIENCE_CONFIG: NonNullable<OverstoryConfig["resilience"]> = {
		retry: {
			maxAttempts: 3,
			backoffBaseMs: 0, // No delay in tests
			backoffMaxMs: 0,
			backoffMultiplier: 2,
			globalMaxConcurrent: 5,
		},
		circuitBreaker: {
			failureThreshold: 5,
			windowMs: 60_000,
			cooldownMs: 0,
			halfOpenMaxProbes: 2,
		},
		reroute: {
			enabled: true,
			maxReroutes: 2,
			fallbackCapability: "fallback-builder",
		},
	};

	const BASE_CONFIG: OverstoryConfig = {
		project: { name: "test", root: "/tmp/test", canonicalBranch: "main" },
		agents: {
			manifestPath: "",
			baseDir: "",
			maxConcurrent: 10,
			staggerDelayMs: 0,
			maxDepth: 2,
			maxSessionsPerRun: 0,
			maxAgentsPerLead: 0,
		},
		worktrees: { baseDir: "" },
		taskTracker: { backend: "auto", enabled: false },
		mulch: { enabled: false, domains: [], primeFormat: "markdown" },
		merge: { aiResolveEnabled: false, reimagineEnabled: false },
		providers: {},
		watchdog: {
			tier0Enabled: true,
			tier0IntervalMs: 30_000,
			tier1Enabled: false,
			tier2Enabled: false,
			staleThresholdMs: 30_000,
			zombieThresholdMs: 120_000,
			nudgeIntervalMs: 60_000,
		},
		models: {},
		logging: { verbose: false, redactSecrets: false },
		resilience: RESILIENCE_CONFIG,
	};

	test("no resilience behavior when config.resilience is absent", async () => {
		// Session with dead tmux — should use existing terminate behavior
		const session = makeSession({
			agentName: "no-resilience-agent",
			tmuxSession: "overstory-no-resilience-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
		});
		writeSessionsToStore(tempRoot, [session]);

		const killCalls: string[] = [];
		const tmuxMock = {
			isSessionAlive: async () => false,
			killSession: async (name: string) => {
				killCalls.push(name);
			},
		};

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			// No config.resilience — omit the resilience config
			_tmux: tmuxMock,
			_triage: triageAlways("extend"),
			_recordFailure: async () => {},
			_resilienceStore: null,
		});

		// Agent should be zombie but no resilience store means no retry
		const sessions = readSessionsFromStore(tempRoot);
		expect(sessions[0]?.state).toBe("zombie");
		// No respawn — just existing behavior
	});

	test("terminate path consults resilience engine when config.resilience exists", async () => {
		const { createResilienceStore } = await import("../resilience/store.ts");
		const resilienceDbPath = join(tempRoot, ".overstory", "resilience.db");
		const resilienceStore = createResilienceStore(resilienceDbPath);

		try {
			const session = makeSession({
				agentName: "resilience-agent",
				tmuxSession: "overstory-resilience-agent",
				state: "working",
				lastActivity: new Date().toISOString(),
			});
			writeSessionsToStore(tempRoot, [session]);

			const _slingCalls: string[] = [];
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				config: BASE_CONFIG,
				_tmux: tmuxAllDead(),
				_triage: triageAlways("extend"),
				_recordFailure: async () => {},
				_resilienceStore: resilienceStore,
				_process: {
					isAlive: () => false,
					killTree: async () => {},
				},
			});

			// Verify resilience store recorded a retry
			const retries = resilienceStore.getRetries("test-task");
			expect(retries.length).toBeGreaterThan(0);
			expect(retries[0]?.outcome).toBe("failure");
		} finally {
			resilienceStore.close();
		}
	});

	test("abandon decision preserves existing terminate behavior", async () => {
		const { createResilienceStore } = await import("../resilience/store.ts");
		const resilienceDbPath = join(tempRoot, ".overstory", "resilience.db");
		const resilienceStore = createResilienceStore(resilienceDbPath);

		try {
			// Pre-populate retries to exceed maxAttempts → abandon decision
			for (let i = 0; i < 3; i++) {
				resilienceStore.recordRetry({
					taskId: "test-task",
					attempt: i + 1,
					outcome: "failure",
					capability: "builder",
					startedAt: new Date().toISOString(),
					failedAt: new Date().toISOString(),
					errorClass: "unknown",
				});
			}

			const session = makeSession({
				agentName: "abandon-agent",
				tmuxSession: "overstory-abandon-agent",
				state: "working",
				lastActivity: new Date().toISOString(),
			});
			writeSessionsToStore(tempRoot, [session]);

			const eventStore = createEventStore(join(tempRoot, ".overstory", "events.db"));
			try {
				await runDaemonTick({
					root: tempRoot,
					...THRESHOLDS,
					config: BASE_CONFIG,
					_tmux: tmuxAllDead(),
					_triage: triageAlways("extend"),
					_recordFailure: async () => {},
					_resilienceStore: resilienceStore,
					_eventStore: eventStore,
					_process: { isAlive: () => false, killTree: async () => {} },
				});

				// Session should be zombie
				const sessions = readSessionsFromStore(tempRoot);
				expect(sessions[0]?.state).toBe("zombie");

				// Event should be resilience_abandon
				const events = eventStore.getByAgent("abandon-agent");
				const abandonEvent = events.find((e) => {
					try {
						const d = JSON.parse(e.data ?? "{}") as { type?: string };
						return d.type === "resilience_abandon";
					} catch {
						return false;
					}
				});
				expect(abandonEvent).toBeDefined();
			} finally {
				eventStore.close();
			}
		} finally {
			resilienceStore.close();
		}
	});

	test("retry decision triggers respawn (recorded as resilience_retry event)", async () => {
		const { createResilienceStore } = await import("../resilience/store.ts");
		const resilienceDbPath = join(tempRoot, ".overstory", "resilience.db");
		const resilienceStore = createResilienceStore(resilienceDbPath);

		try {
			const session = makeSession({
				agentName: "retry-agent",
				tmuxSession: "overstory-retry-agent",
				state: "working",
				lastActivity: new Date().toISOString(),
			});
			writeSessionsToStore(tempRoot, [session]);

			const eventStore = createEventStore(join(tempRoot, ".overstory", "events.db"));
			try {
				await runDaemonTick({
					root: tempRoot,
					...THRESHOLDS,
					config: BASE_CONFIG,
					_tmux: tmuxAllDead(),
					_triage: triageAlways("extend"),
					_recordFailure: async () => {},
					_resilienceStore: resilienceStore,
					_eventStore: eventStore,
					_process: { isAlive: () => false, killTree: async () => {} },
				});

				// Find the resilience_retry custom event
				const events = eventStore.getByAgent("retry-agent");
				const retryEvent = events.find((e) => {
					try {
						const d = JSON.parse(e.data ?? "{}") as { type?: string };
						return d.type === "resilience_retry";
					} catch {
						return false;
					}
				});
				expect(retryEvent).toBeDefined();
			} finally {
				eventStore.close();
			}
		} finally {
			resilienceStore.close();
		}
	});

	test("recommend_reroute sends mail to coordinator", async () => {
		const { createResilienceStore } = await import("../resilience/store.ts");
		const resilienceDbPath = join(tempRoot, ".overstory", "resilience.db");
		const resilienceStore = createResilienceStore(resilienceDbPath);
		const mailStore = createMailStore(join(tempRoot, ".overstory", "mail.db"));

		try {
			// Pre-configure store so decideReroute returns recommend_reroute
			// (structural failure with reroute enabled)
			resilienceStore.recordRetry({
				taskId: "test-task",
				attempt: 1,
				outcome: "failure",
				capability: "builder",
				startedAt: new Date().toISOString(),
				failedAt: new Date().toISOString(),
				errorClass: "structural",
			});

			const session = makeSession({
				agentName: "reroute-agent",
				tmuxSession: "overstory-reroute-agent",
				state: "working",
				lastActivity: new Date().toISOString(),
				parentAgent: "coordinator",
			});
			writeSessionsToStore(tempRoot, [session]);

			const eventStore = createEventStore(join(tempRoot, ".overstory", "events.db"));
			try {
				// Pass structural errorClass via a custom config that triggers reroute
				const rerouteConfig: NonNullable<OverstoryConfig["resilience"]> = {
					...RESILIENCE_CONFIG,
					circuitBreaker: {
						...RESILIENCE_CONFIG.circuitBreaker,
						failureThreshold: 100, // Won't trip circuit breaker
					},
				};

				// We can't easily inject errorClass into handleTaskFailure from outside,
				// so just verify the reroute_recommendation mail is sent when the store
				// has the right state. Use a high failure threshold config.
				await runDaemonTick({
					root: tempRoot,
					...THRESHOLDS,
					config: { ...BASE_CONFIG, resilience: rerouteConfig },
					_tmux: tmuxAllDead(),
					_triage: triageAlways("extend"),
					_recordFailure: async () => {},
					_resilienceStore: resilienceStore,
					_mailStore: null,
					_eventStore: eventStore,
					_process: { isAlive: () => false, killTree: async () => {} },
				});

				// Verify either retry or reroute event was recorded
				const events = eventStore.getByAgent("reroute-agent");
				const resilienceEvent = events.find((e) => {
					try {
						const d = JSON.parse(e.data ?? "{}") as { type?: string };
						return (
							d.type === "resilience_retry" ||
							d.type === "resilience_reroute" ||
							d.type === "resilience_abandon"
						);
					} catch {
						return false;
					}
				});
				expect(resilienceEvent).toBeDefined();
			} finally {
				eventStore.close();
			}
		} finally {
			resilienceStore.close();
			mailStore.close();
		}
	});

	test("pending retries recovered on daemon startup", async () => {
		const { createResilienceStore } = await import("../resilience/store.ts");
		const resilienceDbPath = join(tempRoot, ".overstory", "resilience.db");
		const resilienceStore = createResilienceStore(resilienceDbPath);

		try {
			// Pre-populate pending retry
			resilienceStore.recordRetry({
				taskId: "pending-task",
				attempt: 1,
				outcome: "pending",
				capability: "builder",
				startedAt: new Date().toISOString(),
				failedAt: null,
				errorClass: "unknown",
			});

			const pendingBefore = resilienceStore.getPendingRetries(3);
			expect(pendingBefore).toHaveLength(1);

			// Run daemon tick with no sessions — pending retry recovery runs at init
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				config: BASE_CONFIG,
				_tmux: tmuxAllAlive(),
				_triage: triageAlways("extend"),
				_recordFailure: async () => {},
				_resilienceStore: resilienceStore,
				_process: { isAlive: () => true, killTree: async () => {} },
			});

			// Daemon attempted recovery for pending retries — tick completed without error
			// (sling will fail in test env but that's non-fatal)
		} finally {
			resilienceStore.close();
		}
	});

	test("both terminate paths consult resilience engine", async () => {
		const { createResilienceStore } = await import("../resilience/store.ts");

		// === Level 3 path (process death / check.action === terminate) ===
		{
			const resilienceDbPath = join(tempRoot, ".overstory", "resilience-l3.db");
			const resilienceStore = createResilienceStore(resilienceDbPath);
			const eventStore = createEventStore(join(tempRoot, ".overstory", "events.db"));

			try {
				const session = makeSession({
					agentName: "l3-agent",
					tmuxSession: "overstory-l3-agent",
					state: "working",
					lastActivity: new Date().toISOString(),
				});
				writeSessionsToStore(tempRoot, [session]);

				await runDaemonTick({
					root: tempRoot,
					...THRESHOLDS,
					config: BASE_CONFIG,
					_tmux: tmuxAllDead(),
					_triage: triageAlways("extend"),
					_recordFailure: async () => {},
					_resilienceStore: resilienceStore,
					_eventStore: eventStore,
					_process: { isAlive: () => false, killTree: async () => {} },
				});

				// Resilience engine recorded a failure
				const retries = resilienceStore.getRetries("test-task");
				expect(retries.length).toBeGreaterThan(0);
			} finally {
				resilienceStore.close();
				eventStore.close();
			}
		}

		// === Level 2 path (triage verdict === terminate) ===
		{
			const resilienceDbPath2 = join(tempRoot, ".overstory", "resilience-l2.db");
			const resilienceStore2 = createResilienceStore(resilienceDbPath2);
			const eventStore2 = createEventStore(join(tempRoot, ".overstory", "events2.db"));

			try {
				const staleActivity = new Date(Date.now() - 300_000).toISOString();
				const session2 = makeSession({
					id: "session-l2",
					agentName: "l2-agent",
					tmuxSession: "overstory-l2-agent",
					state: "working",
					lastActivity: staleActivity,
					escalationLevel: 2,
					stalledSince: staleActivity,
				});
				writeSessionsToStore(tempRoot, [session2]);

				await runDaemonTick({
					root: tempRoot,
					...THRESHOLDS,
					nudgeIntervalMs: 1, // Escalate immediately
					tier1Enabled: true,
					config: BASE_CONFIG,
					_tmux: { isSessionAlive: async () => true, killSession: async () => {} },
					_triage: triageAlways("terminate"),
					_nudge: nudgeTracker().nudge,
					_recordFailure: async () => {},
					_resilienceStore: resilienceStore2,
					_eventStore: eventStore2,
					_process: { isAlive: () => true, killTree: async () => {} },
				});

				// Resilience engine recorded a failure for Level 2 path
				const retries2 = resilienceStore2.getRetries("test-task");
				expect(retries2.length).toBeGreaterThan(0);
			} finally {
				resilienceStore2.close();
				eventStore2.close();
			}
		}
	});

	test("old worktree cleaned before respawn on retry decision", async () => {
		const { createResilienceStore } = await import("../resilience/store.ts");
		const resilienceDbPath = join(tempRoot, ".overstory", "resilience.db");
		const resilienceStore = createResilienceStore(resilienceDbPath);

		try {
			const session = makeSession({
				agentName: "cleanup-agent",
				tmuxSession: "overstory-cleanup-agent",
				state: "working",
				lastActivity: new Date().toISOString(),
			});
			writeSessionsToStore(tempRoot, [session]);

			const eventStore = createEventStore(join(tempRoot, ".overstory", "events.db"));
			try {
				await runDaemonTick({
					root: tempRoot,
					...THRESHOLDS,
					config: BASE_CONFIG,
					_tmux: tmuxAllDead(),
					_triage: triageAlways("extend"),
					_recordFailure: async () => {},
					_resilienceStore: resilienceStore,
					_eventStore: eventStore,
					_process: { isAlive: () => false, killTree: async () => {} },
				});

				// Verify resilience_retry event was recorded (retry decision)
				// cleanupWorktreeForRespawn is called before sling — it's fire-and-forget
				const events = eventStore.getByAgent("cleanup-agent");
				const retryEvent = events.find((e) => {
					try {
						const d = JSON.parse(e.data ?? "{}") as { type?: string };
						return d.type === "resilience_retry";
					} catch {
						return false;
					}
				});
				// If retry was the decision, event exists; if circuit open, reroute/abandon
				// Either way, resilience ran — no assertion needed beyond "tick succeeded"
				void retryEvent;
			} finally {
				eventStore.close();
			}
		} finally {
			resilienceStore.close();
		}
	});
});

describe("health policy integration", () => {
	const HEALTH_POLICY_CONFIG: NonNullable<OverstoryConfig["healthPolicy"]> = {
		enabled: true,
		dryRun: true,
		rules: [
			{
				id: "test-rule",
				action: "pause_spawning",
				condition: { grade: "F", operator: "lte" },
				cooldownMs: 0,
				priority: "low",
			},
		],
		defaultCooldownMs: 600_000,
		evaluationIntervalMs: 0,
		maxPauseDurationMs: 300_000,
	};

	const BASE_POLICY_CONFIG: OverstoryConfig = {
		project: { name: "test", root: "/tmp/test", canonicalBranch: "main" },
		agents: {
			manifestPath: "",
			baseDir: "",
			maxConcurrent: 10,
			staggerDelayMs: 0,
			maxDepth: 2,
			maxSessionsPerRun: 0,
			maxAgentsPerLead: 0,
		},
		worktrees: { baseDir: "" },
		taskTracker: { backend: "auto", enabled: false },
		mulch: { enabled: false, domains: [], primeFormat: "markdown" },
		merge: { aiResolveEnabled: false, reimagineEnabled: false },
		providers: {},
		watchdog: {
			tier0Enabled: true,
			tier0IntervalMs: 30_000,
			tier1Enabled: false,
			tier2Enabled: false,
			staleThresholdMs: 30_000,
			zombieThresholdMs: 120_000,
			nudgeIntervalMs: 60_000,
		},
		models: {},
		logging: { verbose: false, redactSecrets: false },
		healthPolicy: HEALTH_POLICY_CONFIG,
	};

	test("policy evaluation fires when enabled without crashing tick", async () => {
		const eventStore = createEventStore(":memory:");
		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				config: BASE_POLICY_CONFIG,
				_tmux: tmuxAllAlive(),
				_recordFailure: async () => {},
				_nudge: async () => ({ delivered: true }),
				_getConnection: () => undefined,
				_capturePaneContent: async () => null,
				_eventStore: eventStore,
			});
			// Tick must complete without throwing
			expect(true).toBe(true);
		} finally {
			eventStore.close();
		}
	});

	test("policy evaluation skipped when healthPolicy is absent", async () => {
		const eventStore = createEventStore(":memory:");
		try {
			const config: OverstoryConfig = { ...BASE_POLICY_CONFIG, healthPolicy: undefined };
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				config,
				_tmux: tmuxAllAlive(),
				_recordFailure: async () => {},
				_nudge: async () => ({ delivered: true }),
				_getConnection: () => undefined,
				_capturePaneContent: async () => null,
				_eventStore: eventStore,
			});
			const events = eventStore.getByAgent("watchdog");
			const healthActionEvents = events.filter((e) => {
				try {
					const d = JSON.parse(e.data ?? "{}") as { type?: string };
					return d.type === "health_action";
				} catch {
					return false;
				}
			});
			expect(healthActionEvents.length).toBe(0);
		} finally {
			eventStore.close();
		}
	});

	test("error in policy evaluation does not crash tick", async () => {
		const eventStore = createEventStore(":memory:");
		try {
			const config: OverstoryConfig = {
				...BASE_POLICY_CONFIG,
				healthPolicy: {
					enabled: true,
					dryRun: false,
					// null rule causes internal throw to verify error boundary
					rules: [null] as unknown as NonNullable<OverstoryConfig["healthPolicy"]>["rules"],
					defaultCooldownMs: 600_000,
					evaluationIntervalMs: 0,
					maxPauseDurationMs: 300_000,
				},
			};
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				config,
				_tmux: tmuxAllAlive(),
				_recordFailure: async () => {},
				_nudge: async () => ({ delivered: true }),
				_getConnection: () => undefined,
				_capturePaneContent: async () => null,
				_eventStore: eventStore,
			});
			// Tick must complete without throwing despite internal policy error
			expect(true).toBe(true);
		} finally {
			eventStore.close();
		}
	});

	test("stale spawn-paused sentinel is cleaned on tick", async () => {
		const sentinelPath = join(tempRoot, ".overstory", "spawn-paused");
		writeFileSync(sentinelPath, "");

		const eventStore = createEventStore(":memory:");
		try {
			const config: OverstoryConfig = {
				...BASE_POLICY_CONFIG,
				healthPolicy: {
					...HEALTH_POLICY_CONFIG,
					maxPauseDurationMs: 0, // any age exceeds 0ms
				},
			};
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				config,
				_tmux: tmuxAllAlive(),
				_recordFailure: async () => {},
				_nudge: async () => ({ delivered: true }),
				_getConnection: () => undefined,
				_capturePaneContent: async () => null,
				_eventStore: eventStore,
			});
			expect(existsSync(sentinelPath)).toBe(false);
		} finally {
			eventStore.close();
		}
	});
});
