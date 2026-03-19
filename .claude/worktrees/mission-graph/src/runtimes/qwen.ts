// Qwen Code runtime adapter for overstory's AgentRuntime interface.
// Implements the AgentRuntime contract for Alibaba's `qwen` CLI (Gemini CLI fork).
//
// Key characteristics:
// - TUI: `qwen` maintains an interactive Ink-based TUI in tmux (forked from Gemini CLI)
// - Instruction file: AGENTS.md (configured via .qwen/settings.json context.fileName)
// - Hooks: Qwen Code v0.12.0+ supports hooks via .qwen/settings.json (Gemini fork format)
// - Auto-approve: `--yolo` flag for full auto-approve mode
// - Headless: `qwen -p "prompt"` for one-shot calls
// - Resume: `--resume <sessionId>` or `--continue` (latest)

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ResolvedModel } from "../types.ts";
import { generateGeminiHooks, QWEN_HOOK_CONFIG } from "./gemini-guards.ts";
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
 * Qwen Code runtime adapter.
 *
 * Implements AgentRuntime for Alibaba's `qwen` CLI (a Gemini CLI fork).
 * Qwen maintains an interactive Ink-based TUI, similar to Gemini.
 *
 * Security: Qwen Code inherits Gemini CLI's sandbox model but has no
 * hook/guard mechanism. The `--yolo` flag enables full auto-approve mode.
 *
 * Instructions are delivered via `AGENTS.md`, configured through
 * `.qwen/settings.json` with `context.fileName: "AGENTS.md"`.
 */
export class QwenRuntime implements AgentRuntime {
	/** Unique identifier for this runtime. */
	readonly id = "qwen";

	/** Stability level. Qwen adapter is experimental — not fully validated. */
	readonly stability = "experimental" as const;

	/** Relative path to the instruction file within a worktree. */
	readonly instructionPath = "AGENTS.md";

	/**
	 * Anthropic aliases used by overstory manifests that Qwen CLI does not
	 * accept as --model values.
	 */
	private static readonly SKIP_MODEL_FLAG = new Set(["sonnet", "opus", "haiku", "default"]);

	/**
	 * Build the shell command string to spawn an interactive Qwen agent.
	 *
	 * Maps SpawnOpts to `qwen` CLI flags:
	 * - `model` → `--model <model>` (skipped for Anthropic aliases)
	 * - `permissionMode === "bypass"` → `--yolo`
	 * - `resumeSessionId` → `--resume <id>`
	 * - `appendSystemPrompt` / `appendSystemPromptFile` → `--prompt-interactive`
	 */
	buildSpawnCommand(opts: SpawnOpts): string {
		const modelFlag = QwenRuntime.SKIP_MODEL_FLAG.has(opts.model) ? "" : ` --model ${opts.model}`;

		let cmd: string;
		if (opts.resumeSessionId) {
			cmd = `qwen --resume ${opts.resumeSessionId}`;
		} else {
			cmd = "qwen";
		}

		if (opts.permissionMode === "bypass") {
			cmd += " --yolo";
		}

		cmd += modelFlag;

		// Qwen has no --system-prompt flag. Use --prompt-interactive to send
		// an initial prompt that goes interactive after processing.
		if (opts.appendSystemPromptFile) {
			const escaped = QwenRuntime.shellEscape(opts.appendSystemPromptFile);
			cmd += ` --prompt-interactive "$(cat '${escaped}') Read AGENTS.md for your task assignment and begin immediately."`;
		} else if (opts.appendSystemPrompt) {
			const escaped = QwenRuntime.shellEscape(
				`${opts.appendSystemPrompt}\n\nRead AGENTS.md for your task assignment and begin immediately.`,
			);
			cmd += ` --prompt-interactive '${escaped}'`;
		} else {
			cmd +=
				" --prompt-interactive 'Read AGENTS.md for your task assignment and begin immediately.'";
		}

		return cmd;
	}

	/**
	 * Build the argv array for a headless one-shot Qwen invocation.
	 *
	 * Returns an argv array suitable for `Bun.spawn()`. Uses positional
	 * prompt (not deprecated `-p`). `--yolo` auto-approves tool calls.
	 */
	buildPrintCommand(prompt: string, model?: string): string[] {
		const cmd = ["qwen", "--yolo"];
		if (model !== undefined) {
			cmd.push("--model", model);
		}
		cmd.push(prompt);
		return cmd;
	}

