// Codex runtime adapter for overstory's AgentRuntime interface.
// Implements the AgentRuntime contract for the OpenAI `codex` CLI.
//
// Key differences from Claude/Pi adapters:
// - Interactive: `codex` (without `exec`) stays alive in tmux for orchestration
// - Instruction file: AGENTS.md (not .claude/CLAUDE.md)
// - No hooks: Codex uses OS-level sandbox (Seatbelt/Landlock)
// - One-shot calls still use `codex exec` (buildPrintCommand)
// - Resume: `codex resume <UUID>` restores previous session context
// - --no-alt-screen: always set for tmux capture-pane compatibility

import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ResolvedModel } from "../types.ts";
import { tailReadLines } from "../watchdog/swap.ts";
import type {
	AgentRuntime,
	HooksDef,
	OverlayContent,
	RateLimitState,
	ReadyState,
	SpawnOpts,
	TranscriptSummary,
} from "./types.ts";

/**
 * Codex runtime adapter.
 *
 * Implements AgentRuntime for the OpenAI `codex` CLI. Tmux-spawned Codex
 * agents run in interactive mode (`codex`) so sessions stay alive and can be
 * nudged via tmux.
 *
 * Security is enforced via Codex's OS-level sandbox (Seatbelt on macOS,
 * Landlock on Linux) rather than hook-based guards. The `--full-auto` flag
 * enables `workspace-write` sandbox + automatic approvals.
 *
 * Instructions are delivered via `AGENTS.md` (Codex's native convention),
 * not `.claude/CLAUDE.md`.
 */
export class CodexRuntime implements AgentRuntime {
	/** Unique identifier for this runtime. */
	readonly id = "codex";

	/** Relative path to the instruction file within a worktree. */
	readonly instructionPath = "AGENTS.md";

	/**
	 * Anthropic aliases used by overstory manifests that Codex CLI does not
	 * accept as --model values.
	 */
	private static readonly SKIP_MODEL_FLAG = new Set(["sonnet", "opus", "haiku", "default"]);

