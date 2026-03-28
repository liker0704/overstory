import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InsertMission } from "../types.ts";
import { createMissionStore } from "./store.ts";
import {
	addActiveMission,
	listActiveMissions,
	missionRunPointerPath,
	readCurrentMissionPointer,
	readCurrentRunPointer,
	readMissionRunPointer,
	removeActiveMission,
	resolveActiveMissionContext,
	writeMissionRuntimePointers,
} from "./runtime-context.ts";
import type { AgentSession, Mission } from "../types.ts";
import { resolveMissionRoleStates } from "./runtime-context.ts";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "overstory-runtime-context-test-"));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

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
		architectSessionId: null,
		pausedLeadNames: [],
		pauseReason: null,
		currentNode: null,
		startedAt: "2026-03-13T00:00:00.000Z",
		completedAt: null,
		createdAt: "2026-03-13T00:00:00.000Z",
		updatedAt: "2026-03-13T00:00:00.000Z",
		learningsExtracted: false,
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

// === addActiveMission ===

describe("addActiveMission", () => {
	test("adds first mission ID to empty/absent pointer file", async () => {
		await addActiveMission(tempDir, "mission-alpha");
		const ids = await listActiveMissions(tempDir);
		expect(ids).toEqual(["mission-alpha"]);
	});

	test("adds second mission without duplicating first", async () => {
		await addActiveMission(tempDir, "mission-alpha");
		await addActiveMission(tempDir, "mission-beta");
		const ids = await listActiveMissions(tempDir);
		expect(ids).toEqual(["mission-alpha", "mission-beta"]);
	});

	test("idempotent — adding same ID twice does not duplicate", async () => {
		await addActiveMission(tempDir, "mission-alpha");
		await addActiveMission(tempDir, "mission-alpha");
		const ids = await listActiveMissions(tempDir);
		expect(ids).toEqual(["mission-alpha"]);
	});
});

// === removeActiveMission ===

describe("removeActiveMission", () => {
	test("removes one of two missions, leaves the other", async () => {
		await addActiveMission(tempDir, "mission-alpha");
		await addActiveMission(tempDir, "mission-beta");
		await removeActiveMission(tempDir, "mission-alpha");
		const ids = await listActiveMissions(tempDir);
		expect(ids).toEqual(["mission-beta"]);
	});

	test("removes last mission and deletes the pointer file", async () => {
		await addActiveMission(tempDir, "mission-alpha");
		await removeActiveMission(tempDir, "mission-alpha");
		const ids = await listActiveMissions(tempDir);
		expect(ids).toEqual([]);
		// File should be gone
		await expect(
			access(join(tempDir, "current-mission.txt")),
		).rejects.toThrow();
	});

	test("removing non-existent ID is a no-op", async () => {
		await addActiveMission(tempDir, "mission-alpha");
		await removeActiveMission(tempDir, "mission-nonexistent");
		const ids = await listActiveMissions(tempDir);
		expect(ids).toEqual(["mission-alpha"]);
	});

	test("removing from absent file is a no-op", async () => {
		await removeActiveMission(tempDir, "mission-nonexistent");
		const ids = await listActiveMissions(tempDir);
		expect(ids).toEqual([]);
	});
});

// === listActiveMissions ===

describe("listActiveMissions", () => {
	test("returns empty array when file absent", async () => {
		const ids = await listActiveMissions(tempDir);
		expect(ids).toEqual([]);
	});

	test("returns single ID", async () => {
		await addActiveMission(tempDir, "mission-alpha");
		const ids = await listActiveMissions(tempDir);
		expect(ids).toEqual(["mission-alpha"]);
	});

	test("returns multiple IDs in insertion order", async () => {
		await addActiveMission(tempDir, "mission-alpha");
		await addActiveMission(tempDir, "mission-beta");
		await addActiveMission(tempDir, "mission-gamma");
		const ids = await listActiveMissions(tempDir);
		expect(ids).toEqual(["mission-alpha", "mission-beta", "mission-gamma"]);
	});

	test("returns empty array for empty file", async () => {
		await Bun.write(join(tempDir, "current-mission.txt"), "");
		const ids = await listActiveMissions(tempDir);
		expect(ids).toEqual([]);
	});
});

// === writeMissionRuntimePointers ===