	/**
	 * Deploy per-agent instructions and guards to a worktree.
	 *
	 * Writes the overlay to `AGENTS.md` and creates `.qwen/settings.json`
	 * with `context.fileName: "AGENTS.md"` and hooks for guard enforcement.
	 *
	 * Hooks are always deployed (even when overlay is undefined) so that
	 * coordinator/supervisor agents at the project root still get guards.
	 */
	async deployConfig(
		worktreePath: string,
		overlay: OverlayContent | undefined,
		hooks: HooksDef,
	): Promise<void> {
		if (overlay) {
			const agentsPath = join(worktreePath, this.instructionPath);
			await mkdir(dirname(agentsPath), { recursive: true });
			await Bun.write(agentsPath, overlay.content);
		}

		const qwenHooks = generateGeminiHooks(hooks, QWEN_HOOK_CONFIG);
		const settingsDir = join(worktreePath, ".qwen");
		await mkdir(settingsDir, { recursive: true });

		// Merge: keep context.fileName config, add hooks
		const settingsPath = join(settingsDir, "settings.json");
		let existing: Record<string, unknown> = {};
		const existingFile = Bun.file(settingsPath);
		if (await existingFile.exists()) {
			try {
				existing = (await existingFile.json()) as Record<string, unknown>;
			} catch {
				// Malformed — start fresh
			}
		}
		const {
			hooks: _existingHooks,
			context: _existingContext,
			hooksConfig: _existingHooksConfig,
			...nonHooksKeys
		} = existing;
		const merged = {
			...nonHooksKeys,
			context: { fileName: "AGENTS.md" },
			// Qwen defaults hooks to disabled; explicitly enable
			hooksConfig: { enabled: true },
			...qwenHooks,
		};
		await Bun.write(settingsPath, `${JSON.stringify(merged, null, "\t")}\n`);
	}

	/**
	 * Detect Qwen TUI readiness from tmux pane content.
	 *
	 * Qwen is a Gemini CLI fork with an Ink-based TUI. Detection uses:
	 * - Prompt: "> " prefix, placeholder "type your message", or U+276F (❯)
	 * - Branding: "qwen" visible in the TUI header/status
	 *
	 * No trust dialog phase exists for Qwen.
	 */
	detectReady(paneContent: string): ReadyState {
		const lower = paneContent.toLowerCase();

		const hasPrompt =
			lower.includes("type your message") ||
			/^> /m.test(paneContent) ||
			paneContent.includes("\u276f");

		const hasQwen = lower.includes("qwen");

		if (hasPrompt && hasQwen) {
			return { phase: "ready" };
		}

		return { phase: "loading" };
	}

	/**
	 * Qwen does not require beacon verification/resend.
	 *
	 * Gemini CLI forks accept input reliably once spawned.
	 */
	requiresBeaconVerification(): boolean {
		return false;
	}

	/**
	 * Transcript parsing not yet implemented for Qwen.
	 */
	async parseTranscript(_path: string): Promise<TranscriptSummary | null> {
		return null;
	}

	/**
	 * Build runtime-specific environment variables for model/provider routing.
	 */
	buildEnv(model: ResolvedModel): Record<string, string> {
		return model.env ?? {};
	}

	/** Qwen transcript directory discovery not yet implemented. */
	getTranscriptDir(_projectRoot: string): string | null {
		return null;
	}

	/**
	 * Detect rate limiting from tmux pane content.
	 *
	 * Checks for common rate limit patterns (429, "rate limit", "too many requests").
	 */
	detectRateLimit(paneContent: string): RateLimitState {
		const lower = paneContent.toLowerCase();

		if (lower.includes("429") || lower.includes("rate limit") || lower.includes("rate_limit")) {
			return { limited: true, resumesAt: null, message: "Qwen rate limited (429)" };
		}
		if (lower.includes("too many requests")) {
			return { limited: true, resumesAt: null, message: "Qwen too many requests" };
		}
		if (lower.includes("quota exceeded") || lower.includes("insufficient_quota")) {
			return { limited: true, resumesAt: null, message: "Qwen quota exceeded" };
		}
		return { limited: false };
	}

	/**
	 * Escape a directory path for use in a single-quoted shell argument.
	 */
	private static shellEscape(path: string): string {
		return path.replace(/'/g, "'\\''");
	}
}
