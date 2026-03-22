/**
 * Mission workstream control helpers.
 *
 * Bridges mission workstream plans, brief refresh, and spec metadata so
 * mission runtime code can safely pause/resume workstreams and block stale
 * builder/reviewer dispatch.
 */

import { basename, join, relative, resolve } from "node:path";
import { loadConfig } from "../config.ts";
import { jsonError, jsonOutput } from "../json.ts";
import { printError, printSuccess } from "../logging/color.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { createTrackerClient, resolveBackend } from "../tracker/factory.ts";
import type { Mission } from "../types.ts";
import { type BriefRefreshResult, checkSpecStaleness, refreshBriefChain } from "./brief-refresh.ts";
import {
	buildMissionRoleBeacon,
	getMissionArtifactPaths,
	materializeMissionRolePrompt,
} from "./context.ts";
import { recordMissionEvent } from "./events.ts";
import type { MissionCommandDeps } from "./lifecycle.ts";
import {
	adviseGraphTransition,
	resolveCurrentMissionId,
	resolveMissionRoleStates,
	toSummary,
} from "./lifecycle.ts";
import {
	drainAgentInbox,
	nudgeMissionRoleBestEffort,
	sendMissionControlMail,
} from "./messaging.ts";
import { startExecutionDirector } from "./roles.ts";
import { listSpecMeta, readSpecMeta, type SpecMeta } from "./spec-meta.ts";
import { createMissionStore } from "./store.ts";
import {
	ensureCanonicalWorkstreamTasks,
	loadWorkstreamsFile,
	packageHandoffs,
	slingArgsFromHandoff,
	type Workstream,
} from "./workstreams.ts";

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

// === ov mission resume (per-workstream) ===

export async function missionResume(
	overstoryDir: string,
	projectRoot: string,
	workstreamId: string,
	json: boolean,
	deps: MissionCommandDeps = {},
): Promise<void> {
	const missionId = await resolveCurrentMissionId(overstoryDir);
	if (!missionId) {
		if (json) {
			jsonError("mission resume", "No active mission");
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
			if (json) {
				jsonError("mission resume", `Mission ${missionId} not found`);
			} else {
				printError("Mission not found in store", missionId);
			}
			process.exitCode = 1;
			return;
		}

		let resumeCheck: Awaited<ReturnType<typeof validateWorkstreamResume>> | undefined;
		try {
			resumeCheck = await validateWorkstreamResume(projectRoot, mission, workstreamId);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (json) {
				jsonError("mission resume", message);
			} else {
				printError("Mission resume failed", message);
			}
			process.exitCode = 1;
			return;
		}
		if (!resumeCheck.ok) {
			if (json) {
				jsonError("mission resume", resumeCheck.reason ?? "Workstream is not ready to resume");
			} else {
				printError(
					"Workstream is not ready to resume",
					resumeCheck.reason ?? "spec regeneration is still required",
				);
			}
			process.exitCode = 1;
			return;
		}

		const { resumeWorkstream } = await import("./pause.ts");
		const result = resumeWorkstream(missionStore, mission.id, workstreamId);
		const refreshedMission = missionStore.getById(mission.id) ?? mission;
		recordMissionEvent({
			overstoryDir,
			mission: refreshedMission,
			agentName: "operator",
			data: {
				kind: "workstream_resumed",
				detail: `Resumed ${workstreamId}`,
				workstreamId,
				wasNotPaused: result.wasNotPaused,
				specCount: resumeCheck.specCount,
			},
		});

		let controlMessageId: string | null = null;
		const roles = resolveMissionRoleStates(overstoryDir, refreshedMission);
		if (roles.executionDirector === "running" && !result.wasNotPaused) {
			controlMessageId = await sendMissionControlMail({
				overstoryDir,
				to: "execution-director",
				subject: `Mission control: resume ${workstreamId}`,
				body: [
					`Mission ID: ${refreshedMission.id}`,
					`Workstream: ${workstreamId}`,
					`Objective: ${resumeCheck.workstream.objective}`,
					`Spec meta records checked: ${resumeCheck.specCount}`,
					`Paused workstreams remaining: ${
						refreshedMission.pausedWorkstreamIds.length > 0
							? refreshedMission.pausedWorkstreamIds.join(", ")
							: "none"
					}`,
				].join("\n"),
			});
			await nudgeMissionRoleBestEffort(
				projectRoot,
				"execution-director",
				`Mission resume control for ${workstreamId}. Check mail and continue execution.`,
				deps,
			);
			recordMissionEvent({
				overstoryDir,
				mission: refreshedMission,
				agentName: "operator",
				data: {
					kind: "control_mail",
					detail: `Resume control sent to execution-director (${controlMessageId})`,
					workstreamId,
					to: "execution-director",
				},
			});
		}

		if (json) {
			jsonOutput("mission resume", {
				mission: toSummary(refreshedMission),
				workstreamId,
				wasNotPaused: result.wasNotPaused,
				specCount: resumeCheck.specCount,
				controlMessageId,
			});
		} else {
			printSuccess("Mission workstream resumed", workstreamId);
			process.stdout.write(`  Objective:   ${resumeCheck.workstream.objective}\n`);
			process.stdout.write(`  Already run: ${result.wasNotPaused ? "yes" : "no"}\n`);
			process.stdout.write(`  Spec metas:  ${resumeCheck.specCount}\n`);
			process.stdout.write(`  Paused left: ${refreshedMission.pausedWorkstreamIds.length}\n`);
			if (controlMessageId) {
				process.stdout.write(`  Control:     ${controlMessageId}\n`);
			}
		}
	} finally {
		missionStore.close();
	}
}

