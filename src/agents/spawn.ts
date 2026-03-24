/**
 * Spawn orchestration service extracted from sling.ts.
 *
 * Handles steps 7-14 of the agent spawn pipeline:
 *   7. Create worktree
 *   8. Generate + write overlay CLAUDE.md (including mulch/canopy)
 *   9. Deploy hooks config + send auto-dispatch mail
 *  10. Claim tracker issue
 *  11. Create agent identity + save applied mulch records
 *  12. Create tmux session (or headless subprocess)
 *  13. Record session in SessionStore + increment run agent count
 *  14. Return result (or verify beacon for interactive runtimes)
 *
 * Rollback ownership: spawn() wraps steps 7-14 in try/catch and
 * calls rollbackWorktree() on failure before re-throwing.
 *
 * Session-before-beacon ordering: session record is persisted before
 * the beacon is sent (per overstory-036f).
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CanopyClient } from "../canopy/client.ts";
import { renderCompactContext } from "../commands/prime.ts";
import {
	buildAutoDispatch,
	buildBeacon,
	extractMulchRecordIds,
	getCurrentBranch,
	getSharedWritableDirs,
	inferDomainsFromFiles,
} from "../commands/sling.ts";
import type { OverstoryConfig } from "../config-types.ts";
import type { ProjectContext } from "../context/types.ts";
import { AgentError } from "../errors.ts";
import type { MailClient } from "../mail/client.ts";
import type { MailStore } from "../mail/store.ts";
import type { MulchClient } from "../mulch/client.ts";
import type { AgentRuntime } from "../runtimes/types.ts";
import type { SessionStore } from "../sessions/store.ts";
import type { RunStore } from "../sessions/types.ts";
import type { TrackerClient } from "../tracker/types.ts";
import type { AgentSession, OverlayConfig } from "../types.ts";
import { createWorktree, rollbackWorktree } from "../worktree/manager.ts";
import { spawnHeadlessAgent } from "../worktree/process.ts";
import { createIdentity, loadIdentity } from "./identity.ts";
import type { ManifestLoader } from "./manifest.ts";
import { resolveModel } from "./manifest.ts";
import { writeOverlay } from "./overlay.ts";
import type { AgentDefinition, AgentManifest } from "./types.ts";

// === Types ===

/** Options for the spawn pipeline (steps 7-14). */
export interface SpawnOptions {
	/** Resolved agent name (unique, post-dedup). */
	name: string;
	capability: string;
	/** Resolved capability (may differ from capability in mission mode). */
	resolvedCapability: string;
	taskId: string;
	/** Absolute path to the spec file, or null. */
	specPath: string | null;
	fileScope: string[];
	parentAgent: string | null;
	depth: number;
	runId: string;
	/** Whether to skip scout for lead agents. */
	skipScout: boolean;
	/** Whether to skip review for lead agents. */
	skipReview: boolean;
	/** Per-lead max agents override from dispatch. */
	dispatchMaxAgents: number | undefined;
	/** Base branch for worktree creation. Falls back to current HEAD or config. */
	baseBranch: string | undefined;
	/** Canopy profile name for prompt overlay. */
	profile: string | undefined;
	/** Runtime adapter name override. */
	runtimeName: string | undefined;
	/** Whether to skip task existence check. */
	skipTaskCheck: boolean;
	/** JSON output mode. */
	json: boolean;
	/** Mission slug for worktree isolation. */
	missionSlug?: string;
}

/** Result of a successful spawn. */
export interface SpawnResult {
	agentName: string;
	capability: string;
	taskId: string;
	branchName: string;
	worktreePath: string;
	tmuxSession: string;
	pid: number | null;
}

/** Tmux operations needed by the spawn pipeline. */
export interface TmuxOps {
	ensureTmuxAvailable(): Promise<void>;
	createSession(
		name: string,
		cwd: string,
		cmd: string,
		env: Record<string, string>,
	): Promise<number>;
	waitForTuiReady(
		name: string,
		detect: (content: string) => ReturnType<AgentRuntime["detectReady"]>,
	): Promise<boolean>;
	isSessionAlive(name: string): Promise<boolean>;
	killSession(name: string): Promise<void>;
	checkSessionState(name: string): Promise<string>;
	sendKeys(name: string, text: string): Promise<void>;
	capturePaneContent(name: string): Promise<string | null>;
}

