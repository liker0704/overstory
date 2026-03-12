/**
 * Brief-to-spec refresh chain.
 *
 * Detects when a brief file has changed since a spec was generated, and marks
 * the associated spec as stale. Does NOT regenerate the spec — that is the
 * responsibility of the mission analyst.
 */

import { markStale, readSpecMeta } from "./spec-meta.ts";

// === Types ===

export interface BriefRefreshResult {
	taskId: string;
	workstreamId: string;
	/** Brief revision recorded in the spec meta before this refresh, or null if no meta existed. */
	previousBriefRevision: string | null;
	/** SHA-256 hex hash of the brief file as of this refresh. */
	currentBriefRevision: string;
	/** Whether the spec was already stale before this refresh. */
	specWasStale: boolean;
	/** Whether this refresh call marked the spec as stale. */
	specMarkedStale: boolean;
}

export interface StaleCheckResult {
	taskId: string;
	/** Whether the spec is stale relative to the current brief content. */
	isStale: boolean;
	/** Human-readable reason, or null when not stale. */
	reason: string | null;
	/** SHA-256 hex hash of the brief file right now. */
	currentBriefRevision: string | null;
	/** SHA-256 hex hash stored in the spec meta, or null if no meta exists. */
	recordedBriefRevision: string | null;
}

// === Core functions ===

/**
 * Compute the SHA-256 hex hash of a file's contents.
 *
 * Uses Bun.CryptoHasher (not node:crypto).
 */
export async function computeBriefRevision(briefPath: string): Promise<string> {
	const file = Bun.file(briefPath);
	if (!(await file.exists())) {
		throw new Error(`Brief file not found: ${briefPath}`);
	}
	const content = await file.text();
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(content);
	return hasher.digest("hex");
}

/**
 * Check whether a spec is stale relative to its current brief content.
 *
 * Compares the SHA-256 of the current brief file against the briefRevision
 * recorded in .overstory/specs/<taskId>.meta.json. Returns isStale=true if
 * the hashes differ or if the spec meta does not exist.
 */
export async function checkSpecStaleness(
	projectRoot: string,
	taskId: string,
	briefPath: string,
): Promise<StaleCheckResult> {
	const [currentRevision, meta] = await Promise.all([
		computeBriefRevision(briefPath),
		readSpecMeta(projectRoot, taskId),
	]);

	if (meta === null) {
		return {
			taskId,
			isStale: true,
			reason: "No spec meta found — spec has not been generated yet",
			currentBriefRevision: currentRevision,
			recordedBriefRevision: null,
		};
	}

	if (meta.briefRevision !== currentRevision) {
		return {
			taskId,
			isStale: true,
			reason: `Brief has changed since spec was generated (${meta.briefRevision.slice(0, 8)} → ${currentRevision.slice(0, 8)})`,
			currentBriefRevision: currentRevision,
			recordedBriefRevision: meta.briefRevision,
		};
	}

	return {
		taskId,
		isStale: false,
		reason: null,
		currentBriefRevision: currentRevision,
		recordedBriefRevision: meta.briefRevision,
	};
}

/**
 * Refresh the brief-to-spec chain for a single workstream.
 *
 * Computes the current brief revision, reads existing spec meta, and if the
 * revision has changed marks the spec as stale. Does NOT regenerate the spec.
 */
export async function refreshBriefChain(
	projectRoot: string,
	taskId: string,
	workstreamId: string,
	briefPath: string,
): Promise<BriefRefreshResult> {
	const [currentRevision, meta] = await Promise.all([
		computeBriefRevision(briefPath),
		readSpecMeta(projectRoot, taskId),
	]);

	const previousBriefRevision = meta?.briefRevision ?? null;
	const specWasStale = meta !== null && meta.status === "stale";

	const revisionChanged = previousBriefRevision !== currentRevision;
	const specMarkedStale = revisionChanged && meta !== null && !specWasStale;

	if (specMarkedStale) {
		await markStale(projectRoot, taskId);
	}

	return {
		taskId,
		workstreamId,
		previousBriefRevision,
		currentBriefRevision: currentRevision,
		specWasStale,
		specMarkedStale,
	};
}
