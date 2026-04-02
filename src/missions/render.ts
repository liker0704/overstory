/**
 * Mission rendering and display functions.
 *
 * Handles missionStatus, missionOutput, missionShow, missionList,
 * missionArtifacts, and renderMissionNarrative. Extracted from
 * commands/mission.ts to separate display logic from CLI plumbing.
 */

import { join } from "node:path";
import { jsonError, jsonOutput } from "../json.ts";
import { accent, printError, printHint } from "../logging/color.ts";
import { renderHeader, renderSubHeader, separator } from "../logging/theme.ts";
import {
	MISSION_PHASES,
	type Mission,
	type MissionGraph,
	type MissionPhase,
	type MissionState,
} from "../types.ts";
import { getMissionArtifactPaths } from "./context.ts";
import { getCellEngineStatus } from "./engine-wiring.ts";
import { loadMissionEvents } from "./events.ts";
import {
	DEFAULT_MISSION_GRAPH,
	getAvailableTransitions,
	renderGraphPosition,
	toMermaid,
} from "./graph.ts";
import { resolveCurrentMissionId, resolveMissionRoleStates, toSummary } from "./lifecycle.ts";
import { buildNarrative, renderNarrative } from "./narrative.ts";
import { writeMissionRuntimePointers } from "./runtime-context.ts";
import { computeMissionScore, renderMissionScore } from "./score.ts";
import { createMissionStore } from "./store.ts";

export function renderMissionNarrative(mission: Mission, overstoryDir: string): string {
	return renderNarrative(buildNarrative(mission, loadMissionEvents(overstoryDir, mission)));
}

// === ov mission status ===

