/**
 * Persistent root agent lifecycle abstraction.
 *
 * Provides reusable start/stop/status/output lifecycle for persistent root
 * agents (coordinator, mission-analyst, execution-director, etc.) without
 * duplicating coordinator-specific logic.
 *
 * The coordinator, mission-analyst, and execution-director all run at the
 * project root (no worktree), persist across work batches, and follow the
 * same tmux-based lifecycle. This module extracts that shared lifecycle.
 *
 * What is NOT in this module (stays in coordinator.ts / caller):
 * - Watchdog/monitor/autopull management
 * - Attach-to-session logic
 * - Coordinator beacon text content
 * - check-complete / send / ask protocol
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { AgentError } from "../errors.ts";
import { isProcessRunning } from "../process/util.ts";
import { getRuntime } from "../runtimes/registry.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { createRunStore } from "../sessions/store.ts";
import type { AgentSession } from "../types.ts";
import type { SessionState } from "../worktree/tmux.ts";
import {
	capturePaneContent,
	checkSessionState,
	createSession,
	ensureTmuxAvailable,
	isSessionAlive,
	killSession,
	removeAgentEnvFile,
	sendKeys,
	waitForTuiReady,
} from "../worktree/tmux.ts";
import { createIdentity, loadIdentity } from "./identity.ts";
import { createManifestLoader, resolveModel } from "./manifest.ts";
import { BEACON_POLL_INTERVAL_MS, pollForStateChange } from "./spawn.ts";

// === Dependency Injection Interfaces ===

/** Tmux DI for testing (same shape as CoordinatorDeps._tmux). */
export interface PersistentAgentTmuxDeps {
	createSession: (
		name: string,
		cwd: string,
		command: string,
		env?: Record<string, string>,
	) => Promise<number>;
	isSessionAlive: (name: string) => Promise<boolean>;
	checkSessionState: (name: string) => Promise<SessionState>;
	killSession: (name: string) => Promise<void>;
	sendKeys: (name: string, keys: string) => Promise<void>;
	waitForTuiReady: (
		name: string,
		detectReady: (paneContent: string) => import("../runtimes/types.ts").ReadyState,
		timeoutMs?: number,
		pollIntervalMs?: number,
	) => Promise<boolean>;
	ensureTmuxAvailable: () => Promise<void>;
}

/** Capture DI for testing. */
export interface PersistentAgentCaptureDeps {
	capturePaneContent: (name: string, lines?: number) => Promise<string | null>;
}

// === Parameter / Result Interfaces ===

/** Options for starting a persistent root agent. */
export interface StartPersistentAgentOpts {
	/** Agent name (e.g. 'coordinator', 'mission-analyst'). */
	agentName: string;
	/** Agent capability string (e.g. 'coordinator', 'mission-analyst'). */
	capability: string;
	/** Absolute path to the project root. */
	projectRoot: string;
	/** Absolute path to the .overstory directory. */
	overstoryDir: string;
	/** Tmux session name (caller is responsible for uniqueness). */
	tmuxSession: string;
	/** Whether to create a new run for this agent. */
	createRun: boolean;
	/** Link to an existing run ID instead of creating a new one (createRun ignored when set). */
	existingRunId?: string;
	/** Coordinator name to associate with the run (defaults to agentName). */
	coordinatorName?: string;
	/** Beacon message to send after TUI is ready. Leave undefined to skip. */
	beacon?: string;
	/** Delays (ms) between follow-up Enter presses after beacon. Default: [1000, 2000, 3000, 5000]. */
	beaconDelays?: number[];
	/** Shell init delay ms (from config.runtime.shellInitDelayMs). */
	shellInitDelayMs?: number;
	/** Inline system prompt suffix override for this session. */
	appendSystemPrompt?: string;
	/** System prompt file override for this session. */
	appendSystemPromptFile?: string;
}

/** Result from starting a persistent root agent. */
export interface StartPersistentAgentResult {
	/** The recorded session. */
	session: AgentSession;
	/** The run ID created or linked, or null if no run was created. */
	runId: string | null;
	/** The PID of the spawned process. */
	pid: number;
}

