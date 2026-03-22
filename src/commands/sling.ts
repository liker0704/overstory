/**
 * CLI command: ov sling <task-id>
 *
 * CRITICAL PATH. Orchestrates a full agent spawn:
 * 1. Load config + manifest
 * 2. Validate (depth limit, hierarchy)
 * 3. Load manifest + validate capability
 * 4. Resolve or create run_id (current-run.txt)
 * 5. Check name uniqueness + concurrency limit
 * 6. Validate task exists
 * 7-14. Spawn via SpawnService (worktree, overlay, tmux/headless, session record)
 *
 * Steps 7-14 are delegated to SpawnService in src/agents/spawn.ts.
 */

import { join, resolve } from "node:path";
import { createManifestLoader, resolveMissionCapability } from "../agents/manifest.ts";
import { createSpawnService, type SpawnDeps } from "../agents/spawn.ts";
import { createCanopyClient } from "../canopy/client.ts";
import { loadConfig } from "../config.ts";
import { AgentError, HierarchyError, ValidationError } from "../errors.ts";
import { inferDomain } from "../insights/analyzer.ts";
import { jsonOutput } from "../json.ts";
import { printSuccess } from "../logging/color.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { resolveActiveMissionContext } from "../missions/runtime-context.ts";
import { validateCurrentMissionSpec } from "../missions/workstream-control.ts";
import { createMulchClient } from "../mulch/client.ts";
import { canDispatch } from "../resilience/circuit-breaker.ts";
import { createResilienceStore } from "../resilience/store.ts";
import { getRuntime } from "../runtimes/registry.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { createRunStore } from "../sessions/store.ts";
import type { TrackerIssue } from "../tracker/factory.ts";
import { createTrackerClient, resolveBackend } from "../tracker/factory.ts";
import {
	capturePaneContent,
	checkSessionState,
	createSession,
	ensureTmuxAvailable,
	isSessionAlive,
	killSession,
	sendKeys,
	waitForTuiReady,
} from "../worktree/tmux.ts";

/**
 * Calculate how many milliseconds to sleep before spawning a new agent,
 * based on the configured stagger delay and when the most recent active
 * session was started.
 *
 * Returns 0 if no sleep is needed (no active sessions, delay is 0, or
 * enough time has already elapsed).
 *
 * @param staggerDelayMs - The configured minimum delay between spawns
 * @param activeSessions - Currently active (non-zombie) sessions
 * @param now - Current timestamp in ms (defaults to Date.now(), injectable for testing)
 */
export function calculateStaggerDelay(
	staggerDelayMs: number,
	activeSessions: ReadonlyArray<{ startedAt: string }>,
	now: number = Date.now(),
): number {
	if (staggerDelayMs <= 0 || activeSessions.length === 0) {
		return 0;
	}

	const mostRecent = activeSessions.reduce((latest, s) => {
		return new Date(s.startedAt).getTime() > new Date(latest.startedAt).getTime() ? s : latest;
	});
	const elapsed = now - new Date(mostRecent.startedAt).getTime();
	const remaining = staggerDelayMs - elapsed;
	return remaining > 0 ? remaining : 0;
}

/**
 * Generate a unique agent name from capability and taskId.
 * Base: capability-taskId. If that collides with takenNames,
 * appends -2, -3, etc. up to 100. Falls back to -Date.now() for guaranteed uniqueness.
 */
export function generateAgentName(
	capability: string,
	taskId: string,
	takenNames: readonly string[],
): string {
	const base = `${capability}-${taskId}`;
	if (!takenNames.includes(base)) {
		return base;
	}
	for (let i = 2; i <= 100; i++) {
		const candidate = `${base}-${i}`;
		if (!takenNames.includes(candidate)) {
			return candidate;
		}
	}
	return `${base}-${Date.now()}`;
}

/**
 * Check if the current process is running as root (UID 0).
 * Returns true if running as root, false otherwise.
 * Returns false on platforms that don't support getuid (e.g., Windows).
 *
 * The getuid parameter is injectable for testability without mocking process.getuid.
 */
export function isRunningAsRoot(getuid: (() => number) | undefined = process.getuid): boolean {
	return getuid?.() === 0;
}

