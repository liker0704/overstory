import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMailStore } from "../mail/store.ts";
import { createMergeQueue } from "../merge/queue.ts";
import { createRunStore, createSessionStore } from "../sessions/store.ts";
import type { AgentSession, InsertRun } from "../types.ts";
import { createSnapshot, exportSnapshotBundle } from "./snapshot.ts";

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: "session-001-test-agent",
		agentName: "test-agent",
		capability: "builder",
		runtime: "claude",
		worktreePath: "/tmp/worktrees/test-agent",
		branchName: "overstory/test-agent/task-1",
		taskId: "task-1",
		tmuxSession: "overstory-test-agent",
		state: "working",
		pid: 12345,
		parentAgent: null,
		depth: 0,
		runId: null,
		startedAt: "2026-01-15T10:00:00.000Z",
		lastActivity: "2026-01-15T10:00:00.000Z",
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

function makeRun(overrides: Partial<InsertRun> = {}): InsertRun {
	return {
		id: "run-001",
		startedAt: "2026-01-15T10:00:00.000Z",
		status: "active",
		coordinatorSessionId: null,
		coordinatorName: null,
		...overrides,
	};
}

describe("createSnapshot", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "ov-snapshot-test-"));
		// Create minimal .overstory structure
		await Bun.write(join(tempDir, ".overstory", ".keep"), "");
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("empty stores — returns valid SwarmSnapshot with empty arrays", async () => {
		const snapshot = await createSnapshot(tempDir);

		expect(snapshot.snapshotId).toMatch(/^snap-/);
		expect(snapshot.formatVersion).toBe(1);
		expect(snapshot.createdAt).toBeTruthy();
		expect(snapshot.projectRoot).toBe(tempDir);
		expect(snapshot.sessions).toEqual([]);
		expect(snapshot.runs).toEqual([]);
		expect(snapshot.missions).toEqual([]);
		expect(snapshot.mail).toEqual([]);
		expect(snapshot.mergeQueue).toEqual([]);
		expect(snapshot.checkpoints).toEqual({});
		expect(snapshot.handoffs).toEqual({});
		expect(snapshot.identities).toEqual({});
		expect(snapshot.worktreeStatus).toEqual([]);
		expect(snapshot.metadata.currentRunFile).toBeNull();
		expect(snapshot.metadata.sessionBranchFile).toBeNull();
		expect(snapshot.metadata.configHash).toBeNull();
		expect(snapshot.runId).toBeNull();
		expect(snapshot.missionId).toBeNull();
	});

	test("populated stores — snapshot includes all data", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		const sessionsDbPath = join(overstoryDir, "sessions.db");
		const mailDbPath = join(overstoryDir, "mail.db");
		const mergeQueueDbPath = join(overstoryDir, "merge-queue.db");

		// Populate sessions.db
		const sessionStore = createSessionStore(sessionsDbPath);
		sessionStore.upsert(makeSession());
		sessionStore.close();

		const runStore = createRunStore(sessionsDbPath);
		runStore.createRun(makeRun());
		runStore.close();

		// Populate mail.db
		const mailStore = createMailStore(mailDbPath);
		mailStore.insert({
			id: "",
			from: "agent-a",
			to: "orchestrator",
			subject: "test",
			body: "hello",
			type: "status",
			priority: "normal",
			threadId: null,
		});
		mailStore.close();

		// Populate merge-queue.db
		const mergeQueue = createMergeQueue(mergeQueueDbPath);
		mergeQueue.enqueue({
			branchName: "overstory/test-agent/task-1",
			taskId: "task-1",
			agentName: "test-agent",
			filesModified: ["src/foo.ts"],
		});
		mergeQueue.close();

		const snapshot = await createSnapshot(tempDir);

		expect(snapshot.sessions).toHaveLength(1);
		expect(snapshot.sessions[0]?.agentName).toBe("test-agent");
		expect(snapshot.runs).toHaveLength(1);
		expect(snapshot.mail).toHaveLength(1);
		expect(snapshot.mergeQueue).toHaveLength(1);
	});

	test("missing optional stores — gracefully skips mail and merge-queue", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		const sessionsDbPath = join(overstoryDir, "sessions.db");

		const sessionStore = createSessionStore(sessionsDbPath);
		sessionStore.upsert(makeSession());
		sessionStore.close();

		const snapshot = await createSnapshot(tempDir);

		expect(snapshot.sessions).toHaveLength(1);
		expect(snapshot.mail).toEqual([]);
		expect(snapshot.mergeQueue).toEqual([]);
		expect(existsSync(join(overstoryDir, "mail.db"))).toBe(false);
		expect(existsSync(join(overstoryDir, "merge-queue.db"))).toBe(false);
	});

	test("agentFilter — only returns matching sessions", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		const sessionsDbPath = join(overstoryDir, "sessions.db");

		const sessionStore = createSessionStore(sessionsDbPath);
		sessionStore.upsert(makeSession({ agentName: "agent-a", id: "session-001-agent-a" }));
		sessionStore.upsert(makeSession({ agentName: "agent-b", id: "session-001-agent-b" }));
		sessionStore.close();

		const snapshot = await createSnapshot(tempDir, { agentFilter: ["agent-a"] });

		expect(snapshot.sessions).toHaveLength(1);
		expect(snapshot.sessions[0]?.agentName).toBe("agent-a");
	});

	test("includeCompleted — default excludes completed sessions, flag includes them", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		const sessionsDbPath = join(overstoryDir, "sessions.db");

		const sessionStore = createSessionStore(sessionsDbPath);
		sessionStore.upsert(
			makeSession({ agentName: "agent-working", id: "session-001-working", state: "working" }),
		);
		sessionStore.upsert(
			makeSession({ agentName: "agent-done", id: "session-001-done", state: "completed" }),
		);
		sessionStore.close();

		const defaultSnapshot = await createSnapshot(tempDir);
		expect(defaultSnapshot.sessions).toHaveLength(1);
		expect(defaultSnapshot.sessions[0]?.agentName).toBe("agent-working");

		const fullSnapshot = await createSnapshot(tempDir, { includeCompleted: true });
		expect(fullSnapshot.sessions).toHaveLength(2);
	});
});

