import { describe, expect, test } from "bun:test";
import type { AgentSession, Mission } from "../types.ts";
import { resolveMissionRoleStates } from "./runtime-context.ts";

function makeMission(overrides: Partial<Mission> = {}): Mission {
	return {
		id: "mission-001",
		slug: "mission-auth",
		objective: "Stabilize mission runtime surfaces",
		runId: "run-001",
		state: "active",
		phase: "execute",
		firstFreezeAt: null,
		pendingUserInput: false,
		pendingInputKind: null,
		pendingInputThreadId: null,
		reopenCount: 0,
		artifactRoot: "/tmp/mission-auth",
		pausedWorkstreamIds: [],
		analystSessionId: null,
		executionDirectorSessionId: null,
		coordinatorSessionId: null,
		pausedLeadNames: [],
		pauseReason: null,
		currentNode: null,
		startedAt: "2026-03-13T00:00:00.000Z",
		completedAt: null,
		createdAt: "2026-03-13T00:00:00.000Z",
		updatedAt: "2026-03-13T00:00:00.000Z",
		...overrides,
	};
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: "session-001",
		agentName: "coordinator",
		capability: "coordinator",
		runtime: "claude",
		worktreePath: "/tmp/repo",
		branchName: "main",
		taskId: "mission-001",
		tmuxSession: "ov-coordinator",
		state: "working",
		pid: 1234,
		parentAgent: null,
		depth: 0,
		runId: null,
		startedAt: "2026-03-13T00:00:00.000Z",
		lastActivity: "2026-03-13T00:00:00.000Z",
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

describe("resolveMissionRoleStates", () => {
	test("reports zombie coordinator as stopped on shared mission surfaces", () => {
		const roles = resolveMissionRoleStates(makeMission(), [makeSession({ state: "zombie" })]);
		expect(roles.coordinator).toBe("stopped");
	});

	test("prefers coordinatorSessionId when mission binds a specific coordinator session", () => {
		const roles = resolveMissionRoleStates(makeMission({ coordinatorSessionId: "session-bound" }), [
			makeSession({ id: "session-bound", agentName: "coordinator", state: "working" }),
			makeSession({ id: "session-other", agentName: "coordinator", state: "zombie" }),
		]);
		expect(roles.coordinator).toBe("running");
	});
});
