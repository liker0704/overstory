/**
 * Tests for src/recovery/reconcile.ts and src/recovery/restore.ts.
 *
 * tmux operations are mocked via the ReconcileDeps injectable interface to
 * avoid touching real tmux sessions. All other operations use real temp dirs
 * and real bun:sqlite databases.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMailStore } from "../mail/store.ts";
import { createMergeQueue } from "../merge/queue.ts";
import { createRunStore, createSessionStore } from "../sessions/store.ts";
import type { AgentSession, InsertRun, SessionCheckpoint } from "../types.ts";
import { type ReconcileDeps, reconcileSnapshot } from "./reconcile.ts";
import { restoreBundle } from "./restore.ts";
import { createSnapshot, exportSnapshotBundle } from "./snapshot.ts";
import type { SwarmSnapshot } from "./types.ts";

// --- Test helpers ---

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: "session-001-test-agent",
		agentName: "test-agent",
		capability: "builder",
		runtime: "claude",
		worktreePath: "/tmp/nonexistent-worktree/test-agent",
		branchName: "overstory/test-agent/task-1",
		taskId: "task-1",
		tmuxSession: "overstory-test-agent",
		state: "working",
		pid: null,
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

/** tmux always returns alive */
const tmuxAlwaysAlive: ReconcileDeps = {
	checkTmuxSession: async () => true,
};

/** tmux always returns dead */
const tmuxAlwaysDead: ReconcileDeps = {
	checkTmuxSession: async () => false,
};

/** Minimal valid SwarmSnapshot with no sessions */
function makeEmptySnapshot(projectRoot: string): SwarmSnapshot {
	return {
		snapshotId: "snap-test-001",
		formatVersion: 1,
		createdAt: new Date().toISOString(),
		projectRoot,
		runId: null,
		missionId: null,
		sessions: [],
		runs: [],
		missions: [],
		mail: [],
		mergeQueue: [],
		checkpoints: {},
		handoffs: {},
		identities: {},
		worktreeStatus: [],
		metadata: {
			currentRunFile: null,
			sessionBranchFile: null,
			configHash: null,
		},
	};
}

// ============================================================
// reconcileSnapshot tests
// ============================================================