	/**
	 * Build the shell command string to spawn a Codex agent in a tmux pane.
	 *
	 * Uses interactive `codex` with `--full-auto` for workspace-write sandbox +
	 * automatic approvals. Always passes `--no-alt-screen` to keep tmux
	 * capture-pane working (alternate screen buffers interfere with pane reads).
	 *
	 * When `resumeSessionId` is provided, uses `codex resume <UUID>` subcommand
	 * to restore full conversation context from the previous session.
	 */
	buildSpawnCommand(opts: SpawnOpts): string {
		const modelFlag = CodexRuntime.SKIP_MODEL_FLAG.has(opts.model)
			? ""
			: ` --model ${opts.model}`;

		let cmd: string;
		if (opts.resumeSessionId) {
			cmd = `codex --no-alt-screen resume ${opts.resumeSessionId} --full-auto${modelFlag}`;
		} else {
			cmd = `codex --no-alt-screen --full-auto${modelFlag}`;
		}

		if (opts.appendSystemPromptFile) {
			const escaped = opts.appendSystemPromptFile.replace(/'/g, "'\\''");
			cmd += ` "$(cat '${escaped}')"' Read AGENTS.md for your task assignment and begin immediately.'`;
		} else if (opts.appendSystemPrompt) {
			const prompt = `${opts.appendSystemPrompt}\n\nRead AGENTS.md for your task assignment and begin immediately.`;
			const escaped = prompt.replace(/'/g, "'\\''");
			cmd += ` '${escaped}'`;
		} else {
			cmd += ` 'Read AGENTS.md for your task assignment and begin immediately.'`;
		}

		return cmd;
	}

	/**
	 * Build the argv array for a headless one-shot Codex invocation.
	 *
	 * Returns an argv array suitable for `Bun.spawn()`. Uses `codex exec`
	 * with `--full-auto` and `--ephemeral` (no session persistence).
	 * Without `--json`, stdout contains the plain text final message.
	 *
	 * Used by merge/resolver.ts (AI-assisted conflict resolution) and
	 * watchdog/triage.ts (AI-assisted failure classification).
	 */
	buildPrintCommand(prompt: string, model?: string): string[] {
		const cmd = ["codex", "exec", "--full-auto", "--ephemeral"];
		if (model !== undefined) {
			cmd.push("--model", model);
		}
		cmd.push(prompt);
		return cmd;
	}

	/**
	 * Deploy per-agent instructions to a worktree.
	 *
	 * Writes the overlay to `AGENTS.md` in the worktree root (Codex's native
	 * instruction file convention). Unlike Claude/Pi adapters, no hooks or
	 * guard extensions are deployed — Codex enforces security boundaries via
	 * its OS-level sandbox (Seatbelt on macOS, Landlock on Linux).
	 *
	 * When overlay is undefined (hooks-only deployment for coordinator/supervisor/monitor),
	 * this is a no-op since Codex has no hook system to deploy.
	 */
	async deployConfig(
		worktreePath: string,
		overlay: OverlayContent | undefined,
		_hooks: HooksDef,
	): Promise<void> {
		if (!overlay) return;

		const agentsPath = join(worktreePath, this.instructionPath);
		await mkdir(dirname(agentsPath), { recursive: true });
		await Bun.write(agentsPath, overlay.content);
	}

	/**
	 * Detect Codex TUI readiness from tmux pane content.
	 *
	 * - Idle: "Ask Codex to do anything" placeholder in input area
	 * - Working: "Working (" pattern (e.g. "Working (3s • esc to interrupt)")
	 * - Otherwise: still initializing → loading
	 */
	detectReady(paneContent: string): ReadyState {
		if (paneContent.includes("Ask Codex to do anything")) {
			return { phase: "ready" };
		}
		if (paneContent.includes("Working (")) {
			return { phase: "loading" };
		}
		return { phase: "loading" };
	}

	/**
	 * Codex does not require beacon verification/resend.
	 *
	 * Codex accepts startup input reliably once spawned.
	 */
	requiresBeaconVerification(): boolean {
		return false;
	}

	/**
	 * Parse a Codex rollout JSONL transcript into normalized token usage.
	 *
	 * Codex Rust CLI wraps events in `event_msg` envelopes. Token usage is in
	 * `token_count` events with cumulative `total_token_usage`. Model info
	 * may appear in `turn_context` or `session_meta` events.
	 *
	 * Also supports legacy `turn.completed` format for older Codex versions.
	 */
	async parseTranscript(path: string): Promise<TranscriptSummary | null> {
		const file = Bun.file(path);
		if (!(await file.exists())) {
			return null;
		}

		try {
			const text = await file.text();
			const lines = text.split("\n").filter((l) => l.trim().length > 0);

			let inputTokens = 0;
			let outputTokens = 0;
			let model = "";

			for (const line of lines) {
				let event: Record<string, unknown>;
				try {
					event = JSON.parse(line) as Record<string, unknown>;
				} catch {
					continue;
				}

				// Unwrap event_msg envelope used by Codex Rust CLI
				const payload =
					event.type === "event_msg"
						? (event.payload as Record<string, unknown> | undefined)
						: event;
				if (!payload) continue;
				const ptype = payload.type as string | undefined;

				// token_count: cumulative totals — assignment, not +=
				if (ptype === "token_count") {
					const info = payload.info as Record<string, unknown> | undefined;
					const total = info?.total_token_usage as
						| Record<string, number | undefined>
						| undefined;
					if (total) {
						if (typeof total.input_tokens === "number") {
							inputTokens = total.input_tokens;
						}
						if (typeof total.output_tokens === "number") {
							outputTokens = total.output_tokens;
						}
					}
				}

				// Legacy: turn.completed (older Codex TypeScript CLI)
				if (event.type === "turn.completed") {
					const usage = event.usage as Record<string, number | undefined> | undefined;
					if (usage) {
						if (typeof usage.input_tokens === "number") {
							inputTokens += usage.input_tokens;
						}
						if (typeof usage.output_tokens === "number") {
							outputTokens += usage.output_tokens;
						}
					}
				}

				// Capture model from any event that carries it
				if (typeof event.model === "string") {
					model = event.model;
				}
			}

			return { inputTokens, outputTokens, model };
		} catch {
			return null;
		}
	}

	/**
	 * Build runtime-specific environment variables for model/provider routing.
	 */
	buildEnv(model: ResolvedModel): Record<string, string> {
		return model.env ?? {};
	}

	/**
	 * Return the Codex transcript directory.
	 *
	 * Codex stores rollout JSONL files at `~/.codex/sessions/YYYY/MM/DD/`.
	 * Unlike Claude, sessions are not project-scoped in their directory layout.
	 */
	getTranscriptDir(_projectRoot: string): string | null {
		const home = process.env.HOME ?? "";
		if (home.length === 0) return null;
		return join(home, ".codex", "sessions");
	}

	/**
	 * Discover the Codex session UUID after agent spawn.
	 *
	 * Scans `~/.codex/sessions/YYYY/MM/DD/` for rollout files modified after
	 * the spawn timestamp. Extracts the UUID from the `session_meta` event
	 * (always the first line of a rollout file).
	 */
	async discoverSessionId(
		_worktreePath: string,
		spawnedAfter: number,
	): Promise<string | null> {
		try {
			const home = process.env.HOME ?? "";
			if (home.length === 0) return null;

			const d = new Date(spawnedAfter);
			const dayDir = join(
				home,
				".codex",
				"sessions",
				d.getFullYear().toString(),
				String(d.getMonth() + 1).padStart(2, "0"),
				String(d.getDate()).padStart(2, "0"),
			);

			let entries: string[];
			try {
				entries = await readdir(dayDir);
			} catch {
				return null;
			}

			const candidates: Array<{ path: string; mtime: number }> = [];
			for (const entry of entries) {
				if (!entry.startsWith("rollout-") || !entry.endsWith(".jsonl")) continue;
				const fp = join(dayDir, entry);
				const s = await stat(fp);
				if (s.mtimeMs >= spawnedAfter) {
					candidates.push({ path: fp, mtime: s.mtimeMs });
				}
			}
			if (candidates.length === 0) return null;
			candidates.sort((a, b) => b.mtime - a.mtime);

			const best = candidates[0];
			if (!best) return null;
			const firstLine = (await Bun.file(best.path).text()).split("\n")[0];
			if (!firstLine) return null;
			const meta = JSON.parse(firstLine) as Record<string, unknown>;
			if (meta.type === "session_meta") {
				const metaPayload = meta.payload as Record<string, unknown> | undefined;
				if (metaPayload && typeof metaPayload.id === "string") {
					return metaPayload.id;
				}
			}
			return null;
		} catch {
			return null;
		}
	}

	/**
	 * Extract recent conversation from a Codex rollout JSONL transcript.
	 *
	 * Uses tail-read (last 100KB) for performance. Parses user_message,
	 * agent_message, and function_call events into markdown format.
	 */
	async extractConversation(
		_worktreePath: string,
		sessionId: string,
		maxTurns: number,
	): Promise<string> {
		const rolloutPath = await this.findRolloutFile(sessionId);
		if (!rolloutPath) return "";

		const lines = await tailReadLines(rolloutPath);
		if (lines.length === 0) return "";

		const turns: Array<{ type: string; content: string }> = [];
		for (const line of lines) {
			try {
				const event = JSON.parse(line) as Record<string, unknown>;

				// Unwrap event_msg envelope
				const payload =
					event.type === "event_msg"
						? (event.payload as Record<string, unknown> | undefined)
						: null;
				const responsePayload =
					event.type === "response_item"
						? (event.payload as Record<string, unknown> | undefined)
						: null;

				// User messages: event_msg > user_message
				if (payload && payload.type === "user_message") {
					const msg = payload.message as string | undefined;
					if (msg && msg.trim()) {
						turns.push({ type: "user", content: msg.trim() });
					}
				}

				// Agent messages: event_msg > agent_message
				if (payload && payload.type === "agent_message") {
					const msg = payload.message as string | undefined;
					if (msg && msg.trim()) {
						turns.push({ type: "assistant", content: msg.trim() });
					}
				}

				// Assistant text: response_item > message with output_text
				if (responsePayload && responsePayload.type === "message") {
					const role = responsePayload.role as string | undefined;
					const contentArr = responsePayload.content as
						| Array<Record<string, unknown>>
						| undefined;
					if (role === "assistant" && Array.isArray(contentArr)) {
						let text = "";
						for (const block of contentArr) {
							if (block.type === "output_text" && typeof block.text === "string") {
								text += `${block.text}\n`;
							}
						}
						if (text.trim()) {
							turns.push({ type: "assistant", content: text.trim() });
						}
					}
				}

				// Tool calls: response_item > function_call
				if (responsePayload && responsePayload.type === "function_call") {
					const name = responsePayload.name as string | undefined;
					const args = responsePayload.arguments as string | undefined;
					let content = `[Tool: ${name ?? "unknown"}]`;
					if (name === "exec_command" && args) {
						try {
							const parsed = JSON.parse(args) as Record<string, unknown>;
							const cmd = parsed.cmd as string | undefined;
							if (cmd) content = `[Shell: ${cmd.slice(0, 100)}]`;
						} catch {
							// Use generic label
						}
					}
					turns.push({ type: "assistant", content });
				}
			} catch {
				// Skip malformed lines
			}
		}

		const recent = turns.slice(-maxTurns * 2);
		if (recent.length === 0) return "";

		let md = "";
		for (const turn of recent) {
			const label = turn.type === "user" ? "User" : "Assistant";
			md += `### ${label}\n${turn.content}\n\n`;
		}
		return md.trim();
	}

	/**
	 * Detect rate limiting from tmux pane content.
	 *
	 * Checks for Codex-specific patterns first (more specific messages),
	 * then falls back to generic OpenAI rate limit indicators.
	 */
	detectRateLimit(paneContent: string): RateLimitState {
		const lower = paneContent.toLowerCase();

		// Codex-specific: stream disconnection with rate limit
		if (lower.includes("stream disconnected before completion: rate limit")) {
			return { limited: true, resumesAt: null, message: "Codex stream rate limited" };
		}

		// Codex-specific: TPM rate limit with model details
		if (lower.includes("rate limit reached for")) {
			return { limited: true, resumesAt: null, message: "OpenAI TPM rate limit reached" };
		}

		// Codex-specific: weekly usage cap warning
		if (/you've used over \d+% of your weekly limit/i.test(paneContent)) {
			return { limited: true, resumesAt: null, message: "OpenAI weekly limit warning" };
		}

		// Generic OpenAI patterns
		if (lower.includes("429") || lower.includes("rate limit") || lower.includes("rate_limit")) {
			return { limited: true, resumesAt: null, message: "OpenAI rate limited (429)" };
		}
		if (lower.includes("too many requests")) {
			return { limited: true, resumesAt: null, message: "OpenAI too many requests" };
		}
		if (lower.includes("quota exceeded") || lower.includes("insufficient_quota")) {
			return { limited: true, resumesAt: null, message: "OpenAI quota exceeded" };
		}
		return { limited: false };
	}

	/**
	 * Find the rollout JSONL file for a given Codex session UUID.
	 *
	 * Searches `~/.codex/sessions/` date directories for a rollout file
	 * whose `session_meta` contains the matching UUID.
	 */
	private async findRolloutFile(sessionId: string): Promise<string | null> {
		try {
			const home = homedir();
			const sessionsDir = join(home, ".codex", "sessions");

			// Rollout filenames contain the UUID: rollout-{timestamp}-{uuid}.jsonl
			// Search recent date directories (today and yesterday)
			const now = new Date();
			const dateDirs: string[] = [];
			for (let daysBack = 0; daysBack < 7; daysBack++) {
				const d = new Date(now.getTime() - daysBack * 86_400_000);
				dateDirs.push(
					join(
						sessionsDir,
						d.getFullYear().toString(),
						String(d.getMonth() + 1).padStart(2, "0"),
						String(d.getDate()).padStart(2, "0"),
					),
				);
			}

			for (const dir of dateDirs) {
				let entries: string[];
				try {
					entries = await readdir(dir);
				} catch {
					continue;
				}

				// UUID appears at the end of the filename
				for (const entry of entries) {
					if (!entry.endsWith(".jsonl")) continue;
					if (entry.includes(sessionId)) {
						return join(dir, entry);
					}
				}
			}

			return null;
		} catch {
			return null;
		}
	}
}
