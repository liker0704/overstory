/**
 * Mission lifecycle operations.
 *
 * Handles start, stop, pause, resume, complete, update, answer, and
 * related state transitions for missions. Extracted from commands/mission.ts
 * to separate domain logic from CLI command registration.
 */

import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { nudgeAgent } from "../commands/nudge.ts";
import { resumeAgent } from "../commands/resume.ts";
import { stopCommand } from "../commands/stop.ts";
import { loadConfig } from "../config.ts";
import { jsonError, jsonOutput } from "../json.ts";
import { accent, printError, printHint, printSuccess, printWarning } from "../logging/color.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { createRunStore } from "../sessions/store.ts";
import type {
	InsertMission,
	Mission,
	MissionPhase,
	MissionState,
	MissionStore,
	MissionSummary,
} from "../types.ts";
import { createWatchdogControl } from "../watchdog/control.ts";
import {
	attachOrSwitch,
	getCurrentSessionName,
	isSessionAlive,
	killProcessTree,
	killSession,
	listSessions,
} from "../worktree/tmux.ts";
import {
	buildMissionRoleBeacon,
	ensureMissionArtifacts,
	materializeMissionRolePrompt,
} from "./context.ts";
import { shouldUseEngine } from "./engine-wiring.ts";
import { recordMissionEvent } from "./events.ts";
import { DEFAULT_MISSION_GRAPH, nodeId, validateTransition } from "./graph.ts";
import {
	drainAgentInbox,
	ensureMissionRoleResponsive,
	nudgeMissionRoleBestEffort,
	pendingMissionQuestionSender,
	sendMissionControlMail,
	sendMissionDispatchMail,
} from "./messaging.ts";
import { pauseWorkstream } from "./pause.ts";
import { generateMissionReview } from "./review.ts";
import {
	type startExecutionDirector,
	startMissionAnalyst,
	startMissionCoordinator,
	stopMissionRole,
	stopMissionRunDescendants,
} from "./roles.ts";
import {
	clearMissionRuntimePointers,
	resolveMissionRoleStates as deriveMissionRoleStates,
	resolveActiveMissionContext,
	writeMissionRuntimePointers,
} from "./runtime-context.ts";
import { createMissionStore } from "./store.ts";
import { getMissionWorkstream } from "./workstream-control.ts";

// === Shared types ===

export interface MissionCommandDeps {
	startMissionCoordinator?: typeof startMissionCoordinator;
	startMissionAnalyst?: typeof startMissionAnalyst;
	startExecutionDirector?: typeof startExecutionDirector;
	stopMissionRole?: typeof stopMissionRole;
	stopAgentCommand?: typeof stopCommand;
	ensureCanonicalWorkstreamTasks?: typeof import("./workstreams.ts").ensureCanonicalWorkstreamTasks;
	nudgeAgent?: typeof nudgeAgent;
}

// === Helpers ===

export async function resolveCurrentMissionId(overstoryDir: string): Promise<string | null> {
	return (await resolveActiveMissionContext(overstoryDir))?.missionId ?? null;
}

