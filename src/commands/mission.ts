/**
 * CLI command: ov mission <subcommand>
 *
 * Long-running objective tracking for overstory mission mode.
 */

import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { jsonError, jsonOutput } from "../json.ts";
import { accent, printError, printHint, printSuccess, printWarning } from "../logging/color.ts";
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
	startMissionCoordinator,
	stopMissionRole,
} from "../missions/roles.ts";
import {
	clearMissionRuntimePointers,
	resolveMissionRoleStates as deriveMissionRoleStates,
	resolveActiveMissionContext,
	writeMissionRuntimePointers,
} from "../missions/runtime-context.ts";
import { computeMissionScore, renderMissionScore } from "../missions/score.ts";
import { createMissionStore } from "../missions/store.ts";
import {
	getMissionWorkstream,
	refreshMissionBriefs,
	validateWorkstreamResume,
} from "../missions/workstream-control.ts";
import {
	ensureCanonicalWorkstreamTasks,
	loadWorkstreamsFile,
	packageHandoffs,
	slingArgsFromHandoff,
} from "../missions/workstreams.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { createRunStore } from "../sessions/store.ts";
import { createTrackerClient, resolveBackend } from "../tracker/factory.ts";
import type { InsertMission, Mission, MissionSummary } from "../types.ts";
import {
	attachOrSwitch,
	isSessionAlive,
	killProcessTree,
	killSession,
	listSessions,
} from "../worktree/tmux.ts";
import { nudgeAgent } from "./nudge.ts";
import { resumeAgent } from "./resume.ts";
import { stopCommand } from "./stop.ts";

export interface MissionCommandDeps {
	startMissionCoordinator?: typeof startMissionCoordinator;
	startMissionAnalyst?: typeof startMissionAnalyst;
	startExecutionDirector?: typeof startExecutionDirector;
	stopMissionRole?: typeof stopMissionRole;
	stopAgentCommand?: typeof stopCommand;
	ensureCanonicalWorkstreamTasks?: typeof ensureCanonicalWorkstreamTasks;
	nudgeAgent?: typeof nudgeAgent;
}

export async function resolveCurrentMissionId(overstoryDir: string): Promise<string | null> {
	return (await resolveActiveMissionContext(overstoryDir))?.missionId ?? null;
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

function drainAgentInbox(overstoryDir: string, agentName: string): number {
	const client = openMailClient(overstoryDir);
	try {
		return client.check(agentName).length;
	} finally {
		client.close();
	}
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
			return deriveMissionRoleStates(mission, store.getAll());
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
	type?: "status" | "dispatch";
}): Promise<string> {
	const client = openMailClient(opts.overstoryDir);
	try {
		return client.send({
			from: "operator",
			to: opts.to,
			subject: opts.subject,
			body: opts.body,
			type: opts.type ?? "status",
		});
	} finally {
		client.close();
	}
}

async function nudgeMissionRoleBestEffort(
	projectRoot: string,
	agentName: string,
	message: string,
	deps: MissionCommandDeps = {},
): Promise<void> {
	try {
		await (deps.nudgeAgent ?? nudgeAgent)(projectRoot, agentName, message, true);
	} catch {
		// Best-effort wake-up only.
	}
}

async function pendingMissionQuestionSender(
	overstoryDir: string,
	messageId: string,
): Promise<string | null> {
	const store = createMailStore(join(overstoryDir, "mail.db"));
	try {
		return store.getById(messageId)?.from ?? null;
	} finally {
		store.close();
	}
}

