/**
 * CLI command: ov mission <subcommand>
 *
 * Long-running objective tracking for overstory mission mode.
 */

import { mkdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { jsonError, jsonOutput } from "../json.ts";
import {
	accent,
	printError,
	printHint,
	printSuccess,
	printWarning,
} from "../logging/color.ts";
import { renderHeader, renderSubHeader, separator } from "../logging/theme.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import {
	buildMissionRoleBeacon,
	ensureMissionArtifacts,
	getMissionArtifactPaths,
	materializeMissionRolePrompt,
} from "../missions/context.ts";
import { loadMissionEvents, recordMissionEvent } from "../missions/events.ts";
import { buildNarrative, renderNarrative } from "../missions/narrative.ts";
import { pauseWorkstream, resumeWorkstream } from "../missions/pause.ts";
import { generateMissionReview } from "../missions/review.ts";
import {
	startExecutionDirector,
	startMissionAnalyst,
	stopMissionRole,
} from "../missions/roles.ts";
import { createMissionStore } from "../missions/store.ts";
import {
	getMissionWorkstream,
	refreshMissionBriefs,
	validateWorkstreamResume,
} from "../missions/workstream-control.ts";
import { loadWorkstreamsFile, packageHandoffs } from "../missions/workstreams.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { createRunStore } from "../sessions/store.ts";
import type { InsertMission, Mission, MissionSummary } from "../types.ts";

/** Path to current-mission.txt pointer file. */
function currentMissionPath(overstoryDir: string): string {
	return join(overstoryDir, "current-mission.txt");
}

/** Path to current-run.txt pointer file. */
function currentRunPath(overstoryDir: string): string {
	return join(overstoryDir, "current-run.txt");
}

/** Read current mission ID from pointer file, or null. */
async function readPointerMissionId(overstoryDir: string): Promise<string | null> {
	const file = Bun.file(currentMissionPath(overstoryDir));
	if (!(await file.exists())) return null;
	const text = await file.text();
	const trimmed = text.trim();
	return trimmed.length > 0 ? trimmed : null;
}

async function writeMissionPointers(
	overstoryDir: string,
	missionId: string,
	runId: string | null,
): Promise<void> {
	await Bun.write(currentMissionPath(overstoryDir), `${missionId}\n`);
	if (runId) {
		await Bun.write(currentRunPath(overstoryDir), `${runId}\n`);
	}
}

async function clearMissionPointers(overstoryDir: string): Promise<void> {
	for (const path of [currentMissionPath(overstoryDir), currentRunPath(overstoryDir)]) {
		try {
			await unlink(path);
		} catch {
			// Pointer may already be absent.
		}
	}
}

export async function resolveCurrentMissionId(overstoryDir: string): Promise<string | null> {
	const pointedId = await readPointerMissionId(overstoryDir);
	if (pointedId) {
		return pointedId;
	}

	const dbPath = join(overstoryDir, "sessions.db");
	const dbFile = Bun.file(dbPath);
	if (!(await dbFile.exists())) {
		return null;
	}

	const missionStore = createMissionStore(dbPath);
	try {
		const active = missionStore.getActive();
		if (!active) {
			return null;
		}
		await writeMissionPointers(overstoryDir, active.id, active.runId);
		return active.id;
	} finally {
		missionStore.close();
	}
}

/** Convert Mission to MissionSummary. */
function toSummary(mission: Mission): MissionSummary {
	return {
		id: mission.id,
		slug: mission.slug,
		objective: mission.objective,
		state: mission.state,
		phase: mission.phase,
		pendingUserInput: mission.pendingUserInput,
		pendingInputKind: mission.pendingInputKind,
		firstFreezeAt: mission.firstFreezeAt,
		reopenCount: mission.reopenCount,
		pausedWorkstreamCount: mission.pausedWorkstreamIds.length,
		pauseReason: mission.pauseReason,
		createdAt: mission.createdAt,
		updatedAt: mission.updatedAt,
	};
}

function openMailClient(overstoryDir: string) {
	return createMailClient(createMailStore(join(overstoryDir, "mail.db")));
}

async function readAnswerBody(opts: { body?: string; file?: string }): Promise<string | null> {
	if (opts.body !== undefined) {
		const body = opts.body.trim();
		return body.length > 0 ? body : null;
	}
	if (opts.file !== undefined) {
		const file = Bun.file(opts.file);
		if (!(await file.exists())) {
			throw new Error(`Answer file not found: ${opts.file}`);
		}
		const body = (await file.text()).trim();
		return body.length > 0 ? body : null;
	}
	return null;
}

function roleRuntimeState(
	allSessions: Array<{ id: string; agentName: string; state: string }>,
	sessionId: string | null,
): string {
	if (!sessionId) return "not started";
	const session = allSessions.find((candidate) => candidate.id === sessionId);
	if (!session) return "unknown";
	if (session.state === "completed" || session.state === "zombie") {
		return "stopped";
	}
	return "running";
}

function resolveMissionRoleStates(
	overstoryDir: string,
	mission: Mission,
): {
	coordinator: string;
	analyst: string;
	executionDirector: string;
} {
	try {
		const { store } = openSessionStore(overstoryDir);
		try {
			const sessions = store.getAll();
			const coordinatorSession =
				sessions.find((session) => session.agentName === "coordinator") ?? null;
			return {
				coordinator:
					coordinatorSession && coordinatorSession.state !== "completed"
						? "running"
						: "not started",
				analyst: roleRuntimeState(sessions, mission.analystSessionId),
				executionDirector: roleRuntimeState(sessions, mission.executionDirectorSessionId),
			};
		} finally {
			store.close();
		}
	} catch {
		return {
			coordinator: "unknown",
			analyst: "unknown",
			executionDirector: "unknown",
		};
	}
}

