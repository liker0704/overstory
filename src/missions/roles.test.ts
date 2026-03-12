/**
 * Tests for mission role lifecycle (startMissionAnalyst, startExecutionDirector, stopMissionRole).
 *
 * Real tmux operations are mocked to avoid interfering with developer sessions.
 * MissionStore is mocked to verify bindSessions is called correctly without
 * needing a real SQLite database.
 */

import { describe, expect, test } from "bun:test";
import { AgentError } from "../errors.ts";
import type {
	StartPersistentAgentOpts,
	StartPersistentAgentResult,
} from "../agents/persistent-root.ts";
import type { AgentSession } from "../types.ts";
import type { MissionRoleDeps } from "./roles.ts";
import { startExecutionDirector, startMissionAnalyst, stopMissionRole } from "./roles.ts";

// === Shared mock builders ===

function makeSession(agentName: string): AgentSession {
	return {
		id: `session-${agentName}`,
		agentName,
		capability: agentName,
		runtime: "claude",
		worktreePath: "/proj",
		branchName: "main",
		taskId: "",
		tmuxSession: `ov-${agentName}`,
		state: "working",
		pid: 1234,
		parentAgent: null,
		depth: 0,
		runId: "run-test",
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		escalationLevel: 0,
		stalledSince: null,
		rateLimitedSince: null,
		runtimeSessionId: "runtime-uuid",
		transcriptPath: null,
		originalRuntime: null,
	};
}

function makeStartResult(agentName: string): StartPersistentAgentResult {
	return { session: makeSession(agentName), runId: "run-test", pid: 1234 };
}

function makeStoreWithSpy(): {
	store: {
		bindSessions: (
			id: string,
			sessions: { analystSessionId?: string; executionDirectorSessionId?: string },
		) => void;
		close: () => void;
	};
	calls: Array<{ id: string; sessions: Record<string, string | undefined> }>;
} {
	const calls: Array<{ id: string; sessions: Record<string, string | undefined> }> = [];
	function mockBindSessions(
		id: string,
		sessions: { analystSessionId?: string; executionDirectorSessionId?: string },
	): void {
		calls.push({ id, sessions });
	}
	const store = { bindSessions: mockBindSessions, close: () => {} };
	return { store, calls };
}

// === startMissionAnalyst ===

describe("startMissionAnalyst", () => {
	test("calls startPersistentAgent with capability=mission-analyst and agentName=mission-analyst", async () => {
		let capturedOpts: StartPersistentAgentOpts | undefined;
		const { store } = makeStoreWithSpy();

		const deps: MissionRoleDeps = {
			startAgent: async (opts) => {
				capturedOpts = opts;
				return makeStartResult("mission-analyst");
			},
			createStore: () => store as never,
		};

		await startMissionAnalyst(
			{
				missionId: "m-001",
				projectRoot: "/proj",
				overstoryDir: "/proj/.overstory",
				existingRunId: "run-1",
			},
			deps,
		);

		expect(capturedOpts?.capability).toBe("mission-analyst");
		expect(capturedOpts?.agentName).toBe("mission-analyst");
		expect(capturedOpts?.existingRunId).toBe("run-1");
		expect(capturedOpts?.createRun).toBe(false);
	});

	test("calls bindSessions with analystSessionId after start", async () => {
		const { store, calls } = makeStoreWithSpy();

		const deps: MissionRoleDeps = {
			startAgent: async () => makeStartResult("mission-analyst"),
			createStore: () => store as never,
		};

		await startMissionAnalyst(
			{
				missionId: "m-001",
				projectRoot: "/proj",
				overstoryDir: "/proj/.overstory",
				existingRunId: "run-1",
			},
			deps,
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.id).toBe("m-001");
		expect(calls[0]?.sessions.analystSessionId).toBe("session-mission-analyst");
	});

	test("returns the StartPersistentAgentResult from startAgent", async () => {
		const expected = makeStartResult("mission-analyst");
		const { store } = makeStoreWithSpy();

		const deps: MissionRoleDeps = {
			startAgent: async () => expected,
			createStore: () => store as never,
		};

		const result = await startMissionAnalyst(
			{
				missionId: "m-001",
				projectRoot: "/proj",
				overstoryDir: "/proj/.overstory",
				existingRunId: "run-1",
			},
			deps,
		);

		expect(result).toBe(expected);
	});
});

// === startExecutionDirector ===