async function ensureMissionRoleResponsive(opts: {
	projectRoot: string;
	overstoryDir: string;
	mission: Mission;
	roleName: string;
	threadId: string;
	replyId: string;
	deps?: MissionCommandDeps;
}): Promise<void> {
	const { projectRoot, overstoryDir, mission, roleName, threadId, replyId, deps = {} } = opts;
	const nudgeMessage = `Operator replied in thread ${threadId} (${replyId}). Check mail and continue the mission.`;

	// Normalize coordinator-mission sender name to the canonical agent name
	const effectiveRoleName = roleName === "coordinator-mission" ? "coordinator" : roleName;

	if (
		effectiveRoleName !== "coordinator" &&
		effectiveRoleName !== "mission-analyst" &&
		effectiveRoleName !== "execution-director"
	) {
		return;
	}

	const { store } = openSessionStore(overstoryDir);
	let sessionState: string | null = null;
	try {
		sessionState = store.getByName(effectiveRoleName)?.state ?? null;
	} finally {
		store.close();
	}

	if (sessionState && sessionState !== "completed" && sessionState !== "zombie") {
		await nudgeMissionRoleBestEffort(projectRoot, effectiveRoleName, nudgeMessage, deps);
		return;
	}

	if (!mission.runId) {
		return;
	}

	const roleLabels: Record<string, string> = {
		coordinator: "Mission Coordinator",
		"mission-analyst": "Mission Analyst",
		"execution-director": "Execution Director",
	};
	const capabilities: Record<string, string> = {
		coordinator: "coordinator-mission",
		"mission-analyst": "mission-analyst",
		"execution-director": "execution-director",
	};
	const roleLabel = roleLabels[effectiveRoleName] ?? effectiveRoleName;
	const capability = capabilities[effectiveRoleName] ?? effectiveRoleName;

	const prompt = await materializeMissionRolePrompt({
		overstoryDir,
		agentName: effectiveRoleName,
		capability,
		roleLabel,
		mission,
	});
	const beacon = [
		buildMissionRoleBeacon({
			agentName: effectiveRoleName,
			missionId: mission.id,
			contextPath: prompt.contextPath,
		}),
		`Operator replied in thread ${threadId}. Check mail and continue the mission.`,
	].join(" ");

	let startRole: typeof startMissionCoordinator;
	if (effectiveRoleName === "coordinator") {
		startRole = deps.startMissionCoordinator ?? startMissionCoordinator;
	} else if (effectiveRoleName === "mission-analyst") {
		startRole = deps.startMissionAnalyst ?? startMissionAnalyst;
	} else {
		startRole = deps.startExecutionDirector ?? startExecutionDirector;
	}
	const result = await startRole({
		missionId: mission.id,
		projectRoot,
		overstoryDir,
		existingRunId: mission.runId,
		appendSystemPromptFile: prompt.promptPath,
		beacon,
	});

	const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
	try {
		if (effectiveRoleName === "coordinator") {
			missionStore.bindCoordinatorSession(mission.id, result.session.id);
		} else if (effectiveRoleName === "mission-analyst") {
			missionStore.bindSessions(mission.id, { analystSessionId: result.session.id });
		} else {
			missionStore.bindSessions(mission.id, { executionDirectorSessionId: result.session.id });
		}
	} finally {
		missionStore.close();
	}

	recordMissionEvent({
		overstoryDir,
		mission,
		agentName: "operator",
		data: { kind: "role_started", detail: `${effectiveRoleName} restarted after operator reply` },
	});
}

