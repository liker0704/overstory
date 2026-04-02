/**
 * Mission suspend operation: kill tmux sessions but preserve state for resume.
 */

import { join } from "node:path";
import { printSuccess } from "../logging/color.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { Mission } from "../types.ts";
import { isSessionAlive, killProcessTree, killSession } from "../worktree/tmux.ts";
import { recordMissionEvent } from "./events.ts";
import { adviseGraphTransition } from "./lifecycle-helpers.ts";
import { createMissionStore } from "./store.ts";

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
