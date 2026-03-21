// Gemini/Qwen CLI hook generator for overstory guard deployment.
// Generates hooks config compatible with Gemini CLI (v0.26.0+) and Qwen Code.
//
// Reuses guard constants from guard-rules.ts and guard generation functions from
// hooks-deployer.ts, translating Claude Code conventions to Gemini/Qwen conventions:
// - Tool names: Write → write_file, Edit → replace, Bash → run_shell_command
// - Decision: "block" → "deny"
// - Event names: configurable via EventNameMap (Gemini vs Qwen differ)
//   Gemini: BeforeTool/AfterTool/PreCompress/BeforeAgent
//   Qwen:   PreToolUse/PostToolUse/PreCompact (no BeforeAgent)

import { DANGEROUS_BASH_PATTERNS, SAFE_BASH_PREFIXES } from "../agents/guard-rules.ts";
import {
	escapeForSingleQuotedShell,
	extractQualityGatePrefixes,
	PATH_PREFIX,
} from "../agents/hooks-deployer.ts";
import { DEFAULT_QUALITY_GATES } from "../config.ts";
import type { HooksDef } from "./types.ts";

/** Hook entry shape for Gemini/Qwen CLI settings.json. */
export interface GeminiHookEntry {
	matcher?: string;
	hooks: Array<{ type: string; command: string; timeout?: number }>;
}

/**
 * Runtime-specific configuration for hook generation.
 * Covers event names and tool name differences between Gemini/Qwen forks.
 * Empty string for an event means it is not supported and should be omitted.
 */
export interface RuntimeHookConfig {
	// Event names
	sessionStart: string;
	beforeAgent: string;
	beforeTool: string;
	afterTool: string;
	sessionEnd: string;
	preCompress: string;
	// Tool names (Gemini uses "replace", Qwen renamed to "edit")
	editTool: string;
}

/** Gemini CLI config (v0.32+): BeforeTool/AfterTool, edit tool = "replace". */
export const GEMINI_HOOK_CONFIG: RuntimeHookConfig = {
	sessionStart: "SessionStart",
	beforeAgent: "BeforeAgent",
	beforeTool: "BeforeTool",
	afterTool: "AfterTool",
	sessionEnd: "SessionEnd",
	preCompress: "PreCompress",
	editTool: "replace",
};

/** Qwen Code config (PR #2203): PreToolUse/PostToolUse, edit tool = "edit". */
export const QWEN_HOOK_CONFIG: RuntimeHookConfig = {
	sessionStart: "SessionStart",
	beforeAgent: "",
	beforeTool: "PreToolUse",
	afterTool: "PostToolUse",
	sessionEnd: "SessionEnd",
	preCompress: "PreCompact",
	editTool: "edit",
};

/** @deprecated Use GEMINI_HOOK_CONFIG instead */
export const GEMINI_EVENT_NAMES = GEMINI_HOOK_CONFIG;
/** @deprecated Use QWEN_HOOK_CONFIG instead */
export const QWEN_EVENT_NAMES = QWEN_HOOK_CONFIG;

/** Generated hooks config with dynamic event name keys. */
export type HooksConfig = {
	hooks: Record<string, GeminiHookEntry[]>;
};

/**
 * Claude Code → Gemini CLI tool name mapping.
 * NotebookEdit has no Gemini equivalent and is skipped.
 */
const _TOOL_NAME_MAP: Record<string, string> = {
	Write: "write_file",
	Edit: "replace",
	Bash: "run_shell_command",
};

/**
 * Gemini equivalents of Claude Code's interactive tools.
 * Only tools that actually exist in Gemini CLI are included.
 */
const GEMINI_INTERACTIVE_TOOLS = ["ask_user", "enter_plan_mode"];

/**
 * Gemini equivalents of Claude Code's native team/task tools.
 * Only tools that actually exist in Gemini CLI are included.
 */
const GEMINI_TEAM_TOOLS = ["complete_task", "write_todos"];