function shellQuote(arg: string): string {
	return /^[A-Za-z0-9_./:=+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

function renderShellCommand(args: string[]): string {
	return args.map(shellQuote).join(" ");
}

async function stopMissionRunDescendants(opts: {
	overstoryDir: string;
	projectRoot: string;
	runId: string | null;
	excludedAgentNames: ReadonlySet<string>;
	stopAgentCommand: typeof stopCommand;
}): Promise<string[]> {
	if (!opts.runId) {
		return [];
	}

	const { store } = openSessionStore(opts.overstoryDir);
	try {
		const descendants = store
			.getByRun(opts.runId)
			.filter((session) => !opts.excludedAgentNames.has(session.agentName))
			.sort((left, right) => {
				if (right.depth !== left.depth) {
					return right.depth - left.depth;
				}
				return left.agentName.localeCompare(right.agentName);
			});
		const stopped: string[] = [];
		const originalCwd = process.cwd();
		process.chdir(opts.projectRoot);
		try {
			for (const session of descendants) {
				try {
					await opts.stopAgentCommand(session.agentName, { force: true });
					stopped.push(session.agentName);
				} catch {
					// Completed descendants without a live runtime do not need additional cleanup.
				}
			}
		} finally {
			process.chdir(originalCwd);
		}
		return stopped;
	} finally {
		store.close();
	}
}

/**
 * Suspend a mission: kill all tmux sessions but preserve state for resume.
 * Unlike terminalizeMission(), this does NOT drain mail, clear runtime pointers,
 * complete the run, or export bundle/review.
 */
async function suspendMission(opts: {
	overstoryDir: string;
	projectRoot: string;
	mission: Mission;
	json: boolean;
}): Promise<void> {
	const { overstoryDir, mission, json } = opts;
	const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));

	try {
		// Kill tmux sessions for persistent roles (without changing session state)
		for (const roleName of ["coordinator", "mission-analyst", "execution-director"]) {
			const { store } = openSessionStore(overstoryDir);
			try {
				const session = store.getByName(roleName);
				if (!session || session.state === "completed") continue;
				if (session.tmuxSession) {
					const alive = await isSessionAlive(session.tmuxSession);
					if (alive) {
						await killSession(session.tmuxSession);
					}
				}
				if (session.pid) {
					try {
						await killProcessTree(session.pid);
					} catch {
						// Process may already be dead
					}
				}
				recordMissionEvent({
					overstoryDir,
					mission,
					agentName: "operator",
					data: { kind: "role_stopped", detail: `${roleName} suspended` },
				});
			} finally {
				store.close();
			}
		}

		// Kill tmux sessions for descendant worker agents
		if (mission.runId) {
			const { store } = openSessionStore(overstoryDir);
			try {
				const descendants = store
					.getByRun(mission.runId)
					.filter(
						(s) =>
							!["coordinator", "mission-analyst", "execution-director"].includes(s.agentName) &&
							s.state !== "completed",
					);
				for (const session of descendants) {
					if (session.tmuxSession) {
						const alive = await isSessionAlive(session.tmuxSession);
						if (alive) {
							await killSession(session.tmuxSession);
						}
					}
					if (session.pid) {
						try {
							await killProcessTree(session.pid);
						} catch {
							// Process may already be dead
						}
					}
					recordMissionEvent({
						overstoryDir,
						mission,
						agentName: "operator",
						data: { kind: "role_stopped", detail: `${session.agentName} suspended` },
					});
				}
			} finally {
				store.close();
			}
		}

		// Set mission state to suspended (preserves runtime pointers, mail, run)
		const beforeState = mission.state;
		missionStore.updateState(mission.id, "suspended");
		recordMissionEvent({
			overstoryDir,
			mission,
			agentName: "operator",
			data: { kind: "state_change", from: beforeState, to: "suspended" },
		});

		if (!json) {
			printSuccess("Mission suspended", `${mission.slug} — use 'ov mission resume' to restore`);
		}
	} finally {
		missionStore.close();
	}
}

