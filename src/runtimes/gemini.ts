// Gemini CLI runtime adapter for overstory's AgentRuntime interface.
// Implements the AgentRuntime contract for Google's `gemini` CLI.
//
// Key characteristics:
// - TUI: `gemini` maintains an interactive Ink-based TUI in tmux
// - Instruction file: GEMINI.md (read automatically from workspace root)
// - Hooks: Gemini CLI v0.26.0+ supports BeforeTool/AfterTool hooks via .gemini/settings.json
// - Sandbox: `--sandbox` flag + `--approval-mode yolo` for bypass
// - Headless: `gemini -p "prompt"` for one-shot calls
// - Transcripts: `--output-format stream-json` produces NDJSON events

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ResolvedModel } from "../types.ts";
import { generateGeminiHooks } from "./gemini-guards.ts";
import type {
	AgentRuntime,
	HooksDef,
	OverlayContent,
	ReadyState,
	SpawnOpts,
	TranscriptSummary,
} from "./types.ts";

/**
 * Gemini CLI runtime adapter.
 *
 * Implements AgentRuntime for Google's `gemini` CLI (Gemini coding agent).
 * Gemini maintains an interactive Ink-based TUI, similar to Copilot.
 *
 * Security: Gemini CLI supports `--sandbox` for filesystem isolation
 * (Seatbelt on macOS, container-based on Linux). Hooks (v0.26.0+) provide
 * BeforeTool/AfterTool interception for guard deployment.
 *
 * Instructions are delivered via `GEMINI.md` (Gemini's native context
 * file convention), which the CLI reads automatically from the workspace.
 */
export class GeminiRuntime implements AgentRuntime {
	/** Unique identifier for this runtime. */
	readonly id = "gemini";

	/** Stability level. Gemini adapter is experimental — not fully validated. */
	readonly stability = "experimental" as const;

	/** Relative path to the instruction file within a worktree. */
	readonly instructionPath = "GEMINI.md";

	/**
	 * Build the shell command string to spawn an interactive Gemini agent.
	 *
	 * Maps SpawnOpts to `gemini` CLI flags:
	 * - `model` → `-m <model>`
	 * - `permissionMode === "bypass"` → `--approval-mode yolo`
	 * - `permissionMode === "ask"` → no approval flag
	 * - `appendSystemPrompt` and `appendSystemPromptFile` are IGNORED —
	 *   the `gemini` CLI has no `--append-system-prompt` equivalent.
	 *   Role definitions are deployed via GEMINI.md instead.
	 *
	 * @param opts - Spawn options (model, permissionMode; appendSystemPrompt ignored)
	 * @returns Shell command string suitable for tmux new-session -c
	 */
	buildSpawnCommand(opts: SpawnOpts): string {
		let cmd = `gemini -m ${opts.model}`;

		if (opts.permissionMode === "bypass") {
			cmd += " --approval-mode yolo";
		}

		// appendSystemPrompt and appendSystemPromptFile are intentionally ignored.
		// The gemini CLI has no --append-system-prompt equivalent. Role definitions
		// are deployed via GEMINI.md (the instruction file) by deployConfig().

		return cmd;
	}

	/**
	 * Build the argv array for a headless one-shot Gemini invocation.
	 *
	 * Returns an argv array suitable for `Bun.spawn()`. The `-p` flag
	 * triggers headless mode — the CLI processes the prompt (including tool
	 * invocations) and exits. `--yolo` auto-approves tool calls; without it,
	 * unapproved tool calls fail rather than hang.
	 *
	 * Used by merge/resolver.ts and watchdog/triage.ts for AI-assisted operations.
	 *
	 * @param prompt - The prompt to pass via `-p`
	 * @param model - Optional model override
	 * @returns Argv array for Bun.spawn
	 */
	buildPrintCommand(prompt: string, model?: string): string[] {
		const cmd = ["gemini", "-p", prompt, "--yolo"];
		if (model !== undefined) {
			cmd.push("-m", model);
		}
		return cmd;
	}