/** Dependencies injected into the spawn service. */
export interface SpawnDeps {
	/** Pre-opened session store (shared with validation in slingCommand). */
	sessionStore: SessionStore;
	/** Run store factory -- creates from same DB path. */
	createRunStore: (dbPath: string) => RunStore;
	/** Pre-loaded manifest loader. */
	manifestLoader: ManifestLoader;
	/** Loaded manifest. */
	manifest: AgentManifest;
	/** Resolved agent definition for the capability. */
	agentDef: AgentDefinition;
	/** Loaded config. */
	config: OverstoryConfig;
	/** Resolved tracker backend name. */
	resolvedBackend: string;

	// Lazy deps -- constructed only when needed
	/** Lazy tracker client. */
	tracker: () => TrackerClient;
	/** Lazy mail store factory. */
	mailStore: () => MailStore;
	/** Lazy mail client factory. */
	mailClient: (store: MailStore) => MailClient;
	/** Lazy canopy client factory. */
	canopy: () => CanopyClient;
	/** Lazy mulch client factory. */
	mulch: () => MulchClient;
	/** Lazy runtime factory. */
	runtime: () => AgentRuntime;

	// Tmux operations (mockable)
	tmux: TmuxOps;
}

/** Interface for the spawn service. */
export interface SpawnService {
	spawn(opts: SpawnOptions): Promise<SpawnResult>;
}

// === Factory ===

export function createSpawnService(deps: SpawnDeps): SpawnService {
	return {
		async spawn(opts: SpawnOptions): Promise<SpawnResult> {
			const { config, agentDef } = deps;
			const overstoryDir = join(config.project.root, ".overstory");

			// Check spawn-paused sentinel
			const spawnPausedPath = join(overstoryDir, "spawn-paused");
			if (existsSync(spawnPausedPath)) {
				let ruleId = "unknown";
				try {
					const data = JSON.parse(readFileSync(spawnPausedPath, "utf-8")) as {
						ruleId?: unknown;
					};
					if (data && typeof data.ruleId === "string") ruleId = data.ruleId;
				} catch {
					/* ignore parse errors */
				}
				throw new AgentError(
					`Spawning paused by health policy (rule: ${ruleId}). Run \`ov health policy enable\` or remove .overstory/spawn-paused to resume.`,
					{ agentName: opts.name },
				);
			}

			// 7. Create worktree
			const worktreeBaseDir = join(config.project.root, config.worktrees.baseDir);
			await mkdir(worktreeBaseDir, { recursive: true });

			const baseBranch =
				opts.baseBranch ??
				(await getCurrentBranch(config.project.root)) ??
				config.project.canonicalBranch;

			const { path: worktreePath, branch: branchName } = await createWorktree({
				repoRoot: config.project.root,
				baseDir: worktreeBaseDir,
				agentName: opts.name,
				baseBranch,
				taskId: opts.taskId,
				missionSlug: opts.missionSlug,
			});

			try {
				return await executePostWorktreeSteps(
					deps,
					opts,
					worktreePath,
					branchName,
					overstoryDir,
					agentDef,
				);
			} catch (err) {
				await rollbackWorktree(config.project.root, worktreePath, branchName);
				throw err;
			}
		},
	};
}

// === Internal pipeline (steps 8-14) ===