/** Env var guard — no-op when not running as overstory agent. */
const ENV_GUARD = '[ -z "$OVERSTORY_AGENT_NAME" ] && exit 0;';

/** Capabilities that must never modify project files. */
const NON_IMPLEMENTATION_CAPABILITIES = new Set([
	"scout",
	"reviewer",
	"lead",
	"coordinator",
	"supervisor",
	"monitor",
	"mission-analyst",
	"plan-review-lead",
]);

/** Coordination capabilities that get git add/commit whitelisted. */
const COORDINATION_CAPABILITIES = new Set([
	"coordinator",
	"coordinator-mission",
	"execution-director",
	"supervisor",
	"monitor",
]);

const COORDINATION_SAFE_PREFIXES = ["git add", "git commit"];

const IMPLEMENTATION_CAPABILITIES = new Set(["builder", "merger"]);

/**
 * Translate a Claude Code guard command to Gemini format.
 * Replaces `"block"` → `"deny"` in JSON decision outputs.
 */
function _translateCommand(cmd: string): string {
	return cmd.replace(/"decision":"block"/g, '"decision":"deny"');
}

/**
 * Build a block guard that denies a specific tool call.
 */
function denyGuard(toolName: string, reason: string): GeminiHookEntry {
	const response = JSON.stringify({ decision: "deny", reason });
	return {
		matcher: toolName,
		hooks: [
			{
				type: "command",
				command: `${ENV_GUARD} echo '${escapeForSingleQuotedShell(response)}'`,
			},
		],
	};
}

/**
 * Build Bash danger guard script for Gemini format.
 * Checks for git push, git reset --hard, wrong branch naming.
 */
function buildGeminiBashGuardScript(agentName: string): string {
	const script = [
		ENV_GUARD,
		"read -r INPUT;",
		'CMD=$(echo "$INPUT" | sed \'s/.*"command": *"\\([^"]*\\)".*/\\1/\');',
		"if echo \"$CMD\" | grep -qE '\\bgit\\s+push\\b'; then",
		'  echo \'{"decision":"deny","reason":"git push is blocked — use ov merge to integrate changes, push manually when ready"}\';',
		"  exit 0;",
		"fi;",
		"if echo \"$CMD\" | grep -qE 'git\\s+reset\\s+--hard'; then",
		'  echo \'{"decision":"deny","reason":"git reset --hard is not allowed — it destroys uncommitted work"}\';',
		"  exit 0;",
		"fi;",
		"if echo \"$CMD\" | grep -qE 'git\\s+checkout\\s+-b\\s'; then",
		`  BRANCH=$(echo "$CMD" | sed 's/.*git\\s*checkout\\s*-b\\s*\\([^ ]*\\).*/\\1/');`,
		`  if ! echo "$BRANCH" | grep -qE '^overstory/${agentName}/'; then`,
		`    echo '{"decision":"deny","reason":"Branch must follow overstory/${agentName}/{task-id} convention"}';`,
		"    exit 0;",
		"  fi;",
		"fi;",
	].join(" ");
	return script;
}

/**
 * Build path boundary guard for Gemini format (uses "deny" instead of "block").
 */
function buildGeminiPathBoundaryScript(filePathField: string): string {
	const script = [
		ENV_GUARD,
		'[ -z "$OVERSTORY_WORKTREE_PATH" ] && exit 0;',
		"read -r INPUT;",
		`FILE_PATH=$(echo "$INPUT" | sed -n 's/.*"${filePathField}": *"\\([^"]*\\)".*/\\1/p');`,
		'[ -z "$FILE_PATH" ] && exit 0;',
		'case "$FILE_PATH" in /*) ;; *) FILE_PATH="$(pwd)/$FILE_PATH" ;; esac;',
		'case "$FILE_PATH" in "$OVERSTORY_WORKTREE_PATH"/*) exit 0 ;; "$OVERSTORY_WORKTREE_PATH") exit 0 ;; esac;',
		'echo \'{"decision":"deny","reason":"Path boundary violation: file is outside your assigned worktree. All writes must target files within your worktree."}\';',
	].join(" ");
	return script;
}

