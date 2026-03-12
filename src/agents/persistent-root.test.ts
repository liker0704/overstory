/**
 * Tests for persistent-root lifecycle abstraction.
 *
 * Focuses on stopPersistentAgent, getPersistentAgentStatus, and
 * readPersistentAgentOutput. All tmux operations are mocked to avoid
 * interfering with developer sessions.
 *
 * Real SQLite (bun:sqlite) is used via temp files — no db mocks.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentError } from "../errors.ts";
import { createRunStore, createSessionStore } from "../sessions/store.ts";
import type { AgentSession } from "../types.ts";
import type {
	PersistentAgentCaptureDeps,
	PersistentAgentTmuxDeps,
} from "./persistent-root.ts";
import {
	getPersistentAgentStatus,
	readPersistentAgentOutput,
	stopPersistentAgent,
} from "./persistent-root.ts";

// === Setup ===

let tempDir: string;
let overstoryDir: string;
let dbPath: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "overstory-pr-test-"));
	overstoryDir = join(tempDir, ".overstory");
	await mkdir(overstoryDir, { recursive: true });
	dbPath = join(overstoryDir, "sessions.db");
});

afterEach(async () => {
	const { rm } = await import("node:fs/promises");
	await rm(tempDir, { recursive: true, force: true });
});

// === Helpers ===

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: "session-test-1",
		agentName: "coordinator",
		capability: "coordinator",
		runtime: "claude",
		worktreePath: "/proj",
		branchName: "main",
		taskId: "",
		tmuxSession: "ov-coordinator",
		state: "working",
		pid: 1234,
		parentAgent: null,
		depth: 0,
		runId: "run-test-1",
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

function insertSession(session: AgentSession): void {
	const store = createSessionStore(dbPath);
	try {
		store.upsert(session);
	} finally {
		store.close();
	}
}

function insertRun(runId: string): void {
	const store = createRunStore(dbPath);
	try {
		store.createRun({
			id: runId,
			startedAt: new Date().toISOString(),
			coordinatorSessionId: null,
			coordinatorName: null,
			status: "active",
		});
	} finally {
		store.close();
	}
}

function makeTmuxDeps(
	overrides: Partial<PersistentAgentTmuxDeps> = {},
): PersistentAgentTmuxDeps {
	return {
		createSession: async () => 12345,
		isSessionAlive: async () => true,
		checkSessionState: async () => "alive",
		killSession: async () => {},
		sendKeys: async () => {},
		waitForTuiReady: async () => true,
		ensureTmuxAvailable: async () => {},
		...overrides,
	};
}

// === stopPersistentAgent ===

describe("stopPersistentAgent", () => {
	test("happy path: kills alive session, completes run, returns result", async () => {
		insertSession(makeSession({ agentName: "coordinator", runId: "run-test-1" }));
		insertRun("run-test-1");

		const tmux = makeTmuxDeps({ isSessionAlive: async () => true });
		const result = await stopPersistentAgent(
			"coordinator",
			{ projectRoot: tempDir, overstoryDir },
			tmux,
		);

		expect(result.sessionKilled).toBe(true);
		expect(result.runCompleted).toBe(true);
		expect(result.sessionId).toBe("session-test-1");
	});

	test("throws AgentError when no session exists for agent", async () => {
		const tmux = makeTmuxDeps();
		await expect(
			stopPersistentAgent("coordinator", { projectRoot: tempDir, overstoryDir }, tmux),
		).rejects.toThrow(AgentError);
	});

	test("throws AgentError when session is already completed", async () => {
		insertSession(makeSession({ agentName: "coordinator", state: "completed" }));
		const tmux = makeTmuxDeps();
		await expect(
			stopPersistentAgent("coordinator", { projectRoot: tempDir, overstoryDir }, tmux),
		).rejects.toThrow(AgentError);
	});

	test("throws AgentError when session is zombie", async () => {
		insertSession(makeSession({ agentName: "coordinator", state: "zombie" }));
		const tmux = makeTmuxDeps();
		await expect(
			stopPersistentAgent("coordinator", { projectRoot: tempDir, overstoryDir }, tmux),
		).rejects.toThrow(AgentError);
	});

	test("sessionKilled=false when tmux session is already dead", async () => {
		insertSession(makeSession({ agentName: "coordinator", runId: "run-dead" }));
		insertRun("run-dead");

		const tmux = makeTmuxDeps({ isSessionAlive: async () => false });
		const result = await stopPersistentAgent(
			"coordinator",
			{ projectRoot: tempDir, overstoryDir },
			tmux,
		);

		expect(result.sessionKilled).toBe(false);
		expect(result.runCompleted).toBe(true);
	});

	test("session with no runId falls back to current-run.txt", async () => {
		insertSession(makeSession({ agentName: "coordinator", runId: null }));
		insertRun("run-from-file");
		await writeFile(join(overstoryDir, "current-run.txt"), "run-from-file");

		const tmux = makeTmuxDeps({ isSessionAlive: async () => true });
		const result = await stopPersistentAgent(
			"coordinator",
			{ projectRoot: tempDir, overstoryDir },
			tmux,
		);

		expect(result.sessionKilled).toBe(true);
		expect(result.runCompleted).toBe(true);
	});
});

// === getPersistentAgentStatus ===

describe("getPersistentAgentStatus", () => {
	test("returns status with running=true for active session with alive tmux", async () => {
		insertSession(makeSession({ agentName: "coordinator", state: "working" }));

		const tmux = makeTmuxDeps({ isSessionAlive: async () => true });
		const status = await getPersistentAgentStatus(
			"coordinator",
			{ projectRoot: tempDir, overstoryDir },
			tmux,
		);

		expect(status).not.toBeNull();
		expect(status?.running).toBe(true);
		expect(status?.state).toBe("working");
		expect(status?.sessionId).toBe("session-test-1");
		expect(status?.tmuxSession).toBe("ov-coordinator");
	});

	test("returns null when no session exists", async () => {
		const tmux = makeTmuxDeps();
		const status = await getPersistentAgentStatus(
			"coordinator",
			{ projectRoot: tempDir, overstoryDir },
			tmux,
		);
		expect(status).toBeNull();
	});

	test("returns null when session is completed", async () => {
		insertSession(makeSession({ agentName: "coordinator", state: "completed" }));
		const tmux = makeTmuxDeps();
		const status = await getPersistentAgentStatus(
			"coordinator",
			{ projectRoot: tempDir, overstoryDir },
			tmux,
		);
		expect(status).toBeNull();
	});

	test("returns running=false and reconciles to zombie when tmux is dead", async () => {
		insertSession(makeSession({ agentName: "coordinator", state: "working" }));

		const tmux = makeTmuxDeps({ isSessionAlive: async () => false });
		const status = await getPersistentAgentStatus(
			"coordinator",
			{ projectRoot: tempDir, overstoryDir },
			tmux,
		);

		expect(status).not.toBeNull();
		expect(status?.running).toBe(false);
		expect(status?.state).toBe("zombie");
	});

	test("returns null when session is zombie", async () => {
		insertSession(makeSession({ agentName: "coordinator", state: "zombie" }));
		const tmux = makeTmuxDeps();
		const status = await getPersistentAgentStatus(
			"coordinator",
			{ projectRoot: tempDir, overstoryDir },
			tmux,
		);
		expect(status).toBeNull();
	});
});

// === readPersistentAgentOutput ===

describe("readPersistentAgentOutput", () => {
	test("tmux path: returns captured pane content", async () => {
		insertSession(
			makeSession({ agentName: "coordinator", state: "working", tmuxSession: "ov-coordinator" }),
		);

		const captureDeps: PersistentAgentCaptureDeps = {
			capturePaneContent: async () => "tmux pane output",
		};
		const output = await readPersistentAgentOutput(
			"coordinator",
			{ projectRoot: tempDir, overstoryDir },
			captureDeps,
		);
		expect(output).toBe("tmux pane output");
	});

	test("headless path (tmuxSession='') reads stdout.log", async () => {
		insertSession(
			makeSession({ agentName: "coordinator", state: "working", tmuxSession: "" }),
		);

		const logsDir = join(overstoryDir, "logs", "coordinator");
		await mkdir(logsDir, { recursive: true });
		await writeFile(join(logsDir, "stdout.log"), "log line 1\nlog line 2\n");

		const captureDeps: PersistentAgentCaptureDeps = {
			capturePaneContent: async () => null,
		};
		const output = await readPersistentAgentOutput(
			"coordinator",
			{ projectRoot: tempDir, overstoryDir },
			captureDeps,
		);
		expect(output).toContain("log line 1");
		expect(output).toContain("log line 2");
	});

	test("returns null when no session exists", async () => {
		const captureDeps: PersistentAgentCaptureDeps = {
			capturePaneContent: async () => null,
		};
		const output = await readPersistentAgentOutput(
			"coordinator",
			{ projectRoot: tempDir, overstoryDir },
			captureDeps,
		);
		expect(output).toBeNull();
	});

	test("headless path returns null when stdout.log is missing", async () => {
		insertSession(
			makeSession({ agentName: "coordinator", state: "working", tmuxSession: "" }),
		);

		const captureDeps: PersistentAgentCaptureDeps = {
			capturePaneContent: async () => null,
		};
		const output = await readPersistentAgentOutput(
			"coordinator",
			{ projectRoot: tempDir, overstoryDir },
			captureDeps,
		);
		expect(output).toBeNull();
	});

	test("returns null when session is completed", async () => {
		insertSession(
			makeSession({ agentName: "coordinator", state: "completed", tmuxSession: "ov-coordinator" }),
		);
		const captureDeps: PersistentAgentCaptureDeps = {
			capturePaneContent: async () => "some content",
		};
		const output = await readPersistentAgentOutput(
			"coordinator",
			{ projectRoot: tempDir, overstoryDir },
			captureDeps,
		);
		expect(output).toBeNull();
	});
});