async function executePostWorktreeSteps(
	deps: SpawnDeps,
	opts: SpawnOptions,
	worktreePath: string,
	branchName: string,
	overstoryDir: string,
	agentDef: AgentDefinition,
): Promise<SpawnResult> {
	const { config } = deps;
	const { name, capability, taskId, parentAgent, depth } = opts;

	// 8. Generate + write overlay CLAUDE.md
	const agentDefPath = join(config.project.root, config.agents.baseDir, agentDef.file);
	const baseDefinition = await Bun.file(agentDefPath).text();

	// 8a. Fetch file-scoped mulch expertise if mulch is enabled and files are provided
	let mulchExpertise: string | undefined;
	if (config.mulch.enabled && opts.fileScope.length > 0) {
		try {
			const mulch = deps.mulch();
			mulchExpertise = await mulch.prime(undefined, undefined, {
				files: opts.fileScope,
				sortByScore: true,
			});
		} catch {
			mulchExpertise = undefined;
		}
	}

	// 8b. Resolve canopy profile if specified
	const profileName =
		opts.profile ?? process.env.OVERSTORY_PROFILE ?? config.project.defaultProfile;
	let profileContent: string | undefined;
	if (profileName) {
		try {
			const canopy = deps.canopy();
			const rendered = await canopy.render(profileName);
			if (rendered.success && rendered.sections.length > 0) {
				profileContent = rendered.sections.map((s) => s.body).join("\n\n");
			}
		} catch {
			profileContent = undefined;
		}
	}

	// 8c. Load project context for overlay
	let projectContextRendered: string | undefined;
	if (config.context?.enabled !== false) {
		try {
			const cachePath = config.context?.cachePath ?? ".overstory/project-context.json";
			const fullPath = join(config.project.root, cachePath);
			const file = Bun.file(fullPath);
			if (await file.exists()) {
				const data = JSON.parse(await file.text()) as { version?: number; signals?: unknown };
				if (data?.version === 1 && data?.signals) {
					projectContextRendered = renderCompactContext(data as ProjectContext);
				}
			}
		} catch {
			projectContextRendered = undefined;
		}
	}

	// Resolve runtime before overlayConfig so we can pass runtime.instructionPath
	const runtime = deps.runtime();

	const overlayConfig: OverlayConfig = {
		agentName: name,
		taskId,
		specPath: opts.specPath,
		branchName,
		worktreePath,
		fileScope: opts.fileScope,
		mulchDomains: config.mulch.enabled
			? inferDomainsFromFiles(opts.fileScope, config.mulch.domains)
			: [],
		parentAgent,
		depth,
		canSpawn: agentDef.canSpawn,
		capability,
		baseDefinition,
		profileContent,
		mulchExpertise,
		projectContext: projectContextRendered,
		skipScout: opts.skipScout && capability === "lead",
		skipReview: opts.skipReview && capability === "lead",
		maxAgentsOverride: opts.dispatchMaxAgents,
		qualityGates: config.project.qualityGates,
		trackerCli: trackerCliName(deps.resolvedBackend),
		trackerName: deps.resolvedBackend,
		instructionPath: runtime.instructionPath,
	};

	await writeOverlay(worktreePath, overlayConfig, config.project.root, runtime.instructionPath);

	// 9. Resolve runtime + model (needed for deployConfig, spawn, and beacon)
	const resolvedModel = resolveModel(config, deps.manifest, capability, agentDef.model);

	// 9a. Deploy hooks config (capability-specific guards)
	await runtime.deployConfig(worktreePath, undefined, {
		agentName: name,
		capability,
		worktreePath,
		qualityGates: config.project.qualityGates,
	});

	// 9a2. Deploy MCP config for researcher agents (search providers)
	if (capability === "researcher") {
		const { buildMcpServers, deployMcpConfig } = await import("../research/mcp.ts");
		const servers = buildMcpServers();
		if (Object.keys(servers).length > 0) {
			await deployMcpConfig(worktreePath, servers);
		}
	}

	// 9b. Send auto-dispatch mail so it exists when SessionStart hook fires.
	const dispatch = buildAutoDispatch({
		agentName: name,
		taskId,
		capability,
		specPath: opts.specPath,
		parentAgent,
		instructionPath: runtime.instructionPath,
	});
	const mailStore = deps.mailStore();
	try {
		const mailClient = deps.mailClient(mailStore);
		// Drain stale unread mail before queuing the new dispatch.
		mailClient.check(name);
		mailClient.send({
			from: dispatch.from,
			to: dispatch.to,
			subject: dispatch.subject,
			body: dispatch.body,
			type: "dispatch",
			priority: "normal",
		});
	} finally {
		mailStore.close();
	}

	// 10. Claim tracker issue
	if (config.taskTracker.enabled && !opts.skipTaskCheck) {
		try {
			await deps.tracker().claim(taskId);
		} catch {
			// Non-fatal: issue may already be claimed
		}
	}

	// 11. Create agent identity (if new)
	const identityBaseDir = join(config.project.root, ".overstory", "agents");
	const existingIdentity = await loadIdentity(identityBaseDir, name);
	if (!existingIdentity) {
		await createIdentity(identityBaseDir, {
			name,
			capability,
			created: new Date().toISOString(),
			sessionsCompleted: 0,
			expertiseDomains: config.mulch.enabled ? config.mulch.domains : [],
			recentTasks: [],
		});
	}

	// 11b. Save applied mulch record IDs for session-end outcome tracking.
	if (mulchExpertise) {
		const appliedRecords = extractMulchRecordIds(mulchExpertise);
		if (appliedRecords.length > 0) {
			const appliedRecordsPath = join(identityBaseDir, name, "applied-records.json");
			const appliedData = {
				taskId,
				agentName: name,
				capability,
				records: appliedRecords,
			};
			try {
				await Bun.write(appliedRecordsPath, `${JSON.stringify(appliedData, null, "\t")}\n`);
			} catch {
				// Non-fatal: outcome tracking is supplementary context
			}
		}
	}

	// 11c. Branch: headless vs interactive spawn
	if (runtime.headless === true && runtime.buildDirectSpawn) {
		return spawnHeadless(
			deps,
			opts,
			runtime,
			resolvedModel,
			worktreePath,
			branchName,
			overstoryDir,
		);
	}
	return spawnInteractive(
		deps,
		opts,
		runtime,
		resolvedModel,
		worktreePath,
		branchName,
		overstoryDir,
	);
}