/**
 * Infer mulch domains from a list of file paths.
 * Returns unique domains sorted alphabetically, falling back to
 * configured defaults if no domains could be inferred.
 */
export function inferDomainsFromFiles(
	files: readonly string[],
	configDomains: readonly string[],
): string[] {
	const inferred = new Set<string>();
	for (const file of files) {
		const domain = inferDomain(file);
		if (domain !== null) {
			inferred.add(domain);
		}
	}
	if (inferred.size === 0) {
		return [...configDomains];
	}
	return [...inferred].sort();
}

export interface SlingOptions {
	capability?: string;
	name?: string;
	spec?: string;
	files?: string;
	parent?: string;
	depth?: string;
	skipScout?: boolean;
	skipTaskCheck?: boolean;
	forceHierarchy?: boolean;
	json?: boolean;
	maxAgents?: string;
	skipReview?: boolean;
	dispatchMaxAgents?: string;
	runtime?: string;
	noScoutCheck?: boolean;
	baseBranch?: string;
	profile?: string;
}

export interface AutoDispatchOptions {
	agentName: string;
	taskId: string;
	capability: string;
	specPath: string | null;
	parentAgent: string | null;
	instructionPath: string;
}

/**
 * Build a structured auto-dispatch mail message for a newly slung agent.
 *
 * Sending this mail before creating the tmux session ensures it exists
 * in the DB when SessionStart fires, eliminating the race where dispatch
 * mail arrives after the agent boots and sits idle forever.
 */
export function buildAutoDispatch(opts: AutoDispatchOptions): {
	from: string;
	to: string;
	subject: string;
	body: string;
} {
	const from = opts.parentAgent ?? "orchestrator";
	const specLine = opts.specPath
		? `Spec file: ${opts.specPath}`
		: "No spec file provided. Check your overlay for task details.";
	const body = [
		`You have been assigned task ${opts.taskId} as a ${opts.capability} agent.`,
		specLine,
		`Read your overlay at ${opts.instructionPath} and begin immediately.`,
	].join(" ");

	return {
		from,
		to: opts.agentName,
		subject: `Dispatch: ${opts.taskId}`,
		body,
	};
}

/**
 * Options for building the structured startup beacon.
 */
export interface BeaconOptions {
	agentName: string;
	capability: string;
	taskId: string;
	parentAgent: string | null;
	depth: number;
	instructionPath: string;
}

/**
 * Build a structured startup beacon for an agent.
 *
 * The beacon is the first user message sent to a Claude Code agent via
 * tmux send-keys. It provides identity context and a numbered startup
 * protocol so the agent knows exactly what to do on boot.
 *
 * Format:
 *   [OVERSTORY] <agent-name> (<capability>) <ISO timestamp> task:<task-id>
 *   Depth: <n> | Parent: <parent-name|none>
 *   Startup protocol:
 *   1. Read your assignment in .claude/CLAUDE.md
 *   2. Load expertise: mulch prime
 *   3. Check mail: ov mail check --agent <name>
 *   4. Begin working on task <task-id>
 */
export function buildBeacon(opts: BeaconOptions): string {
	const timestamp = new Date().toISOString();
	const parent = opts.parentAgent ?? "none";
	const parts = [
		`[OVERSTORY] ${opts.agentName} (${opts.capability}) ${timestamp} task:${opts.taskId}`,
		`Depth: ${opts.depth} | Parent: ${parent}`,
		`Startup: read ${opts.instructionPath}, run mulch prime, check mail (ov mail check --agent ${opts.agentName}), then begin task ${opts.taskId}`,
	];
	return parts.join(" — ");
}

/**
 * Check if a parent agent has spawned any scouts.
 * Returns true if the parent has at least one scout child in the session history.
 */
export function parentHasScouts(
	sessions: ReadonlyArray<{ parentAgent: string | null; capability: string }>,
	parentAgent: string,
): boolean {
	return sessions.some((s) => s.parentAgent === parentAgent && s.capability === "scout");
}