/**
 * Build Bash file guard for non-implementation agents (Gemini format).
 */
function buildGeminiBashFileGuardScript(
	capability: string,
	extraSafePrefixes: string[] = [],
): string {
	const allSafePrefixes = [...SAFE_BASH_PREFIXES, ...extraSafePrefixes];
	const safePrefixChecks = allSafePrefixes
		.map((prefix) => `if echo "$CMD" | grep -qE '^\\s*${prefix}'; then exit 0; fi;`)
		.join(" ");

	const dangerPattern = DANGEROUS_BASH_PATTERNS.join("|");

	const script = [
		ENV_GUARD,
		"read -r INPUT;",
		'CMD=$(echo "$INPUT" | sed \'s/.*"command": *"\\([^"]*\\)".*/\\1/\');',
		safePrefixChecks,
		`if echo "$CMD" | grep -qE '${dangerPattern}'; then`,
		`  echo '{"decision":"deny","reason":"${capability} agents cannot modify files — this command is not allowed"}';`,
		"  exit 0;",
		"fi;",
	].join(" ");
	return script;
}

/**
 * Build Bash path boundary guard for implementation agents (Gemini format).
 */
function buildGeminiBashPathBoundaryGuardScript(): string {
	const fileModifyPatterns = [
		"sed\\s+-i",
		"sed\\s+--in-place",
		"echo\\s+.*>",
		"printf\\s+.*>",
		"cat\\s+.*>",
		"tee\\s",
		"\\bmv\\s",
		"\\bcp\\s",
		"\\brm\\s",
		"\\bmkdir\\s",
		"\\btouch\\s",
		"\\bchmod\\s",
		"\\bchown\\s",
		">>",
		"\\binstall\\s",
		"\\brsync\\s",
	];
	const fileModifyPattern = fileModifyPatterns.join("|");

	const script = [
		ENV_GUARD,
		'[ -z "$OVERSTORY_WORKTREE_PATH" ] && exit 0;',
		"read -r INPUT;",
		'CMD=$(echo "$INPUT" | sed \'s/.*"command": *"\\([^"]*\\)".*/\\1/\');',
		`if ! echo "$CMD" | grep -qE '${fileModifyPattern}'; then exit 0; fi;`,
		"PATHS=$(echo \"$CMD\" | tr ' \\t' '\\n\\n' | grep '^/' | sed 's/[\";>]*$//');",
		'[ -z "$PATHS" ] && exit 0;',
		'echo "$PATHS" | while IFS= read -r P; do',
		'  case "$P" in',
		'    "$OVERSTORY_WORKTREE_PATH"/*) ;;',
		'    "$OVERSTORY_WORKTREE_PATH") ;;',
		"    /dev/*) ;;",
		"    /tmp/*) ;;",
		'    *) echo \'{"decision":"deny","reason":"Bash path boundary violation: command targets a path outside your worktree. All file modifications must stay within your assigned worktree."}\'; exit 0; ;;',
		"  esac;",
		"done;",
	].join(" ");
	return script;
}

/**
 * Build tracker close guard for Gemini format.
 */