// === Headless spawn (step 12-14 headless path) ===

async function spawnHeadless(
	deps: SpawnDeps,
	opts: SpawnOptions,
	runtime: AgentRuntime,
	resolvedModel: ReturnType<typeof resolveModel>,
	worktreePath: string,
	branchName: string,
	overstoryDir: string,
): Promise<SpawnResult> {
	const { sessionStore: store } = deps;
	const { name, capability, taskId, parentAgent, depth, runId } = opts;

	const directEnv = {
		...runtime.buildEnv(resolvedModel),
		OVERSTORY_AGENT_NAME: name,
		OVERSTORY_WORKTREE_PATH: worktreePath,
		OVERSTORY_TASK_ID: taskId,
	};

	if (!runtime.buildDirectSpawn) {
		throw new Error("Runtime does not support headless spawn");
	}

	const argv = runtime.buildDirectSpawn({
		cwd: worktreePath,
		env: directEnv,
		...(resolvedModel.isExplicitOverride ? { model: resolvedModel.model } : {}),
		instructionPath: runtime.instructionPath,
	});

	// Create timestamped log dir for this headless agent session.
	const logTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const agentLogDir = join(overstoryDir, "logs", name, logTimestamp);
	mkdirSync(agentLogDir, { recursive: true });

	const headlessProc = await spawnHeadlessAgent(argv, {
		cwd: worktreePath,
		env: { ...(process.env as Record<string, string>), ...directEnv },
		stdoutFile: join(agentLogDir, "stdout.log"),
		stderrFile: join(agentLogDir, "stderr.log"),
	});

	// 13. Record session BEFORE any external signal.
	const session: AgentSession = {
		id: crypto.randomUUID(),
		agentName: name,
		capability,
		runtime: runtime.id,
		worktreePath,
		branchName,
		taskId,
		tmuxSession: "",
		state: "booting",
		pid: headlessProc.pid,
		parentAgent,
		depth,
		runId,
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		escalationLevel: 0,
		stalledSince: null,
		rateLimitedSince: null,
		runtimeSessionId: null,
		transcriptPath: null,
		originalRuntime: null,
		statusLine: null,
	};
	store.upsert(session);

	const runStore = deps.createRunStore(join(overstoryDir, "sessions.db"));
	try {
		runStore.incrementAgentCount(runId);
	} finally {
		runStore.close();
	}

	return {
		agentName: name,
		capability,
		taskId,
		branchName,
		worktreePath,
		tmuxSession: "",
		pid: headlessProc.pid,
	};
}

// === Interactive spawn (step 12-14 tmux path) ===