function renderMissionNarrative(mission: Mission, overstoryDir: string): string {
	return renderNarrative(buildNarrative(mission, loadMissionEvents(overstoryDir, mission)));
}

async function sendMissionDispatchMail(opts: {
	overstoryDir: string;
	to: string;
	subject: string;
	body: string;
}): Promise<string> {
	const client = openMailClient(opts.overstoryDir);
	try {
		return client.send({
			from: "operator",
			to: opts.to,
			subject: opts.subject,
			body: opts.body,
			type: "dispatch",
		});
	} finally {
		client.close();
	}
}

async function sendMissionControlMail(opts: {
	overstoryDir: string;
	to: string;
	subject: string;
	body: string;
}): Promise<string> {
	const client = openMailClient(opts.overstoryDir);
	try {
		return client.send({
			from: "operator",
			to: opts.to,
			subject: opts.subject,
			body: opts.body,
			type: "status",
		});
	} finally {
		client.close();
	}
}

async function terminalizeMission(opts: {
	overstoryDir: string;
	projectRoot: string;
	mission: Mission;
	targetState: "completed" | "stopped";
	json: boolean;
}): Promise<{ bundlePath: string | null; reviewId: string | null }> {
	const { overstoryDir, projectRoot, mission, targetState, json } = opts;
	const dbPath = join(overstoryDir, "sessions.db");
	const missionStore = createMissionStore(dbPath);

	try {
		for (const roleName of ["mission-analyst", "execution-director"]) {
			try {
				await stopMissionRole(roleName, {
					projectRoot,
					overstoryDir,
					completeRun: false,
					runStatus: targetState === "completed" ? "completed" : "stopped",
				});
				recordMissionEvent({
					overstoryDir,
					mission,
					agentName: "operator",
					data: { kind: "role_stopped", detail: `${roleName} stopped` },
				});
			} catch {
				// Role may not be running.
			}
		}

		const beforeState = mission.state;
		const beforePhase = mission.phase;
		if (targetState === "completed") {
			if (mission.phase !== "done") {
				missionStore.updatePhase(mission.id, "done");
				recordMissionEvent({
					overstoryDir,
					mission,
					agentName: "operator",
					data: { kind: "phase_change", from: beforePhase, to: "done" },
				});
			}
			missionStore.completeMission(mission.id);
		} else {
			missionStore.updateState(mission.id, "stopped");
		}

		recordMissionEvent({
			overstoryDir,
			mission,
			agentName: "operator",
			data: { kind: "state_change", from: beforeState, to: targetState },
		});

		if (mission.runId) {
			const runStore = createRunStore(dbPath);
			try {
				runStore.completeRun(mission.runId, targetState === "completed" ? "completed" : "stopped");
			} finally {
				runStore.close();
			}
		}

		await clearMissionPointers(overstoryDir);

		let bundlePath: string | null = null;
		let refreshedMission = missionStore.getById(mission.id) ?? mission;
		try {
			const { exportBundle } = await import("../missions/bundle.ts");
			const initialBundle = await exportBundle({
				overstoryDir,
				dbPath,
				missionId: mission.id,
				force: true,
			});
			bundlePath = initialBundle.outputDir;
		} catch (err) {
			if (!json) {
				printWarning("Bundle export failed", String(err));
			}
		}

		const review = generateMissionReview({ overstoryDir, mission: refreshedMission });
		recordMissionEvent({
			overstoryDir,
			mission: refreshedMission,
			agentName: "operator",
			data: {
				kind: "review_generated",
				detail: `Mission review recorded (${review.record.overallScore}/100)`,
			},
		});

		try {
			const { exportBundle } = await import("../missions/bundle.ts");
			const bundleResult = await exportBundle({
				overstoryDir,
				dbPath,
				missionId: mission.id,
				force: true,
			});
			bundlePath = bundleResult.outputDir;
			if (!json) {
				printSuccess("Bundle exported", bundleResult.outputDir);
			}
		} catch (err) {
			if (!json) {
				printWarning("Bundle refresh after review failed", String(err));
			}
		}

		return { bundlePath, reviewId: review.record.id };
	} finally {
		missionStore.close();
	}
}

// === ov mission start ===

interface StartOpts {
	slug?: string;
	objective?: string;
	json?: boolean;
}