/**
 * Determine whether to emit the scout-before-build warning.
 *
 * Returns true when all of the following hold:
 *  - The incoming capability is "builder" (only builders trigger the check)
 *  - A parent agent is set (orphaned builders don't trigger it)
 *  - The parent has not yet spawned any scouts
 *  - noScoutCheck is false (caller has not suppressed the warning)
 *  - skipScout is false (the lead is not intentionally running without scouts)
 *
 * Extracted from slingCommand for testability (overstory-6eyw).
 *
 * @param capability - The requested agent capability
 * @param parentAgent - The --parent flag value (null = coordinator/human)
 * @param sessions - All sessions (not just active) for parentHasScouts query
 * @param noScoutCheck - True when --no-scout-check flag is set
 * @param skipScout - True when --skip-scout flag is set (lead opted out of scouting)
 */
export function shouldShowScoutWarning(
	capability: string,
	parentAgent: string | null,
	sessions: ReadonlyArray<{ parentAgent: string | null; capability: string }>,
	noScoutCheck: boolean,
	skipScout: boolean,
): boolean {
	if (capability !== "builder") return false;
	if (parentAgent === null) return false;
	if (noScoutCheck) return false;
	if (skipScout) return false;
	return !parentHasScouts(sessions, parentAgent);
}

/**
 * Resolve which canonical repo directories should be writable to an
 * interactive agent runtime in addition to its worktree sandbox.
 *
 * All interactive agents need `.overstory` so they can access shared mail,
 * metrics, and session state. Only `lead` agents need canonical `.git`
 * because they can spawn child worktrees from inside the runtime.
 *
 * @param projectRoot - Absolute path to the canonical repository root
 * @param capability - Capability being launched
 */
export function getSharedWritableDirs(projectRoot: string, capability: string): string[] {
	const sharedWritableDirs = [join(projectRoot, ".overstory")];

	if (capability === "lead" || capability === "execution-director") {
		sharedWritableDirs.push(join(projectRoot, ".git"));
	}

	return sharedWritableDirs;
}

/**
 * Check if any active agent is already working on the given task ID.
 * Returns the agent name if locked, or null if the task is free.
 *
 * @param activeSessions - Currently active (non-zombie) sessions
 * @param taskId - The task ID to check for concurrent work
 */
export function checkTaskLock(
	activeSessions: ReadonlyArray<{ agentName: string; taskId: string }>,
	taskId: string,
): string | null {
	const existing = activeSessions.find((s) => s.taskId === taskId);
	return existing?.agentName ?? null;
}

/**
 * Check if an active lead agent is already assigned to the given task ID.
 * Returns the lead agent name if found, or null if no active lead exists.
 *
 * This prevents the duplicate-lead anti-pattern where two leads run
 * simultaneously on the same bead, causing duplicate work streams and
 * wasted tokens (overstory-gktc postmortem).
 *
 * Only checks sessions with capability "lead". Builder/scout children
 * working the same bead (via parent delegation) do not trigger this check.
 *
 * @param activeSessions - Currently active (non-zombie, non-completed) sessions
 * @param taskId - The task ID to check for an existing lead
 */
export function checkDuplicateLead(
	activeSessions: ReadonlyArray<{ agentName: string; taskId: string; capability: string }>,
	taskId: string,
): string | null {
	const existing = activeSessions.find((s) => s.taskId === taskId && s.capability === "lead");
	return existing?.agentName ?? null;
}

/**
 * Check if spawning another agent would exceed the per-run session limit.
 * Returns true if the limit is reached. A limit of 0 means unlimited.
 *
 * @param maxSessionsPerRun - Config limit (0 = unlimited)
 * @param currentRunAgentCount - Number of agents already spawned in this run
 */
export function checkRunSessionLimit(
	maxSessionsPerRun: number,
	currentRunAgentCount: number,
): boolean {
	if (maxSessionsPerRun <= 0) return false;
	return currentRunAgentCount >= maxSessionsPerRun;
}

/**
 * Check if a parent agent has reached its per-lead child ceiling.
 * Returns true if the limit is reached. A limit of 0 means unlimited.
 *
 * @param activeSessions - Currently active (non-zombie) sessions
 * @param parentAgent - The parent agent name to count children for
 * @param maxAgentsPerLead - Config or CLI limit (0 = unlimited)
 */
