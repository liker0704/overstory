import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { saveCheckpoint } from "../agents/checkpoint.ts";
import { createIdentity } from "../agents/identity.ts";
import { RecoveryError } from "../errors.ts";
import { createMailStore } from "../mail/store.ts";
import { createMergeQueue } from "../merge/queue.ts";
import { createMissionStore } from "../missions/store.ts";
import { createRunStore, createSessionStore } from "../sessions/store.ts";
import { type ReconcileDeps, reconcileSnapshot } from "./reconcile.ts";
import type {
	ReconciliationReport,
	RecoveryBundleManifest,
	RestoreOptions,
	SwarmSnapshot,
} from "./types.ts";

/** Injectable deps for testing. */
export interface RestoreDeps {
	reconcile?: ReconcileDeps;
}

async function loadJson<T>(filePath: string, bundleId?: string): Promise<T> {
	const file = Bun.file(filePath);
	const exists = await file.exists();
	if (!exists) {
		throw new RecoveryError(`Bundle file not found: ${filePath}`, { bundleId });
	}
	try {
		return JSON.parse(await file.text()) as T;
	} catch (err) {
		throw new RecoveryError(`Failed to parse bundle file: ${filePath}`, {
			bundleId,
			cause: err instanceof Error ? err : undefined,
		});
	}
}

/** Load and validate bundle from the given directory path. */
async function loadBundle(
	bundlePath: string,
): Promise<{ manifest: RecoveryBundleManifest; snapshot: SwarmSnapshot }> {
	const manifest = await loadJson<RecoveryBundleManifest>(join(bundlePath, "manifest.json"));

	if (manifest.formatVersion !== 1) {
		throw new RecoveryError(`Unsupported bundle format version: ${manifest.formatVersion}`, {
			bundleId: manifest.bundleId,
		});
	}

	const snapshot = await loadJson<SwarmSnapshot>(
		join(bundlePath, "snapshot.json"),
		manifest.bundleId,
	);

	return { manifest, snapshot };
}

/** Restore sessions into sessions.db (upsert — safe to re-run). */
function restoreSessions(
	dbPath: string,
	snapshot: SwarmSnapshot,
): { count: number; skipped: number } {
	const store = createSessionStore(dbPath);
	let count = 0;
	let skipped = 0;
	try {
		for (const session of snapshot.sessions) {
			try {
				store.upsert(session);
				count++;
			} catch {
				skipped++;
			}
		}
	} finally {
		store.close();
	}
	return { count, skipped };
}

/** Restore runs into sessions.db (skips on primary key conflict). */
function restoreRuns(dbPath: string, snapshot: SwarmSnapshot): { count: number; skipped: number } {
	const store = createRunStore(dbPath);
	let count = 0;
	let skipped = 0;
	try {
		for (const run of snapshot.runs) {
			try {
				store.createRun(run);
				count++;
			} catch {
				skipped++;
			}
		}
	} finally {
		store.close();
	}
	return { count, skipped };
}

/**
 * Restore missions into sessions.db.
 *
 * Creates each mission via the store API, then updates state and phase to
 * match snapshot values. Missions with duplicate IDs are skipped.
 */
function restoreMissions(
	dbPath: string,
	snapshot: SwarmSnapshot,
): { count: number; skipped: number } {
	const store = createMissionStore(dbPath);
	let count = 0;
	let skipped = 0;
	try {
		for (const mission of snapshot.missions) {
			try {
				store.create({
					id: mission.id,
					slug: mission.slug,
					objective: mission.objective,
					runId: mission.runId,
					artifactRoot: mission.artifactRoot,
					startedAt: mission.startedAt,
				});
				// Restore non-default state and phase
				if (mission.state !== "active") {
					store.updateState(mission.id, mission.state);
				}
				if (mission.phase !== "understand") {
					store.updatePhase(mission.id, mission.phase);
				}
				count++;
			} catch {
				skipped++;
			}
		}
	} finally {
		store.close();
	}
	return { count, skipped };
}

