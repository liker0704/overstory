/**
 * Runtime swap module for rate-limited agents.
 *
 * When an agent hits a rate limit and config.rateLimit.behavior === "swap",
 * this module orchestrates the transition to a different runtime (e.g. Claude → Codex):
 *
 * 1. Builds handoff context (git state + last N conversation turns from JSONL)
 * 2. Writes HANDOFF.md to the worktree
 * 3. Kills the old tmux session
 * 4. Deploys overlay for the new runtime's instruction path
 * 5. Spawns a new tmux session with the target runtime
 * 6. Updates the session store
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { initiateHandoff } from "../agents/lifecycle.ts";
import { createManifestLoader, resolveModel } from "../agents/manifest.ts";
import { nudgeAgent } from "../commands/nudge.ts";
import { sanitize } from "../logging/sanitizer.ts";
import { getRuntime } from "../runtimes/registry.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession, OverstoryConfig, SessionHandoff } from "../types.ts";
import { createSession, killSession } from "../worktree/tmux.ts";

export type SwapReason = "rate_limit_swap" | "failure_reroute";

export interface SwapOptions {
	/** Project root (contains .overstory/). */
	root: string;
	/** The session being swapped. */
	session: AgentSession;
	/** Runtime name to swap TO (e.g. "codex"). */
	targetRuntimeName: string;
	/** Full config. */
	config: OverstoryConfig;
	/** Last N lines captured from tmux pane. */
	paneContext: string | null;
	/** DI overrides for testing. */
	_tmux?: {
		killSession: (name: string) => Promise<void>;
		createSession: (
			name: string,
			cwd: string,
			cmd: string,
			env?: Record<string, string>,
		) => Promise<number>;
	};
}

export interface RerouteOptions extends SwapOptions {
	reason: SwapReason;
	/** Target capability for failure reroute. */
	targetCapability?: string;
	/** Sanitized error info for HANDOFF.md. */
	errorContext?: string;
}

export interface SwapResult {
	success: boolean;
	newTmuxSession: string | null;
	newPid: number | null;
	newRuntime: string;
	error?: string;
}

const MAX_HANDOFF_CHARS = 40_000;
const MAX_RECENT_TURNS = 10;

/**
 * Swap a rate-limited or failed agent to a different runtime.
 */