// === Helpers for missionHandoff ===

function shellQuote(arg: string): string {
	return /^[A-Za-z0-9_./:=+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

function renderShellCommand(args: string[]): string {
	return args.map(shellQuote).join(" ");
}

function openMailClient(overstoryDir: string) {
	return createMailClient(createMailStore(join(overstoryDir, "mail.db")));
}

// === ov mission handoff ===

export async function missionHandoff(
	overstoryDir: string,
	projectRoot: string,
	json: boolean,
	deps: MissionCommandDeps = {},
): Promise<void> {
	const missionId = await resolveCurrentMissionId(overstoryDir);
	if (!missionId) {
		if (json) {
			jsonError("mission handoff", "No active mission");
		} else {
			printError("No active mission");
		}
		process.exitCode = 1;
		return;
	}

	const dbPath = join(overstoryDir, "sessions.db");
	const missionStore = createMissionStore(dbPath);
	const startDirector = deps.startExecutionDirector ?? startExecutionDirector;
	const ensureCanonicalTasks =
		deps.ensureCanonicalWorkstreamTasks ?? ensureCanonicalWorkstreamTasks;
	try {
		const mission = missionStore.getById(missionId);
		if (!mission || !mission.artifactRoot || !mission.runId) {
			if (json) {
				jsonError("mission handoff", "Mission is missing required runtime metadata");
			} else {
				printError("Mission is missing required runtime metadata");
			}
			process.exitCode = 1;
			return;
		}
		if (mission.pendingUserInput) {
			if (json) {
				jsonError("mission handoff", "Mission cannot hand off while pending user input");
			} else {
				printError("Mission cannot hand off while pending user input");
			}
			process.exitCode = 1;
			return;
		}
		if (!mission.firstFreezeAt) {
			const message =
				"Mission must be frozen at least once before execution handoff (freeze ensures blocking ambiguity is resolved)";
			if (json) {
				jsonError("mission handoff", message);
			} else {
				printError("Mission handoff failed", message);
			}
			process.exitCode = 1;
			return;
		}
		const artifactRoot = mission.artifactRoot;
		const roles = resolveMissionRoleStates(overstoryDir, mission);
		if (roles.executionDirector === "running") {
			if (json) {
				jsonError("mission handoff", "Execution director is already running for this mission");
			} else {
				printError("Execution director is already running for this mission");
			}
			process.exitCode = 1;
			return;
		}

		const paths = getMissionArtifactPaths(mission);
		const validation = await loadWorkstreamsFile(paths.workstreamsJson);
		if (!validation.valid || !validation.workstreams) {
			const message =
				validation.errors[0]?.message ??
				"workstreams.json is missing or invalid; cannot hand off execution";
			if (json) {
				jsonError("mission handoff", message);
			} else {
				printError("Mission handoff failed", message);
			}
			process.exitCode = 1;
			return;
		}

		let dispatchableWorkstreams = validation.workstreams.workstreams;
		const config = await loadConfig(projectRoot);
		if (config.taskTracker.enabled) {
			try {
				const resolvedBackend = await resolveBackend(config.taskTracker.backend, projectRoot);
				const tracker = createTrackerClient(resolvedBackend, projectRoot);
				const canonical = await ensureCanonicalTasks(paths.workstreamsJson, tracker);
				dispatchableWorkstreams = canonical.workstreams;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (json) {
					jsonError("mission handoff", message);
				} else {
					printError("Mission handoff failed", message);
				}
				process.exitCode = 1;
				return;
			}
		}

		const pausedWorkstreamIds = new Set(mission.pausedWorkstreamIds);
		const allHandoffs = packageHandoffs(dispatchableWorkstreams);
		const handoffs = allHandoffs.filter(
			(handoff) => !pausedWorkstreamIds.has(handoff.workstreamId),
		);
		const skippedPausedCount = allHandoffs.length - handoffs.length;
		const dispatchCommands = handoffs.map((handoff) => {
			const args = slingArgsFromHandoff(handoff, {
				parentAgent: "execution-director",
				depth: 1,
				specBasePath: artifactRoot,
			});
			return {
				workstreamId: handoff.workstreamId,
				args,
				command: renderShellCommand(args),
			};
		});
		if (handoffs.length === 0) {
			const message =
				skippedPausedCount > 0
					? "No dispatchable workstreams found; all eligible workstreams are currently paused"
					: "No dispatchable workstreams found";
			if (json) {
				jsonError("mission handoff", message);
			} else {
				printError(message);
			}
			process.exitCode = 1;
			return;
		}

		for (const handoff of handoffs) {
			if (!handoff.briefPath) {
				if (json) {
					jsonError("mission handoff", `Workstream ${handoff.workstreamId} is missing briefPath`);
				} else {
					printError("Workstream missing briefPath", handoff.workstreamId);
				}
				process.exitCode = 1;
				return;
			}
			const briefFile = Bun.file(join(mission.artifactRoot, handoff.briefPath));
			if (!(await briefFile.exists())) {
				if (json) {
					jsonError(
						"mission handoff",
						`Workstream ${handoff.workstreamId} brief is missing: ${handoff.briefPath}`,
					);
				} else {
					printError(
						"Workstream brief is missing",
						`${handoff.workstreamId}: ${handoff.briefPath}`,
					);
				}
				process.exitCode = 1;
				return;
			}
		}

		const prompt = await materializeMissionRolePrompt({
			overstoryDir,
			agentName: "execution-director",
			capability: "execution-director",
			roleLabel: "Execution Director",
			mission,
		});
		drainAgentInbox(overstoryDir, "execution-director");

		const executionDirectorResult = await startDirector({
			missionId: mission.id,
			projectRoot,
			overstoryDir,
			existingRunId: mission.runId,
			appendSystemPromptFile: prompt.promptPath,
			beacon: buildMissionRoleBeacon({
				agentName: "execution-director",
				missionId: mission.id,
				contextPath: prompt.contextPath,
			}),
		});
		missionStore.bindSessions(mission.id, {
			executionDirectorSessionId: executionDirectorResult.session.id,
		});

		adviseGraphTransition(overstoryDir, missionStore, mission, "execute", "active");
		const beforePhase = mission.phase;
		missionStore.updatePhase(mission.id, "execute");
		recordMissionEvent({
			overstoryDir,
			mission,
			agentName: "operator",
			data: { kind: "phase_change", from: beforePhase, to: "execute" },
		});
		recordMissionEvent({
			overstoryDir,
			mission,
			agentName: "operator",
			data: { kind: "role_started", detail: "execution-director started" },
		});

		const client = openMailClient(overstoryDir);
		let messageId: string;
		try {
			messageId = client.sendProtocol({
				from: "operator",
				to: "execution-director",
				subject: `Execution handoff: ${mission.slug}`,
				body: handoffs
					.map((handoff, index) =>
						[
							`- ${handoff.workstreamId} (${handoff.taskId}): ${handoff.objective} [brief: ${handoff.briefPath}]`,
							`  Dispatch: ${dispatchCommands[index]?.command ?? "n/a"}`,
						].join("\n"),
					)
					.join("\n"),
				type: "execution_handoff",
				payload: {
					missionId: mission.id,
					taskIds: handoffs.map((handoff) => handoff.taskId),
					workstreamIds: handoffs.map((handoff) => handoff.workstreamId),
					briefPaths: handoffs.map((handoff) => handoff.briefPath!).filter(Boolean),
					dispatchCommands,
					handoffs,
				},
			});
		} finally {
			client.close();
		}
		await nudgeMissionRoleBestEffort(
			projectRoot,
			"execution-director",
			`Execution handoff is ready for mission ${mission.slug}. Check mail and dispatch workstreams.`,
			deps,
		);

		recordMissionEvent({
			overstoryDir,
			mission,
			agentName: "operator",
			data: {
				kind: "execution_handoff",
				detail: `Execution handoff sent to execution-director (${messageId})`,
				workstreamCount: handoffs.length,
				skippedPausedCount,
			},
		});

		if (json) {
			jsonOutput("mission handoff", {
				missionId: mission.id,
				messageId,
				workstreamCount: handoffs.length,
				skippedPausedCount,
				dispatchCommands,
			});
		} else {
			printSuccess("Mission handed off to execution director", mission.slug);
			process.stdout.write(`  Mail:        ${messageId}\n`);
			process.stdout.write(`  Workstreams: ${handoffs.length}\n`);
			if (skippedPausedCount > 0) {
				process.stdout.write(`  Paused skip: ${skippedPausedCount}\n`);
			}
			for (const dispatch of dispatchCommands) {
				process.stdout.write(`  Dispatch:    ${dispatch.workstreamId} -> ${dispatch.command}\n`);
			}
		}
	} finally {
		missionStore.close();
	}
}