describe("exportSnapshotBundle", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "ov-bundle-test-"));
		await Bun.write(join(tempDir, ".overstory", ".keep"), "");
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("bundle file structure — writes all 5 files, manifest written last", async () => {
		const snapshot = await createSnapshot(tempDir);
		const outputDir = join(tempDir, "bundle-out");
		const manifest = await exportSnapshotBundle(snapshot, outputDir);

		const expectedFiles = [
			"snapshot.json",
			"sessions.json",
			"mail.json",
			"merge-queue.json",
			"manifest.json",
		];
		for (const name of expectedFiles) {
			expect(existsSync(join(outputDir, name))).toBe(true);
		}

		expect(manifest.files.map((f) => f.name)).toContain("manifest.json");
		// manifest.json must be last in the files array
		const lastFile = manifest.files.at(-1);
		expect(lastFile?.name).toBe("manifest.json");
	});

	test("bundle manifest completeness — all required fields present with correct values", async () => {
		const snapshot = await createSnapshot(tempDir);
		const outputDir = join(tempDir, "bundle-out-2");
		const manifest = await exportSnapshotBundle(snapshot, outputDir);

		expect(manifest.bundleId).toMatch(/^bundle-snap-/);
		expect(manifest.formatVersion).toBe(1);
		expect(manifest.createdAt).toBeTruthy();
		expect(manifest.snapshotId).toBe(snapshot.snapshotId);
		expect(manifest.files.length).toBe(5);
		for (const file of manifest.files) {
			expect(file.sizeBytes).toBeGreaterThan(0);
			expect(file.name).toBeTruthy();
			expect(file.description).toBeTruthy();
		}
	});

	test("default outputDir uses .overstory/snapshots/{snapshotId}/", async () => {
		const snapshot = await createSnapshot(tempDir);
		const manifest = await exportSnapshotBundle(snapshot);

		const expectedDir = join(tempDir, ".overstory", "snapshots", snapshot.snapshotId);
		expect(existsSync(join(expectedDir, "manifest.json"))).toBe(true);
		expect(manifest.snapshotId).toBe(snapshot.snapshotId);
	});
});
