import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadCheckpoint } from "../agents/checkpoint.ts";
import { loadIdentity } from "../agents/identity.ts";
import { SnapshotError } from "../errors.ts";
import { createMailStore } from "../mail/store.ts";
import { createMergeQueue } from "../merge/queue.ts";
import { createMissionStore } from "../missions/store.ts";
import { createRunStore, createSessionStore } from "../sessions/store.ts";
import type { AgentIdentity, SessionCheckpoint, SessionHandoff } from "../types.ts";
import { listWorktrees } from "../worktree/manager.ts";
import type {
	RecoveryBundleManifest,
	SnapshotOptions,
	SwarmSnapshot,
	WorktreeStatus,
} from "./types.ts";

function makeSnapshotId(): string {
	return `snap-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

async function readTextFile(path: string): Promise<string | null> {
	const file = Bun.file(path);
	const exists = await file.exists();
	if (!exists) return null;
	return file.text();
}

async function hashFile(path: string): Promise<string | null> {
	const text = await readTextFile(path);
	if (text === null) return null;
	return createHash("sha256").update(text).digest("hex");
}

async function collectAgentNames(agentsDir: string): Promise<string[]> {
	try {
		const entries = await readdir(agentsDir, { withFileTypes: true });
		return entries.filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}
}

async function getWorktreeStatus(repoRoot: string): Promise<WorktreeStatus[]> {
	let worktrees: Array<{ path: string; branch: string; head: string }>;
	try {
		worktrees = await listWorktrees(repoRoot);
	} catch {
		return [];
	}

	return Promise.all(
		worktrees.map(async ({ path, branch, head }) => {
			const exists = existsSync(path);
			let hasUncommittedChanges = false;
			if (exists) {
				try {
					const proc = Bun.spawn(["git", "status", "--porcelain"], {
						cwd: path,
						stdout: "pipe",
						stderr: "pipe",
					});
					const stdout = await new Response(proc.stdout).text();
					await proc.exited;
					hasUncommittedChanges = stdout.trim().length > 0;
				} catch {
					// ignore
				}
			}
			return { path, branch, head, exists, hasUncommittedChanges };
		}),
	);
}

async function loadHandoffs(agentsDir: string, agentName: string): Promise<SessionHandoff[]> {
	const filePath = join(agentsDir, agentName, "handoffs.json");
	const file = Bun.file(filePath);
	const exists = await file.exists();
	if (!exists) return [];
	try {
		const text = await file.text();
		return JSON.parse(text) as SessionHandoff[];
	} catch {
		return [];
	}
}

/**
 * Create a SwarmSnapshot from all SQLite stores and file-based state.
 */
export async function createSnapshot(
	projectRoot: string,
	options?: SnapshotOptions,
): Promise<SwarmSnapshot> {
	const snapshotId = makeSnapshotId();

	try {
		const overstoryDir = join(projectRoot, ".overstory");
		const agentsDir = join(overstoryDir, "agents");

		// --- SQLite stores ---
		const sessionsDbPath = join(overstoryDir, "sessions.db");
		const mailDbPath = join(overstoryDir, "mail.db");
		const mergeQueueDbPath = join(overstoryDir, "merge-queue.db");

		let sessions: SwarmSnapshot["sessions"] = [];
		let runs: SwarmSnapshot["runs"] = [];
		let missions: SwarmSnapshot["missions"] = [];
		let mail: SwarmSnapshot["mail"] = [];
		let mergeQueue: SwarmSnapshot["mergeQueue"] = [];
		let runId: string | null = null;

		// Sessions + Runs + Missions share sessions.db
		if (existsSync(sessionsDbPath)) {
			const sessionStore = createSessionStore(sessionsDbPath);
			try {
				sessions = sessionStore.getAll();
			} finally {
				sessionStore.close();
			}

			const runStore = createRunStore(sessionsDbPath);
			try {
				runs = runStore.listRuns();
			} finally {
				runStore.close();
			}

			const missionStore = createMissionStore(sessionsDbPath);
			try {
				missions = missionStore.list();
			} finally {
				missionStore.close();
			}
		}

		// Mail
		if (existsSync(mailDbPath)) {
			const mailStore = createMailStore(mailDbPath);
			try {
				mail = mailStore.getAll();
			} finally {
				mailStore.close();
			}
		}

		// Merge queue
		if (existsSync(mergeQueueDbPath)) {
			const mergeQueueStore = createMergeQueue(mergeQueueDbPath);
			try {
				mergeQueue = mergeQueueStore.list();
			} finally {
				mergeQueueStore.close();
			}
		}

		// --- Apply filters ---
		if (options?.agentFilter && options.agentFilter.length > 0) {
			const filter = new Set(options.agentFilter);
			sessions = sessions.filter((s) => filter.has(s.agentName));
		}

		if (!options?.includeCompleted) {
			sessions = sessions.filter((s) => s.state !== "completed");
		}

		// --- File-based state (parallel) ---
		const agentNames = await collectAgentNames(agentsDir);

		const [checkpointResults, handoffResults, identityResults, worktreeStatus] = await Promise.all([
			Promise.all(
				agentNames.map(async (name) => ({
					name,
					checkpoint: await loadCheckpoint(agentsDir, name).catch(() => null),
				})),
			),
			Promise.all(
				agentNames.map(async (name) => ({
					name,
					handoffs: await loadHandoffs(agentsDir, name),
				})),
			),
			Promise.all(
				agentNames.map(async (name) => ({
					name,
					identity: await loadIdentity(agentsDir, name).catch(() => null),
				})),
			),
			getWorktreeStatus(projectRoot),
		]);

		const checkpoints: Record<string, SessionCheckpoint> = {};
		for (const { name, checkpoint } of checkpointResults) {
			if (checkpoint !== null) {
				checkpoints[name] = checkpoint;
			}
		}

		const handoffs: Record<string, SessionHandoff[]> = {};
		for (const { name, handoffs: h } of handoffResults) {
			if (h.length > 0) {
				handoffs[name] = h;
			}
		}

		const identities: Record<string, AgentIdentity> = {};
		for (const { name, identity } of identityResults) {
			if (identity !== null) {
				identities[name] = identity;
			}
		}

		// --- Metadata ---
		const currentRunFilePath = join(overstoryDir, "current-run.txt");
		const sessionBranchFilePath = join(overstoryDir, "session-branch.txt");
		const configYamlPath = join(overstoryDir, "config.yaml");

		const [currentRunFile, sessionBranchFile, configHash] = await Promise.all([
			readTextFile(currentRunFilePath).then((t) => t?.trim() ?? null),
			readTextFile(sessionBranchFilePath).then((t) => t?.trim() ?? null),
			hashFile(configYamlPath),
		]);

		// runId from current-run.txt or active run from store
		runId = currentRunFile ?? runs.find((r) => r.status === "active")?.id ?? null;

		// missionId: first active mission
		const missionId = missions.find((m) => m.state === "active")?.id ?? null;

		const snapshot: SwarmSnapshot = {
			snapshotId,
			formatVersion: 1,
			createdAt: new Date().toISOString(),
			projectRoot,
			runId,
			missionId,
			sessions,
			runs,
			missions,
			mail,
			mergeQueue,
			checkpoints,
			handoffs,
			identities,
			worktreeStatus,
			metadata: {
				currentRunFile,
				sessionBranchFile,
				configHash,
			},
		};

		return snapshot;
	} catch (err) {
		if (err instanceof SnapshotError) throw err;
		throw new SnapshotError(
			`Failed to create snapshot: ${err instanceof Error ? err.message : String(err)}`,
			{
				snapshotId,
				cause: err instanceof Error ? err : undefined,
			},
		);
	}
}

interface BundleFile {
	name: string;
	description: string;
	content: string;
}

async function writeBundleFile(
	dir: string,
	file: BundleFile,
): Promise<{ name: string; description: string; sizeBytes: number }> {
	const filePath = join(dir, file.name);
	const contentWithNewline = `${file.content}\n`;
	await Bun.write(filePath, contentWithNewline);
	return {
		name: file.name,
		description: file.description,
		sizeBytes: Buffer.byteLength(contentWithNewline, "utf8"),
	};
}

/**
 * Export a SwarmSnapshot to a directory bundle with manifest.
 */
export async function exportSnapshotBundle(
	snapshot: SwarmSnapshot,
	outputDir?: string,
): Promise<RecoveryBundleManifest> {
	const dir =
		outputDir ?? join(snapshot.projectRoot, ".overstory", "snapshots", snapshot.snapshotId);
	await mkdir(dir, { recursive: true });

	const bundleId = `bundle-${snapshot.snapshotId}`;
	const createdAt = new Date().toISOString();

	const files: BundleFile[] = [
		{
			name: "snapshot.json",
			description: "Full SwarmSnapshot",
			content: JSON.stringify(snapshot, null, "\t"),
		},
		{
			name: "sessions.json",
			description: "Sessions and runs extract",
			content: JSON.stringify({ sessions: snapshot.sessions, runs: snapshot.runs }, null, "\t"),
		},
		{
			name: "mail.json",
			description: "Mail messages extract",
			content: JSON.stringify({ messages: snapshot.mail }, null, "\t"),
		},
		{
			name: "merge-queue.json",
			description: "Merge queue entries extract",
			content: JSON.stringify({ entries: snapshot.mergeQueue }, null, "\t"),
		},
	];

	const fileEntries = await Promise.all(files.map((f) => writeBundleFile(dir, f)));

	const manifest: RecoveryBundleManifest = {
		bundleId,
		formatVersion: 1,
		createdAt,
		snapshotId: snapshot.snapshotId,
		files: fileEntries,
	};

	// Write manifest last (atomicity signal)
	const manifestContent = `${JSON.stringify(manifest, null, "\t")}\n`;
	await Bun.write(join(dir, "manifest.json"), manifestContent);
	manifest.files.push({
		name: "manifest.json",
		description: "Bundle manifest (written last)",
		sizeBytes: Buffer.byteLength(manifestContent, "utf8"),
	});

	return manifest;
}
