/**
 * Mission lifecycle helpers: shared utility functions used across lifecycle modules.
 */

import type { Mission, MissionPhase, MissionState, MissionStore, MissionSummary } from "../types.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { resolveActiveMissionContext } from "./runtime-context.ts";
import { resolveMissionRoleStates as deriveMissionRoleStates } from "./runtime-context.ts";
import { DEFAULT_MISSION_GRAPH, nodeId, validateTransition } from "./graph.ts";
import { recordMissionEvent } from "./events.ts";

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
