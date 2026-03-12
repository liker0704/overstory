/**
 * Mission role lifecycle management.
 *
 * Wraps the persistent-root abstraction for mission-analyst and
 * execution-director agents. Both roles run at the project root (no worktree),
 * are linked to the mission's run, and follow the same tmux-based lifecycle.
 */

import { join } from "node:path";
import type {
	StartPersistentAgentOpts,
	StartPersistentAgentResult,
	StopPersistentAgentResult,
} from "../agents/persistent-root.ts";
import { startPersistentAgent, stopPersistentAgent } from "../agents/persistent-root.ts";
import { AgentError } from "../errors.ts";
import type { MissionStore } from "../types.ts";
import { createMissionStore } from "./store.ts";

// === Interfaces ===

/** Options for starting a mission role (analyst or execution-director). */
export interface StartMissionRoleOpts {
	/** Mission ID to bind the session to. */
	missionId: string;
	/** Absolute path to the project root. */
	projectRoot: string;
	/** Absolute path to the .overstory directory. */
	overstoryDir: string;
	/** Mission-owned run ID to link the agent to. */
	existingRunId: string;
}

/** Options for stopping a mission role. */
export interface StopMissionRoleOpts {
	/** Absolute path to the project root. */
	projectRoot: string;
	/** Absolute path to the .overstory directory. */
	overstoryDir: string;
}

/** Internal dependency injection — used in tests to avoid real tmux and store I/O. */
export interface MissionRoleDeps {
	startAgent?: (opts: StartPersistentAgentOpts) => Promise<StartPersistentAgentResult>;
	stopAgent?: (
		agentName: string,
		opts: { projectRoot: string; overstoryDir: string; runStatus?: "completed" | "stopped" },
	) => Promise<StopPersistentAgentResult>;
	createStore?: (dbPath: string) => MissionStore;
}

// === Role Lifecycle ===

/**
 * Start the mission-analyst persistent root agent.
 *
 * Calls startPersistentAgent with capability='mission-analyst', links the
 * resulting session to the mission via MissionStore.bindSessions, and returns
 * the start result.
 */
export async function startMissionAnalyst(
	opts: StartMissionRoleOpts,
	_deps?: MissionRoleDeps,
): Promise<StartPersistentAgentResult> {
	const startAgent = _deps?.startAgent ?? startPersistentAgent;
	const storeFactory = _deps?.createStore ?? createMissionStore;

	const result = await startAgent({
		agentName: "mission-analyst",
		capability: "mission-analyst",
		projectRoot: opts.projectRoot,
		overstoryDir: opts.overstoryDir,
		tmuxSession: "ov-mission-analyst",
		createRun: false,
		existingRunId: opts.existingRunId,
	});

	const store = storeFactory(join(opts.overstoryDir, "sessions.db"));
	try {
		const mission = store.getById(opts.missionId);
		if (!mission) {
			throw new AgentError(`Mission not found: ${opts.missionId}`, { agentName: "mission-analyst" });
		}
		store.bindSessions(opts.missionId, { analystSessionId: result.session.id });
	} finally {
		store.close();
	}

	return result;
}

/**
 * Start the execution-director persistent root agent.
 *
 * Calls startPersistentAgent with capability='execution-director', links the
 * resulting session to the mission via MissionStore.bindSessions, and returns
 * the start result.
 */
export async function startExecutionDirector(
	opts: StartMissionRoleOpts,
	_deps?: MissionRoleDeps,
): Promise<StartPersistentAgentResult> {
	const startAgent = _deps?.startAgent ?? startPersistentAgent;
	const storeFactory = _deps?.createStore ?? createMissionStore;

	const result = await startAgent({
		agentName: "execution-director",
		capability: "execution-director",
		projectRoot: opts.projectRoot,
		overstoryDir: opts.overstoryDir,
		tmuxSession: "ov-execution-director",
		createRun: false,
		existingRunId: opts.existingRunId,
	});

	const store = storeFactory(join(opts.overstoryDir, "sessions.db"));
	try {
		const mission = store.getById(opts.missionId);
		if (!mission) {
			throw new AgentError(`Mission not found: ${opts.missionId}`, {
				agentName: "execution-director",
			});
		}
		store.bindSessions(opts.missionId, {
			executionDirectorSessionId: result.session.id,
		});
	} finally {
		store.close();
	}

	return result;
}

/**
 * Stop a mission role agent (mission-analyst or execution-director).
 *
 * Calls stopPersistentAgent with the given agent name and returns the result.
 */
export async function stopMissionRole(
	agentName: string,
	opts: StopMissionRoleOpts,
	_deps?: MissionRoleDeps,
): Promise<StopPersistentAgentResult> {
	const stopAgent = _deps?.stopAgent ?? stopPersistentAgent;
	return stopAgent(agentName, {
		projectRoot: opts.projectRoot,
		overstoryDir: opts.overstoryDir,
		runStatus: "stopped",
	});
}