async function spawnInteractive(
	deps: SpawnDeps,
	opts: SpawnOptions,
	runtime: AgentRuntime,
	resolvedModel: ReturnType<typeof resolveModel>,
	worktreePath: string,
	branchName: string,
	overstoryDir: string,
): Promise<SpawnResult> {
	const { sessionStore: store, config, tmux } = deps;
	const { name, capability, taskId, parentAgent, depth, runId } = opts;

	// 11c. Preflight: verify tmux is available
	await tmux.ensureTmuxAvailable();

	// 12. Create tmux session running agent in interactive mode
	const tmuxSessionName = `overstory-${config.project.name}-${name}`;
	const sessionId = crypto.randomUUID();
	const spawnTimestamp = Date.now();
	const spawnCmd = runtime.buildSpawnCommand({
		model: resolvedModel.model,
		permissionMode: "bypass",
		sessionId,
		cwd: worktreePath,
		sharedWritableDirs: getSharedWritableDirs(config.project.root, capability),
		env: {
			...runtime.buildEnv(resolvedModel),
			OVERSTORY_AGENT_NAME: name,
			OVERSTORY_WORKTREE_PATH: worktreePath,
			OVERSTORY_TASK_ID: taskId,
		},
	});
	const pid = await tmux.createSession(tmuxSessionName, worktreePath, spawnCmd, {
		...runtime.buildEnv(resolvedModel),
		OVERSTORY_AGENT_NAME: name,
		OVERSTORY_WORKTREE_PATH: worktreePath,
		OVERSTORY_TASK_ID: taskId,
	});

	// 13. Record session BEFORE sending the beacon (overstory-036f ordering guarantee).
	const session: AgentSession = {
		id: sessionId,
		agentName: name,
		capability,
		runtime: runtime.id,
		worktreePath,
		branchName,
		taskId,
		tmuxSession: tmuxSessionName,
		state: "booting",
		pid,
		parentAgent,
		depth,
		runId,
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		escalationLevel: 0,
		stalledSince: null,
		rateLimitedSince: null,
		runtimeSessionId: sessionId,
		transcriptPath: null,
		originalRuntime: null,
		statusLine: null,
	};

	store.upsert(session);

	// Increment agent count for the run
	const runStore = deps.createRunStore(join(overstoryDir, "sessions.db"));
	try {
		runStore.incrementAgentCount(runId);
	} finally {
		runStore.close();
	}

	// 13b. Give slow shells time to finish initializing before polling for TUI readiness.
	const shellDelay = config.runtime?.shellInitDelayMs ?? 0;
	if (shellDelay > 0) {
		await Bun.sleep(shellDelay);
	}

	// Wait for TUI to render before sending input.
	const tuiReady = await tmux.waitForTuiReady(tmuxSessionName, (content) =>
		runtime.detectReady(content),
	);
	if (!tuiReady) {
		const alive = await tmux.isSessionAlive(tmuxSessionName);
		store.updateState(name, "completed");

		if (alive) {
			await tmux.killSession(tmuxSessionName);
			throw new AgentError(
				`Agent tmux session "${tmuxSessionName}" did not become ready during startup. ` +
					"The runtime may still be waiting on an interactive dialog or initializing too slowly.",
				{ agentName: name },
			);
		}

		const sessionState = await tmux.checkSessionState(tmuxSessionName);
		const detail =
			sessionState === "no_server"
				? "The tmux server is no longer running. It may have crashed or been killed externally."
				: "The agent process may have crashed or exited immediately before the TUI became ready.";
		throw new AgentError(`Agent tmux session "${tmuxSessionName}" died during startup. ${detail}`, {
			agentName: name,
		});
	}

	// Buffer for the input handler to attach after initial render
	await Bun.sleep(1_000);

	const beacon = buildBeacon({
		agentName: name,
		capability,
		taskId,
		parentAgent,
		depth,
		instructionPath: runtime.instructionPath,
	});
	await tmux.sendKeys(tmuxSessionName, beacon);

	// 13c. Follow-up Enters with increasing delays to ensure submission.
	for (const delay of [1_000, 2_000, 3_000, 5_000]) {
		await Bun.sleep(delay);
		await tmux.sendKeys(tmuxSessionName, "");
	}

	// 13d. Verify beacon was received
	const needsVerification =
		!runtime.requiresBeaconVerification || runtime.requiresBeaconVerification();
	if (needsVerification) {
		const verifyAttempts = 5;
		for (let v = 0; v < verifyAttempts; v++) {
			await Bun.sleep(2_000);
			const paneContent = await tmux.capturePaneContent(tmuxSessionName);
			if (paneContent) {
				const readyState = runtime.detectReady(paneContent);
				if (readyState.phase !== "ready") {
					break; // Agent is processing
				}
			}
			// Still at welcome/idle screen -- resend beacon
			await tmux.sendKeys(tmuxSessionName, beacon);
			await Bun.sleep(1_000);
			await tmux.sendKeys(tmuxSessionName, ""); // Follow-up Enter
		}
	}

	// 13e. Discover runtime-native session ID
	if (runtime.discoverSessionId) {
		const runtimeSessionId = await runtime.discoverSessionId(worktreePath, spawnTimestamp);
		if (runtimeSessionId) {
			store.updateRuntimeSessionId(name, runtimeSessionId);
		}
	}

	return {
		agentName: name,
		capability,
		taskId,
		branchName,
		worktreePath,
		tmuxSession: tmuxSessionName,
		pid,
	};
}

// === Internal helpers ===

/**
 * Get the CLI name for a tracker backend.
 * Duplicated here to avoid pulling in the full tracker factory module
 * just for a string mapping.
 */
function trackerCliName(backend: string): string {
	if (backend === "github") return "gh";
	return backend === "seeds" ? "sd" : "bd";
}
