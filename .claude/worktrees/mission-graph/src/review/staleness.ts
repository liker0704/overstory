/**
 * Staleness detection for review orchestration surfaces.
 *
 * Tracks SHA-256 hashes of key files. When those files change,
 * prior reviews for the associated subject type become stale.
 */

import type { ReviewStore } from "./store.ts";
import type { ReviewSubjectType, StalenessState } from "./types.ts";

/** Sentinel value for files that do not exist on disk. */
const MISSING = "MISSING";

/**
 * Map from subject type to the files that, when changed, invalidate reviews
 * of that type.
 */
export const WATCHED_SURFACES: Record<ReviewSubjectType, string[]> = {
	session: [
		"agents/coordinator.md",
		"agents/lead.md",
		"agents/builder.md",
		"agents/scout.md",
		"agents/reviewer.md",
		"src/agents/overlay.ts",
		"src/agents/hooks-deployer.ts",
		"templates/overlay.md.tmpl",
	],
	handoff: [
		"src/agents/checkpoint.ts",
		"src/agents/lifecycle.ts",
		"agents/lead.md",
		"agents/builder.md",
	],
	spec: ["src/commands/spec.ts", "agents/lead.md", "templates/overlay.md.tmpl"],
	mission: [
		"src/commands/mission.ts",
		"src/missions/store.ts",
		"src/missions/context.ts",
		"src/missions/bundle.ts",
		"src/missions/events.ts",
		"src/missions/narrative.ts",
		"src/missions/review.ts",
		"src/review/analyzers/mission.ts",
	],
};

/**
 * Compute a StalenessState snapshot for a single subject type.
 *
 * Hashes each watched file with SHA-256. Missing files get the sentinel
 * value "MISSING" instead of a hash.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @param subjectType - Which subject type's surfaces to hash.
 */
export async function computeStalenessState(
	repoRoot: string,
	subjectType: ReviewSubjectType,
): Promise<StalenessState> {
	const paths = WATCHED_SURFACES[subjectType];
	const fileHashes: Record<string, string> = {};

	for (const relativePath of paths) {
		const fullPath = `${repoRoot}/${relativePath}`;
		const file = Bun.file(fullPath);
		const exists = await file.exists();

		if (!exists) {
			fileHashes[relativePath] = MISSING;
		} else {
			const content = await file.arrayBuffer();
			const hasher = new Bun.CryptoHasher("sha256");
			hasher.update(content);
			fileHashes[relativePath] = hasher.digest("hex");
		}
	}

	return {
		fileHashes,
		capturedAt: new Date().toISOString(),
	};
}

/**
 * Diff two staleness states and return which file paths changed.
 *
 * @param current - Freshly computed state.
 * @param stored - Previously persisted state, or null on first run.
 * @returns Array of file paths whose hashes differ. Empty on first run (stored === null).
 */
export function detectStaleness(current: StalenessState, stored: StalenessState | null): string[] {
	if (stored === null) return [];

	const changed: string[] = [];
	for (const [path, hash] of Object.entries(current.fileHashes)) {
		if (stored.fileHashes[path] !== hash) {
			changed.push(path);
		}
	}
	return changed;
}

/**
 * Check all three subject types for staleness, mark affected reviews in the
 * store, persist the updated hash snapshot, and return the per-type diff.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @param store - ReviewStore instance for reading/writing staleness state.
 * @returns Array of per-subject-type results containing changed file paths.
 */
export async function checkAndMarkStale(
	repoRoot: string,
	store: ReviewStore,
): Promise<{ subjectType: ReviewSubjectType; changedPaths: string[] }[]> {
	const subjectTypes: ReviewSubjectType[] = ["session", "handoff", "spec", "mission"];
	const stored = store.loadStalenessState();
	const results: { subjectType: ReviewSubjectType; changedPaths: string[] }[] = [];
	const allCurrentHashes: Record<string, string> = {};

	for (const subjectType of subjectTypes) {
		const current = await computeStalenessState(repoRoot, subjectType);

		// Accumulate hashes for final snapshot save
		for (const [path, hash] of Object.entries(current.fileHashes)) {
			allCurrentHashes[path] = hash;
		}

		// Build a stored state scoped to this subject's watched paths so we
		// can compare only the relevant hashes.
		const paths = WATCHED_SURFACES[subjectType];
		const storedForSubject: StalenessState | null = stored
			? {
					fileHashes: Object.fromEntries(paths.map((p) => [p, stored.fileHashes[p] ?? MISSING])),
					capturedAt: stored.capturedAt,
				}
			: null;

		const changedPaths = detectStaleness(current, storedForSubject);

		if (changedPaths.length > 0) {
			store.markStale(subjectType, `Watched surfaces changed: ${changedPaths.join(", ")}`);
		}

		results.push({ subjectType, changedPaths });
	}

	// Always persist the latest snapshot so subsequent calls detect
	// incremental changes correctly.
	store.saveStalenessState({
		fileHashes: allCurrentHashes,
		capturedAt: new Date().toISOString(),
	});

	return results;
}