export async function missionStatus(
	overstoryDir: string,
	json: boolean,
	missionId?: string,
): Promise<void> {
	const resolvedId = missionId ?? (await resolveCurrentMissionId(overstoryDir));
	if (!resolvedId) {
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
		const mission = missionStore.getById(resolvedId);
		if (!mission) {
			if (json) {
				jsonOutput("mission status", { mission: null, message: `Mission ${resolvedId} not found` });
			} else {
				printError("Mission not found in store", resolvedId);
			}
			process.exitCode = 1;
			return;
		}

		await writeMissionRuntimePointers(overstoryDir, mission.id, mission.runId);
		const roles = resolveMissionRoleStates(overstoryDir, mission);

		const missionScore = computeMissionScore(overstoryDir, mission);

		if (json) {
			const engineStatus = (() => {
				try {
					return getCellEngineStatus(mission, {
						checkpointStore: missionStore.checkpoints,
						missionStore,
					});
				} catch {
					return null;
				}
			})();
			const checkpoints = engineStatus ? missionStore.checkpoints.listCheckpoints(mission.id) : [];
			jsonOutput("mission status", {
				mission: toSummary(mission),
				roles,
				score: missionScore,
				engineStatus,
				checkpoints,
			});
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

		const engineStatus = (() => {
			try {
				return getCellEngineStatus(mission, {
					checkpointStore: missionStore.checkpoints,
					missionStore,
				});
			} catch {
				return null;
			}
		})();

		if (engineStatus) {
			process.stdout.write(`\n${renderSubHeader("Graph Execution")}\n`);
			process.stdout.write(`  Cell type:    ${engineStatus.cellType}\n`);
			process.stdout.write(`  Current node: ${accent(engineStatus.currentNodeId)}\n`);
			process.stdout.write(`  Transitions:  ${engineStatus.transitions.length}\n`);

			const last = engineStatus.transitions[engineStatus.transitions.length - 1];
			if (last) {
				process.stdout.write(
					`  Last:         ${last.fromNode} → ${last.toNode} via ${last.trigger}\n`,
				);
			}

			if (engineStatus.transitions.length > 0) {
				process.stdout.write(`\n  Recent transitions:\n`);
				const recent = engineStatus.transitions.slice(-5);
				for (const t of recent) {
					process.stdout.write(
						`    ${t.fromNode} → ${t.toNode} [${t.trigger}] at ${t.createdAt}\n`,
					);
				}
			}

			const checkpoints = missionStore.checkpoints.listCheckpoints(mission.id);
			if (checkpoints.length > 0) {
				process.stdout.write(`\n  Checkpoints: ${checkpoints.length}\n`);
				const latestCp = checkpoints[checkpoints.length - 1];
				if (latestCp) {
					const age = Date.now() - new Date(latestCp.createdAt).getTime();
					const ageSec = Math.round(age / 1000);
					process.stdout.write(
						`  Latest:      ${latestCp.nodeId} v${latestCp.version} (${ageSec}s ago)\n`,
					);
				}
			}
		}
	} finally {
		missionStore.close();
	}
}

// === ov mission output ===

export async function missionOutput(
	overstoryDir: string,
	json: boolean,
	missionId?: string,
): Promise<void> {
	const resolvedId = missionId ?? (await resolveCurrentMissionId(overstoryDir));
	if (!resolvedId) {
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
		const mission = missionStore.getById(resolvedId);
		if (!mission) {
			if (json) {
				jsonOutput("mission output", { mission: null });
			} else {
				printError("Mission not found in store", resolvedId);
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

// === ov mission artifacts ===

export async function missionArtifacts(
	overstoryDir: string,
	json: boolean,
	missionId?: string,
): Promise<void> {
	const resolvedId = missionId ?? (await resolveCurrentMissionId(overstoryDir));
	if (!resolvedId) {
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
		const mission = missionStore.getById(resolvedId);
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

// === ov mission graph ===

export async function missionGraph(
	overstoryDir: string,
	json: boolean,
	format: "text" | "mermaid" | "json",
	missionId?: string,
): Promise<void> {
	const resolvedId = missionId ?? (await resolveCurrentMissionId(overstoryDir));
	const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
	try {
		const mission = resolvedId ? missionStore.getById(resolvedId) : null;
		const graph = DEFAULT_MISSION_GRAPH;

		if (json || format === "json") {
			const transitions = mission
				? getAvailableTransitions(graph, mission.phase, mission.state)
				: [];
			jsonOutput("mission graph", {
				graph,
				currentNode: mission ? `${mission.phase}:${mission.state}` : null,
				availableTransitions: transitions.map((e) => ({
					to: e.to,
					trigger: e.trigger,
					condition: e.condition,
				})),
			});
			return;
		}

		if (format === "mermaid") {
			const output = toMermaid(graph, mission?.phase ?? undefined, mission?.state ?? undefined);
			console.log(output);
			return;
		}

		// Default: text format
		renderHeader("Mission Workflow Graph");
		if (mission) {
			const position = renderGraphPositionWithNode(
				graph,
				mission.phase,
				mission.state,
				mission.currentNode,
			);
			console.log(`\n  ${position}\n`);

			const transitions = getAvailableTransitions(graph, mission.phase, mission.state);
			if (transitions.length > 0) {
				renderSubHeader("Available transitions");
				for (const edge of transitions) {
					const desc = edge.condition ? ` (${edge.condition})` : "";
					console.log(`  ${edge.trigger} → ${edge.to}${desc}`);
				}
				console.log();
			}
			printHint("Note: align and decide phases auto-advance (placeholders)");
		} else {
			printHint("No active mission. Showing default lifecycle graph.");
			const position = renderGraphPosition(graph, "understand", "active");
			console.log(`\n  ${position}\n`);
		}
	} finally {
		missionStore.close();
	}
}

// === Local rendering helpers ===

const VALID_PHASES_SET = new Set<string>(MISSION_PHASES);

/**
 * Extends renderGraphPosition with an optional currentNode to show subgraph position.
 * If currentNode looks like a cell node (contains ":" but prefix is not a lifecycle phase),
 * appends it as a state annotation.
 */
function renderGraphPositionWithNode(
	graph: MissionGraph,
	currentPhase: MissionPhase,
	currentState: MissionState,
	currentNode?: string | null,
): string {
	const base = renderGraphPosition(graph, currentPhase, currentState);
	if (currentNode?.includes(":")) {
		const parsed = currentNode.split(":");
		const prefix = parsed[0];
		const isCell = !VALID_PHASES_SET.has(prefix ?? "");
		if (isCell) {
			return `${base}\n  ▶ ${currentNode}`;
		}
	}
	return base;
}
