/**
 * Spec metadata for brief-to-spec lifecycle tracking.
 *
 * Each spec file (.overstory/specs/<taskId>.md) may have a companion
 * .meta.json file that records the brief revision at the time the spec
 * was generated, the spec's own revision, and a staleness status.
 *
 * This enables the brief-refresh chain to detect when a brief has changed
 * after a spec was generated and mark the spec as stale.
 */

import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

// === Types ===

export type SpecMetaStatus = "current" | "stale" | "superseded" | "unscored" | "under-target";

export const SPEC_META_STATUSES: readonly SpecMetaStatus[] = [
	"current",
	"stale",
	"superseded",
	"unscored",
	"under-target",
] as const;

export interface SpecMeta {
	/** Seeds/tracker task ID that owns this spec. */
	taskId: string;
	/** Workstream ID within the mission plan. */
	workstreamId: string;
	/** Relative path to the brief file (within artifact root or project root). */
	briefPath: string;
	/** SHA-256 hex hash of the brief content at spec-generation time. */
	briefRevision: string;
	/** SHA-256 hex hash of the spec file content at write time. */
	specRevision: string;
	/** Staleness status of this spec relative to its brief. */
	status: SpecMetaStatus;
	/** ISO 8601 timestamp when this spec was generated. */
	generatedAt: string;
	/** Name of the agent that generated this spec. */
	generatedBy: string;
}

// === Path helpers ===

function specsDir(projectRoot: string): string {
	return join(projectRoot, ".overstory", "specs");
}

function metaPath(projectRoot: string, taskId: string): string {
	return join(specsDir(projectRoot), `${taskId}.meta.json`);
}

// === I/O functions ===

/**
 * Read spec metadata for a given task.
 *
 * Returns null if the .meta.json file does not exist.
 */
function isValidSpecMeta(raw: unknown): raw is SpecMeta {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
	const obj = raw as Record<string, unknown>;
	return (
		typeof obj.taskId === "string" &&
		typeof obj.workstreamId === "string" &&
		typeof obj.briefPath === "string" &&
		typeof obj.briefRevision === "string" &&
		typeof obj.specRevision === "string" &&
		typeof obj.status === "string" &&
		SPEC_META_STATUSES.includes(obj.status as SpecMetaStatus) &&
		typeof obj.generatedAt === "string" &&
		typeof obj.generatedBy === "string"
	);
}

export async function readSpecMeta(projectRoot: string, taskId: string): Promise<SpecMeta | null> {
	const path = metaPath(projectRoot, taskId);
	const file = Bun.file(path);
	const exists = await file.exists();
	if (!exists) {
		return null;
	}
	try {
		const raw = await file.json();
		if (!isValidSpecMeta(raw)) {
			return null;
		}
		return raw;
	} catch {
		return null;
	}
}

/**
 * Write spec metadata for a given task.
 *
 * Creates the .overstory/specs/ directory if it does not exist.
 * Returns the absolute path to the written file.
 */
export async function writeSpecMeta(
	projectRoot: string,
	taskId: string,
	meta: SpecMeta,
): Promise<string> {
	const dir = specsDir(projectRoot);
	await mkdir(dir, { recursive: true });
	const path = metaPath(projectRoot, taskId);
	await Bun.write(path, `${JSON.stringify(meta, null, 2)}\n`);
	return path;
}

/**
 * List all spec metadata records in .overstory/specs/.
 *
 * Reads all *.meta.json files and returns parsed SpecMeta objects.
 * Skips files that cannot be parsed.
 */
export async function listSpecMeta(projectRoot: string): Promise<SpecMeta[]> {
	const dir = specsDir(projectRoot);
	try {
		const s = await stat(dir);
		if (!s.isDirectory()) {
			return [];
		}
	} catch {
		return [];
	}
	const glob = new Bun.Glob("*.meta.json");
	const results: SpecMeta[] = [];

	for await (const filename of glob.scan({ cwd: dir, onlyFiles: true })) {
		const file = Bun.file(join(dir, filename));
		try {
			const raw = await file.json();
			results.push(raw as SpecMeta);
		} catch {
			// Skip unparseable files
		}
	}

	return results;
}

/**
 * Mark a spec as stale.
 *
 * Reads the existing meta.json, sets status to 'stale', and writes it back.
 * No-op if the file does not exist.
 */
export async function markStale(projectRoot: string, taskId: string): Promise<void> {
	const existing = await readSpecMeta(projectRoot, taskId);
	if (existing === null) {
		return;
	}
	await writeSpecMeta(projectRoot, taskId, { ...existing, status: "stale" });
}

/**
 * Mark a spec as superseded.
 *
 * Reads the existing meta.json, sets status to 'superseded', and writes it back.
 * No-op if the file does not exist.
 */
export async function markSuperseded(projectRoot: string, taskId: string): Promise<void> {
	const existing = await readSpecMeta(projectRoot, taskId);
	if (existing === null) {
		return;
	}
	await writeSpecMeta(projectRoot, taskId, { ...existing, status: "superseded" });
}
