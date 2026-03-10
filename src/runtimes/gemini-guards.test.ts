import { describe, expect, test } from "bun:test";
import { generateGeminiHooks } from "./gemini-guards.ts";
import type { HooksDef } from "./types.ts";

describe("generateGeminiHooks", () => {
	const builderHooks: HooksDef = {
		agentName: "test-builder",
		capability: "builder",
		worktreePath: "/tmp/worktree",
	};

	const scoutHooks: HooksDef = {
		agentName: "test-scout",
		capability: "scout",
		worktreePath: "/tmp/worktree",
	};

	describe("structure", () => {
		test("returns object with hooks key", () => {
			const result = generateGeminiHooks(builderHooks);
			expect(result.hooks).toBeDefined();
		});

		test("contains all lifecycle event types", () => {
			const result = generateGeminiHooks(builderHooks);
			expect(result.hooks.SessionStart).toBeDefined();
			expect(result.hooks.BeforeAgent).toBeDefined();
			expect(result.hooks.BeforeTool).toBeDefined();
			expect(result.hooks.AfterTool).toBeDefined();
			expect(result.hooks.SessionEnd).toBeDefined();
			expect(result.hooks.PreCompress).toBeDefined();
		});

		test("does not contain Claude Code event names", () => {
			const result = generateGeminiHooks(builderHooks);
			const keys = Object.keys(result.hooks);
			expect(keys).not.toContain("PreToolUse");
			expect(keys).not.toContain("PostToolUse");
			expect(keys).not.toContain("Stop");
			expect(keys).not.toContain("PreCompact");
			expect(keys).not.toContain("UserPromptSubmit");
		});
	});

	describe("tool name mapping", () => {
		test("BeforeTool uses Gemini tool names", () => {
			const result = generateGeminiHooks(builderHooks);
			const matchers = result.hooks.BeforeTool.map((e) => e.matcher).filter(Boolean);
			expect(matchers).toContain("write_file");
			expect(matchers).toContain("replace");
			expect(matchers).toContain("run_shell_command");
		});

		test("does not use Claude Code tool names", () => {
			const result = generateGeminiHooks(builderHooks);
			const matchers = result.hooks.BeforeTool.map((e) => e.matcher).filter(Boolean);
			expect(matchers).not.toContain("Write");
			expect(matchers).not.toContain("Edit");
			expect(matchers).not.toContain("Bash");
			expect(matchers).not.toContain("NotebookEdit");
		});

		test("AfterTool uses run_shell_command for git commit hook", () => {
			const result = generateGeminiHooks(builderHooks);
			const shellMatchers = result.hooks.AfterTool
				.filter((e) => e.matcher === "run_shell_command");
			expect(shellMatchers.length).toBeGreaterThan(0);
		});
	});

	describe("decision format", () => {
		test("guard scripts contain deny decision", () => {
			const result = generateGeminiHooks(builderHooks);
			const allCommands = result.hooks.BeforeTool
				.flatMap((e) => e.hooks.map((h) => h.command));
			const guardCommands = allCommands.filter((c) => c.includes("decision"));
			expect(guardCommands.length).toBeGreaterThan(0);
			for (const cmd of guardCommands) {
				expect(cmd).toContain("deny");
				expect(cmd).not.toContain('"decision":"block"');
			}
		});
	});

	describe("interactive and team tool guards", () => {
		test("blocks ask_user and enter_plan_mode", () => {
			const result = generateGeminiHooks(builderHooks);
			const matchers = result.hooks.BeforeTool.map((e) => e.matcher).filter(Boolean);
			expect(matchers).toContain("ask_user");
			expect(matchers).toContain("enter_plan_mode");
		});

		test("blocks complete_task and write_todos", () => {
			const result = generateGeminiHooks(builderHooks);
			const matchers = result.hooks.BeforeTool.map((e) => e.matcher).filter(Boolean);
			expect(matchers).toContain("complete_task");
			expect(matchers).toContain("write_todos");
		});

		test("does not block Claude-only team tools", () => {
			const result = generateGeminiHooks(builderHooks);
			const matchers = result.hooks.BeforeTool.map((e) => e.matcher).filter(Boolean);
			expect(matchers).not.toContain("Task");
			expect(matchers).not.toContain("TeamCreate");
			expect(matchers).not.toContain("SendMessage");
		});
	});

	describe("capability guards", () => {
		test("non-implementation capability blocks write_file and replace", () => {
			const result = generateGeminiHooks(scoutHooks);
			const allCommands = result.hooks.BeforeTool
				.flatMap((e) => e.hooks.map((h) => h.command));
			const blockMessages = allCommands.filter((c) =>
				c.includes("scout agents cannot modify files"),
			);
			expect(blockMessages.length).toBeGreaterThanOrEqual(2);
		});

		test("implementation capability gets bash path boundary guard", () => {
			const result = generateGeminiHooks(builderHooks);
			const shellEntries = result.hooks.BeforeTool.filter(
				(e) => e.matcher === "run_shell_command",
			);
			const hasBoundaryGuard = shellEntries.some((e) =>
				e.hooks.some((h) => h.command.includes("OVERSTORY_WORKTREE_PATH")),
			);
			expect(hasBoundaryGuard).toBe(true);
		});

		test("non-implementation capability gets bash file guard", () => {
			const result = generateGeminiHooks(scoutHooks);
			const shellEntries = result.hooks.BeforeTool.filter(
				(e) => e.matcher === "run_shell_command",
			);
			const hasFileGuard = shellEntries.some((e) =>
				e.hooks.some((h) => h.command.includes("cannot modify files")),
			);
			expect(hasFileGuard).toBe(true);
		});
	});

	describe("lifecycle hooks", () => {
		test("SessionStart runs ov prime and ov mail check", () => {
			const result = generateGeminiHooks(builderHooks);
			const commands = result.hooks.SessionStart.flatMap((e) =>
				e.hooks.map((h) => h.command),
			);
			expect(commands.some((c) => c.includes("ov prime --agent test-builder"))).toBe(true);
			expect(commands.some((c) => c.includes("ov mail check --inject --agent test-builder"))).toBe(true);
		});

		test("BeforeAgent runs mail check", () => {
			const result = generateGeminiHooks(builderHooks);
			const commands = result.hooks.BeforeAgent.flatMap((e) =>
				e.hooks.map((h) => h.command),
			);
			expect(commands.some((c) => c.includes("ov mail check --inject"))).toBe(true);
		});

		test("SessionEnd runs session-end log and ml learn", () => {
			const result = generateGeminiHooks(builderHooks);
			const commands = result.hooks.SessionEnd.flatMap((e) =>
				e.hooks.map((h) => h.command),
			);
			expect(commands.some((c) => c.includes("ov log session-end"))).toBe(true);
			expect(commands.some((c) => c.includes("ml learn"))).toBe(true);
		});

		test("PreCompress runs ov prime --compact", () => {
			const result = generateGeminiHooks(builderHooks);
			const commands = result.hooks.PreCompress.flatMap((e) =>
				e.hooks.map((h) => h.command),
			);
			expect(commands.some((c) => c.includes("ov prime --agent test-builder --compact"))).toBe(true);
		});

		test("BeforeTool includes tool-start logging (wildcard entry)", () => {
			const result = generateGeminiHooks(builderHooks);
			const wildcardEntries = result.hooks.BeforeTool.filter((e) => !e.matcher);
			const commands = wildcardEntries.flatMap((e) => e.hooks.map((h) => h.command));
			expect(commands.some((c) => c.includes("ov log tool-start"))).toBe(true);
		});

		test("AfterTool includes tool-end logging and mail check", () => {
			const result = generateGeminiHooks(builderHooks);
			const commands = result.hooks.AfterTool.flatMap((e) =>
				e.hooks.map((h) => h.command),
			);
			expect(commands.some((c) => c.includes("ov log tool-end"))).toBe(true);
			expect(commands.some((c) => c.includes("ov mail check --inject"))).toBe(true);
		});
	});

	describe("PATH prefix", () => {
		test("lifecycle hooks include PATH prefix for bun CLI resolution", () => {
			const result = generateGeminiHooks(builderHooks);
			const sessionStartCmd = result.hooks.SessionStart[0]?.hooks[0]?.command ?? "";
			expect(sessionStartCmd).toContain(".bun/bin");
		});
	});

	describe("agent name injection", () => {
		test("agent name appears in lifecycle hook commands", () => {
			const customHooks: HooksDef = {
				agentName: "my-custom-agent",
				capability: "builder",
				worktreePath: "/tmp/wt",
			};
			const result = generateGeminiHooks(customHooks);
			const allCommands = [
				...result.hooks.SessionStart,
				...result.hooks.BeforeAgent,
				...result.hooks.AfterTool,
				...result.hooks.SessionEnd,
				...result.hooks.PreCompress,
			].flatMap((e) => e.hooks.map((h) => h.command));

			const withAgent = allCommands.filter((c) => c.includes("my-custom-agent"));
			expect(withAgent.length).toBeGreaterThan(0);
		});

		test("agent name appears in bash guard for branch naming", () => {
			const result = generateGeminiHooks(builderHooks);
			const shellEntries = result.hooks.BeforeTool.filter(
				(e) => e.matcher === "run_shell_command",
			);
			const hasBranchGuard = shellEntries.some((e) =>
				e.hooks.some((h) => h.command.includes("overstory/test-builder/")),
			);
			expect(hasBranchGuard).toBe(true);
		});
	});

	describe("tracker close guard", () => {
		test("includes tracker close guard for run_shell_command", () => {
			const result = generateGeminiHooks(builderHooks);
			const shellEntries = result.hooks.BeforeTool.filter(
				(e) => e.matcher === "run_shell_command",
			);
			const hasTrackerGuard = shellEntries.some((e) =>
				e.hooks.some((h) => h.command.includes("OVERSTORY_TASK_ID")),
			);
			expect(hasTrackerGuard).toBe(true);
		});
	});
});
