/**
 * Brief-to-spec refresh chain.
 *
 * Detects when a brief file has changed since a spec was generated, and marks
 * the associated spec as stale. Does NOT regenerate the spec — that is the
 * responsibility of the mission analyst.
 */

import { join } from "node:path";
import { jsonError, jsonOutput } from "../json.ts";
import { printError, printSuccess } from "../logging/color.ts";
import { computeFileHash } from "./artifact-staleness.ts";
import { recordMissionEvent } from "./events.ts";
import type { MissionCommandDeps } from "./lifecycle.ts";
import {
	adviseGraphTransition,
	resolveCurrentMissionId,
	resolveMissionRoleStates,
	toSummary,
} from "./lifecycle.ts";
import {
	nudgeMissionRoleBestEffort,
	sendMissionControlMail,
} from "./messaging.ts";
import { pauseWorkstream } from "./pause.ts";
import { markStale, readSpecMeta } from "./spec-meta.ts";
import { createMissionStore } from "./store.ts";
import { refreshMissionBriefs } from "./workstream-control.ts";

// === Types ===

export interface BriefRefreshResult {
	taskId: string;
	workstreamId: string;
	/** Brief revision recorded in the spec meta before this refresh, or null if no meta existed. */
	previousBriefRevision: string | null;
	/** SHA-256 hex hash of the brief file as of this refresh. */
	currentBriefRevision: string;
	/** Whether the spec metadata was missing entirely before refresh. */
	metaMissing: boolean;
	/** Whether the brief revision changed relative to the recorded meta. */
	revisionChanged: boolean;
	/** Whether the spec was already stale before this refresh. */
	specWasStale: boolean;
	/** Whether this refresh call marked the spec as stale. */
	specMarkedStale: boolean;
	/** Whether execution must regenerate spec metadata before resuming. */
	regenerationRequired: boolean;
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
 * Compute the SHA-256 hex hash of a brief file's contents.
 *
 * Delegates to computeFileHash from artifact-staleness module.
 * Uses arrayBuffer() for consistency across all staleness modules.
 * Throws if the file does not exist.
 */
export async function computeBriefRevision(briefPath: string): Promise<string> {
	const hash = await computeFileHash(briefPath);
	if (hash === "MISSING") {
		throw new Error(`Brief file not found: ${briefPath}`);
	}
	return hash;
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
	const metaMissing = meta === null;
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
		metaMissing,
		revisionChanged,
		specWasStale,
		specMarkedStale,
		regenerationRequired: metaMissing || revisionChanged || specWasStale,
	};
}

// === Helpers for missionRefreshBriefsCommand ===

