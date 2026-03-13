/**
 * Helpers for mission-level event recording and event loading.
 */

import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import type { EventLevel, Mission, StoredEvent } from "../types.ts";

export interface MissionEventData {
	kind: string;
	missionId?: string;
	detail?: string;
	from?: string;
	to?: string;
	[key: string]: unknown;
}

export function recordMissionEvent(opts: {
	overstoryDir: string;
	mission: Pick<Mission, "id" | "runId">;
	agentName: string;
	data: MissionEventData;
	level?: EventLevel;
	sessionId?: string | null;
}): void {
	const store = createEventStore(join(opts.overstoryDir, "events.db"));
	try {
		store.insert({
			runId: opts.mission.runId,
			agentName: opts.agentName,
			sessionId: opts.sessionId ?? null,
			eventType: "mission",
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			level: opts.level ?? "info",
			data: JSON.stringify({ missionId: opts.mission.id, ...opts.data }),
		});
	} finally {
		store.close();
	}
}

export function loadMissionEvents(
	overstoryDir: string,
	mission: Pick<Mission, "runId">,
): StoredEvent[] {
	if (!mission.runId) {
		return [];
	}
	const store = createEventStore(join(overstoryDir, "events.db"));
	try {
		return store.getByRun(mission.runId);
	} finally {
		store.close();
	}
}