async function missionStart(
	overstoryDir: string,
	projectRoot: string,
	opts: StartOpts,
): Promise<void> {
	if (!opts.objective) {
		printError("--objective is required");
		process.exitCode = 1;
		return;
	}
	if (!opts.slug) {
		printError("--slug is required");
		process.exitCode = 1;
		return;
	}

	const dbPath = join(overstoryDir, "sessions.db");
	const missionStore = createMissionStore(dbPath);
	const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-mission`;
	const missionId = `mission-${Date.now()}-${opts.slug}`;
	const artifactRoot = join(overstoryDir, "missions", missionId);
	let missionCreated = false;
	let analystStarted = false;

	try {
		const existing = missionStore.getActive();
		if (existing) {
			if (opts.json) {
				jsonError("mission start", `Active mission already exists: ${existing.id}`);
			} else {
				printError("An active mission already exists", existing.slug);
				printHint("Stop it first with: ov mission stop");
			}
			process.exitCode = 1;
			return;
		}

		const runStore = createRunStore(dbPath);
		try {
			runStore.createRun({
				id: runId,
				startedAt: new Date().toISOString(),
				coordinatorSessionId: null,
				coordinatorName: "mission",
				status: "active",
			});
		} finally {
			runStore.close();
		}

		await mkdir(artifactRoot, { recursive: true });

		const insertMission: InsertMission = {
			id: missionId,
			slug: opts.slug,
			objective: opts.objective,
			runId,
			artifactRoot,
			startedAt: new Date().toISOString(),
		};
		const createdMission = missionStore.create(insertMission);
		missionCreated = true;
		missionStore.start(missionId);
		const mission = missionStore.getById(missionId) ?? createdMission;

		await ensureMissionArtifacts(mission);
		const prompt = await materializeMissionRolePrompt({
			overstoryDir,
			agentName: "mission-analyst",
			capability: "mission-analyst",
			roleLabel: "Mission Analyst",
			mission,
		});

		await writeMissionPointers(overstoryDir, mission.id, runId);

		await startMissionAnalyst({
			missionId: mission.id,
			projectRoot,
			overstoryDir,
			existingRunId: runId,
			appendSystemPromptFile: prompt.promptPath,
			beacon: buildMissionRoleBeacon({
				agentName: "mission-analyst",
				missionId: mission.id,
				contextPath: prompt.contextPath,
			}),
		});
		analystStarted = true;

		const dispatchId = await sendMissionDispatchMail({
			overstoryDir,
			to: "mission-analyst",
			subject: `Mission started: ${mission.slug}`,
			body: [
				`Mission ID: ${mission.id}`,
				`Objective: ${mission.objective}`,
				`Artifact root: ${mission.artifactRoot ?? "none"}`,
				`Context file: ${prompt.contextPath}`,
			].join("\n"),
		});

		recordMissionEvent({
			overstoryDir,
			mission,
			agentName: "operator",
			data: {
				kind: "mission_started",
				detail: `Mission started and dispatched to mission-analyst (${dispatchId})`,
			},
		});
		recordMissionEvent({
			overstoryDir,
			mission,
			agentName: "operator",
			data: { kind: "role_started", detail: "mission-analyst started" },
		});

		if (opts.json) {
			jsonOutput("mission start", { mission: toSummary(mission), runId, dispatchId });
		} else {
			printSuccess("Mission started", mission.slug);
			process.stdout.write(`  ID:          ${accent(mission.id)}\n`);
			process.stdout.write(`  Objective:   ${mission.objective}\n`);
			process.stdout.write(`  Run:         ${runId}\n`);
			process.stdout.write(`  Artifacts:   ${artifactRoot}\n`);
			process.stdout.write(`  Analyst mail:${dispatchId}\n`);
		}
	} catch (err) {
		if (analystStarted) {
			try {
				await stopMissionRole("mission-analyst", {
					projectRoot,
					overstoryDir,
					completeRun: false,
				});
			} catch {
				// Best-effort cleanup.
			}
		}
		if (missionCreated) {
			missionStore.delete(missionId);
		}
		try {
			const runStore = createRunStore(dbPath);
			try {
				runStore.completeRun(runId, "stopped");
			} finally {
				runStore.close();
			}
		} catch {
			// Best-effort cleanup.
		}
		await clearMissionPointers(overstoryDir);
		await rm(artifactRoot, { recursive: true, force: true });

		const message = err instanceof Error ? err.message : String(err);
		if (opts.json) {
			jsonError("mission start", message);
		} else {
			printError("Mission start failed", message);
		}
		process.exitCode = 1;
	} finally {
		missionStore.close();
	}
}

// === ov mission status ===

async function missionStatus(overstoryDir: string, json: boolean): Promise<void> {
	const missionId = await resolveCurrentMissionId(overstoryDir);
	if (!missionId) {
		if (json) {
			jsonOutput("mission status", { mission: null, message: "No active mission" });
		} else {
			printHint("No active mission");
		}
		return;
	}

	const dbPath = join(overstoryDir, "sessions.db");
	const missionStore = createMissionStore(dbPath);
	try {
		const mission = missionStore.getById(missionId);
		if (!mission) {
			if (json) {
				jsonOutput("mission status", { mission: null, message: `Mission ${missionId} not found` });
			} else {
				printError("Mission not found in store", missionId);
			}
			process.exitCode = 1;
			return;
		}

		await writeMissionPointers(overstoryDir, mission.id, mission.runId);
		const roles = resolveMissionRoleStates(overstoryDir, mission);

		if (json) {
			jsonOutput("mission status", { mission: toSummary(mission), roles });
			return;
		}

		process.stdout.write(`${renderHeader("Mission Status")}\n`);
		process.stdout.write(`  ID:           ${accent(mission.id)}\n`);
		process.stdout.write(`  Slug:         ${mission.slug}\n`);
		process.stdout.write(`  Objective:    ${mission.objective}\n`);
		process.stdout.write(`  State:        ${mission.state}\n`);
		process.stdout.write(`  Phase:        ${mission.phase}\n`);
		if (mission.pendingUserInput) {
			process.stdout.write(
				`  Pending:      ${mission.pendingInputKind ?? "input"} (thread: ${mission.pendingInputThreadId ?? "none"})\n`,
			);
		} else {
			process.stdout.write("  Pending:      none\n");
		}
		process.stdout.write(`  First freeze: ${mission.firstFreezeAt ?? "never"}\n`);
		process.stdout.write(`  Reopen count: ${mission.reopenCount}\n`);
		process.stdout.write(`  Paused:       ${mission.pausedWorkstreamIds.length} workstreams\n`);
		if (mission.pauseReason) {
			process.stdout.write(`  Pause reason: ${mission.pauseReason}\n`);
		}
		process.stdout.write(`  Coordinator:  ${roles.coordinator}\n`);
		process.stdout.write(`  Analyst:      ${roles.analyst}\n`);
		process.stdout.write(`  Exec Dir:     ${roles.executionDirector}\n`);
		if (mission.artifactRoot) {
			process.stdout.write(`  Artifacts:    ${mission.artifactRoot}\n`);
		}
		if (mission.runId) {
			process.stdout.write(`  Run:          ${mission.runId}\n`);
		}
		process.stdout.write(`  Created:      ${mission.createdAt}\n`);
		process.stdout.write(`  Updated:      ${mission.updatedAt}\n`);
	} finally {
		missionStore.close();
	}
}

// === ov mission output ===

async function missionOutput(overstoryDir: string, json: boolean): Promise<void> {
	const missionId = await resolveCurrentMissionId(overstoryDir);
	if (!missionId) {
		if (json) {
			jsonOutput("mission output", { mission: null, message: "No active mission" });
		} else {
			printHint("No active mission");
		}
		return;
	}

	const dbPath = join(overstoryDir, "sessions.db");
	const missionStore = createMissionStore(dbPath);
	try {
		const mission = missionStore.getById(missionId);
		if (!mission) {
			if (json) {
				jsonOutput("mission output", { mission: null });
			} else {
				printError("Mission not found in store", missionId);
			}
			process.exitCode = 1;
			return;
		}

		await writeMissionPointers(overstoryDir, mission.id, mission.runId);
		const roles = resolveMissionRoleStates(overstoryDir, mission);
		const narrative = buildNarrative(mission, loadMissionEvents(overstoryDir, mission));

		if (json) {
			jsonOutput("mission output", {
				mission: toSummary(mission),
				narrative,
				artifactRoot: mission.artifactRoot,
				pausedWorkstreamIds: mission.pausedWorkstreamIds,
				roles,
			});
			return;
		}

		process.stdout.write(`${renderHeader("Mission Output")}\n`);
		process.stdout.write(`${renderNarrative(narrative)}\n\n`);
		process.stdout.write(`${renderSubHeader("Roles")}\n`);
		process.stdout.write(`  Coordinator:         ${roles.coordinator}\n`);
		process.stdout.write(`  Mission Analyst:     ${roles.analyst}\n`);
		process.stdout.write(`  Execution Director:  ${roles.executionDirector}\n`);
		process.stdout.write("\n");
		process.stdout.write(`${renderSubHeader("Mission")}\n`);
		process.stdout.write(`  State:               ${mission.state}/${mission.phase}\n`);
		process.stdout.write(
			`  Pending:             ${mission.pendingUserInput ? mission.pendingInputKind ?? "input" : "none"}\n`,
		);
		process.stdout.write(`  Reopens:             ${mission.reopenCount}\n`);
		process.stdout.write(
			`  Paused workstreams:  ${mission.pausedWorkstreamIds.length > 0 ? mission.pausedWorkstreamIds.join(", ") : "none"}\n`,
		);
		if (mission.pauseReason) {
			process.stdout.write(`  Pause reason:        ${mission.pauseReason}\n`);
		}
		if (mission.artifactRoot) {
			process.stdout.write(`  Artifacts:           ${mission.artifactRoot}\n`);
		}
	} finally {
		missionStore.close();
	}
}

// === ov mission answer ===

interface AnswerOpts {
	body?: string;
	file?: string;
	json?: boolean;
}

async function missionAnswer(overstoryDir: string, opts: AnswerOpts): Promise<void> {
	const missionId = await resolveCurrentMissionId(overstoryDir);
	if (!missionId) {
		if (opts.json) {
			jsonError("mission answer", "No active mission");
		} else {
			printError("No active mission");
		}
		process.exitCode = 1;
		return;
	}

	let body: string | null;
	try {
		body = await readAnswerBody(opts);
	} catch (err) {
		if (opts.json) {
			jsonError("mission answer", String(err));
		} else {
			printError("Failed to read answer", String(err));
		}
		process.exitCode = 1;
		return;
	}
	if (!body) {
		if (opts.json) {
			jsonError("mission answer", "Provide a non-empty --body or --file");
		} else {
			printError("Provide a non-empty --body or --file");
		}
		process.exitCode = 1;
		return;
	}

	const dbPath = join(overstoryDir, "sessions.db");
	const missionStore = createMissionStore(dbPath);
	try {
		const mission = missionStore.getById(missionId);
		if (!mission) {
			if (opts.json) {
				jsonError("mission answer", `Mission ${missionId} not found`);
			} else {
				printError("Mission not found in store", missionId);
			}
			process.exitCode = 1;
			return;
		}

		if (!mission.pendingUserInput || !mission.pendingInputThreadId) {
			if (opts.json) {
				jsonError("mission answer", "Mission is not waiting for a question packet");
			} else {
				printError("Mission is not waiting for a question packet");
			}
			process.exitCode = 1;
			return;
		}

		const client = openMailClient(overstoryDir);
		let replyId: string;
		try {
			replyId = client.reply(mission.pendingInputThreadId, body, "operator");
		} finally {
			client.close();
		}

		missionStore.unfreeze(missionId);
		recordMissionEvent({
			overstoryDir,
			mission,
			agentName: "operator",
			data: {
				kind: "user_answer",
				detail: `Operator replied in thread ${mission.pendingInputThreadId}`,
				threadId: mission.pendingInputThreadId,
				replyId,
			},
		});
		recordMissionEvent({
			overstoryDir,
			mission,
			agentName: "operator",
			data: { kind: "state_change", from: "frozen", to: "active" },
		});

		if (opts.json) {
			jsonOutput("mission answer", { missionId, answered: true, replyId, body });
		} else {
			printSuccess("Mission answer delivered", mission.slug);
			process.stdout.write(`  Reply:   ${replyId}\n`);
		}
	} finally {
		missionStore.close();
	}
}

// === ov mission artifacts ===

async function missionArtifacts(overstoryDir: string, json: boolean): Promise<void> {
	const missionId = await resolveCurrentMissionId(overstoryDir);
	if (!missionId) {
		if (json) {
			jsonOutput("mission artifacts", { mission: null, message: "No active mission" });
		} else {
			printHint("No active mission");
		}
		return;
	}

	const dbPath = join(overstoryDir, "sessions.db");
	const missionStore = createMissionStore(dbPath);
	try {
		const mission = missionStore.getById(missionId);
		if (!mission || !mission.artifactRoot) {
			if (json) {
				jsonOutput("mission artifacts", { artifactRoot: null });
			} else {
				printHint("No artifact root for this mission");
			}
			return;
		}

		const paths = getMissionArtifactPaths(mission);
		if (json) {
			jsonOutput("mission artifacts", { artifactRoot: paths.root, paths });
			return;
		}

		process.stdout.write(`${renderHeader("Mission Artifacts")}\n`);
		process.stdout.write(`  Root:           ${paths.root}\n`);
		process.stdout.write(`  mission.md:     ${paths.missionMd}\n`);
		process.stdout.write(`  decisions.md:   ${paths.decisionsMd}\n`);
		process.stdout.write(`  open-questions: ${paths.openQuestionsMd}\n`);
		process.stdout.write(`  current-state:  ${paths.currentStateMd}\n`);
		process.stdout.write(`  summary:        ${paths.researchSummaryMd}\n`);
		process.stdout.write(`  workstreams:    ${paths.workstreamsJson}\n`);
		process.stdout.write(`  results/:       ${paths.resultsDir}\n`);
	} finally {
		missionStore.close();
	}
}

// === ov mission handoff ===

interface HandoffOpts {
	json?: boolean;
}

async function missionHandoff(
	overstoryDir: string,
	projectRoot: string,
	json: boolean,
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

		const pausedWorkstreamIds = new Set(mission.pausedWorkstreamIds);
		const handoffs = packageHandoffs(validation.workstreams.workstreams).filter(
			(handoff) => !pausedWorkstreamIds.has(handoff.workstreamId),
		);
		const skippedPausedCount = packageHandoffs(validation.workstreams.workstreams).length - handoffs.length;
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

		await startExecutionDirector({
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
					.map(
						(handoff) =>
							`- ${handoff.workstreamId} (${handoff.taskId}): ${handoff.objective} [brief: ${handoff.briefPath}]`,
					)
					.join("\n"),
				type: "execution_handoff",
				payload: {
					missionId: mission.id,
					taskIds: handoffs.map((handoff) => handoff.taskId),
					workstreamIds: handoffs.map((handoff) => handoff.workstreamId),
					briefPaths: handoffs.map((handoff) => handoff.briefPath!).filter(Boolean),
					handoffs,
				},
			});
		} finally {
			client.close();
		}

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
			});
		} else {
			printSuccess("Mission handed off to execution director", mission.slug);
			process.stdout.write(`  Mail:        ${messageId}\n`);
			process.stdout.write(`  Workstreams: ${handoffs.length}\n`);
			if (skippedPausedCount > 0) {
				process.stdout.write(`  Paused skip: ${skippedPausedCount}\n`);
			}
		}
	} finally {
		missionStore.close();
	}
}

// === ov mission pause / resume / refresh-briefs ===

interface PauseOpts {
	reason?: string;
	json?: boolean;
}

interface RefreshBriefOpts {
	workstream?: string;
	json?: boolean;
}

async function missionPause(
	overstoryDir: string,
	workstreamId: string,
	opts: PauseOpts,
): Promise<void> {
	const missionId = await resolveCurrentMissionId(overstoryDir);
	if (!missionId) {
		if (opts.json) {
			jsonError("mission pause", "No active mission");
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
				jsonError("mission pause", `Mission ${missionId} not found`);
			} else {
				printError("Mission not found in store", missionId);
			}
			process.exitCode = 1;
			return;
		}

		let workstreamObjective = workstreamId;
		try {
			const { workstream } = await getMissionWorkstream(mission, workstreamId);
			workstreamObjective = workstream.objective;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (opts.json) {
				jsonError("mission pause", message);
			} else {
				printError("Mission pause failed", message);
			}
			process.exitCode = 1;
			return;
		}

		const result = pauseWorkstream(missionStore, mission.id, workstreamId, opts.reason);
		const refreshedMission = missionStore.getById(mission.id) ?? mission;
		recordMissionEvent({
			overstoryDir,
			mission: refreshedMission,
			agentName: "operator",
			data: {
				kind: "workstream_paused",
				detail: `Paused ${workstreamId}${opts.reason ? `: ${opts.reason}` : ""}`,
				workstreamId,
				alreadyPaused: result.alreadyPaused,
				reason: opts.reason ?? null,
			},
		});

		let controlMessageId: string | null = null;
		const roles = resolveMissionRoleStates(overstoryDir, refreshedMission);
		if (roles.executionDirector === "running") {
			controlMessageId = await sendMissionControlMail({
				overstoryDir,
				to: "execution-director",
				subject: `Mission control: pause ${workstreamId}`,
				body: [
					`Mission ID: ${refreshedMission.id}`,
					`Workstream: ${workstreamId}`,
					`Objective: ${workstreamObjective}`,
					`Reason: ${refreshedMission.pauseReason ?? opts.reason ?? "operator pause"}`,
					`Paused workstreams: ${refreshedMission.pausedWorkstreamIds.join(", ")}`,
				].join("\n"),
			});
			recordMissionEvent({
				overstoryDir,
				mission: refreshedMission,
				agentName: "operator",
				data: {
					kind: "control_mail",
					detail: `Pause control sent to execution-director (${controlMessageId})`,
					workstreamId,
					to: "execution-director",
				},
			});
		}

		if (opts.json) {
			jsonOutput("mission pause", {
				mission: toSummary(refreshedMission),
				workstreamId,
				alreadyPaused: result.alreadyPaused,
				controlMessageId,
			});
		} else {
			printSuccess("Mission workstream paused", workstreamId);
			process.stdout.write(`  Objective:   ${workstreamObjective}\n`);
			process.stdout.write(`  Already set: ${result.alreadyPaused ? "yes" : "no"}\n`);
			process.stdout.write(`  Paused:      ${refreshedMission.pausedWorkstreamIds.length} workstreams\n`);
			if (refreshedMission.pauseReason) {
				process.stdout.write(`  Reason:      ${refreshedMission.pauseReason}\n`);
			}
			if (controlMessageId) {
				process.stdout.write(`  Control:     ${controlMessageId}\n`);
			}
		}
	} finally {
		missionStore.close();
	}
}

async function missionResume(
	overstoryDir: string,
	projectRoot: string,
	workstreamId: string,
	json: boolean,
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

		let resumeCheck;
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

async function missionRefreshBriefsCommand(
	overstoryDir: string,
	projectRoot: string,
	opts: RefreshBriefOpts,
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

		let results;
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
			const shouldPause = result.specMarkedStale || result.specWasStale;
			if (shouldPause) {
				const pauseResult = pauseWorkstream(missionStore, mission.id, result.workstream.id, pauseReason);
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
					specWasStale: result.specWasStale,
					specMarkedStale: result.specMarkedStale,
				},
			});
		}

		const refreshedMission = missionStore.getById(mission.id) ?? mission;
		const roles = resolveMissionRoleStates(overstoryDir, refreshedMission);
		const controlMessageIds: string[] = [];
		const pausedList = [...pausedWorkstreamIds];
		const refreshSummary = results.length
			? results
					.map(
						(result) =>
							`${result.workstream.id} (${result.taskId}) brief=${result.projectRelativeBriefPath} markedStale=${result.specMarkedStale} alreadyStale=${result.specWasStale}`,
					)
					.join("\n")
			: "No refreshable workstreams were found.";

		for (const recipient of [
			roles.executionDirector === "running" ? "execution-director" : null,
			roles.analyst === "running" ? "mission-analyst" : null,
		]) {
			if (!recipient) {
				continue;
			}
			const controlMessageId = await sendMissionControlMail({
				overstoryDir,
				to: recipient,
				subject: pausedList.length
					? `Mission control: refreshed briefs (${pausedList.length} paused)`
					: "Mission control: refreshed briefs",
				body: [
					`Mission ID: ${refreshedMission.id}`,
					`Scope: ${opts.workstream ?? "all workstreams"}`,
					`Paused workstreams: ${pausedList.length > 0 ? pausedList.join(", ") : "none"}`,
					"",
					refreshSummary,
				].join("\n"),
			});
			controlMessageIds.push(controlMessageId);
			recordMissionEvent({
				overstoryDir,
				mission: refreshedMission,
				agentName: "operator",
				data: {
					kind: "control_mail",
					detail: `Brief refresh control sent to ${recipient} (${controlMessageId})`,
					to: recipient,
					workstreamCount: results.length,
				},
			});
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
					specWasStale: result.specWasStale,
					specMarkedStale: result.specMarkedStale,
				})),
			});
		} else {
			printSuccess("Mission briefs refreshed", refreshedMission.slug);
			process.stdout.write(`  Scope:   ${opts.workstream ?? "all workstreams"}\n`);
			process.stdout.write(`  Paused:  ${pausedList.length > 0 ? pausedList.join(", ") : "none"}\n`);
			if (results.length === 0) {
				process.stdout.write("  Result:  no refreshable briefs found\n");
			} else {
				for (const result of results) {
					const status = result.specMarkedStale
						? "stale-marked"
						: result.specWasStale
							? "already-stale"
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

// === ov mission stop / complete ===

async function missionStop(
	overstoryDir: string,
	projectRoot: string,
	json: boolean,
): Promise<void> {
	const missionId = await resolveCurrentMissionId(overstoryDir);
	if (!missionId) {
		if (json) {
			jsonError("mission stop", "No active mission to stop");
		} else {
			printError("No active mission to stop");
		}
		process.exitCode = 1;
		return;
	}

	const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
	try {
		const mission = missionStore.getById(missionId);
		if (!mission) {
			if (json) {
				jsonError("mission stop", `Mission ${missionId} not found`);
			} else {
				printError("Mission not found in store", missionId);
			}
			process.exitCode = 1;
			return;
		}

		const result = await terminalizeMission({
			overstoryDir,
			projectRoot,
			mission,
			targetState: "stopped",
			json,
		});
		if (json) {
			jsonOutput("mission stop", {
				missionId,
				slug: mission.slug,
				state: "stopped",
				bundlePath: result.bundlePath,
				reviewId: result.reviewId,
			});
		} else {
			printSuccess("Mission stopped", mission.slug);
		}
	} finally {
		missionStore.close();
	}
}

async function missionComplete(
	overstoryDir: string,
	projectRoot: string,
	json: boolean,
): Promise<void> {
	const missionId = await resolveCurrentMissionId(overstoryDir);
	if (!missionId) {
		if (json) {
			jsonError("mission complete", "No active mission to complete");
		} else {
			printError("No active mission to complete");
		}
		process.exitCode = 1;
		return;
	}

	const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
	try {
		const mission = missionStore.getById(missionId);
		if (!mission) {
			if (json) {
				jsonError("mission complete", `Mission ${missionId} not found`);
			} else {
				printError("Mission not found in store", missionId);
			}
			process.exitCode = 1;
			return;
		}
		if (mission.pendingUserInput) {
			if (json) {
				jsonError("mission complete", "Mission cannot complete while pending user input");
			} else {
				printError("Mission cannot complete while pending user input");
			}
			process.exitCode = 1;
			return;
		}

		const result = await terminalizeMission({
			overstoryDir,
			projectRoot,
			mission,
			targetState: "completed",
			json,
		});
		if (json) {
			jsonOutput("mission complete", {
				missionId,
				slug: mission.slug,
				state: "completed",
				bundlePath: result.bundlePath,
				reviewId: result.reviewId,
			});
		} else {
			printSuccess("Mission completed", mission.slug);
		}
	} finally {
		missionStore.close();
	}
}

// === ov mission list ===

async function missionList(overstoryDir: string, json: boolean): Promise<void> {
	const dbPath = join(overstoryDir, "sessions.db");
	const dbFile = Bun.file(dbPath);
	if (!(await dbFile.exists())) {
		if (json) {
			jsonOutput("mission list", { missions: [] });
		} else {
			printHint("No missions recorded yet");
		}
		return;
	}

	const missionStore = createMissionStore(dbPath);
	try {
		const missions = missionStore.list();

		if (json) {
			jsonOutput("mission list", { missions: missions.map(toSummary) });
			return;
		}

		if (missions.length === 0) {
			printHint("No missions recorded yet");
			return;
		}

		process.stdout.write(`${renderHeader("Missions")}\n`);
		process.stdout.write(`${"ID".padEnd(18)} ${"State".padEnd(12)} ${"Phase".padEnd(10)} Slug\n`);
		process.stdout.write(`${separator()}\n`);
		for (const mission of missions) {
			const id = accent(mission.id.slice(0, 16).padEnd(18));
			const state = mission.state.padEnd(12);
			const phase = mission.phase.padEnd(10);
			const pending = mission.pendingUserInput ? " [PENDING]" : "";
			process.stdout.write(`${id} ${state} ${phase} ${mission.slug}${pending}\n`);
		}
	} finally {
		missionStore.close();
	}
}

// === ov mission show ===

async function missionShow(overstoryDir: string, idOrSlug: string, json: boolean): Promise<void> {
	const dbPath = join(overstoryDir, "sessions.db");
	const missionStore = createMissionStore(dbPath);
	try {
		let mission = missionStore.getById(idOrSlug);
		if (!mission) {
			mission = missionStore.getBySlug(idOrSlug);
		}
		if (!mission) {
			if (json) {
				jsonError("mission show", `Mission not found: ${idOrSlug}`);
			} else {
				printError("Mission not found", idOrSlug);
			}
			process.exitCode = 1;
			return;
		}

		if (json) {
			jsonOutput("mission show", {
				mission,
				narrative: buildNarrative(mission, loadMissionEvents(overstoryDir, mission)),
			});
			return;
		}

		process.stdout.write(`${renderHeader("Mission")}\n`);
		process.stdout.write(`  ID:           ${accent(mission.id)}\n`);
		process.stdout.write(`  Slug:         ${mission.slug}\n`);
		process.stdout.write(`  Objective:    ${mission.objective}\n`);
		process.stdout.write(`  State:        ${mission.state}\n`);
		process.stdout.write(`  Phase:        ${mission.phase}\n`);
		process.stdout.write(`  Reopen count: ${mission.reopenCount}\n`);
		if (mission.firstFreezeAt) {
			process.stdout.write(`  First freeze: ${mission.firstFreezeAt}\n`);
		}
		if (mission.pendingUserInput) {
			process.stdout.write(
				`  Pending:      ${mission.pendingInputKind ?? "input"} (thread: ${mission.pendingInputThreadId ?? "none"})\n`,
			);
		}
		if (mission.pausedWorkstreamIds.length > 0) {
			process.stdout.write(`  Paused:       ${mission.pausedWorkstreamIds.join(", ")}\n`);
		}
		if (mission.pauseReason) {
			process.stdout.write(`  Pause reason: ${mission.pauseReason}\n`);
		}
		if (mission.artifactRoot) {
			process.stdout.write(`  Artifacts:    ${mission.artifactRoot}\n`);
		}
		if (mission.runId) {
			process.stdout.write(`  Run:          ${mission.runId}\n`);
		}
		process.stdout.write(`  Created:      ${mission.createdAt}\n`);
		process.stdout.write(`  Updated:      ${mission.updatedAt}\n`);
		process.stdout.write("\n");
		process.stdout.write(`${renderSubHeader("Narrative")}\n`);
		process.stdout.write(`${renderMissionNarrative(mission, overstoryDir)}\n`);
	} finally {
		missionStore.close();
	}
}

// === ov mission bundle ===

interface BundleOpts {
	missionId?: string;
	force?: boolean;
	json?: boolean;
}

async function missionBundle(overstoryDir: string, opts: BundleOpts): Promise<void> {
	const dbPath = join(overstoryDir, "sessions.db");

	let missionId = opts.missionId ?? null;
	if (!missionId) {
		missionId = await resolveCurrentMissionId(overstoryDir);
	}
	if (!missionId) {
		if (opts.json) {
			jsonError("mission bundle", "No active mission and no --mission-id provided");
		} else {
			printError("No active mission and no --mission-id provided");
		}
		process.exitCode = 1;
		return;
	}

	const { exportBundle } = await import("../missions/bundle.ts");
	try {
		const result = await exportBundle({
			overstoryDir,
			dbPath,
			missionId,
			force: opts.force,
		});

		if (opts.json) {
			jsonOutput("mission bundle", {
				outputDir: result.outputDir,
				manifest: result.manifest,
				filesWritten: result.filesWritten,
			});
		} else if (result.filesWritten.length === 0) {
			printHint("Bundle is already up to date");
			process.stdout.write(`  Path: ${result.outputDir}\n`);
		} else {
			printSuccess("Bundle exported", result.outputDir);
			for (const file of result.filesWritten) {
				process.stdout.write(`  ${file}\n`);
			}
		}
	} catch (err) {
		if (opts.json) {
			jsonError("mission bundle", String(err));
		} else {
			printError("Bundle export failed", String(err));
		}
		process.exitCode = 1;
	}
}

// === Command factory ===

interface MissionDefaultOpts {
	json?: boolean;
}

export function createMissionCommand(): Command {
	const cmd = new Command("mission").description(
		"Manage long-running missions (objectives, phases, user input)",
	);

	cmd.option("--json", "Output as JSON").action(async (opts: MissionDefaultOpts) => {
		const cwd = process.cwd();
		const config = await loadConfig(cwd);
		const overstoryDir = join(config.project.root, ".overstory");
		await missionStatus(overstoryDir, opts.json ?? false);
	});

	cmd
		.command("start")
		.description("Create a new mission (run + pointer files + artifact root)")
		.requiredOption("--slug <slug>", "Short identifier for the mission (e.g. auth-rewrite)")
		.requiredOption("--objective <objective>", "Mission objective (what to accomplish)")
		.option("--json", "Output as JSON")
		.action(async (opts: { slug: string; objective: string; json?: boolean }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionStart(overstoryDir, config.project.root, opts);
		});

	cmd
		.command("status")
		.description("Show active mission summary")
		.option("--json", "Output as JSON")
		.action(async (opts: MissionDefaultOpts) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionStatus(overstoryDir, opts.json ?? false);
		});

	cmd
		.command("output")
		.description("Mission-centric output with event narrative")
		.option("--json", "Output as JSON")
		.action(async (opts: MissionDefaultOpts) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionOutput(overstoryDir, opts.json ?? false);
		});

	cmd
		.command("answer")
		.description("Respond to the pending mission question packet")
		.option("--body <text>", "Your answer or response text")
		.option("--file <path>", "Path to a file containing your answer")
		.option("--json", "Output as JSON")
		.action(async (opts: { body?: string; file?: string; json?: boolean }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionAnswer(overstoryDir, opts);
		});

	cmd
		.command("artifacts")
		.description("Print artifact root and known paths for the active mission")
		.option("--json", "Output as JSON")
		.action(async (opts: MissionDefaultOpts) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionArtifacts(overstoryDir, opts.json ?? false);
		});

	cmd
		.command("handoff")
		.description("Start execution director and hand off dispatchable workstreams")
		.option("--json", "Output as JSON")
		.action(async (opts: HandoffOpts) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionHandoff(overstoryDir, config.project.root, opts.json ?? false);
		});

	cmd
		.command("pause")
		.description("Pause a mission workstream without changing runtime agent state")
		.argument("<workstream-id>", "Mission workstream ID")
		.option("--reason <text>", "Operator-visible pause reason")
		.option("--json", "Output as JSON")
		.action(async (workstreamId: string, opts: PauseOpts) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionPause(overstoryDir, workstreamId, opts);
		});

	cmd
		.command("resume")
		.description("Resume a paused mission workstream after spec/brief validation")
		.argument("<workstream-id>", "Mission workstream ID")
		.option("--json", "Output as JSON")
		.action(async (workstreamId: string, opts: MissionDefaultOpts) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionResume(overstoryDir, config.project.root, workstreamId, opts.json ?? false);
		});

	cmd
		.command("refresh-briefs")
		.description("Refresh brief revisions, mark stale specs, and pause affected workstreams")
		.option("--workstream <id>", "Refresh a single workstream instead of the full mission plan")
		.option("--json", "Output as JSON")
		.action(async (opts: RefreshBriefOpts) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionRefreshBriefsCommand(overstoryDir, config.project.root, opts);
		});

	cmd
		.command("complete")
		.description("Complete the active mission, export bundle, and clear pointers")
		.option("--json", "Output as JSON")
		.action(async (opts: MissionDefaultOpts) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionComplete(overstoryDir, config.project.root, opts.json ?? false);
		});

	cmd
		.command("stop")
		.description("Stop and terminalize the active mission (clears pointer files)")
		.option("--json", "Output as JSON")
		.action(async (opts: MissionDefaultOpts) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionStop(overstoryDir, config.project.root, opts.json ?? false);
		});

	cmd
		.command("list")
		.description("List all missions")
		.option("--json", "Output as JSON")
		.action(async (opts: MissionDefaultOpts) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionList(overstoryDir, opts.json ?? false);
		});

	cmd
		.command("show")
		.description("Show details for a specific mission")
		.argument("<id-or-slug>", "Mission ID or slug")
		.option("--json", "Output as JSON")
		.action(async (idOrSlug: string, opts: MissionDefaultOpts) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionShow(overstoryDir, idOrSlug, opts.json ?? false);
		});

	cmd
		.command("bundle")
		.description("Export a result bundle (summary, events, narrative, review) for a mission")
		.option("--mission-id <id>", "Mission ID (defaults to active mission)")
		.option("--force", "Force regeneration even if bundle is fresh")
		.option("--json", "Output as JSON")
		.action(async (opts: { missionId?: string; force?: boolean; json?: boolean }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionBundle(overstoryDir, opts);
		});

	return cmd;
}
