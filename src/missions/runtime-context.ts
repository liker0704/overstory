import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSession, Mission, MissionStore } from "../types.ts";
import { createMissionStore } from "./store.ts";

export interface ActiveMissionContext {
	missionId: string;
	runId: string | null;
}

export interface MissionRoleStates {
	coordinator: string;
	analyst: string;
	executionDirector: string;
}

export function currentMissionPointerPath(overstoryDir: string): string {
	return join(overstoryDir, "current-mission.txt");
}

export function currentRunPointerPath(overstoryDir: string): string {
	return join(overstoryDir, "current-run.txt");
}

export async function readCurrentMissionPointer(overstoryDir: string): Promise<string | null> {
	const file = Bun.file(currentMissionPointerPath(overstoryDir));
	if (!(await file.exists())) {
		return null;
	}
	const text = (await file.text()).trim();
	return text.length > 0 ? text : null;
}

export async function readCurrentRunPointer(overstoryDir: string): Promise<string | null> {
	const file = Bun.file(currentRunPointerPath(overstoryDir));
	if (!(await file.exists())) {
		return null;
	}
	const text = (await file.text()).trim();
	return text.length > 0 ? text : null;
}

export async function writeMissionRuntimePointers(
	overstoryDir: string,
	missionId: string,
	runId: string | null,
): Promise<void> {
	await Bun.write(currentMissionPointerPath(overstoryDir), `${missionId}\n`);
	if (runId) {
		await Bun.write(currentRunPointerPath(overstoryDir), `${runId}\n`);
	}
}

export async function clearMissionRuntimePointers(overstoryDir: string): Promise<void> {
	for (const path of [
		currentMissionPointerPath(overstoryDir),
		currentRunPointerPath(overstoryDir),
	]) {
		try {
			await unlink(path);
		} catch {
			// Pointer may already be absent.
		}
	}
}

export async function resolveActiveMissionContext(
	overstoryDir: string,
): Promise<ActiveMissionContext | null> {
	const pointedMissionId = await readCurrentMissionPointer(overstoryDir);
	const pointedRunId = await readCurrentRunPointer(overstoryDir);
	const dbPath = join(overstoryDir, "sessions.db");
	const dbFile = Bun.file(dbPath);
	if (pointedMissionId && !(await dbFile.exists())) {
		return {
			missionId: pointedMissionId,
			runId: pointedRunId,
		};
	}
	if (!(await dbFile.exists())) {
		return null;
	}

	const missionStore = createMissionStore(dbPath);
	try {
		if (pointedMissionId) {
			const pointedMission = missionStore.getById(pointedMissionId);
			if (
				pointedMission &&
				(pointedMission.state === "active" || pointedMission.state === "frozen")
			) {
				if (!pointedRunId && pointedMission.runId) {
					await writeMissionRuntimePointers(overstoryDir, pointedMission.id, pointedMission.runId);
				}
				return {
					missionId: pointedMission.id,
					runId: pointedMission.runId ?? pointedRunId,
				};
			}
		}

		const activeList = missionStore.getActiveList();
		if (activeList.length === 0) {
			return null;
		}
		if (activeList.length > 1) {
			const listing = activeList.map((m) => `  - ${m.id} (${m.slug})`).join("\n");
			throw new Error(
				`Multiple active missions found. Specify --mission to disambiguate:\n${listing}`,
			);
		}
		const active = activeList[0]!;
		await writeMissionRuntimePointers(overstoryDir, active.id, active.runId);
		return { missionId: active.id, runId: active.runId };
	} finally {
		missionStore.close();
	}
}

export function roleRuntimeState(
	allSessions: Array<{ id: string; state: string }>,
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

function roleRuntimeStateFromSession(session: Pick<AgentSession, "state"> | null): string {
	if (!session) return "not started";
	if (session.state === "completed" || session.state === "zombie") {
		return "stopped";
	}
	return "running";
}

export function resolveMissionByIdOrSlug(idOrSlug: string, missionStore: MissionStore): string {
	const byId = missionStore.getById(idOrSlug);
	if (byId) return byId.id;
	const bySlug = missionStore.getBySlug(idOrSlug);
	if (bySlug) return bySlug.id;
	throw new Error(`Mission not found: ${idOrSlug}`);
}

export function resolveMissionRoleStates(
	mission: Mission,
	sessions: AgentSession[],
): MissionRoleStates {
	const coordinatorSession =
		(mission.coordinatorSessionId
			? sessions.find((session) => session.id === mission.coordinatorSessionId)
			: null) ??
		sessions.find((session) => session.agentName === "coordinator") ??
		null;
	return {
		coordinator: roleRuntimeStateFromSession(coordinatorSession),
		analyst: roleRuntimeState(sessions, mission.analystSessionId),
		executionDirector: roleRuntimeState(sessions, mission.executionDirectorSessionId),
	};
}
