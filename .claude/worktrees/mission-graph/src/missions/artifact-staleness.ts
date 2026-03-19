/**
 * Unified machine-checkable staleness/invalidation policy for mission artifacts.
 *
 * Tracks SHA-256 hashes of dependency files. When those files change,
 * the associated artifact type becomes stale.
 *
 * Types are self-contained here (not in src/types.ts) following the
 * review/types.ts self-contained module pattern.
 */

import { stat } from "node:fs/promises";

// === Constants ===

/** Sentinel value for files that do not exist on disk. */
export const MISSING = "MISSING";

/** Filename for the persisted staleness snapshot within a mission dir. */
export const SNAPSHOT_FILENAME = ".artifact-staleness.json";

// === Types ===

export type ArtifactType = "brief" | "spec" | "mission-plan" | "review-output" | "mission-score";

export interface ArtifactStalenessResult {
	artifactType: ArtifactType;
	/** Whether the artifact is stale relative to its dependencies. */
	isStale: boolean;
	/** Dependency file paths (relative to missionDir) whose hashes changed. */
	changedDependencies: string[];
	/** Dependency file paths (relative to missionDir) that do not exist. */
	missingDependencies: string[];
	/** Current hashes for all dependency files. */
	currentHashes: Record<string, string>;
	/** Stored hashes from the snapshot, or null on first run. */
	storedHashes: Record<string, string> | null;
}

export interface ArtifactStalenessSnapshot {
	/** Map from file path (relative to missionDir) to SHA-256 hex hash or MISSING. */
	fileHashes: Record<string, string>;
	/** ISO 8601 timestamp when this snapshot was captured. */
	capturedAt: string;
}

export interface ArtifactStalenessReport {
	/** Absolute path to the mission directory. */
	missionDir: string;
	/** Per-artifact-type staleness results. */
	results: ArtifactStalenessResult[];
	/** True if any artifact type is stale. */
	anyStale: boolean;
	/** ISO 8601 timestamp when this report was generated. */
	checkedAt: string;
}

// === Dependency map ===

/**
 * Maps each ArtifactType to the file paths (relative to mission dir)
 * that, when changed, indicate the artifact is stale.
 */
export const ARTIFACT_DEPENDENCIES: Record<ArtifactType, string[]> = {
	brief: ["mission.md", "plan/workstreams.json"],
	spec: ["mission.md", "plan/workstreams.json"],
	"mission-plan": ["mission.md", "decisions.md", "open-questions.md", "plan/workstreams.json"],
	"review-output": ["mission.md", "decisions.md"],
	"mission-score": ["results/summary.json", "results/review.json"],
};

// === Core functions ===

/**
 * Compute the SHA-256 hex hash of a file's contents.
 *
 * Returns the sentinel value MISSING if the file does not exist.
 * Uses file.arrayBuffer() for consistency with other staleness modules.
 */
export async function computeFileHash(filePath: string): Promise<string> {
	const file = Bun.file(filePath);
	if (!(await file.exists())) {
		return MISSING;
	}
	const content = await file.arrayBuffer();
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(content);
	return hasher.digest("hex");
}

/**
 * Compute SHA-256 hashes for all dependency files of an artifact type.
 *
 * @param missionDir - Absolute path to the mission directory.
 * @param artifactType - The artifact type whose dependencies to hash.
 * @returns Map from relative file path to hash (or MISSING).
 */
export async function computeDependencyHashes(
	missionDir: string,
	artifactType: ArtifactType,
): Promise<Record<string, string>> {
	const deps = ARTIFACT_DEPENDENCIES[artifactType];
	const hashes: Record<string, string> = {};

	for (const dep of deps) {
		const fullPath = `${missionDir}/${dep}`;
		hashes[dep] = await computeFileHash(fullPath);
	}

	return hashes;
}

/**
 * Read the persisted staleness snapshot from a mission directory.
 *
 * Returns null if the snapshot file is missing or cannot be parsed.
 */