/** Result from stopping a persistent root agent. */
export interface StopPersistentAgentResult {
	/** Whether the tmux session was killed. */
	sessionKilled: boolean;
	/** Session ID that was stopped. */
	sessionId: string;
	/** Whether the associated run was completed. */
	runCompleted: boolean;
}

/** Status of a persistent root agent. */
export interface PersistentAgentStatus {
	/** Whether the tmux session is alive. */
	running: boolean;
	/** Session record from the store. */
	sessionId: string;
	/** Reconciled state (may differ from stored if session died). */
	state: string;
	/** Tmux session name. */
	tmuxSession: string;
	/** PID of the agent process. */
	pid: number | null;
	/** When the session started. */
	startedAt: string;
	/** When the session was last active. */
	lastActivity: string;
}

// === Core Lifecycle Functions ===

/**
 * Start a persistent root agent.
 *
 * Generic lifecycle: checks for existing session, resolves model/runtime,
 * deploys hooks, creates identity, spawns tmux session, creates run,
 * records session, waits for TUI ready, sends beacon.
 *
 * Coordinator-specific extras (watchdog, monitor, autopull, attach) must
 * be handled by the caller after this function returns.
 */
export async function startPersistentAgent(
	opts: StartPersistentAgentOpts,
	tmuxDeps?: PersistentAgentTmuxDeps,
): Promise<StartPersistentAgentResult> {
	const tmux = tmuxDeps ?? {
		createSession,
		isSessionAlive,
		checkSessionState,
		killSession,
		sendKeys,
		waitForTuiReady,
		ensureTmuxAvailable,
	};

	const {
		agentName,
		capability,
		projectRoot,
		overstoryDir,
		tmuxSession,
		createRun: shouldCreateRun,
		existingRunId,
		coordinatorName,
		beacon,
		beaconDelays = [1_000, 2_000, 3_000, 5_000],
		shellInitDelayMs = 0,
		appendSystemPrompt,
		appendSystemPromptFile: customAppendSystemPromptFile,
	} = opts;

	const { store } = openSessionStore(overstoryDir);
	try {
		const existing = store.getByName(agentName);
		if (existing) {
			const sessionState = await tmux.checkSessionState(existing.tmuxSession);
			const tmuxAlive = sessionState === "alive";
			const processRunning = existing.pid !== null && isProcessRunning(existing.pid);

			if (existing.state === "completed" || existing.state === "zombie") {
				if (tmuxAlive) {
					await tmux.killSession(existing.tmuxSession);
				}
				store.updateState(agentName, "completed");
			} else if (tmuxAlive) {
				// Tmux session exists — check whether the process inside is still running.
				// A crashed process leaves a zombie tmux pane that blocks retries.
				if (existing.pid === null) {
					throw new AgentError(
						`${capability} agent '${agentName}' is already running (tmux: ${existing.tmuxSession}, since: ${existing.startedAt})`,
						{ agentName },
					);
				}
				if (!processRunning) {
					// Zombie: kill the empty session and reclaim the slot.
					await tmux.killSession(existing.tmuxSession);
					store.updateState(agentName, "completed");
				} else {
					throw new AgentError(
						`${capability} agent '${agentName}' is already running (tmux: ${existing.tmuxSession}, since: ${existing.startedAt})`,
						{ agentName },
					);
				}
			} else {
				// Session is dead or tmux server is not running — clean up stale entry.
				store.updateState(agentName, "completed");
			}
		}

		// Load config and resolve model + runtime for this capability
		const config = await loadConfig(projectRoot);
		const manifestLoader = createManifestLoader(
			join(projectRoot, config.agents.manifestPath),
			join(projectRoot, config.agents.baseDir),
		);
		const manifest = await manifestLoader.load();
		const resolvedModel = resolveModel(config, manifest, capability, "opus");
		const runtime = getRuntime(undefined, config, capability);

		// Deploy hooks config to the project root for this agent.
		// The ENV_GUARD prefix ensures hooks only activate inside this agent's
		// tmux session (when OVERSTORY_AGENT_NAME is set), not the user's session.
		await runtime.deployConfig(projectRoot, undefined, {
			agentName,
			capability,
			worktreePath: projectRoot,
		});

		// Create or load persistent identity for this agent
		const identityBaseDir = join(overstoryDir, "agents");
		await mkdir(identityBaseDir, { recursive: true });
		const existingIdentity = await loadIdentity(identityBaseDir, agentName);
		if (!existingIdentity) {
			await createIdentity(identityBaseDir, {
				name: agentName,
				capability,
				created: new Date().toISOString(),
				sessionsCompleted: 0,
				expertiseDomains: config.mulch.enabled ? config.mulch.domains : [],
				recentTasks: [],
			});
		}

		// Preflight: verify tmux is installed before attempting to spawn
		await tmux.ensureTmuxAvailable();

		// Build spawn command and launch the tmux session
		let appendSystemPromptFile = customAppendSystemPromptFile;
		if (!appendSystemPromptFile && appendSystemPrompt === undefined) {
			const agentDefPath = join(overstoryDir, "agent-defs", `${capability}.md`);
			const agentDefFile = Bun.file(agentDefPath);
			if (await agentDefFile.exists()) {
				appendSystemPromptFile = agentDefPath;
			}
		}
		const runtimeSessionId = crypto.randomUUID();
		const agentEnv = {
			...runtime.buildEnv(resolvedModel),
			OVERSTORY_AGENT_NAME: agentName,
			OVERSTORY_CAPABILITY: capability,
			OVERSTORY_RUNTIME_SESSION_ID: runtimeSessionId,
		};
		const spawnCmd = runtime.buildSpawnCommand({
			model: resolvedModel.model,
			permissionMode: "bypass",
			sessionId: runtimeSessionId,
			cwd: projectRoot,
			appendSystemPrompt,
			appendSystemPromptFile,
			env: agentEnv,
		});
		const pid = await tmux.createSession(tmuxSession, projectRoot, spawnCmd, agentEnv);

		// Generate session ID shared between the session record and the run record
		const sessionId = `session-${Date.now()}-${agentName}`;

		// Create a run or link to an existing one
		let runId: string | null = existingRunId ?? null;
		if (shouldCreateRun && !existingRunId) {
			runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
			const runStore = createRunStore(join(overstoryDir, "sessions.db"));
			try {
				runStore.createRun({
					id: runId,
					startedAt: new Date().toISOString(),
					coordinatorSessionId: sessionId,
					coordinatorName: coordinatorName ?? agentName,
					status: "active",
				});
			} finally {
				runStore.close();
			}
			// Write current-run.txt for ov sling and other consumers
			await Bun.write(join(overstoryDir, "current-run.txt"), runId);
		}

		// Record session BEFORE sending beacon so hook-triggered updateLastActivity()
		// can find the entry and transition booting->working (overstory-036f).
		const session: AgentSession = {
			id: sessionId,
			agentName,
			capability,
			runtime: runtime.id,
			worktreePath: projectRoot,
			branchName: config.project.canonicalBranch,
			taskId: "",
			tmuxSession,
			state: "booting",
			pid,
			parentAgent: null,
			depth: 0,
			runId,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
			rateLimitedSince: null,
			runtimeSessionId,
			transcriptPath: null,
			originalRuntime: null,
			statusLine: null,
		};
		store.upsert(session);

		// Give slow shells time to finish initializing before polling for TUI readiness
		if (shellInitDelayMs > 0) {
			await Bun.sleep(shellInitDelayMs);
		}

		// Wait for TUI to render before sending input
		const tuiReady = await tmux.waitForTuiReady(tmuxSession, (content) =>
			runtime.detectReady(content),
		);
		if (!tuiReady) {
			const alive = await tmux.isSessionAlive(tmuxSession);
			if (!alive) {
				store.updateState(agentName, "completed");
				const state = await tmux.checkSessionState(tmuxSession);
				const detail =
					state === "no_server"
						? "The tmux server is no longer running. It may have crashed or been killed externally."
						: "The Claude Code process may have crashed or exited immediately. Check tmux logs or try running the claude command manually.";
				throw new AgentError(
					`${capability} tmux session "${tmuxSession}" died during startup. ${detail}`,
					{ agentName },
				);
			}
			await tmux.killSession(tmuxSession);
			store.updateState(agentName, "completed");
			throw new AgentError(
				`${capability} tmux session "${tmuxSession}" did not become ready during startup. Claude Code may still be waiting on an interactive dialog or initializing too slowly.`,
				{ agentName },
			);
		}
		await Bun.sleep(1_000);

		// Send beacon if provided, then adaptive follow-up Enters
		if (beacon !== undefined) {
			await tmux.sendKeys(tmuxSession, beacon);
			for (const timeout of beaconDelays) {
				const departed = await pollForStateChange(
					{ capturePaneContent },
					tmuxSession,
					runtime,
					timeout,
					BEACON_POLL_INTERVAL_MS,
				);
				if (departed) break;
				await tmux.sendKeys(tmuxSession, "");
			}
		}

		return { session, runId, pid };
	} finally {
		store.close();
	}
}