async function terminalizeMission(opts: {
	overstoryDir: string;
	projectRoot: string;
	mission: Mission;
	targetState: "completed" | "stopped";
	json: boolean;
	deps?: MissionCommandDeps;
}): Promise<{ bundlePath: string | null; reviewId: string | null }> {
	const { overstoryDir, projectRoot, mission, targetState, json, deps } = opts;
	const dbPath = join(overstoryDir, "sessions.db");
	const missionStore = createMissionStore(dbPath);
	const stopRole = deps?.stopMissionRole ?? stopMissionRole;
	const stopAgent = deps?.stopAgentCommand ?? stopCommand;

	try {
		for (const roleName of ["coordinator", "mission-analyst", "execution-director"]) {
			try {
				await stopRole(roleName, {
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

		const descendantStops = await stopMissionRunDescendants({
			overstoryDir,
			projectRoot,
			runId: mission.runId,
			excludedAgentNames: new Set(["coordinator", "mission-analyst", "execution-director"]),
			stopAgentCommand: stopAgent,
		});
		for (const agentName of descendantStops) {
			recordMissionEvent({
				overstoryDir,
				mission,
				agentName: "operator",
				data: { kind: "role_stopped", detail: `${agentName} stopped` },
			});
		}
		const drainedAgentNames = new Set<string>([
			"coordinator",
			"mission-analyst",
			"execution-director",
		]);
		if (mission.runId) {
			const { store } = openSessionStore(overstoryDir);
			try {
				for (const session of store.getByRun(mission.runId)) {
					drainedAgentNames.add(session.agentName);
				}
			} finally {
				store.close();
			}
		}
		for (const agentName of drainedAgentNames) {
			drainAgentInbox(overstoryDir, agentName);
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

		await clearMissionRuntimePointers(overstoryDir);

		let bundlePath: string | null = null;
		const refreshedMission = missionStore.getById(mission.id) ?? mission;
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
	attach?: boolean;
}

export async function missionStart(
	overstoryDir: string,
	projectRoot: string,
	opts: StartOpts,
	deps: MissionCommandDeps = {},
): Promise<void> {
	const slug = opts.slug ?? `mission-${Date.now()}`;
	const objective = opts.objective ?? "Pending — coordinator will clarify with operator";
	const pendingObjective = !opts.objective;
	const shouldAttach = opts.attach ?? false;

	const dbPath = join(overstoryDir, "sessions.db");
	const missionStore = createMissionStore(dbPath);
	const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-mission`;
	const missionId = `mission-${Date.now()}-${slug}`;
	const artifactRoot = join(overstoryDir, "missions", missionId);
	let missionCreated = false;
	let coordinatorStarted = false;
	let analystStarted = false;
	const startCoord = deps.startMissionCoordinator ?? startMissionCoordinator;
	const startAnalyst = deps.startMissionAnalyst ?? startMissionAnalyst;
	const stopRole = deps.stopMissionRole ?? stopMissionRole;

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
				coordinatorName: "coordinator",
				status: "active",
			});
		} finally {
			runStore.close();
		}

		await mkdir(artifactRoot, { recursive: true });

		const insertMission: InsertMission = {
			id: missionId,
			slug,
			objective,
			runId,
			artifactRoot,
			startedAt: new Date().toISOString(),
		};
		const createdMission = missionStore.create(insertMission);
		missionCreated = true;
		missionStore.start(missionId);
		const mission = missionStore.getById(missionId) ?? createdMission;

		await ensureMissionArtifacts(mission);
		await writeMissionRuntimePointers(overstoryDir, mission.id, runId);

		// --- Start mission coordinator (user-facing role) ---
		const coordPrompt = await materializeMissionRolePrompt({
			overstoryDir,
			agentName: "coordinator",
			capability: "coordinator-mission",
			roleLabel: "Mission Coordinator",
			mission,
		});
		drainAgentInbox(overstoryDir, "coordinator");

		const coordResult = await startCoord({
			missionId: mission.id,
			projectRoot,
			overstoryDir,
			existingRunId: runId,
			appendSystemPromptFile: coordPrompt.promptPath,
			beacon: buildMissionRoleBeacon({
				agentName: "coordinator",
				missionId: mission.id,
				contextPath: coordPrompt.contextPath,
			}),
		});
		coordinatorStarted = true;

		// Bind coordinator session to the mission record
		missionStore.bindCoordinatorSession(mission.id, coordResult.session.id);

		// --- Start mission analyst (internal research role) ---
		const analystPrompt = await materializeMissionRolePrompt({
			overstoryDir,
			agentName: "mission-analyst",
			capability: "mission-analyst",
			roleLabel: "Mission Analyst",
			mission,
		});
		drainAgentInbox(overstoryDir, "mission-analyst");

		const analystResult = await startAnalyst({
			missionId: mission.id,
			projectRoot,
			overstoryDir,
			existingRunId: runId,
			appendSystemPromptFile: analystPrompt.promptPath,
			beacon: buildMissionRoleBeacon({
				agentName: "mission-analyst",
				missionId: mission.id,
				contextPath: analystPrompt.contextPath,
			}),
		});
		analystStarted = true;
		missionStore.bindSessions(mission.id, { analystSessionId: analystResult.session.id });

		// --- Dispatch objective to coordinator (not analyst) ---
		const dispatchBody = pendingObjective
			? [
					`Mission ID: ${mission.id}`,
					`Artifact root: ${mission.artifactRoot ?? "none"}`,
					`Context file: ${coordPrompt.contextPath}`,
					"",
					"No objective was provided at start. Begin by asking the operator what they want to accomplish.",
					"Once you understand the objective, set the mission identity:",
					`  ov mission update --slug <short-name> --objective '<real objective>'`,
					"Then proceed with standard mission coordination (planning, freeze, handoff).",
					"Mission Analyst is running and available for research queries via mail.",
				]
			: [
					`Mission ID: ${mission.id}`,
					`Objective: ${mission.objective}`,
					`Artifact root: ${mission.artifactRoot ?? "none"}`,
					`Context file: ${coordPrompt.contextPath}`,
					"",
					"You are the user-facing mission coordinator.",
					"Mission Analyst is running and available for research queries via mail.",
					"Begin initial clarification with the operator.",
				];
		const dispatchId = await sendMissionDispatchMail({
			overstoryDir,
			to: "coordinator",
			subject: `Mission started: ${mission.slug}`,
			body: dispatchBody.join("\n"),
		});
		await nudgeMissionRoleBestEffort(
			projectRoot,
			"coordinator",
			`Mission started: ${mission.slug}. Check mail and begin mission coordination.`,
			deps,
		);

		// Notify analyst of mission start (internal, not user-facing)
		await sendMissionControlMail({
			overstoryDir,
			to: "mission-analyst",
			subject: `Mission started: ${mission.slug}`,
			body: [
				`Mission ID: ${mission.id}`,
				`Objective: ${mission.objective}`,
				`Artifact root: ${mission.artifactRoot ?? "none"}`,
				`Context file: ${analystPrompt.contextPath}`,
				"",
				"You are the internal research and knowledge role for this mission.",
				"The coordinator owns the user-facing interaction loop.",
				"Begin current-state analysis. Report findings to coordinator via mail.",
			].join("\n"),
			type: "dispatch",
		});
		await nudgeMissionRoleBestEffort(
			projectRoot,
			"mission-analyst",
			`Mission started: ${mission.slug}. Check mail and begin current-state analysis.`,
			deps,
		);

		recordMissionEvent({
			overstoryDir,
			mission,
			agentName: "operator",
			data: {
				kind: "mission_started",
				detail: `Mission started and dispatched to coordinator (${dispatchId})`,
			},
		});
		recordMissionEvent({
			overstoryDir,
			mission,
			agentName: "operator",
			data: { kind: "role_started", detail: "coordinator (mission) started" },
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
			process.stdout.write(`  Coordinator: ${coordResult.session.id}\n`);
			process.stdout.write(`  Analyst:     ${analystResult.session.id}\n`);
			process.stdout.write(`  Dispatch:    ${dispatchId}\n`);
		}

		if (shouldAttach && coordResult.session.tmuxSession) {
			attachOrSwitch(coordResult.session.tmuxSession);
		}
	} catch (err) {
		for (const roleName of ["coordinator", "mission-analyst"]) {
			if (roleName === "coordinator" && !coordinatorStarted) continue;
			if (roleName === "mission-analyst" && !analystStarted) continue;
			try {
				await stopRole(roleName, {
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
		await clearMissionRuntimePointers(overstoryDir);
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

// === ov mission update ===

interface UpdateOpts {
	slug?: string;
	objective?: string;
	json?: boolean;
}

export async function missionUpdate(overstoryDir: string, opts: UpdateOpts): Promise<void> {
	const json = opts.json ?? false;

	if (!opts.slug && !opts.objective) {
		if (json) {
			jsonError("mission update", "At least one of --slug or --objective is required");
		} else {
			printError("Nothing to update", "Provide --slug and/or --objective");
		}
		process.exitCode = 1;
		return;
	}

	const missionId = await resolveCurrentMissionId(overstoryDir);
	if (!missionId) {
		if (json) {
			jsonError("mission update", "No active mission");
		} else {
			printError("No active mission", "Start one with: ov mission start");
		}
		process.exitCode = 1;
		return;
	}

	const dbPath = join(overstoryDir, "sessions.db");
	const missionStore = createMissionStore(dbPath);
	try {
		if (opts.slug) {
			missionStore.updateSlug(missionId, opts.slug);
		}
		if (opts.objective) {
			missionStore.updateObjective(missionId, opts.objective);
		}

		const updated = missionStore.getById(missionId);
		if (json) {
			jsonOutput("mission update", {
				id: missionId,
				slug: updated?.slug,
				objective: updated?.objective,
			});
		} else {
			printSuccess("Mission updated");
			if (opts.slug) console.log(`  Slug: ${accent(opts.slug)}`);
			if (opts.objective) console.log(`  Objective: ${opts.objective}`);
		}
	} finally {
		missionStore.close();
	}
}

// === ov mission status ===

export async function missionStatus(overstoryDir: string, json: boolean): Promise<void> {
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

		await writeMissionRuntimePointers(overstoryDir, mission.id, mission.runId);
		const roles = resolveMissionRoleStates(overstoryDir, mission);

		const missionScore = computeMissionScore(overstoryDir, mission);

		if (json) {
			jsonOutput("mission status", { mission: toSummary(mission), roles, score: missionScore });
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
		renderMissionScore(missionScore);
	} finally {
		missionStore.close();
	}
}

// === ov mission output ===

export async function missionOutput(overstoryDir: string, json: boolean): Promise<void> {
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

		await writeMissionRuntimePointers(overstoryDir, mission.id, mission.runId);
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
			`  Pending:             ${mission.pendingUserInput ? (mission.pendingInputKind ?? "input") : "none"}\n`,
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

export async function missionAnswer(
	overstoryDir: string,
	opts: AnswerOpts,
	deps: MissionCommandDeps = {},
): Promise<void> {
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
	const projectRoot = dirname(overstoryDir);
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
		const pendingThreadId = mission.pendingInputThreadId;
		const pendingSender = await pendingMissionQuestionSender(overstoryDir, pendingThreadId);
		try {
			replyId = client.reply(pendingThreadId, body, "operator");
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
				detail: `Operator replied in thread ${pendingThreadId}`,
				threadId: pendingThreadId,
				replyId,
			},
		});
		recordMissionEvent({
			overstoryDir,
			mission,
			agentName: "operator",
			data: { kind: "state_change", from: "frozen", to: "active" },
		});
		const refreshedMission = missionStore.getById(missionId) ?? mission;
		if (pendingSender) {
			await ensureMissionRoleResponsive({
				projectRoot,
				overstoryDir,
				mission: refreshedMission,
				roleName: pendingSender,
				threadId: pendingThreadId,
				replyId,
				deps,
			});
		}

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

export async function missionArtifacts(overstoryDir: string, json: boolean): Promise<void> {
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

// === ov mission pause / resume / refresh-briefs ===

interface PauseOpts {
	reason?: string;
	json?: boolean;
}

interface RefreshBriefOpts {
	workstream?: string;
	json?: boolean;
}

export async function missionPause(
	overstoryDir: string,
	workstreamId: string,
	opts: PauseOpts,
	deps: MissionCommandDeps = {},
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
	const projectRoot = dirname(overstoryDir);
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
			await nudgeMissionRoleBestEffort(
				projectRoot,
				"execution-director",
				`Mission pause control for ${workstreamId}. Check mail and update execution.`,
				deps,
			);
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
			process.stdout.write(
				`  Paused:      ${refreshedMission.pausedWorkstreamIds.length} workstreams\n`,
			);
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

// === ov mission stop / complete ===

export async function missionStop(
	overstoryDir: string,
	projectRoot: string,
	json: boolean,
	kill: boolean,
	deps: MissionCommandDeps = {},
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

		if (kill) {
			const result = await terminalizeMission({
				overstoryDir,
				projectRoot,
				mission,
				targetState: "stopped",
				json,
				deps,
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
		} else {
			await suspendMission({ overstoryDir, projectRoot, mission, json });
			if (json) {
				jsonOutput("mission stop", {
					missionId,
					slug: mission.slug,
					state: "suspended",
				});
			}
		}
	} finally {
		missionStore.close();
	}
}

export async function missionResumeAll(
	overstoryDir: string,
	projectRoot: string,
	json: boolean,
): Promise<void> {
	// Find suspended mission
	const missionId = await resolveCurrentMissionId(overstoryDir);
	const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
	try {
		let mission: Mission | undefined;
		if (missionId) {
			mission = missionStore.getById(missionId) ?? undefined;
		}
		if (!mission || mission.state !== "suspended") {
			// Try finding most recent suspended mission
			const suspended = missionStore.list({ state: "suspended", limit: 1 });
			mission = suspended[0];
		}
		if (!mission) {
			if (json) {
				jsonError("mission resume", "No suspended mission to resume");
			} else {
				printError("No suspended mission to resume");
			}
			process.exitCode = 1;
			return;
		}

		// Restore mission state
		missionStore.updateState(mission.id, "active");
		recordMissionEvent({
			overstoryDir,
			mission,
			agentName: "operator",
			data: { kind: "state_change", from: "suspended", to: "active" },
		});

		// Ensure runtime pointers are written
		await writeMissionRuntimePointers(overstoryDir, mission.id, mission.runId ?? null);

		// Find all resumable agents from this mission's run
		const config = await loadConfig(projectRoot);
		const { store } = openSessionStore(overstoryDir);
		try {
			const aliveSessions = new Set((await listSessions()).map((s) => s.name));
			const allSessions = mission.runId ? store.getByRun(mission.runId) : [];
			const resumable = allSessions.filter((s) => {
				if (s.state === "completed") return false;
				if (aliveSessions.has(s.tmuxSession)) return false;
				return true;
			});

			// Resume persistent roles first, then workers (by depth)
			const roleNames = new Set(["coordinator", "mission-analyst", "execution-director"]);
			const roles = resumable.filter((s) => roleNames.has(s.agentName));
			const workers = resumable
				.filter((s) => !roleNames.has(s.agentName))
				.sort((a, b) => a.depth - b.depth);
			const ordered = [...roles, ...workers];

			const results: Array<{ agentName: string; success: boolean; error?: string }> = [];
			for (const session of ordered) {
				try {
					await resumeAgent(session, config, projectRoot);
					results.push({ agentName: session.agentName, success: true });
					if (!json) {
						printSuccess(`Resumed ${session.agentName}`);
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					results.push({ agentName: session.agentName, success: false, error: msg });
					if (!json) {
						printWarning(`Failed to resume ${session.agentName}: ${msg}`);
					}
				}
			}

			if (json) {
				jsonOutput("mission resume", {
					missionId: mission.id,
					slug: mission.slug,
					state: "active",
					resumed: results,
				});
			} else if (results.length === 0) {
				printHint("Mission state restored. No agents to resume.");
			}
		} finally {
			store.close();
		}
	} finally {
		missionStore.close();
	}
}

export async function missionComplete(
	overstoryDir: string,
	projectRoot: string,
	json: boolean,
	deps: MissionCommandDeps = {},
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
			deps,
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

export async function missionList(overstoryDir: string, json: boolean): Promise<void> {
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

export async function missionShow(
	overstoryDir: string,
	idOrSlug: string,
	json: boolean,
): Promise<void> {
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

export async function missionBundle(overstoryDir: string, opts: BundleOpts): Promise<void> {
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
		.option("--slug <slug>", "Short identifier for the mission (e.g. auth-rewrite)")
		.option("--objective <objective>", "Mission objective (what to accomplish)")
		.option("--attach", "Attach to coordinator tmux session after start")
		.option("--no-attach", "Do not attach to coordinator tmux session")
		.option("--json", "Output as JSON")
		.action(
			async (opts: { slug?: string; objective?: string; attach?: boolean; json?: boolean }) => {
				const cwd = process.cwd();
				const config = await loadConfig(cwd);
				const overstoryDir = join(config.project.root, ".overstory");
				const attach = opts.attach ?? (opts.json ? false : process.stdout.isTTY === true);
				await missionStart(overstoryDir, config.project.root, { ...opts, attach });
			},
		);

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
		.command("update")
		.description("Update the active mission's slug or objective")
		.option("--slug <slug>", "New short identifier")
		.option("--objective <objective>", "New mission objective")
		.option("--json", "Output as JSON")
		.action(async (opts: UpdateOpts) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionUpdate(overstoryDir, opts);
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
		.description("Resume a suspended mission or a paused workstream")
		.argument("[workstream-id]", "Workstream ID (omit to resume entire suspended mission)")
		.option("--json", "Output as JSON")
		.action(async (workstreamId: string | undefined, opts: MissionDefaultOpts) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			if (workstreamId) {
				await missionResume(overstoryDir, config.project.root, workstreamId, opts.json ?? false);
			} else {
				await missionResumeAll(overstoryDir, config.project.root, opts.json ?? false);
			}
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
		.description("Suspend the active mission (preserves state for resume)")
		.option("--kill", "Full teardown — no resume possible")
		.option("--json", "Output as JSON")
		.action(async (opts: MissionDefaultOpts & { kill?: boolean }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionStop(overstoryDir, config.project.root, opts.json ?? false, opts.kill ?? false);
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
