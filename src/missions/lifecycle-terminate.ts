/**
 * Mission termination operations: stop and complete.
 *
 * Contains the shared terminalizeMission() logic and its two public callers:
 * missionStop() and missionComplete().
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { stopCommand } from "../commands/stop.ts";
import { loadConfig } from "../config.ts";
import { jsonError, jsonOutput } from "../json.ts";
import { printError, printHint, printSuccess, printWarning } from "../logging/color.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { createRunStore } from "../sessions/store.ts";
import type { Mission } from "../types.ts";
import {
	getCurrentSessionName,
	isSessionAlive,
	killProcessTree,
	killSession,
	removeAgentEnvFile,
} from "../worktree/tmux.ts";
import { transitionMissionViaEngine } from "./engine-wiring.ts";
import { recordMissionEvent } from "./events.ts";
import { resolveCurrentMissionId } from "./lifecycle-helpers.ts";
import { suspendMission } from "./lifecycle-suspend.ts";
import type { MissionCommandDeps } from "./lifecycle-types.ts";
import { drainAgentInbox } from "./messaging.ts";
import { generateMissionReview } from "./review.ts";
import { stopMissionRole, stopMissionRunDescendants } from "./roles.ts";
import { removeActiveMission } from "./runtime-context.ts";
import { createMissionStore } from "./store.ts";

/**
 * Delete Claude session transcript directories for a mission's agent sessions.
 * Best-effort: errors are caught and never fail mission completion.
 */
async function purgeSessionTranscripts(overstoryDir: string, runId: string): Promise<number> {
	let purged = 0;
	const { store } = openSessionStore(overstoryDir);
	try {
		const sessions = store.getByRun(runId);
		const home = homedir();
		const claudeProjectsDir = join(home, ".claude", "projects");
		const dirsToRemove = new Set<string>();

		for (const session of sessions) {
			if (!session.worktreePath) continue;
			const encodedDir = session.worktreePath.replace(/[/.]/g, "-");
			const transcriptDir = join(claudeProjectsDir, encodedDir);
			if (existsSync(transcriptDir)) {
				dirsToRemove.add(transcriptDir);
			}
			if (session.runtimeSessionId) {
				removeAgentEnvFile(session.worktreePath, session.runtimeSessionId);
			}
		}

		for (const dir of dirsToRemove) {
			try {
				await rm(dir, { recursive: true, force: true });
				purged++;
			} catch {
				// Best effort
			}
		}
	} finally {
		store.close();
	}
	return purged;
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
							// Mark session completed so watchdog doesn't re-terminate as zombie
							try {
								const { store: killStore } = openSessionStore(overstoryDir);
								try {
									killStore.updateState(roleName, "completed");
								} finally {
									killStore.close();
								}
							} catch {
								/* best effort */
							}
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

		// --- Holdout validation ---
		if (targetState === "completed") {
			const holdoutConfig = await loadConfig(projectRoot);
			const holdoutEnabled = holdoutConfig.mission?.holdout?.enabled !== false;
			if (holdoutEnabled) {
				const { runMissionHoldout } = await import("./holdout.ts");
				const holdoutResult = await runMissionHoldout({
					overstoryDir,
					projectRoot,
					missionId: mission.id,
					maxLevel: holdoutConfig.mission?.holdout?.level3Enabled ? 3 : 2,
				});
				const blockOnFailure = holdoutConfig.mission?.holdout?.blockOnFailure !== false;
				if (!holdoutResult.passed) {
					if (json) {
						console.log(JSON.stringify({ holdout: holdoutResult }, null, 2));
					} else {
						console.error("Holdout validation failed:");
						for (const check of holdoutResult.checks) {
							if (check.status === "fail") {
								console.error(`  [L${check.level}] ${check.name}: ${check.message}`);
								if (check.details) {
									for (const d of check.details) {
										console.error(`      ${d}`);
									}
								}
							}
						}
					}
					if (blockOnFailure) {
						process.exitCode = 1;
						missionStore.close();
						return { bundlePath: null, reviewId: null, deferredSelfSession: null };
					}
				}
			}
		}

		const beforeState = mission.state;
		const beforePhase = mission.phase;
		if (targetState === "completed") {
			await transitionMissionViaEngine(mission.id, "complete", {
				checkpointStore: missionStore.checkpoints,
				missionStore,
			});
			if (mission.phase !== "done") {
				missionStore.updatePhase(mission.id, "done");
			}
			missionStore.completeMission(mission.id);
			if (mission.phase !== "done") {
				recordMissionEvent({
					overstoryDir,
					mission,
					agentName: "operator",
					data: { kind: "phase_change", from: beforePhase, to: "done" },
				});
			}
		} else {
			await transitionMissionViaEngine(mission.id, "stop", {
				checkpointStore: missionStore.checkpoints,
				missionStore,
			});
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

		// Purge Claude session transcripts (config-gated, best-effort)
		if (mission.runId) {
			try {
				const cleanupConfig = await loadConfig(projectRoot);
				if (cleanupConfig.mission?.cleanup?.purgeSessionTranscripts) {
					const purgedCount = await purgeSessionTranscripts(overstoryDir, mission.runId);
					if (!json && purgedCount > 0) {
						printSuccess(
							"Session transcripts purged",
							`${purgedCount} director${purgedCount === 1 ? "y" : "ies"}`,
						);
					}
				}
			} catch {
				// Best effort — never fail mission completion
			}
		}

		await removeActiveMission(overstoryDir, mission.id);

		let bundlePath: string | null = null;
		const refreshedMission = missionStore.getById(mission.id) ?? mission;

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

			// Spawn architecture-sync agent (Phase 3)
			try {
				const { buildSyncAgentContext } = await import("./learnings.ts");
				const artifactRoot =
					refreshedMission.artifactRoot ?? join(overstoryDir, "missions", mission.id);
				const syncContext = buildSyncAgentContext({
					bundlePath,
					artifactRoot,
					missionSlug: refreshedMission.slug,
					projectRoot,
				});
				if (syncContext !== null) {
					const agentName = `arch-sync-${refreshedMission.slug}`;
					const taskId = `${mission.id}-sync`;
					const slingProc = Bun.spawn(
						[
							"ov",
							"sling",
							taskId,
							"--capability",
							"architecture-sync",
							"--name",
							agentName,
							"--skip-task-check",
							"--depth",
							"0",
						],
						{ cwd: projectRoot, stdout: "pipe", stderr: "pipe" },
					);
					await slingProc.exited;
					Bun.spawn(
						[
							"ov",
							"mail",
							"send",
							"--to",
							agentName,
							"--subject",
							`Sync: ${refreshedMission.slug}`,
							"--body",
							JSON.stringify(syncContext),
							"--type",
							"dispatch",
						],
						{ cwd: projectRoot, stdout: "pipe", stderr: "pipe" },
					);
					if (!json) {
						printSuccess("Architecture-sync agent spawned", agentName);
					}
				}
			} catch (err) {
				if (!json) {
					printWarning("Architecture sync failed", String(err));
				}
			}
		}

		return { bundlePath, reviewId: review.record.id, deferredSelfSession: selfTmuxSession };
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