function buildGeminiTrackerCloseGuardScript(): string {
	const script = [
		ENV_GUARD,
		'[ -z "$OVERSTORY_TASK_ID" ] && exit 0;',
		"read -r INPUT;",
		'CMD=$(echo "$INPUT" | sed \'s/.*"command": *"\\([^"]*\\)".*/\\1/\');',
		"if echo \"$CMD\" | grep -qE '^\\s*(sd|bd)\\s+close\\s'; then",
		"  ISSUE_ID=$(echo \"$CMD\" | sed -E 's/^[[:space:]]*(sd|bd)[[:space:]]+close[[:space:]]+([^ ]+).*/\\2/');",
		'  if [ "$ISSUE_ID" != "$OVERSTORY_TASK_ID" ]; then',
		'    echo "{\\"decision\\":\\"deny\\",\\"reason\\":\\"Cannot close issue $ISSUE_ID — agents may only close their own task ($OVERSTORY_TASK_ID). Report completion via worker_done mail to your parent instead.\\"}";',
		"    exit 0;",
		"  fi;",
		"fi;",
		"if echo \"$CMD\" | grep -qE '^\\s*(sd|bd)\\s+update\\s.*--status'; then",
		"  ISSUE_ID=$(echo \"$CMD\" | sed -E 's/^[[:space:]]*(sd|bd)[[:space:]]+update[[:space:]]+([^ ]+).*/\\2/');",
		'  if [ "$ISSUE_ID" != "$OVERSTORY_TASK_ID" ]; then',
		'    echo "{\\"decision\\":\\"deny\\",\\"reason\\":\\"Cannot update issue $ISSUE_ID — agents may only update their own task ($OVERSTORY_TASK_ID).\\"}";',
		"    exit 0;",
		"  fi;",
		"fi;",
	].join(" ");
	return script;
}

/**
 * Generate Gemini/Qwen CLI hooks configuration.
 *
 * Returns a settings object with a `hooks` key containing all guard and
 * lifecycle hooks. Event names are configurable via `eventNames` parameter
 * to support both Gemini CLI (BeforeTool/AfterTool) and Qwen Code
 * (PreToolUse/PostToolUse) conventions.
 *
 * @param hooks - Agent hook definition (name, capability, worktree path)
 * @param eventNames - Event name mapping (default: Gemini names)
 * @returns Object with `hooks` key ready to merge into settings.json
 */
