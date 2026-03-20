/**
 * Mission workstream control helpers.
 *
 * Bridges mission workstream plans, brief refresh, and spec metadata so
 * mission runtime code can safely pause/resume workstreams and block stale
 * builder/reviewer dispatch.
 */

import { basename, join, relative, resolve } from "node:path";
import type { Mission } from "../types.ts";
import { type BriefRefreshResult, checkSpecStaleness, refreshBriefChain } from "./brief-refresh.ts";
import { listSpecMeta, readSpecMeta, type SpecMeta } from "./spec-meta.ts";
import { loadWorkstreamsFile, type Workstream } from "./workstreams.ts";

export interface MissionWorkstreamRef {
	workstream: Workstream;
	absoluteBriefPath: string | null;
}

export interface MissionBriefRefreshEntry extends BriefRefreshResult {
	workstream: Workstream;
	absoluteBriefPath: string;
	projectRelativeBriefPath: string;
}

export interface SpecValidationResult {
	ok: boolean;
	taskId: string | null;
	reason: string | null;
	meta: SpecMeta | null;
}

export interface WorkstreamResumeCheck {
	ok: boolean;
	workstream: Workstream;
	specCount: number;
	reason: string | null;
}

function ensureArtifactRoot(mission: Pick<Mission, "id" | "artifactRoot">): string {
	if (!mission.artifactRoot) {
		throw new Error(`Mission ${mission.id} has no artifact root`);
	}
	return mission.artifactRoot;
}

export function normalizeTrackedPath(projectRoot: string, pathValue: string): string {
	const absolute = resolve(projectRoot, pathValue);
	const rel = relative(projectRoot, absolute);
	return rel.startsWith("..") ? absolute : rel;
}

export function specTaskIdFromPath(specPath: string): string | null {
	const file = basename(specPath);
	if (!file.endsWith(".md")) {
		return null;
	}
	const taskId = file.slice(0, -3).trim();
	return taskId.length > 0 ? taskId : null;
}

export function workstreamRequiresCurrentSpec(workstream: Workstream): boolean {
	return workstream.briefPath !== null;
}

export async function loadMissionWorkstreams(
	mission: Pick<Mission, "id" | "artifactRoot">,
): Promise<MissionWorkstreamRef[]> {
	const artifactRoot = ensureArtifactRoot(mission);
	const validation = await loadWorkstreamsFile(join(artifactRoot, "plan", "workstreams.json"));
	if (!validation.valid || !validation.workstreams) {
		const message = validation.errors[0]?.message ?? "workstreams.json is missing or invalid";
		throw new Error(message);
	}

	return validation.workstreams.workstreams.map((workstream) => {
		const absoluteBriefPath =
			workstream.briefPath !== null ? join(artifactRoot, workstream.briefPath) : null;
		return {
			workstream,
			absoluteBriefPath,
		};
	});
}

export async function getMissionWorkstream(
	mission: Pick<Mission, "id" | "artifactRoot">,
	workstreamId: string,
): Promise<MissionWorkstreamRef> {
	const workstreams = await loadMissionWorkstreams(mission);
	const match = workstreams.find((entry) => entry.workstream.id === workstreamId);
	if (!match) {
		throw new Error(`Unknown workstream: ${workstreamId}`);
	}
	return match;
}

export async function refreshMissionBriefs(
	projectRoot: string,
	mission: Pick<Mission, "id" | "artifactRoot">,
	opts: { workstreamId?: string } = {},
): Promise<MissionBriefRefreshEntry[]> {
	const workstreams = opts.workstreamId
		? [await getMissionWorkstream(mission, opts.workstreamId)]
		: await loadMissionWorkstreams(mission);

	const refreshable = workstreams.filter((entry) => entry.workstream.briefPath !== null);
	if (refreshable.length === 0) {
		return [];
	}

	const results: MissionBriefRefreshEntry[] = [];
	for (const entry of refreshable) {
		if (!entry.absoluteBriefPath) {
			continue;
		}
		const result = await refreshBriefChain(
			projectRoot,
			entry.workstream.taskId,
			entry.workstream.id,
			entry.absoluteBriefPath,
		);
		results.push({
			...result,
			workstream: entry.workstream,
			absoluteBriefPath: entry.absoluteBriefPath,
			projectRelativeBriefPath: normalizeTrackedPath(projectRoot, entry.absoluteBriefPath),
		});
	}
	return results;
}

export async function validateCurrentMissionSpec(
	projectRoot: string,
	specPath: string,
	opts: { expectedTaskId?: string } = {},
): Promise<SpecValidationResult> {
	const taskId = specTaskIdFromPath(specPath);
	if (!taskId) {
		return {
			ok: false,
			taskId: null,
			reason: "Unable to derive task ID from spec path",
			meta: null,
		};
	}
	if (opts.expectedTaskId && taskId !== opts.expectedTaskId) {
		return {
			ok: false,
			taskId,
			reason: `Spec path task ${taskId} does not match requested task ${opts.expectedTaskId}`,
			meta: null,
		};
	}

	const meta = await readSpecMeta(projectRoot, taskId);
	if (meta === null) {
		return {
			ok: false,
			taskId,
			reason: `No spec metadata found for ${taskId}`,
			meta: null,
		};
	}

	if (meta.status !== "current") {
		return {
			ok: false,
			taskId,
			reason: `Spec metadata for ${taskId} is ${meta.status}`,
			meta,
		};
	}
	if (meta.taskId !== taskId) {
		return {
			ok: false,
			taskId,
			reason: `Spec metadata taskId ${meta.taskId} does not match spec path task ${taskId}`,
			meta,
		};
	}

	const briefPath = resolve(projectRoot, meta.briefPath);
	const stale = await checkSpecStaleness(projectRoot, taskId, briefPath);
	if (stale.isStale) {
		return {
			ok: false,
			taskId,
			reason: stale.reason ?? `Spec ${taskId} is stale`,
			meta,
		};
	}

	return { ok: true, taskId, reason: null, meta };
}

export async function validateWorkstreamResume(
	projectRoot: string,
	mission: Pick<Mission, "id" | "artifactRoot">,
	workstreamId: string,
): Promise<WorkstreamResumeCheck> {
	const entry = await getMissionWorkstream(mission, workstreamId);
	const metas = (await listSpecMeta(projectRoot)).filter(
		(meta) => meta.workstreamId === workstreamId && meta.taskId === entry.workstream.taskId,
	);
	const requiresSpec = workstreamRequiresCurrentSpec(entry.workstream);

	if (metas.length === 0 && requiresSpec) {
		return {
			ok: false,
			workstream: entry.workstream,
			specCount: 0,
			reason: `No current spec metadata found for ${entry.workstream.taskId}; regenerate the lead spec before resuming`,
		};
	}

	if (metas.length === 0) {
		return {
			ok: true,
			workstream: entry.workstream,
			specCount: 0,
			reason: null,
		};
	}

	for (const meta of metas) {
		if (meta.status !== "current") {
			return {
				ok: false,
				workstream: entry.workstream,
				specCount: metas.length,
				reason: `Spec ${meta.taskId} is marked ${meta.status}`,
			};
		}

		const briefPath = resolve(projectRoot, meta.briefPath);
		const stale = await checkSpecStaleness(projectRoot, meta.taskId, briefPath);
		if (stale.isStale) {
			return {
				ok: false,
				workstream: entry.workstream,
				specCount: metas.length,
				reason: stale.reason ?? `Spec ${meta.taskId} is stale`,
			};
		}
	}

	return {
		ok: true,
		workstream: entry.workstream,
		specCount: metas.length,
		reason: null,
	};
}
