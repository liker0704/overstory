/**
 * Mission lifecycle helpers: shared utility functions used across lifecycle modules.
 */

import { openSessionStore } from "../sessions/compat.ts";
import type { Mission, MissionSummary } from "../types.ts";
import {
	resolveMissionRoleStates as deriveMissionRoleStates,
	resolveActiveMissionContext,
} from "./runtime-context.ts";

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