	/**
	 * Deploy per-agent instructions and guards to a worktree.
	 *
	 * Writes the overlay to `GEMINI.md` in the worktree root (Gemini's
	 * native context file convention). Deploys hooks to `.gemini/settings.json`
	 * for guard enforcement (path boundary, dangerous commands, capability-based).
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
			const geminiPath = join(worktreePath, this.instructionPath);
			await mkdir(dirname(geminiPath), { recursive: true });
			await Bun.write(geminiPath, overlay.content);
		}

		const geminiHooks = generateGeminiHooks(hooks);
		const settingsDir = join(worktreePath, ".gemini");
		await mkdir(settingsDir, { recursive: true });

		// Merge with existing settings if present
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
		const { hooks: _existingHooks, ...nonHooksKeys } = existing;
		const merged = { ...nonHooksKeys, ...geminiHooks };
		await Bun.write(settingsPath, `${JSON.stringify(merged, null, "\t")}\n`);
	}

	/**
	 * Detect Gemini TUI readiness from a tmux pane content snapshot.
	 *
	 * Gemini uses an Ink-based React TUI. Detection requires both a
	 * prompt indicator AND a Gemini branding indicator:
	 *
	 * - Prompt: "> " prefix, placeholder "type your message", or U+276F (❯)
	 * - Branding: "gemini" visible in the TUI header or status area
	 *
	 * No trust dialog phase exists for Gemini (unlike Claude Code).
	 *
	 * @param paneContent - Captured tmux pane content to analyze
	 * @returns Current readiness phase (never "dialog" for Gemini)
	 */
	detectReady(paneContent: string): ReadyState {
		const lower = paneContent.toLowerCase();

		// Prompt indicator: placeholder text, "> " at line start, or ❯ character.
		const hasPrompt =
			lower.includes("type your message") ||
			/^> /m.test(paneContent) ||
			paneContent.includes("\u276f");

		// Branding indicator: "gemini" visible in TUI header/status.
		const hasGemini = lower.includes("gemini");

		if (hasPrompt && hasGemini) {
			return { phase: "ready" };
		}

		return { phase: "loading" };
	}

	/**
	 * Parse a Gemini NDJSON transcript file into normalized token usage.
	 *
	 * Gemini's `--output-format stream-json` produces NDJSON with these events:
	 * - `init`: carries `model` and `session_id`
	 * - `message`: user/assistant messages (content chunks when delta=true)
	 * - `tool_use` / `tool_result`: tool call lifecycle
	 * - `result`: final event with `stats.input_tokens` and `stats.output_tokens`
	 *
	 * Returns null if the file does not exist or cannot be parsed.
	 *
	 * @param path - Absolute path to the Gemini NDJSON transcript file
	 * @returns Aggregated token usage, or null if unavailable
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
					// Skip malformed lines — partial writes during capture.
					continue;
				}

				// Model from init event.
				if (event.type === "init" && typeof event.model === "string") {
					model = event.model;
				}

				// Token usage from result event's stats field.
				if (event.type === "result" && typeof event.stats === "object" && event.stats !== null) {
					const stats = event.stats as Record<string, unknown>;
					const inp = stats.input_tokens;
					const out = stats.output_tokens;
					if (typeof inp === "number") {
						inputTokens += inp;
					}
					if (typeof out === "number") {
						outputTokens += out;
					}
				}

				// Fallback: capture model from any event that carries it.
				if (typeof event.model === "string" && event.model && !model) {
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
	 *
	 * Returns the provider environment variables from the resolved model.
	 * For Google native: may include GEMINI_API_KEY.
	 * For gateway providers: may include gateway-specific auth and routing vars.
	 *
	 * @param model - Resolved model with optional provider env vars
	 * @returns Environment variable map (may be empty)
	 */
	buildEnv(model: ResolvedModel): Record<string, string> {
		return model.env ?? {};
	}

	/** Gemini does not produce transcript files. */
	getTranscriptDir(_projectRoot: string): string | null {
		return null;
	}
}