export function checkParentAgentLimit(
	activeSessions: ReadonlyArray<{ parentAgent: string | null }>,
	parentAgent: string,
	maxAgentsPerLead: number,
): boolean {
	if (maxAgentsPerLead <= 0) return false;
	const count = activeSessions.filter((s) => s.parentAgent === parentAgent).length;
	return count >= maxAgentsPerLead;
}

/**
 * Validate hierarchy constraints: the coordinator (no parent) may only spawn leads.
 *
 * When parentAgent is null, the caller is the coordinator or a human.
 * Only "lead" capability is allowed in that case. All other capabilities
 * (builder, scout, reviewer, merger) must be spawned by a lead
 * that passes --parent.
 *
 * @param parentAgent - The --parent flag value (null = coordinator/human)
 * @param capability - The requested agent capability
 * @param name - The agent name (for error context)
 * @param depth - The requested hierarchy depth
 * @param forceHierarchy - If true, bypass the check (for debugging)
 * @throws HierarchyError if the constraint is violated
 */
export function resolveParentCapability(
	parentAgent: string | null,
	sessions: ReadonlyArray<{ agentName: string; capability: string }>,
): string | null {
	if (parentAgent === null) {
		return null;
	}
	return sessions.find((session) => session.agentName === parentAgent)?.capability ?? null;
}

export function allowedChildCapabilities(parentCapability: string | null): string[] {
	if (parentCapability === null) {
		return ["lead", "scout", "builder", "mission-analyst", "execution-director"];
	}

	if (parentCapability === "coordinator" || parentCapability === "coordinator-mission") {
		return ["lead", "scout", "builder", "mission-analyst", "execution-director"];
	}

	if (parentCapability === "execution-director") {
		return ["lead"];
	}

	if (parentCapability === "mission-analyst") {
		return ["scout", "plan-review-lead"];
	}

	if (parentCapability === "lead" || parentCapability === "lead-mission") {
		return ["scout", "builder", "reviewer", "merger"];
	}

	if (parentCapability === "plan-review-lead") {
		return [
			"plan-devil-advocate",
			"plan-security-critic",
			"plan-performance-critic",
			"plan-second-opinion",
			"plan-simulator",
		];
	}

	return [];
}

export function validateHierarchy(
	parentAgent: string | null,
	capability: string,
	name: string,
	_depth: number,
	forceHierarchy: boolean,
	sessions: ReadonlyArray<{ agentName: string; capability: string }> = [],
): void {
	if (forceHierarchy) {
		return;
	}

	const parentCapability = resolveParentCapability(parentAgent, sessions);
	if (parentAgent !== null && parentCapability === null) {
		throw new HierarchyError(
			`Parent agent "${parentAgent}" was not found in session state. Cannot spawn "${capability}" safely without a known parent capability.`,
			{ agentName: name, requestedCapability: capability },
		);
	}

	const allowed = allowedChildCapabilities(parentCapability);
	if (!allowed.includes(capability)) {
		const parentLabel =
			parentAgent === null
				? "Coordinator"
				: `Parent "${parentAgent}" (${parentCapability ?? "unknown"})`;
		throw new HierarchyError(
			`${parentLabel} cannot spawn "${capability}". Allowed child capabilities: ${allowed.join(", ") || "none"}. Use a valid intermediary, or pass --force-hierarchy to bypass.`,
			{ agentName: name, requestedCapability: capability },
		);
	}
}

/**
 * Extract mulch record IDs and their domains from mulch prime output text.
 * Parses the markdown structure produced by ml prime: domain headings
 * (## <name>) followed by record lines containing (mx-XXXXXX) identifiers.
 * @param primeText - The output text from ml prime
 * @returns Array of {id, domain} pairs. Deduplicated.
 */