/**
 * Stop a persistent root agent.
 *
 * Kills the tmux session, marks the session completed, and completes
 * the associated run. Caller is responsible for stopping ancillary
 * processes (watchdog, monitor, autopull) before or after calling this.
 */
export async function stopPersistentAgent(
	agentName: string,
	opts: {
		projectRoot: string;
		overstoryDir: string;
		runStatus?: "completed" | "stopped";
		completeRun?: boolean;
	},
	tmuxDeps?: PersistentAgentTmuxDeps,
): Promise<StopPersistentAgentResult> {
	const tmux = tmuxDeps ?? {
		createSession,
		isSessionAlive,
		checkSessionState,
		killSession,
		sendKeys,
		waitForTuiReady,
		ensureTmuxAvailable,
	};

	const { overstoryDir } = opts;
	const { store } = openSessionStore(overstoryDir);
	try {
		const session = store.getByName(agentName);

		if (!session || session.state === "completed" || session.state === "zombie") {
			throw new AgentError(`No active session found for agent '${agentName}'`, { agentName });
		}

		// Kill tmux session with process tree cleanup
		let sessionKilled = false;
		const alive = await tmux.isSessionAlive(session.tmuxSession);
		if (alive) {
			await tmux.killSession(session.tmuxSession);
			sessionKilled = true;
		}

		// Clean up session-scoped .agent-env file for this agent only.
		// Pass runtimeSessionId so only this role's file is removed,
		// leaving other active root roles' files intact.
		removeAgentEnvFile(opts.projectRoot, session.runtimeSessionId ?? undefined);

		// Update session state
		store.updateState(agentName, "completed");
		store.updateLastActivity(agentName);

		// Record successful stop in resilience circuit breaker
		try {
			const { createResilienceStore } = await import("../resilience/store.ts");
			const { recordSuccess } = await import("../resilience/circuit-breaker.ts");
			const resStore = createResilienceStore(join(overstoryDir, "resilience.db"));
			try {
				recordSuccess(resStore, session.capability);
			} finally {
				resStore.close();
			}
		} catch { /* resilience recording is non-fatal */ }

		// Resolve runId: prefer session field, fall back to current-run.txt
		const currentRunPath = join(overstoryDir, "current-run.txt");
		let resolvedRunId: string | null = session.runId ?? null;
		if (!resolvedRunId) {
			try {
				const currentRunFile = Bun.file(currentRunPath);
				if (await currentRunFile.exists()) {
					const text = (await currentRunFile.text()).trim();
					if (text.length > 0) {
						resolvedRunId = text;
					}
				}
			} catch {
				// Non-fatal
			}
		}

		// Complete the run and clean up current-run.txt
		let runCompleted = false;
		if (resolvedRunId && opts.completeRun !== false) {
			try {
				const runStore = createRunStore(join(overstoryDir, "sessions.db"));
				try {
					runStore.completeRun(resolvedRunId, opts.runStatus ?? "stopped");
					runCompleted = true;
				} finally {
					runStore.close();
				}

				// Clear current-run.txt if it points to the resolved run
				try {
					const currentRunFile = Bun.file(currentRunPath);
					if (await currentRunFile.exists()) {
						const currentRunId = (await currentRunFile.text()).trim();
						if (currentRunId === resolvedRunId) {
							const { unlink } = await import("node:fs/promises");
							await unlink(currentRunPath);
						}
					}
				} catch {
					// File may already be gone — not an error
				}
			} catch {
				// Non-fatal: run completion should not break the stop
			}
		}

		return { sessionKilled, sessionId: session.id, runCompleted };
	} finally {
		store.close();
	}
}