describe("reconcileSnapshot", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "ov-reconcile-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("empty snapshot — returns restored with skipped component", async () => {
		const snapshot = makeEmptySnapshot(tempDir);
		const report = await reconcileSnapshot(snapshot, "bundle-001", tmuxAlwaysDead);

		expect(report.bundleId).toBe("bundle-001");
		expect(report.restoredAt).toBeTruthy();
		expect(report.overallStatus).toBe("restored");
		expect(report.components).toHaveLength(1);
		expect(report.components[0]?.name).toBe("agents");
		expect(report.components[0]?.status).toBe("skipped");
		expect(report.operatorActions).toHaveLength(0);
	});

	test("completed sessions are excluded from reconciliation", async () => {
		const snapshot = {
			...makeEmptySnapshot(tempDir),
			sessions: [makeSession({ state: "completed" })],
		};
		const report = await reconcileSnapshot(snapshot, "bundle-001", tmuxAlwaysDead);

		expect(report.overallStatus).toBe("restored");
		expect(report.components[0]?.status).toBe("skipped");
	});

	test("active session — tmux alive and worktree exists → restored", async () => {
		const worktreePath = join(tempDir, "worktrees", "test-agent");
		await Bun.write(join(worktreePath, ".keep"), "");

		const snapshot = {
			...makeEmptySnapshot(tempDir),
			sessions: [makeSession({ worktreePath })],
		};
		const report = await reconcileSnapshot(snapshot, "bundle-001", tmuxAlwaysAlive);

		expect(report.overallStatus).toBe("restored");
		expect(report.components[0]?.status).toBe("restored");
		expect(report.components[0]?.name).toBe("agent:test-agent");
		expect(report.components[0]?.details).toContain("tmux:alive");
		expect(report.components[0]?.details).toContain("worktree:exists");
	});

	test("active session — tmux dead and worktree missing → missing + operator action", async () => {
		const snapshot = {
			...makeEmptySnapshot(tempDir),
			sessions: [makeSession({ worktreePath: join(tempDir, "nonexistent") })],
		};
		const report = await reconcileSnapshot(snapshot, "bundle-001", tmuxAlwaysDead);

		expect(report.overallStatus).toBe("partial");
		expect(report.components[0]?.status).toBe("missing");
		expect(report.components[0]?.details).toContain("tmux:gone");
		expect(report.components[0]?.details).toContain("worktree:missing");
		expect(report.operatorActions.length).toBeGreaterThan(0);
		expect(report.operatorActions[0]).toContain("Re-spawn");
	});

	test("active session — tmux alive but worktree missing → degraded + operator action", async () => {
		const snapshot = {
			...makeEmptySnapshot(tempDir),
			sessions: [makeSession({ worktreePath: join(tempDir, "nonexistent") })],
		};
		const report = await reconcileSnapshot(snapshot, "bundle-001", tmuxAlwaysAlive);

		expect(report.overallStatus).toBe("partial");
		expect(report.components[0]?.status).toBe("degraded");
		expect(report.operatorActions[0]).toContain("Inspect");
	});

	test("pid alive — current process PID is always alive", async () => {
		const worktreePath = join(tempDir, "worktrees", "pid-agent");
		await Bun.write(join(worktreePath, ".keep"), "");

		const snapshot = {
			...makeEmptySnapshot(tempDir),
			sessions: [makeSession({ worktreePath, pid: process.pid })],
		};
		const report = await reconcileSnapshot(snapshot, "bundle-001", tmuxAlwaysAlive);

		expect(report.components[0]?.details).toContain("pid:alive");
	});

	test("pid dead — high pid that cannot exist reports as gone", async () => {
		const worktreePath = join(tempDir, "worktrees", "dead-pid-agent");
		await Bun.write(join(worktreePath, ".keep"), "");

		const snapshot = {
			...makeEmptySnapshot(tempDir),
			sessions: [makeSession({ worktreePath, pid: 2147483647 })],
		};
		const report = await reconcileSnapshot(snapshot, "bundle-001", tmuxAlwaysAlive);

		expect(report.components[0]?.details).toContain("pid:gone");
	});

	test("multiple sessions — all missing → overall partial", async () => {
		const snapshot = {
			...makeEmptySnapshot(tempDir),
			sessions: [
				makeSession({ agentName: "agent-a", id: "s-001-a", worktreePath: join(tempDir, "a") }),
				makeSession({ agentName: "agent-b", id: "s-001-b", worktreePath: join(tempDir, "b") }),
			],
		};
		const report = await reconcileSnapshot(snapshot, "bundle-001", tmuxAlwaysDead);

		expect(report.overallStatus).toBe("partial");
		expect(report.components).toHaveLength(2);
		expect(report.operatorActions).toHaveLength(2);
	});
});

// ============================================================
// restoreBundle tests
// ============================================================