export async function readSnapshot(missionDir: string): Promise<ArtifactStalenessSnapshot | null> {
	const snapshotPath = `${missionDir}/${SNAPSHOT_FILENAME}`;
	const file = Bun.file(snapshotPath);
	if (!(await file.exists())) {
		return null;
	}
	try {
		const raw: unknown = await file.json();
		if (
			typeof raw !== "object" ||
			raw === null ||
			typeof (raw as Record<string, unknown>)["fileHashes"] !== "object" ||
			typeof (raw as Record<string, unknown>)["capturedAt"] !== "string"
		) {
			return null;
		}
		return raw as ArtifactStalenessSnapshot;
	} catch {
		return null;
	}
}

/**
 * Write a staleness snapshot to a mission directory.
 *
 * Writes with a trailing newline.
 */
export async function writeSnapshot(
	missionDir: string,
	snapshot: ArtifactStalenessSnapshot,
): Promise<void> {
	const snapshotPath = `${missionDir}/${SNAPSHOT_FILENAME}`;
	await Bun.write(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
}

/**
 * Check whether a single artifact type is stale.
 *
 * On first run (stored === null), the artifact is NOT stale — we consider
 * the current state as the baseline.
 *
 * @param missionDir - Absolute path to the mission directory.
 * @param artifactType - The artifact type to check.
 * @param stored - Previously persisted snapshot, or null on first run.
 */
export async function checkArtifactStaleness(
	missionDir: string,
	artifactType: ArtifactType,
	stored: ArtifactStalenessSnapshot | null,
): Promise<ArtifactStalenessResult> {
	const currentHashes = await computeDependencyHashes(missionDir, artifactType);
	const deps = ARTIFACT_DEPENDENCIES[artifactType];

	const missingDependencies: string[] = [];
	for (const dep of deps) {
		if (currentHashes[dep] === MISSING) {
			missingDependencies.push(dep);
		}
	}

	const storedHashes = stored
		? Object.fromEntries(deps.map((dep) => [dep, stored.fileHashes[dep] ?? MISSING]))
		: null;

	// On first run, not stale
	if (storedHashes === null) {
		return {
			artifactType,
			isStale: false,
			changedDependencies: [],
			missingDependencies,
			currentHashes,
			storedHashes: null,
		};
	}

	const changedDependencies: string[] = [];
	for (const dep of deps) {
		const current = currentHashes[dep];
		const previous = storedHashes[dep];
		if (current !== previous) {
			changedDependencies.push(dep);
		}
	}

	return {
		artifactType,
		isStale: changedDependencies.length > 0,
		changedDependencies,
		missingDependencies,
		currentHashes,
		storedHashes,
	};
}

/**
 * Check all artifact types for staleness, persist updated snapshot, and
 * return a full staleness report.
 *
 * Returns an empty report (no results) if the mission directory does not exist.
 *
 * @param missionDir - Absolute path to the mission directory.
 */
export async function computeArtifactStaleness(
	missionDir: string,
): Promise<ArtifactStalenessReport> {
	const checkedAt = new Date().toISOString();

	// Return empty report for non-existent directories
	try {
		const s = await stat(missionDir);
		if (!s.isDirectory()) {
			return { missionDir, results: [], anyStale: false, checkedAt };
		}
	} catch {
		return { missionDir, results: [], anyStale: false, checkedAt };
	}

	const stored = await readSnapshot(missionDir);
	const artifactTypes: ArtifactType[] = [
		"brief",
		"spec",
		"mission-plan",
		"review-output",
		"mission-score",
	];

	const results: ArtifactStalenessResult[] = [];
	const allCurrentHashes: Record<string, string> = {};

	for (const artifactType of artifactTypes) {
		const result = await checkArtifactStaleness(missionDir, artifactType, stored);
		results.push(result);

		// Accumulate hashes for snapshot
		for (const [path, hash] of Object.entries(result.currentHashes)) {
			allCurrentHashes[path] = hash;
		}
	}

	// Persist updated snapshot
	await writeSnapshot(missionDir, {
		fileHashes: allCurrentHashes,
		capturedAt: checkedAt,
	});

	const anyStale = results.some((r) => r.isStale);
	return { missionDir, results, anyStale, checkedAt };
}