/**
 * Get the status of a persistent root agent.
 *
 * Checks session liveness, reconciles zombie state, and returns a status
 * object. Caller can augment with capability-specific fields (e.g.
 * watchdogRunning) before returning to the user.
 */
export async function getPersistentAgentStatus(
	agentName: string,
	opts: { projectRoot: string; overstoryDir: string },
	tmuxDeps?: PersistentAgentTmuxDeps,
): Promise<PersistentAgentStatus | null> {
	const tmux = tmuxDeps ?? {
		createSession,
		isSessionAlive,
		checkSessionState,
		killSession,
		sendKeys,
		waitForTuiReady,
		ensureTmuxAvailable,
	};

	const { overstoryDir } = opts;
	const { store } = openSessionStore(overstoryDir);
	try {
		const session = store.getByName(agentName);

		if (!session || session.state === "completed" || session.state === "zombie") {
			return null;
		}

		const alive = await tmux.isSessionAlive(session.tmuxSession);

		// Reconcile state: if session says active but tmux is dead, mark as zombie
		if (!alive) {
			store.updateState(agentName, "zombie");
			store.updateLastActivity(agentName);
			session.state = "zombie";
		}

		return {
			running: alive,
			sessionId: session.id,
			state: session.state,
			tmuxSession: session.tmuxSession,
			pid: session.pid,
			startedAt: session.startedAt,
			lastActivity: session.lastActivity,
		};
	} finally {
		store.close();
	}
}