/** Convert Mission to MissionSummary. */
export function toSummary(mission: Mission): MissionSummary {
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

/**
 * Advisory graph transition: validate the transition, update currentNode,
 * and log a warning event if the transition is not legal per the graph.
 */
export function adviseGraphTransition(
	overstoryDir: string,
	missionStore: MissionStore,
	mission: Mission,
	toPhase: MissionPhase,
	toState: MissionState,
): void {
	const result = validateTransition(
		DEFAULT_MISSION_GRAPH,
		mission.phase,
		mission.state,
		toPhase,
		toState,
	);
	const targetNode = nodeId(toPhase, toState);
	missionStore.updateCurrentNode(mission.id, targetNode);
	if (!result.valid) {
		recordMissionEvent({
			overstoryDir,
			mission,
			agentName: "operator",
			data: {
				kind: "graph_transition_warning",
				detail: result.reason,
				from: nodeId(mission.phase, mission.state),
				to: targetNode,
			},
		});
	}
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

export function resolveMissionRoleStates(
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

/**
 * Suspend a mission: kill all tmux sessions but preserve state for resume.
 * Unlike terminalizeMission(), this does NOT drain mail, clear runtime pointers,
 * complete the run, or export bundle/review.
 */
export async function suspendMission(opts: {
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
		adviseGraphTransition(overstoryDir, missionStore, mission, mission.phase, "suspended");
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
}): Promise<{
	bundlePath: string | null;
	reviewId: string | null;
	deferredSelfSession: string | null;
}> {
	const { overstoryDir, projectRoot, mission, targetState, json, deps } = opts;
	const dbPath = join(overstoryDir, "sessions.db");
	const missionStore = createMissionStore(dbPath);
	const stopRole = deps?.stopMissionRole ?? stopMissionRole;
	const stopAgent = deps?.stopAgentCommand ?? stopCommand;

	// Detect if we're running inside a mission tmux session (coordinator calling ov mission complete).
	// If so, skip killing our own session until all cleanup is done.
	const selfTmuxSession = await getCurrentSessionName();

	try {
		const roleStopFailures: string[] = [];
		// Try slug-scoped names first (parallel missions), then legacy names
		const slug = mission.slug;
		const roleNames = slug
			? [
					`coordinator-${slug}`,
					"coordinator",
					`mission-analyst-${slug}`,
					"mission-analyst",
					`execution-director-${slug}`,
					"execution-director",
				]
			: ["coordinator", "mission-analyst", "execution-director"];
		const stoppedRoles = new Set<string>();
		// Open session store once for self-detection lookups
		const { store: selfCheckStore } = selfTmuxSession
			? openSessionStore(overstoryDir)
			: { store: null };
		try {
			for (const roleName of roleNames) {
				// Skip if we already stopped the base role via its scoped variant
				const baseRole = roleName.replace(`-${slug}`, "");
				if (stoppedRoles.has(baseRole)) continue;
				// Skip killing our own session — defer until all cleanup is done
				if (selfTmuxSession && selfCheckStore) {
					const roleSession = selfCheckStore.getByName(roleName);
					if (roleSession?.tmuxSession === selfTmuxSession) {
						stoppedRoles.add(baseRole);
						continue;
					}
				}
				try {
					await stopRole(roleName, {
						projectRoot,
						overstoryDir,
						completeRun: false,
						runStatus: targetState === "completed" ? "completed" : "stopped",
					});
					stoppedRoles.add(baseRole);
					recordMissionEvent({
						overstoryDir,
						mission,
						agentName: "operator",
						data: { kind: "role_stopped", detail: `${roleName} stopped` },
					});
				} catch {
					if (!slug || !roleName.includes(slug)) {
						roleStopFailures.push(roleName);
					}
				}
			}
		} finally {
			selfCheckStore?.close();
		}

		// Fallback: directly kill tmux sessions for roles that failed graceful stop
		// Try slug-scoped names first, then legacy singleton names
		const roleTmuxNames: Record<string, string[]> = {
			coordinator: slug
				? [`ov-coordinator-${slug}`, "ov-mission-coordinator"]
				: ["ov-mission-coordinator"],
			"mission-analyst": slug
				? [`ov-analyst-${slug}`, "ov-mission-analyst"]
				: ["ov-mission-analyst"],
			"execution-director": slug
				? [`ov-ed-${slug}`, "ov-execution-director"]
				: ["ov-execution-director"],
		};
		for (const roleName of roleStopFailures) {
			const tmuxNames = roleTmuxNames[roleName];
			if (tmuxNames) {
				for (const tmuxName of tmuxNames) {
					if (tmuxName === selfTmuxSession) continue;
					try {
						if (await isSessionAlive(tmuxName)) {
							await killSession(tmuxName);
							break;
						}
					} catch {
						// Best effort — session may already be gone
					}
				}
			}
			recordMissionEvent({
				overstoryDir,
				mission,
				agentName: "operator",
				data: {
					kind: "role_stopped",
					detail: `${roleName} force-killed (graceful stop failed)`,
				},
			});
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
			adviseGraphTransition(overstoryDir, missionStore, mission, "done", "completed");
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
			adviseGraphTransition(overstoryDir, missionStore, mission, "done", "stopped");
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

		// Final verification: kill any surviving tmux sessions before clearing pointers
		if (mission.runId) {
			const { store: verifyStore } = openSessionStore(overstoryDir);
			try {
				for (const session of verifyStore.getByRun(mission.runId)) {
					if (session.tmuxSession === selfTmuxSession) continue;
					if (session.tmuxSession && (await isSessionAlive(session.tmuxSession))) {
						try {
							await killSession(session.tmuxSession);
						} catch {
							// Best effort
						}
					}
				}
			} finally {
				verifyStore.close();
			}
		}

		await clearMissionRuntimePointers(overstoryDir);

		let bundlePath: string | null = null;
		const refreshedMission = missionStore.getById(mission.id) ?? mission;
		try {
			const { exportBundle } = await import("./bundle.ts");
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
			const { exportBundle } = await import("./bundle.ts");
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

		// Extract learnings into mulch
		if (bundlePath) {
			try {
				const { extractMissionLearnings } = await import("./learnings.ts");
				const artifactRoot =
					refreshedMission.artifactRoot ?? join(overstoryDir, "missions", mission.id);
				const learningsResult = await extractMissionLearnings({
					bundlePath,
					artifactRoot,
					projectRoot,
					missionSlug: refreshedMission.slug,
				});
				missionStore.markLearningsExtracted(mission.id);
				if (!json && learningsResult.recordsSucceeded > 0) {
					printSuccess("Learnings extracted", `${learningsResult.recordsSucceeded} mulch records`);
				}
				if (learningsResult.errors.length > 0) {
					for (const err of learningsResult.errors) {
						if (!json) printWarning("Learnings extraction warning", err);
					}
				}
			} catch (err) {
				if (!json) {
					printWarning("Learnings extraction failed", String(err));
				}
			}
		}

		return { bundlePath, reviewId: review.record.id, deferredSelfSession: selfTmuxSession };
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
		const config = await loadConfig(projectRoot);
		const maxConcurrent = config.mission?.maxConcurrent ?? 1;
		const activeMissions = missionStore.getActiveList();
		if (activeMissions.length >= maxConcurrent) {
			const listing = activeMissions.map((m) => m.slug).join(", ");
			if (opts.json) {
				jsonError(
					"mission start",
					`Maximum concurrent missions reached (${activeMissions.length} active, limit ${maxConcurrent})`,
				);
			} else {
				printError(
					`Maximum concurrent missions reached (${activeMissions.length} active, limit ${maxConcurrent})`,
				);
				printHint(`Active missions: ${listing}`);
				printHint("Stop one first with: ov mission stop");
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
		missionStore.updateCurrentNode(missionId, nodeId("understand", "active"));
		const mission = missionStore.getById(missionId) ?? createdMission;

		await mkdir(artifactRoot, { recursive: true });

		await ensureMissionArtifacts(mission);
		await writeMissionRuntimePointers(overstoryDir, mission.id, runId);

		// --- Start mission coordinator (user-facing role) ---
		// Scope agent names by slug for parallel mission support
		const coordAgentName = slug ? `coordinator-${slug}` : "coordinator";
		const analystAgentName = slug ? `mission-analyst-${slug}` : "mission-analyst";
		const edAgentName = slug ? `execution-director-${slug}` : "execution-director";
		const coordPrompt = await materializeMissionRolePrompt({
			overstoryDir,
			agentName: coordAgentName,
			capability: "coordinator-mission",
			roleLabel: "Mission Coordinator",
			mission,
			siblingNames: {
				"Mission Analyst agent": analystAgentName,
				"Execution Director agent": edAgentName,
			},
		});
		drainAgentInbox(overstoryDir, coordAgentName);

		const coordResult = await startCoord({
			missionId: mission.id,
			missionSlug: mission.slug,
			agentName: coordAgentName,
			projectRoot,
			overstoryDir,
			existingRunId: runId,
			appendSystemPromptFile: coordPrompt.promptPath,
			beacon: buildMissionRoleBeacon({
				agentName: coordAgentName,
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
			agentName: analystAgentName,
			capability: "mission-analyst",
			roleLabel: "Mission Analyst",
			mission,
			siblingNames: {
				"Coordinator agent": coordAgentName,
			},
		});
		drainAgentInbox(overstoryDir, analystAgentName);

		const analystResult = await startAnalyst({
			missionId: mission.id,
			missionSlug: mission.slug,
			agentName: analystAgentName,
			projectRoot,
			overstoryDir,
			existingRunId: runId,
			appendSystemPromptFile: analystPrompt.promptPath,
			beacon: buildMissionRoleBeacon({
				agentName: analystAgentName,
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

		// Auto-start watchdog for rate-limit detection and health monitoring
		try {
			const config = await loadConfig(projectRoot);
			if (config.watchdog.tier0Enabled) {
				const watchdog = createWatchdogControl(projectRoot);
				const watchdogResult = await watchdog.start();
				if (watchdogResult && !opts.json) {
					printHint("Watchdog started");
				}
			}
			// Guard: note graph execution engine availability (advisory only)
			if (shouldUseEngine(mission, config)) {
				recordMissionEvent({
					overstoryDir,
					mission,
					agentName: "operator",
					data: { kind: "engine_available", detail: "Graph execution engine is enabled" },
				});
			}
		} catch {
			if (!opts.json) printWarning("Watchdog failed to start");
		}

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

// === ov mission answer ===

interface AnswerOpts {
	body?: string;
	file?: string;
	json?: boolean;
	missionId?: string;
}

export async function missionAnswer(
	overstoryDir: string,
	opts: AnswerOpts,
	deps: MissionCommandDeps = {},
): Promise<void> {
	const missionId = opts.missionId ?? (await resolveCurrentMissionId(overstoryDir));
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
			replyId = client.reply(pendingThreadId, body, "operator").id;
		} finally {
			client.close();
		}

		adviseGraphTransition(overstoryDir, missionStore, mission, mission.phase, "active");
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

// === ov mission pause ===

interface PauseOpts {
	reason?: string;
	json?: boolean;
	missionId?: string;
}

export async function missionPause(
	overstoryDir: string,
	workstreamId: string,
	opts: PauseOpts,
	deps: MissionCommandDeps = {},
): Promise<void> {
	const missionId = opts.missionId ?? (await resolveCurrentMissionId(overstoryDir));
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

// === ov mission stop / complete ===

export async function missionStop(
	overstoryDir: string,
	projectRoot: string,
	json: boolean,
	kill: boolean,
	deps: MissionCommandDeps = {},
	missionId?: string,
): Promise<void> {
	let resolvedMissionId = missionId ?? (await resolveCurrentMissionId(overstoryDir));

	// When --kill is used and no active/frozen mission is found, also check for
	// suspended missions. Without this, users get stuck: `start` says "suspended
	// mission exists", but `stop` says "no active mission" — a deadlock.
	if (!resolvedMissionId && kill) {
		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			const suspended = store.list({ state: "suspended", limit: 1 });
			if (suspended[0]) {
				resolvedMissionId = suspended[0].id;
			}
		} finally {
			store.close();
		}
	}

	if (!resolvedMissionId) {
		// Check if there's a suspended mission the user might be trying to kill
		if (!kill) {
			const store = createMissionStore(join(overstoryDir, "sessions.db"));
			try {
				const suspended = store.list({ state: "suspended", limit: 1 });
				if (suspended[0]) {
					if (json) {
						jsonError("mission stop", "Mission is already suspended");
					} else {
						printError("Mission is already suspended", suspended[0].slug);
						printHint("Kill it with: ov mission stop --kill");
						printHint("Or resume it with: ov mission resume");
					}
					process.exitCode = 1;
					return;
				}
			} finally {
				store.close();
			}
		}
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
		const mission = missionStore.getById(resolvedMissionId);
		if (!mission) {
			if (json) {
				jsonError("mission stop", `Mission ${resolvedMissionId} not found`);
			} else {
				printError("Mission not found in store", resolvedMissionId);
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
					missionId: resolvedMissionId,
					slug: mission.slug,
					state: "stopped",
					bundlePath: result.bundlePath,
					reviewId: result.reviewId,
				});
			} else {
				printSuccess("Mission stopped", mission.slug);
			}
			if (result.deferredSelfSession) {
				try {
					await killSession(result.deferredSelfSession);
				} catch {
					// Best effort
				}
				process.exit(0);
			}
		} else {
			await suspendMission({ overstoryDir, projectRoot, mission, json });
			if (json) {
				jsonOutput("mission stop", {
					missionId: resolvedMissionId,
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
	missionId?: string,
): Promise<void> {
	// Find suspended mission
	const resolvedMissionId = missionId ?? (await resolveCurrentMissionId(overstoryDir));
	const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
	try {
		let mission: Mission | undefined;
		if (resolvedMissionId) {
			mission = missionStore.getById(resolvedMissionId) ?? undefined;
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
		adviseGraphTransition(overstoryDir, missionStore, mission, mission.phase, "active");
		missionStore.updateState(mission.id, "active");
		recordMissionEvent({
			overstoryDir,
			mission,
			agentName: "operator",
			data: { kind: "state_change", from: "suspended", to: "active" },
		});

		// Reactivate the run if it was stopped/completed by a prior kill
		if (mission.runId) {
			const runStore = createRunStore(join(overstoryDir, "sessions.db"));
			try {
				const run = runStore.getRun(mission.runId);
				if (run && run.status !== "active") {
					runStore.reactivateRun(mission.runId);
				}
			} finally {
				runStore.close();
			}
		}

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

			if (ordered.length === 0) {
				// No resumable sessions — restart roles fresh against existing mission
				await restartMissionRoles(overstoryDir, projectRoot, mission);
				results.push({ agentName: "coordinator", success: true });
				results.push({ agentName: "mission-analyst", success: true });
				if (!json) {
					printSuccess("Restarted coordinator and mission-analyst (no prior sessions to resume)");
				}
			} else {
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
			}

			// Auto-start watchdog for rate-limit detection and health monitoring
			try {
				if (config.watchdog.tier0Enabled) {
					const watchdog = createWatchdogControl(projectRoot);
					const watchdogResult = await watchdog.start();
					if (watchdogResult && !json) {
						printHint("Watchdog started");
					}
				}
			} catch {
				if (!json) printWarning("Watchdog failed to start");
			}

			if (json) {
				jsonOutput("mission resume", {
					missionId: mission.id,
					slug: mission.slug,
					state: "active",
					resumed: results,
				});
			}
		} finally {
			store.close();
		}
	} finally {
		missionStore.close();
	}
}

/**
 * Restart coordinator and mission-analyst from scratch against an existing mission.
 * Used by resume when prior sessions are gone (e.g. after --kill).
 */
async function restartMissionRoles(
	overstoryDir: string,
	projectRoot: string,
	mission: Mission,
): Promise<void> {
	if (!mission.runId) {
		throw new Error(`Mission ${mission.id} has no runId — cannot restart roles`);
	}
	const runId = mission.runId;

	const coordAgentName = "coordinator";
	const analystAgentName = "mission-analyst";
	const edAgentName = "execution-director";

	const coordPrompt = await materializeMissionRolePrompt({
		overstoryDir,
		agentName: coordAgentName,
		capability: "coordinator-mission",
		roleLabel: "Mission Coordinator",
		mission,
		siblingNames: {
			"Mission Analyst agent": analystAgentName,
			"Execution Director agent": edAgentName,
		},
	});
	drainAgentInbox(overstoryDir, coordAgentName);

	const coordResult = await startMissionCoordinator({
		missionId: mission.id,
		missionSlug: mission.slug,
		projectRoot,
		overstoryDir,
		existingRunId: runId,
		appendSystemPromptFile: coordPrompt.promptPath,
		beacon: buildMissionRoleBeacon({
			agentName: coordAgentName,
			missionId: mission.id,
			contextPath: coordPrompt.contextPath,
		}),
	});

	const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
	try {
		missionStore.bindCoordinatorSession(mission.id, coordResult.session.id);
	} finally {
		missionStore.close();
	}

	const analystPrompt = await materializeMissionRolePrompt({
		overstoryDir,
		agentName: analystAgentName,
		capability: "mission-analyst",
		roleLabel: "Mission Analyst",
		mission,
		siblingNames: {
			"Coordinator agent": coordAgentName,
		},
	});
	drainAgentInbox(overstoryDir, "mission-analyst");

	const analystResult = await startMissionAnalyst({
		missionId: mission.id,
		missionSlug: mission.slug,
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

	const missionStore2 = createMissionStore(join(overstoryDir, "sessions.db"));
	try {
		missionStore2.bindSessions(mission.id, { analystSessionId: analystResult.session.id });
	} finally {
		missionStore2.close();
	}

	// Notify coordinator of resumed mission
	await sendMissionDispatchMail({
		overstoryDir,
		to: "coordinator",
		subject: `Mission resumed: ${mission.slug}`,
		body: [
			`Mission ID: ${mission.id}`,
			`Objective: ${mission.objective}`,
			`Artifact root: ${mission.artifactRoot ?? "none"}`,
			`Context file: ${coordPrompt.contextPath}`,
			"",
			"This mission is being RESUMED (not started fresh).",
			"Check the mission artifacts directory for prior work.",
			"Mission Analyst is running and available for research queries via mail.",
		].join("\n"),
	});
	await nudgeMissionRoleBestEffort(
		projectRoot,
		"coordinator",
		`Mission resumed: ${mission.slug}. Check mail and review prior artifacts.`,
	);

	await sendMissionControlMail({
		overstoryDir,
		to: "mission-analyst",
		subject: `Mission resumed: ${mission.slug}`,
		body: [
			`Mission ID: ${mission.id}`,
			`Objective: ${mission.objective}`,
			`Artifact root: ${mission.artifactRoot ?? "none"}`,
			`Context file: ${analystPrompt.contextPath}`,
			"",
			"This mission is being RESUMED. Check artifacts for prior analysis.",
			"Report findings to coordinator via mail.",
		].join("\n"),
		type: "dispatch",
	});
	await nudgeMissionRoleBestEffort(
		projectRoot,
		"mission-analyst",
		`Mission resumed: ${mission.slug}. Check mail and review prior work.`,
	);
}

export async function missionComplete(
	overstoryDir: string,
	projectRoot: string,
	json: boolean,
	deps: MissionCommandDeps = {},
	missionId?: string,
): Promise<void> {
	const resolvedMissionId = missionId ?? (await resolveCurrentMissionId(overstoryDir));
	if (!resolvedMissionId) {
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
		const mission = missionStore.getById(resolvedMissionId);
		if (!mission) {
			if (json) {
				jsonError("mission complete", `Mission ${resolvedMissionId} not found`);
			} else {
				printError("Mission not found in store", resolvedMissionId);
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
				missionId: resolvedMissionId,
				slug: mission.slug,
				state: "completed",
				bundlePath: result.bundlePath,
				reviewId: result.reviewId,
			});
		} else {
			printSuccess("Mission completed", mission.slug);
		}

		// Deferred self-kill: if we're the coordinator, kill our own session
		// now that all cleanup is done.
		if (result.deferredSelfSession) {
			try {
				await killSession(result.deferredSelfSession);
			} catch {
				// If kill fails, force exit — session dies with process
			}
			process.exit(0);
		}
	} finally {
		missionStore.close();
	}
}

// === ov mission extract-learnings ===

export async function missionExtractLearnings(
	overstoryDir: string,
	projectRoot: string,
	idOrSlug: string | undefined,
	opts: { force?: boolean; json?: boolean },
): Promise<void> {
	const dbPath = join(overstoryDir, "sessions.db");
	const missionStore = createMissionStore(dbPath);

	try {
		let mission: ReturnType<typeof missionStore.getById>;

		if (idOrSlug) {
			mission = missionStore.getById(idOrSlug) ?? missionStore.getBySlug(idOrSlug);
		} else {
			const completed = missionStore.list({ state: "completed", limit: 1 });
			const stopped = missionStore.list({ state: "stopped", limit: 1 });
			const candidates = [...completed, ...stopped].sort((a, b) =>
				b.updatedAt > a.updatedAt ? 1 : -1,
			);
			mission = candidates[0] ?? null;
		}

		if (!mission) {
			if (opts.json) {
				jsonError("extract-learnings", "No matching mission found");
			} else {
				printError("No matching mission found");
			}
			process.exitCode = 1;
			return;
		}

		if (mission.learningsExtracted && !opts.force) {
			if (opts.json) {
				jsonOutput("extract-learnings", {
					missionId: mission.id,
					slug: mission.slug,
					skipped: true,
					reason: "already extracted",
				});
			} else {
				printHint(`Learnings already extracted for ${mission.slug}. Use --force to re-extract.`);
			}
			return;
		}

		const bundlePath = join(overstoryDir, "missions", mission.id, "results");
		const summaryFile = Bun.file(join(bundlePath, "summary.json"));
		if (!(await summaryFile.exists())) {
			if (opts.json) {
				jsonError(
					"extract-learnings",
					`No bundle found at ${bundlePath}. Run 'ov mission bundle' first.`,
				);
			} else {
				printError(`No bundle found at ${bundlePath}. Run 'ov mission bundle' first.`);
			}
			process.exitCode = 1;
			return;
		}

		const { extractMissionLearnings } = await import("./learnings.ts");
		const artifactRoot = mission.artifactRoot ?? join(overstoryDir, "missions", mission.id);
		const result = await extractMissionLearnings({
			bundlePath,
			artifactRoot,
			projectRoot,
			missionSlug: mission.slug,
		});
		missionStore.markLearningsExtracted(mission.id);

		if (opts.json) {
			jsonOutput("extract-learnings", {
				missionId: mission.id,
				slug: mission.slug,
				...result,
			});
		} else {
			printSuccess(
				`Learnings extracted for ${mission.slug}`,
				`${result.recordsSucceeded}/${result.recordsAttempted} records`,
			);
			for (const err of result.errors) {
				printWarning("Warning", err);
			}
		}
	} finally {
		missionStore.close();
	}
}