/** Restore mail messages into mail.db (skips on ID conflict). */
function restoreMail(dbPath: string, snapshot: SwarmSnapshot): { count: number; skipped: number } {
	const store = createMailStore(dbPath);
	let count = 0;
	let skipped = 0;
	try {
		for (const message of snapshot.mail) {
			try {
				store.insert({
					id: message.id,
					from: message.from,
					to: message.to,
					subject: message.subject,
					body: message.body,
					type: message.type,
					priority: message.priority,
					threadId: message.threadId,
					payload: message.payload ?? null,
				});
				count++;
			} catch {
				skipped++;
			}
		}
	} finally {
		store.close();
	}
	return { count, skipped };
}

/**
 * Restore pending merge-queue entries into merge-queue.db.
 * Non-pending entries (merged, failed, conflict) are not re-queued.
 */
function restoreMergeQueue(
	dbPath: string,
	snapshot: SwarmSnapshot,
): { count: number; skipped: number } {
	const store = createMergeQueue(dbPath);
	const pendingEntries = snapshot.mergeQueue.filter((e) => e.status === "pending");
	let count = 0;
	let skipped = 0;
	try {
		for (const entry of pendingEntries) {
			try {
				store.enqueue({
					branchName: entry.branchName,
					taskId: entry.taskId,
					agentName: entry.agentName,
					filesModified: entry.filesModified,
				});
				count++;
			} catch {
				skipped++;
			}
		}
	} finally {
		store.close();
	}
	return { count, skipped };
}

/** Restore file-based agent state: checkpoints, handoffs, identities. */
async function restoreAgentFiles(agentsDir: string, snapshot: SwarmSnapshot): Promise<void> {
	await mkdir(agentsDir, { recursive: true });

	const tasks: Promise<void>[] = [];

	for (const checkpoint of Object.values(snapshot.checkpoints)) {
		tasks.push(saveCheckpoint(agentsDir, checkpoint).catch(() => undefined));
	}

	for (const [agentName, handoffs] of Object.entries(snapshot.handoffs)) {
		const agentDir = join(agentsDir, agentName);
		const filePath = join(agentDir, "handoffs.json");
		tasks.push(
			mkdir(agentDir, { recursive: true })
				.then(() => Bun.write(filePath, `${JSON.stringify(handoffs, null, "\t")}\n`))
				.then(() => undefined)
				.catch(() => undefined),
		);
	}

	for (const identity of Object.values(snapshot.identities)) {
		tasks.push(createIdentity(agentsDir, identity).catch(() => undefined));
	}

	await Promise.all(tasks);
}

/** Restore metadata files: current-run.txt and session-branch.txt. */
async function restoreMetadata(overstoryDir: string, snapshot: SwarmSnapshot): Promise<void> {
	const tasks: Promise<void>[] = [];

	if (snapshot.metadata.currentRunFile !== null) {
		tasks.push(
			Bun.write(
				join(overstoryDir, "current-run.txt"),
				`${snapshot.metadata.currentRunFile}\n`,
			).then(() => undefined),
		);
	}

	if (snapshot.metadata.sessionBranchFile !== null) {
		tasks.push(
			Bun.write(
				join(overstoryDir, "session-branch.txt"),
				`${snapshot.metadata.sessionBranchFile}\n`,
			).then(() => undefined),
		);
	}

	await Promise.all(tasks);
}

function computeOverallStatus(
	components: ReconciliationReport["components"],
): ReconciliationReport["overallStatus"] {
	const statuses = components.map((c) => c.status);
	if (statuses.every((s) => s === "restored" || s === "skipped")) return "restored";
	if (statuses.some((s) => s === "missing")) return "partial";
	return "partial";
}

/**
 * Restore a swarm from a recovery bundle.
 *
 * Loads the bundle at `options.bundlePath`, restores all SQLite stores and
 * file-based agent state into `projectRoot`, then validates external agent
 * state (tmux sessions, worktree paths, PIDs). Returns a ReconciliationReport
 * describing what was restored and any operator actions required.
 *
 * If `options.dryRun` is true, no data is written — only bundle validation
 * and external state reconciliation are performed.
 */