/**
 * Read output from a persistent root agent.
 *
 * For tmux-based agents: captures pane content.
 * For headless agents (tmuxSession=''): reads stdout.log.
 * Returns null if no content is available or the session is not found.
 */
export async function readPersistentAgentOutput(
	agentName: string,
	opts: { projectRoot: string; overstoryDir: string; lines?: number },
	captureDeps?: PersistentAgentCaptureDeps,
): Promise<string | null> {
	const capture = captureDeps ?? { capturePaneContent };
	const { overstoryDir, lines = 100 } = opts;

	const { store } = openSessionStore(overstoryDir);
	let tmuxSessionName: string | undefined;
	try {
		const session = store.getByName(agentName);

		if (!session || session.state === "completed" || session.state === "zombie") {
			return null;
		}

		tmuxSessionName = session.tmuxSession;

		// Headless path: read stdout.log
		if (tmuxSessionName === "") {
			const logsDir = join(overstoryDir, "logs", agentName);
			const stdoutPath = join(logsDir, "stdout.log");
			const stdoutFile = Bun.file(stdoutPath);
			if (!(await stdoutFile.exists())) {
				return null;
			}
			const text = await stdoutFile.text();
			// Return last `lines` lines
			const allLines = text.split("\n");
			return allLines.slice(-lines).join("\n");
		}
	} finally {
		store.close();
	}

	// Tmux path: capture pane content
	if (tmuxSessionName === undefined) {
		return null;
	}
	return capture.capturePaneContent(tmuxSessionName, lines);
}