export function extractMulchRecordIds(primeText: string): Array<{ id: string; domain: string }> {
	const results: Array<{ id: string; domain: string }> = [];
	const seen = new Set<string>();
	let currentDomain = "";

	for (const line of primeText.split("\n")) {
		const domainMatch = line.match(/^## ([\w-]+)/);
		if (domainMatch) {
			currentDomain = domainMatch[1] ?? "";
			continue;
		}
		if (currentDomain) {
			const idRegex = /\(mx-([a-f0-9]+)\)/g;
			let match = idRegex.exec(line);
			while (match !== null) {
				const shortId = match[1] ?? "";
				if (shortId) {
					const key = `${currentDomain}:mx-${shortId}`;
					if (!seen.has(key)) {
						seen.add(key);
						results.push({ id: `mx-${shortId}`, domain: currentDomain });
					}
				}
				match = idRegex.exec(line);
			}
		}
	}
	return results;
}

/**
 * Get the current git branch name for the repo at the given path.
 *
 * Returns null if in detached HEAD state, the directory is not a git repo,
 * or git exits non-zero.
 *
 * @param repoRoot - Absolute path to the git repository root
 */
export async function getCurrentBranch(repoRoot: string): Promise<string | null> {
	const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (exitCode !== 0) return null;
	const branch = stdout.trim();
	// "HEAD" is returned when in detached HEAD state
	if (branch === "HEAD" || branch === "") return null;
	return branch;
}

/**
 * Entry point for `ov sling <task-id> [flags]`.
 *
 * @param taskId - The task ID to assign to the agent
 * @param opts - Command options
 */
export async function slingCommand(taskId: string, opts: SlingOptions): Promise<void> {
	if (!taskId) {
		throw new ValidationError("Task ID is required: ov sling <task-id>", {
			field: "taskId",
		});
	}

	const capability = opts.capability ?? "builder";
	const rawName = opts.name?.trim() ?? "";
	const nameWasAutoGenerated = rawName.length === 0;
	let name = nameWasAutoGenerated ? `${capability}-${taskId}` : rawName;
	const specPath = opts.spec ?? null;
	const filesRaw = opts.files;
	const parentAgent = opts.parent ?? null;
	const depthStr = opts.depth;
	const depth = depthStr !== undefined ? Number.parseInt(depthStr, 10) : 0;
	const forceHierarchy = opts.forceHierarchy ?? false;
	const skipScout = opts.skipScout ?? false;
	const skipTaskCheck = opts.skipTaskCheck ?? false;

	if (Number.isNaN(depth) || depth < 0) {
		throw new ValidationError("--depth must be a non-negative integer", {
			field: "depth",
			value: depthStr,
		});
	}

	if (isRunningAsRoot()) {
		throw new AgentError(
			"Cannot spawn agents as root (UID 0). The claude CLI rejects --permission-mode bypassPermissions when run as root, causing the tmux session to die immediately. Run overstory as a non-root user.",
			{ agentName: name },
		);
	}

	if (opts.maxAgents !== undefined) {
		const parsed = Number.parseInt(opts.maxAgents, 10);
		if (Number.isNaN(parsed) || parsed < 0) {
			throw new ValidationError("--max-agents must be a non-negative integer", {
				field: "maxAgents",
				value: opts.maxAgents,
			});
		}
	}

	if (opts.dispatchMaxAgents !== undefined) {
		const parsed = Number.parseInt(opts.dispatchMaxAgents, 10);
		if (Number.isNaN(parsed) || parsed < 0) {
			throw new ValidationError("--dispatch-max-agents must be a non-negative integer", {
				field: "dispatchMaxAgents",
				value: opts.dispatchMaxAgents,
			});
		}
	}

	// Warn if --skip-scout is used for a non-lead capability (harmless but confusing)
	if (skipScout && capability !== "lead") {
		process.stderr.write(
			`Warning: --skip-scout is only meaningful for leads. Ignoring for "${capability}" agent "${name}".\n`,
		);
	}

	if (skipTaskCheck && !parentAgent) {
		process.stderr.write(
			`Warning: --skip-task-check without --parent is unusual. This flag is designed for leads spawning builders with worktree-created issues.\n`,
		);
	}

	// Validate that spec file exists if provided, and resolve to absolute path
	// so agents in worktrees can access it (worktrees don't have .overstory/)
	let absoluteSpecPath: string | null = null;
	if (specPath !== null) {
		absoluteSpecPath = resolve(specPath);
		const specFile = Bun.file(absoluteSpecPath);
		const specExists = await specFile.exists();
		if (!specExists) {
			throw new ValidationError(`Spec file not found: ${specPath}`, {
				field: "spec",
				value: specPath,
			});
		}
	}

	const fileScope = filesRaw
		? filesRaw
				.split(",")
				.map((f) => f.trim())
				.filter((f) => f.length > 0)
		: [];

	// 1. Load config
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const resolvedBackend = await resolveBackend(config.taskTracker.backend, config.project.root);
	const overstoryDir = join(config.project.root, ".overstory");
	const missionContext = await resolveActiveMissionContext(overstoryDir);
	const hasMission = missionContext !== null;

	// 2. Validate depth limit
	// Hierarchy: orchestrator(0) -> lead(1) -> specialist(2)
	// With maxDepth=2, depth=2 is the deepest allowed leaf, so reject only depth > maxDepth
	if (depth > config.agents.maxDepth) {
		throw new AgentError(
			`Depth limit exceeded: depth ${depth} > maxDepth ${config.agents.maxDepth}`,
			{ agentName: name },
		);
	}

	if (
		hasMission &&
		(capability === "builder" || capability === "reviewer") &&
		absoluteSpecPath === null
	) {
		throw new ValidationError(
			`Mission ${capability} agents must be launched with --spec so runtime can verify current mission metadata.`,
			{ field: "spec", value: specPath },
		);
	}

	// 3. Load manifest and validate capability
	const manifestLoader = createManifestLoader(
		join(config.project.root, config.agents.manifestPath),
		join(config.project.root, config.agents.baseDir),
	);
	const manifest = await manifestLoader.load();

	const resolvedCapability = resolveMissionCapability(capability, hasMission);

	if (
		hasMission &&
		absoluteSpecPath !== null &&
		(capability === "builder" || capability === "reviewer")
	) {
		const specValidation = await validateCurrentMissionSpec(config.project.root, absoluteSpecPath, {
			expectedTaskId: taskId,
		});
		if (!specValidation.ok) {
			throw new ValidationError(
				`Mission spec is not current: ${specValidation.reason}. Regenerate the spec before spawning ${capability}.`,
				{ field: "spec", value: specPath ?? absoluteSpecPath },
			);
		}
	}

	const agentDef = manifest.agents[resolvedCapability];
	if (!agentDef) {
		throw new AgentError(
			`Unknown capability "${capability}". Available: ${Object.keys(manifest.agents).join(", ")}`,
			{ agentName: name, capability },
		);
	}

	// 4. Resolve or create run_id for this spawn
	const currentRunPath = join(overstoryDir, "current-run.txt");

	// 5. Check name uniqueness and concurrency limit against active sessions
	// (Session store opened here so we can also use it for parent run ID inheritance in step 4.)
	const { store } = openSessionStore(overstoryDir);
	try {
		// 2b. Validate hierarchy using live parent capability data when available.
		validateHierarchy(parentAgent, capability, name, depth, forceHierarchy, store.getAll());

		// 4a. Resolve run ID: inherit from parent → current-run.txt fallback → create new.
		// Parent inheritance ensures child agents belong to the same run as their coordinator.
		const runId = await (async (): Promise<string> => {
			if (parentAgent) {
				const parentSession = store.getByName(parentAgent);
				if (parentSession?.runId) {
					return parentSession.runId;
				}
			}

			// Fallback: read current-run.txt (backward compat with single-coordinator setups).
			const currentRunFile = Bun.file(currentRunPath);
			if (await currentRunFile.exists()) {
				const text = (await currentRunFile.text()).trim();
				if (text) return text;
			}

			// Create a new run if none exists.
			const newRunId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
			const runStore = createRunStore(join(overstoryDir, "sessions.db"));
			try {
				runStore.createRun({
					id: newRunId,
					startedAt: new Date().toISOString(),
					coordinatorSessionId: null,
					coordinatorName: null,
					status: "active",
				});
			} finally {
				runStore.close();
			}
			await Bun.write(currentRunPath, newRunId);
			return newRunId;
		})();

		// 4b. Check per-run session limit
		if (config.agents.maxSessionsPerRun > 0) {
			const runCheckStore = createRunStore(join(overstoryDir, "sessions.db"));
			try {
				const run = runCheckStore.getRun(runId);
				if (run && checkRunSessionLimit(config.agents.maxSessionsPerRun, run.agentCount)) {
					throw new AgentError(
						`Run session limit reached: ${run.agentCount}/${config.agents.maxSessionsPerRun} agents spawned in run "${runId}". ` +
							`Increase agents.maxSessionsPerRun in config.yaml or start a new run.`,
						{ agentName: name },
					);
				}
			} finally {
				runCheckStore.close();
			}
		}

		const activeSessions = store.getActive();
		if (activeSessions.length >= config.agents.maxConcurrent) {
			throw new AgentError(
				`Max concurrent agent limit reached: ${activeSessions.length}/${config.agents.maxConcurrent} active agents`,
				{ agentName: name },
			);
		}

		if (nameWasAutoGenerated) {
			const takenNames = activeSessions.map((s) => s.agentName);
			name = generateAgentName(capability, taskId, takenNames);
		} else {
			const existing = store.getByName(name);
			if (existing && existing.state !== "zombie" && existing.state !== "completed") {
				throw new AgentError(`Agent name "${name}" is already in use (state: ${existing.state})`, {
					agentName: name,
				});
			}
		}

		// 5d. Task-level locking: prevent concurrent agents on the same task ID.
		// Exception: the parent agent may delegate its own task to a child.
		const lockHolder = checkTaskLock(activeSessions, taskId);
		if (lockHolder !== null && lockHolder !== parentAgent) {
			throw new AgentError(
				`Task "${taskId}" is already being worked by agent "${lockHolder}". ` +
					`Concurrent work on the same task causes duplicate issues and wasted tokens.`,
				{ agentName: name },
			);
		}

		// 5b. Enforce stagger delay between agent spawns
		const staggerMs = calculateStaggerDelay(config.agents.staggerDelayMs, activeSessions);
		if (staggerMs > 0) {
			await Bun.sleep(staggerMs);
		}

		// 5e. Enforce per-lead agent ceiling when spawning under a parent
		if (parentAgent !== null) {
			const maxPerLead =
				opts.maxAgents !== undefined
					? Number.parseInt(opts.maxAgents, 10)
					: config.agents.maxAgentsPerLead;
			if (checkParentAgentLimit(activeSessions, parentAgent, maxPerLead)) {
				const currentCount = activeSessions.filter((s) => s.parentAgent === parentAgent).length;
				throw new AgentError(
					`Per-lead agent limit reached: "${parentAgent}" has ${currentCount}/${maxPerLead} active children. ` +
						`Increase agents.maxAgentsPerLead in config.yaml or pass --max-agents <n>.`,
					{ agentName: name },
				);
			}
		}

		// 5f. Breaker check: if resilience is configured, verify circuit breaker allows dispatch.
		if (config.resilience?.circuitBreaker) {
			const cbPartial = config.resilience.circuitBreaker;
			const cbConfig = {
				failureThreshold: cbPartial.failureThreshold ?? 5,
				windowMs: cbPartial.windowMs ?? 60_000,
				cooldownMs: cbPartial.cooldownMs ?? 30_000,
				halfOpenMaxProbes: cbPartial.halfOpenMaxProbes ?? 1,
			};
			const resilienceStore = createResilienceStore(join(overstoryDir, "resilience.db"));
			try {
				const allowed = canDispatch(resilienceStore, capability, cbConfig);
				if (!allowed) {
					process.stderr.write(
						`Warning: Circuit breaker is open for capability "${capability}". Dispatch blocked.\n`,
					);
					try {
						const mailStore = createMailStore(join(overstoryDir, "mail.db"));
						const mailClient = createMailClient(mailStore);
						const recipient = parentAgent ?? "coordinator";
						mailClient.send({
							from: name,
							to: recipient,
							subject: `breaker_tripped: ${capability}`,
							body: `Circuit breaker is open for capability "${capability}". Cannot dispatch agent "${name}" for task "${taskId}".`,
							type: "error",
							priority: "high",
						});
						mailStore.close();
					} catch {
						// Mail send failure is non-fatal
					}
					throw new AgentError(
						`Circuit breaker is open for capability "${capability}". Dispatch blocked. Wait for cooldown or check resilience state.`,
						{ agentName: name },
					);
				}
			} finally {
				resilienceStore.close();
			}
		}

		// 5c. Structural enforcement: warn when a lead spawns a builder without prior scouts.
		// This is a non-blocking warning — it does not prevent the spawn, but surfaces
		// the scout-skip pattern so agents and operators can see it happening.
		// Use --no-scout-check to suppress this warning when intentionally skipping scouts.
		if (
			shouldShowScoutWarning(
				capability,
				parentAgent,
				store.getAll(),
				opts.noScoutCheck ?? false,
				skipScout,
			)
		) {
			process.stderr.write(
				`Warning: "${parentAgent}" is spawning builder "${name}" without having spawned any scouts.\n`,
			);
			process.stderr.write(
				"   Leads should spawn scouts in Phase 1 before building. See agents/lead.md.\n",
			);
		}

		// 6. Validate task exists and is in a workable state (if tracker enabled)
		const tracker = createTrackerClient(resolvedBackend, config.project.root);
		if (config.taskTracker.enabled && !skipTaskCheck) {
			let issue: TrackerIssue;
			try {
				issue = await tracker.show(taskId);
			} catch (err) {
				throw new AgentError(`Task "${taskId}" not found or inaccessible`, {
					agentName: name,
					cause: err instanceof Error ? err : undefined,
				});
			}

			const workableStatuses = ["open", "in_progress"];
			if (!workableStatuses.includes(issue.status)) {
				throw new ValidationError(
					`Task "${taskId}" is not workable (status: ${issue.status}). Only open or in_progress issues can be assigned.`,
					{ field: "taskId", value: taskId },
				);
			}
		}

		// 7-14. Delegate spawn orchestration to SpawnService.
		// SpawnService owns rollback: if any step fails after worktree creation,
		// it calls rollbackWorktree() before re-throwing.
		const spawnDeps: SpawnDeps = {
			sessionStore: store,
			createRunStore: (dbPath: string) => createRunStore(dbPath),
			manifestLoader,
			manifest,
			agentDef,
			config,
			resolvedBackend,
			tracker: () => tracker,
			mailStore: () => createMailStore(join(overstoryDir, "mail.db")),
			mailClient: (ms) => createMailClient(ms),
			canopy: () => createCanopyClient(config.project.root),
			mulch: () => createMulchClient(config.project.root),
			runtime: () => getRuntime(opts.runtime, config, capability),
			tmux: {
				ensureTmuxAvailable,
				createSession,
				waitForTuiReady,
				isSessionAlive,
				killSession,
				checkSessionState,
				sendKeys,
				capturePaneContent,
			},
		};

		const result = await createSpawnService(spawnDeps).spawn({
			name,
			capability,
			resolvedCapability,
			taskId,
			specPath: absoluteSpecPath,
			fileScope,
			parentAgent,
			depth,
			runId,
			skipScout,
			skipReview: opts.skipReview === true,
			dispatchMaxAgents:
				opts.dispatchMaxAgents !== undefined
					? Number.parseInt(opts.dispatchMaxAgents, 10)
					: undefined,
			baseBranch: opts.baseBranch,
			profile: opts.profile,
			runtimeName: opts.runtime,
			skipTaskCheck,
			json: opts.json ?? false,
		});

		// 14. Output result
		if (opts.json ?? false) {
			jsonOutput("sling", {
				agentName: result.agentName,
				capability: result.capability,
				taskId: result.taskId,
				branch: result.branchName,
				worktree: result.worktreePath,
				tmuxSession: result.tmuxSession,
				pid: result.pid,
			});
		} else {
			const isHeadless = result.tmuxSession === "";
			printSuccess(isHeadless ? "Agent launched (headless)" : "Agent launched", result.agentName);
			process.stdout.write(`   Task:     ${result.taskId}\n`);
			process.stdout.write(`   Branch:   ${result.branchName}\n`);
			process.stdout.write(`   Worktree: ${result.worktreePath}\n`);
			if (isHeadless) {
				process.stdout.write(`   PID:      ${result.pid}\n`);
			} else {
				process.stdout.write(`   Tmux:     ${result.tmuxSession}\n`);
				process.stdout.write(`   PID:      ${result.pid}\n`);
			}
		}
	} finally {
		store.close();
	}
}