export function generateGeminiHooks(
	hooks: HooksDef,
	eventNames: RuntimeHookConfig = GEMINI_HOOK_CONFIG,
): HooksConfig {
	const { agentName, capability, qualityGates } = hooks;
	const gates = qualityGates ?? DEFAULT_QUALITY_GATES;
	const gatePrefixes = extractQualityGatePrefixes(gates);

	const beforeToolGuards: GeminiHookEntry[] = [];

	const editTool = eventNames.editTool;

	// Path boundary guards for write_file and edit/replace
	beforeToolGuards.push({
		matcher: "write_file",
		hooks: [{ type: "command", command: buildGeminiPathBoundaryScript("file_path") }],
	});
	beforeToolGuards.push({
		matcher: editTool,
		hooks: [{ type: "command", command: buildGeminiPathBoundaryScript("file_path") }],
	});

	// Bash danger guards (git push, reset --hard, branch naming)
	beforeToolGuards.push({
		matcher: "run_shell_command",
		hooks: [{ type: "command", command: buildGeminiBashGuardScript(agentName) }],
	});

	// Block interactive tools
	for (const tool of GEMINI_INTERACTIVE_TOOLS) {
		beforeToolGuards.push(
			denyGuard(
				tool,
				`${tool} requires human interaction — agents run non-interactively. Use ov mail (--type question) to escalate`,
			),
		);
	}

	// Block team/task tools
	for (const tool of GEMINI_TEAM_TOOLS) {
		beforeToolGuards.push(
			denyGuard(
				tool,
				`Overstory agents must use 'ov sling' for delegation — ${tool} is not allowed`,
			),
		);
	}

	// Capability-specific guards
	if (NON_IMPLEMENTATION_CAPABILITIES.has(capability)) {
		// Block file write tools
		beforeToolGuards.push(
			denyGuard(
				"write_file",
				`${capability} agents cannot modify files — write_file is not allowed`,
			),
		);
		beforeToolGuards.push(
			denyGuard(editTool, `${capability} agents cannot modify files — ${editTool} is not allowed`),
		);

		// Bash file guard with safe prefixes
		const extraSafe = COORDINATION_CAPABILITIES.has(capability)
			? [...COORDINATION_SAFE_PREFIXES, ...gatePrefixes]
			: gatePrefixes;
		beforeToolGuards.push({
			matcher: "run_shell_command",
			hooks: [
				{
					type: "command",
					command: buildGeminiBashFileGuardScript(capability, extraSafe),
				},
			],
		});
	}

	// Implementation agents get bash path boundary guards
	if (IMPLEMENTATION_CAPABILITIES.has(capability)) {
		beforeToolGuards.push({
			matcher: "run_shell_command",
			hooks: [{ type: "command", command: buildGeminiBashPathBoundaryGuardScript() }],
		});
	}

	// Tracker close guard
	beforeToolGuards.push({
		matcher: "run_shell_command",
		hooks: [{ type: "command", command: buildGeminiTrackerCloseGuardScript() }],
	});

	// Lifecycle hooks
	const sessionStart: GeminiHookEntry[] = [
		{
			hooks: [
				{
					type: "command",
					command: `${PATH_PREFIX} ${ENV_GUARD} ov prime --agent ${agentName}`,
				},
				{
					type: "command",
					command: `${PATH_PREFIX} ${ENV_GUARD} ov mail check --inject --agent ${agentName}`,
				},
			],
		},
	];

	const beforeAgent: GeminiHookEntry[] = [
		{
			hooks: [
				{
					type: "command",
					command: `${PATH_PREFIX} ${ENV_GUARD} ov mail check --inject --agent ${agentName}`,
				},
			],
		},
	];

	// Add tool-start logging to BeforeTool (wildcard — no matcher)
	const beforeToolWithLogging: GeminiHookEntry[] = [
		{
			hooks: [
				{
					type: "command",
					command: `${PATH_PREFIX} ${ENV_GUARD} ov log tool-start --agent ${agentName} --stdin`,
				},
			],
		},
		...beforeToolGuards,
	];

	const afterTool: GeminiHookEntry[] = [
		{
			hooks: [
				{
					type: "command",
					command: `${PATH_PREFIX} ${ENV_GUARD} ov log tool-end --agent ${agentName} --stdin`,
				},
				{
					type: "command",
					command: `${PATH_PREFIX} ${ENV_GUARD} ov mail check --inject --agent ${agentName} --debounce 500`,
				},
			],
		},
		{
			hooks: [
				{
					type: "command",
					command: `${PATH_PREFIX} ${ENV_GUARD} ov mail check --inject --agent ${agentName} --debounce 30000`,
				},
			],
		},
		{
			matcher: "run_shell_command",
			hooks: [
				{
					type: "command",
					command: `${PATH_PREFIX} ${ENV_GUARD} read -r INPUT; if echo "$INPUT" | grep -qE '\\bgit\\s+commit\\b'; then ml diff HEAD~1 >/dev/null 2>&1 || true; fi; exit 0;`,
				},
			],
		},
	];

	const sessionEnd: GeminiHookEntry[] = [
		{
			hooks: [
				{
					type: "command",
					command: `${PATH_PREFIX} ${ENV_GUARD} ov log session-end --agent ${agentName} --stdin`,
				},
				{
					type: "command",
					command: `${PATH_PREFIX} ${ENV_GUARD} ml learn`,
				},
			],
		},
	];

	const preCompress: GeminiHookEntry[] = [
		{
			hooks: [
				{
					type: "command",
					command: `${PATH_PREFIX} ${ENV_GUARD} ov prime --agent ${agentName} --compact`,
				},
			],
		},
	];

	const hooksMap: Record<string, GeminiHookEntry[]> = {};
	hooksMap[eventNames.sessionStart] = sessionStart;
	if (eventNames.beforeAgent) {
		hooksMap[eventNames.beforeAgent] = beforeAgent;
	}
	hooksMap[eventNames.beforeTool] = beforeToolWithLogging;
	hooksMap[eventNames.afterTool] = afterTool;
	hooksMap[eventNames.sessionEnd] = sessionEnd;
	hooksMap[eventNames.preCompress] = preCompress;

	return { hooks: hooksMap };
}