describe("restoreBundle", () => {
	let sourceDir: string; // project with populated .overstory
	let targetDir: string; // empty target project

	beforeEach(async () => {
		sourceDir = await mkdtemp(join(tmpdir(), "ov-restore-source-"));
		targetDir = await mkdtemp(join(tmpdir(), "ov-restore-target-"));
		await Bun.write(join(sourceDir, ".overstory", ".keep"), "");
	});

	afterEach(async () => {
		await rm(sourceDir, { recursive: true, force: true });
		await rm(targetDir, { recursive: true, force: true });
	});

	test("missing bundle directory → throws RecoveryError", async () => {
		await expect(
			restoreBundle(targetDir, {
				bundlePath: join(targetDir, "nonexistent-bundle"),
			}),
		).rejects.toThrow("Bundle file not found");
	});

	test("bundle with unsupported format version → throws RecoveryError", async () => {
		const bundleDir = join(targetDir, "bad-bundle");
		await Bun.write(
			join(bundleDir, "manifest.json"),
			JSON.stringify({
				bundleId: "bundle-bad",
				formatVersion: 99,
				createdAt: new Date().toISOString(),
				snapshotId: "snap-bad",
				files: [],
			}),
		);
		await expect(
			restoreBundle(targetDir, { bundlePath: bundleDir }),
		).rejects.toThrow("Unsupported bundle format version");
	});

	test("dry run — returns reconcile report without writing any files", async () => {
		const snapshot = await createSnapshot(sourceDir);
		const manifest = await exportSnapshotBundle(snapshot);
		const bundlePath = join(
			sourceDir,
			".overstory",
			"snapshots",
			snapshot.snapshotId,
		);

		const report = await restoreBundle(
			targetDir,
			{ bundlePath, dryRun: true },
			{ reconcile: tmuxAlwaysDead },
		);

		expect(report.bundleId).toBe(manifest.bundleId);
		expect(report.restoredAt).toBeTruthy();
		// Target should have no sessions.db (dry run writes nothing)
		expect(existsSync(join(targetDir, ".overstory", "sessions.db"))).toBe(false);
	});

	test("empty snapshot restore — all components marked restored", async () => {
		const snapshot = await createSnapshot(sourceDir);
		const manifest = await exportSnapshotBundle(snapshot);
		const bundlePath = join(sourceDir, ".overstory", "snapshots", snapshot.snapshotId);

		const report = await restoreBundle(
			targetDir,
			{ bundlePath },
			{ reconcile: tmuxAlwaysDead },
		);

		expect(report.bundleId).toBe(manifest.bundleId);
		expect(report.overallStatus).toBe("restored");

		const componentNames = report.components.map((c) => c.name);
		expect(componentNames).toContain("sessions");
		expect(componentNames).toContain("runs");
		expect(componentNames).toContain("mail");
		expect(componentNames).toContain("merge-queue");
		expect(componentNames).toContain("agent-files");
	});

	test("sessions are restored into target sessions.db", async () => {
		const sourceOvDir = join(sourceDir, ".overstory");
		const sessionsDbPath = join(sourceOvDir, "sessions.db");

		const store = createSessionStore(sessionsDbPath);
		store.upsert(makeSession());
		store.close();

		const snapshot = await createSnapshot(sourceDir, { includeCompleted: true });
		const manifest = await exportSnapshotBundle(snapshot);
		const bundlePath = join(sourceOvDir, "snapshots", snapshot.snapshotId);

		await restoreBundle(targetDir, { bundlePath }, { reconcile: tmuxAlwaysDead });

		const targetStore = createSessionStore(join(targetDir, ".overstory", "sessions.db"));
		const sessions = targetStore.getAll();
		targetStore.close();

		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.agentName).toBe("test-agent");
	});

	test("runs are restored into target sessions.db", async () => {
		const sourceOvDir = join(sourceDir, ".overstory");
		const sessionsDbPath = join(sourceOvDir, "sessions.db");

		const runStore = createRunStore(sessionsDbPath);
		runStore.createRun(makeRun());
		runStore.close();

		const snapshot = await createSnapshot(sourceDir);
		const manifest = await exportSnapshotBundle(snapshot);
		const bundlePath = join(sourceOvDir, "snapshots", snapshot.snapshotId);

		await restoreBundle(targetDir, { bundlePath }, { reconcile: tmuxAlwaysDead });

		const targetRunStore = createRunStore(join(targetDir, ".overstory", "sessions.db"));
		const runs = targetRunStore.listRuns();
		targetRunStore.close();

		expect(runs).toHaveLength(1);
		expect(runs[0]?.id).toBe("run-001");
	});

	test("mail messages are restored into target mail.db", async () => {
		const sourceOvDir = join(sourceDir, ".overstory");
		const mailDbPath = join(sourceOvDir, "mail.db");

		const mailStore = createMailStore(mailDbPath);
		mailStore.insert({
			id: "msg-test-001",
			from: "agent-a",
			to: "orchestrator",
			subject: "hello",
			body: "world",
			type: "status",
			priority: "normal",
			threadId: null,
		});
		mailStore.close();

		const snapshot = await createSnapshot(sourceDir);
		const manifest = await exportSnapshotBundle(snapshot);
		const bundlePath = join(sourceOvDir, "snapshots", snapshot.snapshotId);

		await restoreBundle(targetDir, { bundlePath }, { reconcile: tmuxAlwaysDead });

		const targetMailStore = createMailStore(join(targetDir, ".overstory", "mail.db"));
		const messages = targetMailStore.getAll();
		targetMailStore.close();

		expect(messages).toHaveLength(1);
		expect(messages[0]?.from).toBe("agent-a");
		expect(messages[0]?.subject).toBe("hello");
	});

	test("only pending merge-queue entries are restored", async () => {
		const sourceOvDir = join(sourceDir, ".overstory");
		const mergeQueueDbPath = join(sourceOvDir, "merge-queue.db");

		const mq = createMergeQueue(mergeQueueDbPath);
		mq.enqueue({
			branchName: "overstory/agent-a/task-1",
			taskId: "task-1",
			agentName: "agent-a",
			filesModified: ["src/foo.ts"],
		});
		mq.enqueue({
			branchName: "overstory/agent-b/task-2",
			taskId: "task-2",
			agentName: "agent-b",
			filesModified: ["src/bar.ts"],
		});
		// Mark one as merged (should not be re-queued)
		mq.updateStatus("overstory/agent-b/task-2", "merged");
		mq.close();

		const snapshot = await createSnapshot(sourceDir);
		await exportSnapshotBundle(snapshot);
		const bundlePath = join(sourceOvDir, "snapshots", snapshot.snapshotId);

		await restoreBundle(targetDir, { bundlePath }, { reconcile: tmuxAlwaysDead });

		const targetMq = createMergeQueue(join(targetDir, ".overstory", "merge-queue.db"));
		const entries = targetMq.list();
		targetMq.close();

		// Only the pending entry should be restored
		expect(entries).toHaveLength(1);
		expect(entries[0]?.branchName).toBe("overstory/agent-a/task-1");
	});

	test("metadata files are restored into target .overstory/", async () => {
		const sourceOvDir = join(sourceDir, ".overstory");
		await Bun.write(join(sourceOvDir, "current-run.txt"), "run-abc\n");
		await Bun.write(join(sourceOvDir, "session-branch.txt"), "main\n");

		const snapshot = await createSnapshot(sourceDir);
		await exportSnapshotBundle(snapshot);
		const bundlePath = join(sourceOvDir, "snapshots", snapshot.snapshotId);

		await restoreBundle(targetDir, { bundlePath }, { reconcile: tmuxAlwaysDead });

		const currentRun = await Bun.file(join(targetDir, ".overstory", "current-run.txt")).text();
		const sessionBranch = await Bun.file(
			join(targetDir, ".overstory", "session-branch.txt"),
		).text();

		expect(currentRun.trim()).toBe("run-abc");
		expect(sessionBranch.trim()).toBe("main");
	});

	test("reconcile report is included in restore output", async () => {
		const sourceOvDir = join(sourceDir, ".overstory");
		const sessionsDbPath = join(sourceOvDir, "sessions.db");

		const store = createSessionStore(sessionsDbPath);
		store.upsert(makeSession({ worktreePath: join(targetDir, "nonexistent") }));
		store.close();

		const snapshot = await createSnapshot(sourceDir, { includeCompleted: true });
		await exportSnapshotBundle(snapshot);
		const bundlePath = join(sourceOvDir, "snapshots", snapshot.snapshotId);

		const report = await restoreBundle(
			targetDir,
			{ bundlePath },
			{ reconcile: tmuxAlwaysDead },
		);

		// Should include agent reconcile components alongside store components
		const agentComponents = report.components.filter((c) => c.name.startsWith("agent:"));
		expect(agentComponents).toHaveLength(1);
		expect(agentComponents[0]?.status).toBe("missing");
		expect(report.overallStatus).toBe("partial");
	});

	test("idempotent restore — re-running restore on populated target skips conflicts", async () => {
		const snapshot = await createSnapshot(sourceDir);
		await exportSnapshotBundle(snapshot);
		const bundlePath = join(
			sourceDir,
			".overstory",
			"snapshots",
			snapshot.snapshotId,
		);

		// First restore
		await restoreBundle(targetDir, { bundlePath }, { reconcile: tmuxAlwaysDead });
		// Second restore (should skip all conflicts, not throw)
		const report = await restoreBundle(
			targetDir,
			{ bundlePath },
			{ reconcile: tmuxAlwaysDead },
		);

		expect(report.bundleId).toBeTruthy();
	});
});
