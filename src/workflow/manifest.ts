/** Workflow import manifest — CRUD and drift detection. */

import type { ImportManifest, ParsedWorkflow, SyncResult } from "./types.ts";

// Known artifact filenames relative to sourcePath
const KNOWN_ARTIFACTS = [
	"task.md",
	"plan/tasks.md",
	"plan/plan.md",
	"plan/risks.md",
	"plan/acceptance.md",
	"architecture.md",
	"research/_summary.md",
];

// ── helpers ────────────────────────────────────────────────────────────────────────────────────

async function hashFile(filePath: string): Promise<string | null> {
	try {
		const data = await Bun.file(filePath).arrayBuffer();
		const hasher = new Bun.CryptoHasher("sha256");
		hasher.update(data);
		return hasher.digest("hex");
	} catch {
		return null;
	}
}

function hashString(content: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(content);
	return hasher.digest("hex");
}

// ── createManifest ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an ImportManifest from parsed workflow data.
 * Hashes each known artifact file (skips missing optional files).
 */
export async function createManifest(
	sourcePath: string,
	parsed: ParsedWorkflow,
	workstreamIds: string[],
	briefContents: Record<string, string>,
): Promise<ImportManifest> {
	// Hash artifact files
	const artifactHashes: Record<string, string> = {};
	for (const artifact of KNOWN_ARTIFACTS) {
		const hash = await hashFile(`${sourcePath}/${artifact}`);
		if (hash !== null) {
			artifactHashes[artifact] = hash;
		}
	}

	// Build briefHashes: workstream ID -> SHA256 of brief content string
	const briefHashes: Record<string, string> = {};
	for (const wsId of workstreamIds) {
		const content = briefContents[wsId];
		if (content !== undefined) {
			briefHashes[wsId] = hashString(content);
		}
	}

	// Build taskMapping: workstream ID -> source task ID
	// Assumes tasks are assigned to workstreams in index order
	const taskMapping: Record<string, string> = {};
	for (let i = 0; i < workstreamIds.length; i++) {
		const wsId = workstreamIds[i];
		const task = parsed.tasks[i];
		if (wsId !== undefined && task !== undefined) {
			taskMapping[wsId] = task.id;
		}
	}

	return {
		version: 1,
		sourcePath,
		sourceSlug: parsed.metadata.slug,
		importedAt: new Date().toISOString(),
		artifactHashes,
		briefHashes,
		taskMapping,
	};
}

// ── writeManifest ──────────────────────────────────────────────────────────────────────────────

/** Write manifest as JSON with tab indentation. */
export async function writeManifest(manifestPath: string, manifest: ImportManifest): Promise<void> {
	await Bun.write(manifestPath, JSON.stringify(manifest, null, "\t"));
}

// ── readManifest ───────────────────────────────────────────────────────────────────────────────

/** Read and parse manifest JSON; returns null if file is missing or unparseable. */
export async function readManifest(manifestPath: string): Promise<ImportManifest | null> {
	try {
		const text = await Bun.file(manifestPath).text();
		return JSON.parse(text) as ImportManifest;
	} catch {
		return null;
	}
}

// ── detectDrift ────────────────────────────────────────────────────────────────────────────────

/**
 * Compare current artifact hashes and task list against stored manifest.
 * Returns a SyncResult describing what changed.
 */
export async function detectDrift(
	manifest: ImportManifest,
	sourcePath: string,
): Promise<SyncResult> {
	const drifted: SyncResult["drifted"] = [];
	const added: string[] = [];
	const removed: string[] = [];
	const unchanged: string[] = [];

	// Re-hash all known artifacts
	const currentHashes: Record<string, string> = {};
	for (const artifact of KNOWN_ARTIFACTS) {
		const hash = await hashFile(`${sourcePath}/${artifact}`);
		if (hash !== null) {
			currentHashes[artifact] = hash;
		}
	}

	// Compare stored artifact hashes
	const checkedArtifacts = new Set<string>();
	for (const [artifact, oldHash] of Object.entries(manifest.artifactHashes)) {
		checkedArtifacts.add(artifact);
		const newHash = currentHashes[artifact];
		if (newHash === undefined) {
			removed.push(`artifact:${artifact}`);
		} else if (newHash !== oldHash) {
			drifted.push({ workstreamId: artifact, field: "hash", old: oldHash, new: newHash });
		} else {
			unchanged.push(`artifact:${artifact}`);
		}
	}

	// Detect newly added artifacts
	for (const artifact of Object.keys(currentHashes)) {
		if (!checkedArtifacts.has(artifact)) {
			added.push(`artifact:${artifact}`);
		}
	}

	// Re-parse source to compare tasks — lazy import to avoid circular deps
	const { parseWorkflow } = await import("./parse.ts");
	const current = await parseWorkflow(sourcePath);
	const currentTaskIds = new Set(current.tasks.map((t) => t.id));
	const storedTaskIds = new Set(Object.values(manifest.taskMapping));

	for (const taskId of storedTaskIds) {
		if (!currentTaskIds.has(taskId)) {
			removed.push(`task:${taskId}`);
		}
	}

	for (const taskId of currentTaskIds) {
		if (!storedTaskIds.has(taskId)) {
			added.push(`task:${taskId}`);
		}
	}

	return { drifted, added, removed, unchanged };
}
