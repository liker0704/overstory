/**
 * Mission role lifecycle management.
 *
 * Wraps the persistent-root abstraction for mission-coordinator,
 * mission-analyst, and execution-director agents. All roles run at the
 * project root (no worktree), are linked to the mission's run, and follow
 * the same tmux-based lifecycle.
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
	/** Optional role-specific prompt file override. */
	appendSystemPromptFile?: string;
	/** Optional inline prompt suffix override. */
	appendSystemPrompt?: string;
	/** Optional startup beacon. */
	beacon?: string;
}

/** Options for stopping a mission role. */
export interface StopMissionRoleOpts {
	/** Absolute path to the project root. */
	projectRoot: string;
	/** Absolute path to the .overstory directory. */
	overstoryDir: string;
	/** Whether stopping this role should also complete the shared run. */
	completeRun?: boolean;
	/** Shared run terminal status when completeRun is enabled. */
	runStatus?: "completed" | "stopped";
}

/** Internal dependency injection — used in tests to avoid real tmux and store I/O. */
export interface MissionRoleDeps {
	startAgent?: (opts: StartPersistentAgentOpts) => Promise<StartPersistentAgentResult>;
	stopAgent?: (
		agentName: string,
		opts: {
			projectRoot: string;
			overstoryDir: string;
			runStatus?: "completed" | "stopped";
			completeRun?: boolean;
		},
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
		appendSystemPromptFile: opts.appendSystemPromptFile,
		appendSystemPrompt: opts.appendSystemPrompt,
		beacon: opts.beacon,
	});

	const store = storeFactory(join(opts.overstoryDir, "sessions.db"));
	try {
		const mission = store.getById(opts.missionId);
		if (!mission) {
			throw new AgentError(`Mission not found: ${opts.missionId}`, {
				agentName: "mission-analyst",
			});
		}
		store.bindSessions(opts.missionId, { analystSessionId: result.session.id });
	} finally {
		store.close();
	}

	return result;
}

/**
 * Start the mission coordinator persistent root agent.
 *
 * Calls startPersistentAgent with capability='coordinator-mission', links the
 * resulting session to the mission via MissionStore.bindCoordinatorSession,
 * and returns the start result. The agent name is 'coordinator' (reusing the
 * existing coordinator slot), but the capability selects the mission-specific
 * prompt definition.
 */
export async function startMissionCoordinator(
	opts: StartMissionRoleOpts,
	_deps?: MissionRoleDeps,
): Promise<StartPersistentAgentResult> {
	const startAgent = _deps?.startAgent ?? startPersistentAgent;
	const storeFactory = _deps?.createStore ?? createMissionStore;

	const result = await startAgent({
		agentName: "coordinator",
		capability: "coordinator-mission",
		projectRoot: opts.projectRoot,
		overstoryDir: opts.overstoryDir,
		tmuxSession: "ov-mission-coordinator",
		createRun: false,
		existingRunId: opts.existingRunId,
		appendSystemPromptFile: opts.appendSystemPromptFile,
		appendSystemPrompt: opts.appendSystemPrompt,
		beacon: opts.beacon,
	});

	const store = storeFactory(join(opts.overstoryDir, "sessions.db"));
	try {
		const mission = store.getById(opts.missionId);
		if (!mission) {
			throw new AgentError(`Mission not found: ${opts.missionId}`, { agentName: "coordinator" });
		}
		store.bindCoordinatorSession(opts.missionId, result.session.id);
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
		appendSystemPromptFile: opts.appendSystemPromptFile,
		appendSystemPrompt: opts.appendSystemPrompt,
		beacon: opts.beacon,
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
 * Start the plan-review-lead persistent root agent.
 *
 * Spawned during the plan phase to coordinate critic agents. Unlike other
 * mission roles, the plan-review-lead is ephemeral — it runs only during
 * plan review and is stopped after the review completes. It does NOT bind
 * to a mission session column (no dedicated DB field).
 */
export async function startPlanReviewLead(
	opts: StartMissionRoleOpts,
	_deps?: MissionRoleDeps,
): Promise<StartPersistentAgentResult> {
	const startAgent = _deps?.startAgent ?? startPersistentAgent;

	return startAgent({
		agentName: "plan-review-lead",
		capability: "plan-review-lead",
		projectRoot: opts.projectRoot,
		overstoryDir: opts.overstoryDir,
		tmuxSession: "ov-plan-review-lead",
		createRun: false,
		existingRunId: opts.existingRunId,
		appendSystemPromptFile: opts.appendSystemPromptFile,
		appendSystemPrompt: opts.appendSystemPrompt,
		beacon: opts.beacon,
	});
}

/**
 * Stop the plan-review-lead agent.
 *
 * Convenience wrapper around stopMissionRole for the plan-review-lead.
 */
export async function stopPlanReviewLead(
	opts: StopMissionRoleOpts,
	_deps?: MissionRoleDeps,
): Promise<StopPersistentAgentResult> {
	const stopAgent = _deps?.stopAgent ?? stopPersistentAgent;
	return stopAgent("plan-review-lead", {
		projectRoot: opts.projectRoot,
		overstoryDir: opts.overstoryDir,
		runStatus: opts.runStatus ?? "stopped",
		completeRun: false,
	});
}

/**
 * Stop a mission role agent (coordinator, mission-analyst, or execution-director).
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
		runStatus: opts.runStatus ?? "stopped",
		completeRun: opts.completeRun,
	});
}

/**
 * Stop all descendant agents for a mission run, excluding specified agent names.
 * Stops in reverse depth order (deepest first).
 */
export async function stopMissionRunDescendants(opts: {
	overstoryDir: string;
	projectRoot: string;
	runId: string | null;
	excludedAgentNames: ReadonlySet<string>;
	stopAgentCommand: (agentName: string, opts: { force: boolean }) => Promise<void>;
}): Promise<string[]> {
	if (!opts.runId) {
		return [];
	}

	const { openSessionStore } = await import("../sessions/compat.ts");
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
