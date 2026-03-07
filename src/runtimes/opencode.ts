// OpenCode runtime adapter for overstory's AgentRuntime interface.
// Implements the AgentRuntime contract for the `opencode` CLI (SST OpenCode).
//
// Key differences from Claude/Pi adapters:
// - Uses `opencode` CLI for interactive sessions + `opencode run` for headless
// - Instruction file: AGENTS.md (OpenCode reads `instructions` from config, overlay via AGENTS.md)
// - No hooks: OpenCode has plugin system, not Claude Code hook mechanism
// - Session data stored in SQLite at ~/.local/share/opencode/opencode.db
// - Resume via `--session <id>` or `--continue`

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedModel } from "../types.ts";
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
 * OpenCode runtime adapter.
 *
 * Implements AgentRuntime for the `opencode` CLI (SST OpenCode coding agent).
 * Supports both interactive TUI mode (tmux) and headless mode (`opencode run`).
 *
 * Session data stored in SQLite: ~/.local/share/opencode/opencode.db
 * Tables: session, message, part (conversation history)
 *
 * CLI flags:
 * - `-m, --model <provider/model>` — model selection
 * - `-s, --session <id>` — resume specific session
 * - `-c, --continue` — continue last session
 * - `--agent <name>` — agent to use
 */
export class OpenCodeRuntime implements AgentRuntime {
	readonly id = "opencode";

	/**
	 * Relative path to the instruction file within a worktree.
	 * OpenCode reads instructions from its config's `instructions` array,
	 * but AGENTS.md in the worktree is used for the per-task overlay.
	 */
	readonly instructionPath = "AGENTS.md";

	/**
	 * Build the shell command string to spawn an interactive OpenCode agent in tmux.
	 *
	 * Maps SpawnOpts to `opencode` CLI flags:
	 * - `model` → `--model <model>`
	 * - `sessionId` → used for session tracking (OpenCode generates its own IDs)
	 * - `resumeSessionId` → `--session <id>` to resume an existing session
	 *
	 * The `cwd` and `env` fields are handled by the tmux session creator.
	 */
	buildSpawnCommand(opts: SpawnOpts): string {
		let cmd = `opencode --model ${opts.model}`;

		if (opts.resumeSessionId) {
			cmd += ` --session ${opts.resumeSessionId}`;
		}

		return cmd;
	}

	/**
	 * Build the argv array for a headless one-shot OpenCode invocation.
	 *
	 * Uses `opencode run` subcommand with `--format json` for structured output.
	 */
	buildPrintCommand(prompt: string, model?: string): string[] {
		const cmd = ["opencode", "run", "--format", "json", prompt];
		if (model !== undefined) {
			cmd.splice(2, 0, "--model", model);
		}
		return cmd;
	}

	/**
	 * Deploy per-agent instructions to a worktree.
	 *
	 * Writes AGENTS.md with the overlay content. OpenCode has no hook mechanism,
	 * so guard rules are injected as instructions in the overlay.
	 */
	async deployConfig(
		worktreePath: string,
		overlay: OverlayContent | undefined,
		_hooks: HooksDef,
	): Promise<void> {
		if (overlay) {
			await mkdir(worktreePath, { recursive: true });
			await Bun.write(join(worktreePath, "AGENTS.md"), overlay.content);
		}
	}

	/**
	 * Detect OpenCode TUI readiness from tmux pane content.
	 *
	 * Ready patterns observed from live OpenCode v1.2.20 TUI:
	 * - "Ask anything" placeholder text in the input area
	 * - Version number in footer (e.g., "1.2.20")
	 * - "ctrl+t" or "ctrl+p" keyboard hints
	 */
	detectReady(paneContent: string): ReadyState {
		const hasPrompt = paneContent.includes("Ask anything");
		const hasControls =
			paneContent.includes("ctrl+t") || paneContent.includes("ctrl+p");

		if (hasPrompt && hasControls) {
			return { phase: "ready" };
		}

		// During loading, OpenCode shows the ASCII banner before the input box
		if (paneContent.includes("OPENCODE") || paneContent.includes("opencode")) {
			return { phase: "loading" };
		}

		return { phase: "loading" };
	}

	/**
	 * Parse an OpenCode session transcript into normalized token usage.
	 *
	 * OpenCode stores sessions in SQLite (~/.local/share/opencode/opencode.db).
	 * The `opencode stats` command shows token usage.
	 * The `opencode export <sessionId>` exports session data as JSON.
	 *
	 * For now, returns null. Full implementation would query the SQLite DB directly
	 * or parse `opencode export` JSON output.
	 */
	async parseTranscript(_path: string): Promise<TranscriptSummary | null> {
		// OpenCode stores data in SQLite, not JSONL files.
		// TODO: query ~/.local/share/opencode/opencode.db for token usage
		return null;
	}

	/**
	 * Return the transcript directory for OpenCode sessions.
	 *
	 * OpenCode uses a centralized SQLite database, not per-project transcript files.
	 * The database is at ~/.local/share/opencode/opencode.db
	 */
	getTranscriptDir(_projectRoot: string): string | null {
		const home = process.env.HOME ?? "";
		return join(home, ".local", "share", "opencode");
	}

	/**
	 * Build runtime-specific environment variables for model/provider routing.
	 */
	buildEnv(model: ResolvedModel): Record<string, string> {
		return model.env ?? {};
	}

	/**
	 * Detect rate limiting from tmux pane content.
	 *
	 * Checks for HTTP 429, "rate limit", and "too many requests" patterns.
	 */
	detectRateLimit(paneContent: string): RateLimitState {
		const lower = paneContent.toLowerCase();
		if (
			lower.includes("429") ||
			lower.includes("rate limit") ||
			lower.includes("too many requests")
		) {
			return {
				limited: true,
				resumesAt: null,
				message: "Rate limit detected in OpenCode output",
			};
		}
		return { limited: false };
	}

	/**
	 * Extract recent conversation from OpenCode's SQLite database.
	 *
	 * Queries the message + part tables for the given session ID.
	 */
	async extractConversation(
		_worktreePath: string,
		sessionId: string,
		maxTurns: number,
	): Promise<string> {
		try {
			const { Database } = await import("bun:sqlite");
			const dbPath = join(
				process.env.HOME ?? "",
				".local",
				"share",
				"opencode",
				"opencode.db",
			);
			const db = new Database(dbPath, { readonly: true });

			const rows = db
				.query<
					{ data: string; time_created: number },
					[string, number]
				>(
					`SELECT m.data, m.time_created
					 FROM message m
					 WHERE m.session_id = ?
					 ORDER BY m.time_created DESC
					 LIMIT ?`,
				)
				.all(sessionId, maxTurns * 2);

			db.close();

			if (rows.length === 0) return "";

			const turns: string[] = [];
			for (const row of rows.reverse()) {
				try {
					const msg = JSON.parse(row.data);
					const role = msg.role ?? "unknown";
					const content =
						typeof msg.content === "string"
							? msg.content
							: JSON.stringify(msg.content);
					turns.push(`### ${role}\n${content.slice(0, 3000)}`);
				} catch {
					// Skip malformed messages
				}
			}

			return turns.join("\n\n");
		} catch {
			return "";
		}
	}
}