function shellQuote(arg: string): string {
	return /^[A-Za-z0-9_./:=+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

// === ov mission refresh-briefs ===

interface RefreshBriefOpts {
	workstream?: string;
	json?: boolean;
}

export async function missionRefreshBriefsCommand(
	overstoryDir: string,
	projectRoot: string,
	opts: RefreshBriefOpts,
	deps: MissionCommandDeps = {},
): Promise<void> {
	const missionId = await resolveCurrentMissionId(overstoryDir);
	if (!missionId) {
		if (opts.json) {
			jsonError("mission refresh-briefs", "No active mission");
		} else {
			printError("No active mission");
		}
		process.exitCode = 1;
		return;
	}

	const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
	try {
		const mission = missionStore.getById(missionId);
		if (!mission) {
			if (opts.json) {
				jsonError("mission refresh-briefs", `Mission ${missionId} not found`);
			} else {
				printError("Mission not found in store", missionId);
			}
			process.exitCode = 1;
			return;
		}

		let results: Awaited<ReturnType<typeof refreshMissionBriefs>> | undefined;
		try {
			results = await refreshMissionBriefs(projectRoot, mission, {
				workstreamId: opts.workstream,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (opts.json) {
				jsonError("mission refresh-briefs", message);
			} else {
				printError("Mission brief refresh failed", message);
			}
			process.exitCode = 1;
			return;
		}

		const pausedWorkstreamIds = new Set<string>();
		for (const result of results) {
			const pauseReason = `Brief refreshed for ${result.workstream.id}; regenerate the spec before resuming execution`;
			const shouldPause = result.regenerationRequired;
			if (shouldPause) {
				const pauseResult = pauseWorkstream(
					missionStore,
					mission.id,
					result.workstream.id,
					pauseReason,
				);
				pausedWorkstreamIds.add(result.workstream.id);
				if (!pauseResult.alreadyPaused) {
					recordMissionEvent({
						overstoryDir,
						mission,
						agentName: "operator",
						data: {
							kind: "workstream_paused",
							detail: `Paused ${result.workstream.id} after brief refresh`,
							workstreamId: result.workstream.id,
							reason: pauseReason,
						},
					});
				}
			}

			recordMissionEvent({
				overstoryDir,
				mission,
				agentName: "operator",
				data: {
					kind: "brief_refreshed",
					detail: `Refreshed brief for ${result.workstream.id}`,
					workstreamId: result.workstream.id,
					taskId: result.taskId,
					briefPath: result.projectRelativeBriefPath,
					metaMissing: result.metaMissing,
					revisionChanged: result.revisionChanged,
					specWasStale: result.specWasStale,
					specMarkedStale: result.specMarkedStale,
					regenerationRequired: result.regenerationRequired,
				},
			});
		}

		const refreshedMission = missionStore.getById(mission.id) ?? mission;
		const roles = resolveMissionRoleStates(overstoryDir, refreshedMission);
		const controlMessageIds: string[] = [];
		const pausedList = [...pausedWorkstreamIds];
		const refreshSummary = results.length
			? results
					.map((result) =>
						[
							`${result.workstream.id} (${result.taskId}) brief=${result.projectRelativeBriefPath} metaMissing=${result.metaMissing} markedStale=${result.specMarkedStale} alreadyStale=${result.specWasStale} regenerationRequired=${result.regenerationRequired}`,
							`Regenerate with: ov spec write ${result.taskId} --body '<updated spec>' --agent $OVERSTORY_AGENT_NAME --workstream-id ${result.workstream.id} --brief-path ${shellQuote(result.projectRelativeBriefPath)}`,
						].join("\n"),
					)
					.join("\n")
			: "No refreshable workstreams were found.";

		for (const recipientConfig of [
			roles.executionDirector === "running"
				? {
						recipient: "execution-director",
						type: "dispatch" as const,
						subject: pausedList.length
							? `Mission control: regenerate stale specs (${pausedList.length} paused)`
							: "Mission control: refreshed briefs",
						actionLine:
							"Action required: coordinate the owning leads to regenerate any affected specs before resuming these workstreams.",
					}
				: null,
			roles.analyst === "running"
				? {
						recipient: "mission-analyst",
						type: "status" as const,
						subject: pausedList.length
							? `Mission control: brief refresh summary (${pausedList.length} paused)`
							: "Mission control: refreshed briefs",
						actionLine:
							"Action required: update mission understanding and coordinate any cross-stream impact from the refreshed briefs.",
					}
				: null,
		]) {
			if (!recipientConfig) {
				continue;
			}
			const controlMessageId = await sendMissionControlMail({
				overstoryDir,
				to: recipientConfig.recipient,
				subject: recipientConfig.subject,
				type: recipientConfig.type,
				body: [
					`Mission ID: ${refreshedMission.id}`,
					`Scope: ${opts.workstream ?? "all workstreams"}`,
					`Paused workstreams: ${pausedList.length > 0 ? pausedList.join(", ") : "none"}`,
					recipientConfig.actionLine,
					"",
					refreshSummary,
				].join("\n"),
			});
			await nudgeMissionRoleBestEffort(
				projectRoot,
				recipientConfig.recipient,
				pausedList.length > 0
					? `Mission briefs refreshed. ${pausedList.length} workstream(s) need regeneration. Check mail.`
					: "Mission briefs refreshed. Check mail for updated context.",
				deps,
			);
			controlMessageIds.push(controlMessageId);
			recordMissionEvent({
				overstoryDir,
				mission: refreshedMission,
				agentName: "operator",
				data: {
					kind: "control_mail",
					detail: `Brief refresh control sent to ${recipientConfig.recipient} (${controlMessageId})`,
					to: recipientConfig.recipient,
					workstreamCount: results.length,
				},
			});
			if (pausedList.length > 0 && recipientConfig.recipient === "execution-director") {
				recordMissionEvent({
					overstoryDir,
					mission: refreshedMission,
					agentName: "operator",
					data: {
						kind: "spec_regeneration_requested",
						detail: `Execution director instructed to regenerate ${pausedList.length} stale spec(s)`,
						workstreamIds: pausedList,
					},
				});
			}
		}

		if (opts.json) {
			jsonOutput("mission refresh-briefs", {
				mission: toSummary(refreshedMission),
				workstreamId: opts.workstream ?? null,
				pausedWorkstreamIds: pausedList,
				controlMessageIds,
				results: results.map((result) => ({
					workstreamId: result.workstream.id,
					taskId: result.taskId,
					briefPath: result.projectRelativeBriefPath,
					previousBriefRevision: result.previousBriefRevision,
					currentBriefRevision: result.currentBriefRevision,
					metaMissing: result.metaMissing,
					revisionChanged: result.revisionChanged,
					specWasStale: result.specWasStale,
					specMarkedStale: result.specMarkedStale,
					regenerationRequired: result.regenerationRequired,
				})),
			});
		} else {
			printSuccess("Mission briefs refreshed", refreshedMission.slug);
			process.stdout.write(`  Scope:   ${opts.workstream ?? "all workstreams"}\n`);
			process.stdout.write(
				`  Paused:  ${pausedList.length > 0 ? pausedList.join(", ") : "none"}\n`,
			);
			if (results.length === 0) {
				process.stdout.write("  Result:  no refreshable briefs found\n");
			} else {
				for (const result of results) {
					const status = result.metaMissing
						? "meta-missing"
						: result.specMarkedStale
							? "stale-marked"
							: result.specWasStale
								? "already-stale"
								: result.regenerationRequired
									? "regen-required"
									: "current";
					process.stdout.write(
						`  ${result.workstream.id}: ${status} (${result.projectRelativeBriefPath})\n`,
					);
				}
			}
			if (controlMessageIds.length > 0) {
				process.stdout.write(`  Control: ${controlMessageIds.join(", ")}\n`);
			}
		}
	} finally {
		missionStore.close();
	}
}