describe("writeMissionRuntimePointers", () => {
	test("writes per-mission run pointer under runs/", async () => {
		await writeMissionRuntimePointers(tempDir, "mission-alpha", "run-001");
		const perMission = await readMissionRunPointer(tempDir, "mission-alpha");
		expect(perMission).toBe("run-001");
	});

	test("writes backward-compat current-run.txt", async () => {
		await writeMissionRuntimePointers(tempDir, "mission-alpha", "run-001");
		const runId = await readCurrentRunPointer(tempDir);
		expect(runId).toBe("run-001");
	});

	test("adds to multi-line pointer file rather than overwriting", async () => {
		await writeMissionRuntimePointers(tempDir, "mission-alpha", "run-001");
		await writeMissionRuntimePointers(tempDir, "mission-beta", "run-002");
		const ids = await listActiveMissions(tempDir);
		expect(ids).toEqual(["mission-alpha", "mission-beta"]);
	});

	test("null runId does not create run pointer files", async () => {
		await writeMissionRuntimePointers(tempDir, "mission-alpha", null);
		const perMission = await readMissionRunPointer(tempDir, "mission-alpha");
		expect(perMission).toBeNull();
	});
});

// === readCurrentMissionPointer ===

describe("readCurrentMissionPointer", () => {
	test("returns null when no file", async () => {
		const id = await readCurrentMissionPointer(tempDir);
		expect(id).toBeNull();
	});

	test("returns the first ID when multiple are present", async () => {
		await addActiveMission(tempDir, "mission-first");
		await addActiveMission(tempDir, "mission-second");
		const id = await readCurrentMissionPointer(tempDir);
		expect(id).toBe("mission-first");
	});
});

// === readCurrentRunPointer ===

describe("readCurrentRunPointer", () => {
	test("returns null when no pointer files exist", async () => {
		const runId = await readCurrentRunPointer(tempDir);
		expect(runId).toBeNull();
	});

	test("returns current-run.txt when no missionId given", async () => {
		await Bun.write(join(tempDir, "current-run.txt"), "run-fallback\n");
		const runId = await readCurrentRunPointer(tempDir);
		expect(runId).toBe("run-fallback");
	});

	test("returns per-mission pointer when missionId given and file exists", async () => {
		await mkdir(join(tempDir, "runs"), { recursive: true });
		await Bun.write(missionRunPointerPath(tempDir, "mission-alpha"), "run-per-mission\n");
		await Bun.write(join(tempDir, "current-run.txt"), "run-global\n");
		const runId = await readCurrentRunPointer(tempDir, "mission-alpha");
		expect(runId).toBe("run-per-mission");
	});

	test("falls back to current-run.txt when per-mission pointer absent", async () => {
		await Bun.write(join(tempDir, "current-run.txt"), "run-fallback\n");
		const runId = await readCurrentRunPointer(tempDir, "mission-missing");
		expect(runId).toBe("run-fallback");
	});
});

// === resolveActiveMissionContext ===

describe("resolveActiveMissionContext", () => {
	test("returns null when no db and no pointer", async () => {
		const ctx = await resolveActiveMissionContext(tempDir);
		expect(ctx).toBeNull();
	});

	test("returns pointer context when no db but pointer file exists", async () => {
		await addActiveMission(tempDir, "mission-pointer");
		const ctx = await resolveActiveMissionContext(tempDir);
		expect(ctx).toEqual({ missionId: "mission-pointer", runId: null });
	});

	test("returns single active mission from db", async () => {
		const dbPath = join(tempDir, "sessions.db");
		const store = createMissionStore(dbPath);
		const mission = store.create({ id: "mission-db-001", slug: "db-mission", objective: "Test" });
		store.close();

		const ctx = await resolveActiveMissionContext(tempDir);
		expect(ctx).not.toBeNull();
		expect(ctx!.missionId).toBe("mission-db-001");
		expect(ctx!.runId).toBe(mission.runId);
	});

	test("returns first active mission when multiple active — no throw", async () => {
		const dbPath = join(tempDir, "sessions.db");
		const store = createMissionStore(dbPath);
		store.create({ id: "mission-aaa", slug: "mission-aaa", objective: "First" });
		store.create({ id: "mission-bbb", slug: "mission-bbb", objective: "Second" });
		store.close();

		// Should not throw even with multiple active missions
		const ctx = await resolveActiveMissionContext(tempDir);
		expect(ctx).not.toBeNull();
		expect(["mission-aaa", "mission-bbb"]).toContain(ctx!.missionId);
	});

	test("returns pointed mission when pointer matches an active db mission", async () => {
		const dbPath = join(tempDir, "sessions.db");
		const store = createMissionStore(dbPath);
		store.create({ id: "mission-aaa", slug: "mission-aaa", objective: "First" });
		store.create({ id: "mission-bbb", slug: "mission-bbb", objective: "Second" });
		store.close();

		await addActiveMission(tempDir, "mission-bbb");
		const ctx = await resolveActiveMissionContext(tempDir);
		expect(ctx).not.toBeNull();
		expect(ctx!.missionId).toBe("mission-bbb");
	});
});

// === resolveMissionRoleStates (existing tests preserved) ===

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