export async function restoreBundle(
	projectRoot: string,
	options: RestoreOptions,
	deps?: RestoreDeps,
): Promise<ReconciliationReport> {
	const { bundlePath, dryRun = false } = options;

	let manifest: RecoveryBundleManifest;
	let snapshot: SwarmSnapshot;
	try {
		({ manifest, snapshot } = await loadBundle(bundlePath));
	} catch (err) {
		if (err instanceof RecoveryError) throw err;
		throw new RecoveryError(
			`Failed to load bundle at ${bundlePath}: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err instanceof Error ? err : undefined },
		);
	}

	const bundleId = manifest.bundleId;

	// Dry run: validate and reconcile only, no data written
	if (dryRun) {
		return reconcileSnapshot(snapshot, bundleId, deps?.reconcile);
	}

	const overstoryDir = join(projectRoot, ".overstory");
	const sessionsDbPath = join(overstoryDir, "sessions.db");
	const mailDbPath = join(overstoryDir, "mail.db");
	const mergeQueueDbPath = join(overstoryDir, "merge-queue.db");
	const agentsDir = join(overstoryDir, "agents");

	await mkdir(overstoryDir, { recursive: true });

	const components: ReconciliationReport["components"] = [];
	const operatorActions: string[] = [];

	// --- SQLite stores ---

	const sessionsResult = restoreSessions(sessionsDbPath, snapshot);
	components.push({
		name: "sessions",
		status: sessionsResult.count > 0 || snapshot.sessions.length === 0 ? "restored" : "degraded",
		details: `${sessionsResult.count} restored, ${sessionsResult.skipped} skipped`,
	});

	const runsResult = restoreRuns(sessionsDbPath, snapshot);
	components.push({
		name: "runs",
		status: runsResult.count > 0 || snapshot.runs.length === 0 ? "restored" : "degraded",
		details: `${runsResult.count} restored, ${runsResult.skipped} skipped`,
	});

	const missionsResult = restoreMissions(sessionsDbPath, snapshot);
	components.push({
		name: "missions",
		status: missionsResult.count > 0 || snapshot.missions.length === 0 ? "restored" : "degraded",
		details: `${missionsResult.count} restored, ${missionsResult.skipped} skipped`,
	});
	if (snapshot.missions.length > 0) {
		operatorActions.push(
			"Verify mission states: some fields (pending_user_input, paused_workstreams) may need manual update",
		);
	}

	const mailResult = restoreMail(mailDbPath, snapshot);
	components.push({
		name: "mail",
		status: mailResult.count > 0 || snapshot.mail.length === 0 ? "restored" : "degraded",
		details: `${mailResult.count} restored, ${mailResult.skipped} skipped`,
	});

	const pendingCount = snapshot.mergeQueue.filter((e) => e.status === "pending").length;
	const nonPendingCount = snapshot.mergeQueue.length - pendingCount;
	const mergeResult = restoreMergeQueue(mergeQueueDbPath, snapshot);
	components.push({
		name: "merge-queue",
		status:
			mergeResult.count >= pendingCount || snapshot.mergeQueue.length === 0
				? "restored"
				: "degraded",
		details: `${mergeResult.count} pending entries restored, ${nonPendingCount} non-pending skipped`,
	});
	if (nonPendingCount > 0) {
		operatorActions.push(
			`${nonPendingCount} completed/failed merge-queue entries not restored (terminal state)`,
		);
	}

	// --- File-based state ---

	try {
		await restoreAgentFiles(agentsDir, snapshot);
		await restoreMetadata(overstoryDir, snapshot);

		const checkpointCount = Object.keys(snapshot.checkpoints).length;
		const handoffCount = Object.keys(snapshot.handoffs).length;
		const identityCount = Object.keys(snapshot.identities).length;

		components.push({
			name: "agent-files",
			status: "restored",
			details: `${checkpointCount} checkpoints, ${handoffCount} handoff files, ${identityCount} identities`,
		});
	} catch (err) {
		components.push({
			name: "agent-files",
			status: "degraded",
			details: `Partial restore: ${err instanceof Error ? err.message : String(err)}`,
		});
		operatorActions.push(
			"Inspect agent file state: some checkpoint/identity files may be incomplete",
		);
	}

	// --- External state reconciliation ---

	const reconcileReport = await reconcileSnapshot(snapshot, bundleId, deps?.reconcile);
	components.push(...reconcileReport.components);
	operatorActions.push(...reconcileReport.operatorActions);

	return {
		bundleId,
		restoredAt: new Date().toISOString(),
		components,
		overallStatus: computeOverallStatus(components),
		operatorActions,
	};
}