describe("startExecutionDirector", () => {
	test("calls startPersistentAgent with capability=execution-director and agentName=execution-director", async () => {
		let capturedOpts: StartPersistentAgentOpts | undefined;
		const { store } = makeStoreWithSpy();

		const deps: MissionRoleDeps = {
			startAgent: async (opts) => {
				capturedOpts = opts;
				return makeStartResult("execution-director");
			},
			createStore: () => store as never,
		};

		await startExecutionDirector(
			{
				missionId: "m-002",
				projectRoot: "/proj",
				overstoryDir: "/proj/.overstory",
				existingRunId: "run-2",
			},
			deps,
		);

		expect(capturedOpts?.capability).toBe("execution-director");
		expect(capturedOpts?.agentName).toBe("execution-director");
		expect(capturedOpts?.existingRunId).toBe("run-2");
		expect(capturedOpts?.createRun).toBe(false);
	});

	test("calls bindSessions with executionDirectorSessionId after start", async () => {
		const { store, calls } = makeStoreWithSpy();

		const deps: MissionRoleDeps = {
			startAgent: async () => makeStartResult("execution-director"),
			createStore: () => store as never,
		};

		await startExecutionDirector(
			{
				missionId: "m-002",
				projectRoot: "/proj",
				overstoryDir: "/proj/.overstory",
				existingRunId: "run-2",
			},
			deps,
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.id).toBe("m-002");
		expect(calls[0]?.sessions.executionDirectorSessionId).toBe("session-execution-director");
	});
});

// === startMissionAnalyst edge cases ===

describe("startMissionAnalyst edge cases", () => {
	test("throws AgentError when missionId does not exist (fixed: bindSessions validates missionId)", async () => {
		// Fixed behavior: bindSessions will validate the missionId and throw AgentError if missing.
		const deps: MissionRoleDeps = {
			startAgent: async () => makeStartResult("mission-analyst"),
			createStore: () =>
				({
					bindSessions: (id: string) => {
						throw new AgentError(`Mission not found: ${id}`, {});
					},
					close: () => {},
				}) as never,
		};

		await expect(
			startMissionAnalyst(
				{
					missionId: "nonexistent-mission",
					projectRoot: "/proj",
					overstoryDir: "/proj/.overstory",
					existingRunId: "run-1",
				},
				deps,
			),
		).rejects.toThrow(AgentError);
	});
});

// === startExecutionDirector edge cases ===

describe("startExecutionDirector edge cases", () => {
	test("throws AgentError when missionId does not exist (fixed: bindSessions validates missionId)", async () => {
		// Fixed behavior: bindSessions will validate the missionId and throw AgentError if missing.
		const deps: MissionRoleDeps = {
			startAgent: async () => makeStartResult("execution-director"),
			createStore: () =>
				({
					bindSessions: (id: string) => {
						throw new AgentError(`Mission not found: ${id}`, {});
					},
					close: () => {},
				}) as never,
		};

		await expect(
			startExecutionDirector(
				{
					missionId: "nonexistent-mission",
					projectRoot: "/proj",
					overstoryDir: "/proj/.overstory",
					existingRunId: "run-2",
				},
				deps,
			),
		).rejects.toThrow(AgentError);
	});
});

// === stopMissionRole ===

describe("stopMissionRole", () => {
	test("calls stopPersistentAgent with the given agentName", async () => {
		let capturedName: string | undefined;
		let capturedOpts: { projectRoot: string; overstoryDir: string } | undefined;

		const deps: MissionRoleDeps = {
			stopAgent: async (name, opts) => {
				capturedName = name;
				capturedOpts = opts;
				return { sessionKilled: true, sessionId: "session-1", runCompleted: false };
			},
		};

		await stopMissionRole(
			"mission-analyst",
			{ projectRoot: "/proj", overstoryDir: "/proj/.overstory" },
			deps,
		);

		expect(capturedName).toBe("mission-analyst");
		expect(capturedOpts?.projectRoot).toBe("/proj");
		expect(capturedOpts?.overstoryDir).toBe("/proj/.overstory");
	});

	test("returns the StopPersistentAgentResult from stopAgent", async () => {
		const expected = { sessionKilled: true, sessionId: "session-abc", runCompleted: true };

		const deps: MissionRoleDeps = {
			stopAgent: async () => expected,
		};

		const result = await stopMissionRole(
			"execution-director",
			{ projectRoot: "/proj", overstoryDir: "/proj/.overstory" },
			deps,
		);

		expect(result).toBe(expected);
	});

	test("works with execution-director agent name", async () => {
		let capturedName: string | undefined;

		const deps: MissionRoleDeps = {
			stopAgent: async (name) => {
				capturedName = name;
				return { sessionKilled: false, sessionId: "session-2", runCompleted: false };
			},
		};

		await stopMissionRole(
			"execution-director",
			{ projectRoot: "/proj", overstoryDir: "/proj/.overstory" },
			deps,
		);

		expect(capturedName).toBe("execution-director");
	});
});