export async function swapRuntime(options: SwapOptions | RerouteOptions): Promise<SwapResult> {
	const { root, session, targetRuntimeName, config, paneContext } = options;
	const tmux = options._tmux ?? { killSession, createSession };
	const reason: SwapReason = "reason" in options ? options.reason : "rate_limit_swap";
	const errorContext = "errorContext" in options ? options.errorContext : undefined;

	// Guard: no-op if swapping to the same runtime
	if (targetRuntimeName === session.runtime) {
		return {
			success: false,
			newTmuxSession: null,
			newPid: null,
			newRuntime: targetRuntimeName,
			error: "Target runtime is the same as current runtime",
		};
	}

	const targetRuntime = getRuntime(targetRuntimeName, config, session.capability);
	const oldRuntime = getRuntime(session.runtime, config, session.capability);
	const overstoryDir = join(root, ".overstory");

	try {
		// 1. Build handoff context
		const gitContext = await getGitContext(session.worktreePath);

		// Try runtime-native conversation extraction, fall back to tmux pane
		let conversationContext = "";
		if (oldRuntime.extractConversation) {
			conversationContext = await oldRuntime.extractConversation(
				session.worktreePath,
				session.id,
				MAX_RECENT_TURNS,
			);
		}
		if (!conversationContext && paneContext) {
			conversationContext = `## Terminal Output (tmux fallback)\n\`\`\`\n${paneContext.slice(-10_000)}\n\`\`\``;
		}

		// If conversation context was built from pane, don't duplicate it
		const usedPaneFallback =
			!oldRuntime.extractConversation || !conversationContext.includes("###");
		const handoffMd = buildHandoffDocument({
			fromRuntime: session.runtime,
			toRuntime: targetRuntimeName,
			taskId: session.taskId,
			branchName: session.branchName,
			gitContext,
			conversationContext,
			paneContext: usedPaneFallback ? null : paneContext,
			reason,
			errorContext,
		});

		// 2. Write HANDOFF.md to worktree
		await Bun.write(join(session.worktreePath, "HANDOFF.md"), handoffMd);

		// 3. Create handoff record
		const progressSummary =
			reason === "failure_reroute"
				? `Failure reroute: ${session.capability} → ${targetRuntimeName}`
				: `Rate limit swap: ${session.runtime} → ${targetRuntimeName}`;
		await initiateHandoff({
			agentsDir: join(overstoryDir, "agents"),
			agentName: session.agentName,
			sessionId: session.id,
			taskId: session.taskId,
			// failure_reroute is not yet in SessionHandoff["reason"] — needs sessions/types.ts update (out of scope)
			reason: reason as unknown as SessionHandoff["reason"],
			progressSummary,
			pendingWork: "Continue work from HANDOFF.md context",
			currentBranch: session.branchName,
			filesModified: gitContext.modifiedFiles,
			mulchDomains: [],
		});

		// 4. Kill old tmux session
		try {
			await tmux.killSession(session.tmuxSession);
		} catch {
			// Session may already be dead — continue
		}

		// 5. Deploy overlay for new runtime
		const oldOverlayPath = join(session.worktreePath, oldRuntime.instructionPath);
		const newOverlayPath = join(session.worktreePath, targetRuntime.instructionPath);
		let overlayContent = "";
		try {
			const file = Bun.file(oldOverlayPath);
			if (await file.exists()) {
				overlayContent = await file.text();
			}
		} catch {
			// Old overlay not found — proceed with empty
		}

		// Prepend handoff reference to overlay
		const handoffRef =
			"# IMPORTANT: Read HANDOFF.md first\n\n" +
			"You are continuing work from a previous agent session that was rate-limited.\n" +
			"Read `HANDOFF.md` in this directory for full context before starting.\n\n---\n\n";
		await Bun.write(newOverlayPath, handoffRef + overlayContent);

		// 6. Spawn new tmux session
		const newTmuxSession = `${session.tmuxSession}-${targetRuntimeName}`;

		// Resolve model properly — same pattern as coordinator/sling/resume
		const capabilityDefaults: Record<string, string> = {
			coordinator: "opus",
			supervisor: "opus",
			monitor: "sonnet",
			lead: "sonnet",
			builder: "sonnet",
			scout: "haiku",
			reviewer: "sonnet",
			merger: "sonnet",
		};
		const fallbackModel = capabilityDefaults[session.capability] ?? "sonnet";
		const manifestLoader = createManifestLoader(
			join(root, config.agents.manifestPath),
			join(root, config.agents.baseDir),
		);
		const manifest = await manifestLoader.load();
		const resolvedModel = resolveModel(config, manifest, session.capability, fallbackModel);

		const env: Record<string, string> = {
			...targetRuntime.buildEnv(resolvedModel),
			OVERSTORY_AGENT_NAME: session.agentName,
		};

		// Root-level agents get their definition via prompt
		const rootAgentCaps = new Set(["coordinator", "supervisor", "monitor"]);
		let appendSystemPromptFile: string | undefined;
		if (rootAgentCaps.has(session.capability)) {
			const agentDefPath = join(root, ".overstory", "agent-defs", `${session.capability}.md`);
			if (existsSync(agentDefPath)) {
				appendSystemPromptFile = agentDefPath;
			}
		}

		const spawnCmd = targetRuntime.buildSpawnCommand({
			model: resolvedModel.model,
			permissionMode: "bypass",
			cwd: session.worktreePath,
			env,
			appendSystemPromptFile,
		});

		const newPid = await tmux.createSession(newTmuxSession, session.worktreePath, spawnCmd, env);

		// 7. Update session store (preserve original runtime for swap-back on resume)
		const { store } = openSessionStore(overstoryDir);
		store.upsert({
			...session,
			runtime: targetRuntime.id,
			originalRuntime: session.originalRuntime ?? session.runtime,
			tmuxSession: newTmuxSession,
			pid: newPid,
			rateLimitedSince: null,
			runtimeSessionId: null,
			state: "booting",
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		});
		store.close();

		// 8. Nudge new session to check mail
		try {
			await nudgeAgent(root, session.agentName, `ov mail check --agent ${session.agentName}`, true);
		} catch {
			// Nudge failure is non-fatal
		}

		return {
			success: true,
			newTmuxSession,
			newPid,
			newRuntime: targetRuntime.id,
		};
	} catch (err) {
		return {
			success: false,
			newTmuxSession: null,
			newPid: null,
			newRuntime: targetRuntimeName,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

// ─── Shared Helpers ──────────────────────────────────────────────────────────

export { tailReadLines } from "../process/util.ts";

// ─── Private Helpers ─────────────────────────────────────────────────────────

interface GitContext {
	diffStat: string;
	logOneline: string;
	modifiedFiles: string[];
}

async function getGitContext(worktreePath: string): Promise<GitContext> {
	const run = async (args: string[]): Promise<string> => {
		const proc = Bun.spawn(["git", ...args], {
			cwd: worktreePath,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode !== 0) return "";
		return new Response(proc.stdout).text();
	};

	const [diffStat, logOneline, nameOnly] = await Promise.all([
		run(["diff", "--stat"]),
		run(["log", "--oneline", "-10"]),
		run(["diff", "--name-only"]),
	]);

	return {
		diffStat: diffStat.trim(),
		logOneline: logOneline.trim(),
		modifiedFiles: nameOnly
			.trim()
			.split("\n")
			.filter((f) => f.length > 0),
	};
}

/**
 * Extract conversation from Claude JSONL transcripts.
 * @deprecated Use ClaudeRuntime.extractConversation() directly. Kept for test compatibility.
 */
export async function extractRecentTurns(
	worktreePath: string,
	sessionId: string,
	maxTurns: number,
): Promise<string> {
	const { ClaudeRuntime } = await import("../runtimes/claude.ts");
	const runtime = new ClaudeRuntime();
	return runtime.extractConversation(worktreePath, sessionId, maxTurns);
}

export function buildHandoffDocument(opts: {
	fromRuntime: string;
	toRuntime: string;
	taskId: string;
	branchName: string;
	gitContext: GitContext;
	conversationContext: string;
	paneContext: string | null;
	reason?: SwapReason;
	errorContext?: string;
}): string {
	const reason = opts.reason ?? "rate_limit_swap";
	const isFailureReroute = reason === "failure_reroute";
	const reasonLabel = isFailureReroute ? "failure reroute" : "rate limit swap";
	const swapDesc = isFailureReroute
		? `a previous ${opts.fromRuntime} session that encountered a failure`
		: `a previous ${opts.fromRuntime} session that hit rate limits`;

	const sanitizedConversation = opts.conversationContext ? sanitize(opts.conversationContext) : "";
	const sanitizedPane = opts.paneContext ? sanitize(opts.paneContext) : null;

	let doc = `# Handoff: ${opts.fromRuntime} → ${opts.toRuntime} (${reasonLabel})

You are continuing work from ${swapDesc}.
**Do NOT restart from scratch.** Review the context below and continue where the previous agent left off.

Use \`ov mail check --agent $OVERSTORY_AGENT_NAME\` to check for messages.
Use \`ov mail send\` to communicate with coordinator and other agents.

## Task
- **ID:** ${opts.taskId}
- **Branch:** ${opts.branchName}

## Recent Git History
\`\`\`
${opts.gitContext.logOneline || "(no commits yet)"}
\`\`\`

## Uncommitted Changes
\`\`\`
${opts.gitContext.diffStat || "(clean working tree)"}
\`\`\`
`;

	if (isFailureReroute && opts.errorContext) {
		const sanitizedError = sanitize(opts.errorContext);
		doc += `\n## Failure Context\n\n${sanitizedError}\n`;
	}

	if (sanitizedConversation) {
		doc += `\n## Previous Conversation (last ${MAX_RECENT_TURNS} turns)\n\n${sanitizedConversation}\n`;
	}

	if (sanitizedPane) {
		const trimmedPane = sanitizedPane.slice(-3000);
		doc += `\n## Last Terminal Output\n\`\`\`\n${trimmedPane}\n\`\`\`\n`;
	}

	doc += `\n## Instructions\n\nContinue the task. Check git diff for current state. Read your overlay/AGENTS.md for the original task assignment.\n`;

	// Truncate if too long
	if (doc.length > MAX_HANDOFF_CHARS) {
		doc = `${doc.slice(0, MAX_HANDOFF_CHARS)}\n\n[...truncated due to size limit]\n`;
	}

	return doc;
}
