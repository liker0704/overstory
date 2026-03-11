import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Spawner } from "../commands/init.ts";
import { initCommand } from "../commands/init.ts";
import { loadConfig } from "../config.ts";
import { GeminiRuntime } from "../runtimes/gemini.ts";
import { QwenRuntime } from "../runtimes/qwen.ts";
import type { HooksDef } from "../runtimes/types.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";

/**
 * E2E test: runtime deployConfig on a real overstory-initialized project.
 *
 * Creates a real temp git repo, runs `ov init`, then deploys Gemini and Qwen
 * runtime configs into worktree-like directories. Validates:
 * - Instruction files written correctly (GEMINI.md / AGENTS.md)
 * - Settings files created with hooks
 * - Guard structure matches Gemini CLI hooks format
 * - Multiple capabilities produce different guard sets
 * - Full init → config → deploy pipeline works end-to-end
 *
 * Uses real filesystem and git repos. No mocks.
 */

const noopSpawner: Spawner = async () => ({ exitCode: 1, stdout: "", stderr: "not found" });

describe("E2E: runtime deployConfig on initialized project", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		originalCwd = process.cwd();
		process.chdir(tempDir);
		originalWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		process.stdout.write = originalWrite;
		await cleanupTempDir(tempDir);
	});

	describe("Gemini runtime", () => {
		const runtime = new GeminiRuntime();

		test("full pipeline: init → loadConfig → deployConfig with overlay", async () => {
			await initCommand({ _spawner: noopSpawner });
			const config = await loadConfig(tempDir);
			expect(config.project.root).toBe(tempDir);

			const worktreePath = join(tempDir, ".overstory", "worktrees", "gemini-builder");
			const hooks: HooksDef = {
				agentName: "gemini-builder",
				capability: "builder",
				worktreePath,
			};

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Builder Instructions\n\nBuild the feature." },
				hooks,
			);

			// GEMINI.md written
			const geminiMd = await Bun.file(join(worktreePath, "GEMINI.md")).text();
			expect(geminiMd).toBe("# Builder Instructions\n\nBuild the feature.");

			// .gemini/settings.json exists with hooks
			const settingsPath = join(worktreePath, ".gemini", "settings.json");
			const settings = (await Bun.file(settingsPath).json()) as Record<string, unknown>;
			expect(settings.hooks).toBeDefined();

			const hooks_ = settings.hooks as Record<string, unknown[]>;
			expect(hooks_.SessionStart).toBeDefined();
			expect(hooks_.BeforeAgent).toBeDefined();
			expect(hooks_.BeforeTool).toBeDefined();
			expect(hooks_.AfterTool).toBeDefined();
			expect(hooks_.SessionEnd).toBeDefined();
			expect(hooks_.PreCompress).toBeDefined();
		});

		test("deployConfig without overlay still deploys hooks", async () => {
			await initCommand({ _spawner: noopSpawner });

			const worktreePath = join(tempDir, ".overstory", "worktrees", "gemini-coord");
			const hooks: HooksDef = {
				agentName: "gemini-coord",
				capability: "coordinator",
				worktreePath,
			};

			await runtime.deployConfig(worktreePath, undefined, hooks);

			// No GEMINI.md
			expect(await Bun.file(join(worktreePath, "GEMINI.md")).exists()).toBe(false);

			// But settings.json has hooks
			const settings = (await Bun.file(
				join(worktreePath, ".gemini", "settings.json"),
			).json()) as Record<string, unknown>;
			expect(settings.hooks).toBeDefined();
		});

		test("builder capability gets path boundary + bash guards", async () => {
			await initCommand({ _spawner: noopSpawner });

			const worktreePath = join(tempDir, ".overstory", "worktrees", "gemini-b1");
			await runtime.deployConfig(
				worktreePath,
				{ content: "# Builder" },
				{ agentName: "gemini-b1", capability: "builder", worktreePath },
			);

			const text = await Bun.file(join(worktreePath, ".gemini", "settings.json")).text();

			// Uses Gemini tool names
			expect(text).toContain("write_file");
			expect(text).toContain("replace");
			expect(text).toContain("run_shell_command");

			// Uses "deny" not "block"
			expect(text).toContain("deny");
			expect(text).not.toMatch(/"decision":"block"/);

			// Contains agent name in lifecycle hooks
			expect(text).toContain("gemini-b1");

			// Does NOT have Claude tool names
			expect(text).not.toMatch(/"matcher":"Write"/);
			expect(text).not.toMatch(/"matcher":"Edit"/);
			expect(text).not.toMatch(/"matcher":"Bash"/);
		});

		test("scout capability blocks write_file and replace", async () => {
			await initCommand({ _spawner: noopSpawner });

			const worktreePath = join(tempDir, ".overstory", "worktrees", "gemini-scout");
			await runtime.deployConfig(
				worktreePath,
				{ content: "# Scout" },
				{ agentName: "gemini-scout", capability: "scout", worktreePath },
			);

			const text = await Bun.file(join(worktreePath, ".gemini", "settings.json")).text();
			expect(text).toContain("scout agents cannot modify files");
		});

		test("settings.json merges with existing keys", async () => {
			await initCommand({ _spawner: noopSpawner });

			const worktreePath = join(tempDir, ".overstory", "worktrees", "gemini-merge");
			const { mkdir } = await import("node:fs/promises");
			const settingsDir = join(worktreePath, ".gemini");
			await mkdir(settingsDir, { recursive: true });

			// Pre-existing settings
			await Bun.write(
				join(settingsDir, "settings.json"),
				JSON.stringify({ customKey: "preserved", hooks: { old: "replaced" } }),
			);

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{ agentName: "gemini-merge", capability: "builder", worktreePath },
			);

			const settings = (await Bun.file(
				join(settingsDir, "settings.json"),
			).json()) as Record<string, unknown>;
			// customKey preserved
			expect(settings.customKey).toBe("preserved");
			// old hooks replaced with new ones
			expect(settings.hooks).toBeDefined();
			const hooks_ = settings.hooks as Record<string, unknown>;
			expect(hooks_.old).toBeUndefined();
			expect(hooks_.BeforeTool).toBeDefined();
		});
	});

	describe("Qwen runtime", () => {
		const runtime = new QwenRuntime();

		test("full pipeline: init → loadConfig → deployConfig with overlay", async () => {
			await initCommand({ _spawner: noopSpawner });
			const config = await loadConfig(tempDir);
			expect(config.project.root).toBe(tempDir);

			const worktreePath = join(tempDir, ".overstory", "worktrees", "qwen-builder");
			const hooks: HooksDef = {
				agentName: "qwen-builder",
				capability: "builder",
				worktreePath,
			};

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Qwen Builder\n\nImplement the feature." },
				hooks,
			);

			// AGENTS.md written
			const agentsMd = await Bun.file(join(worktreePath, "AGENTS.md")).text();
			expect(agentsMd).toBe("# Qwen Builder\n\nImplement the feature.");

			// .qwen/settings.json exists with context and hooks
			const settingsPath = join(worktreePath, ".qwen", "settings.json");
			const settings = (await Bun.file(settingsPath).json()) as Record<string, unknown>;

			// context.fileName set
			expect(settings.context).toEqual({ fileName: "AGENTS.md" });

			// hooks present with Qwen event names
			expect(settings.hooks).toBeDefined();
			const hooks_ = settings.hooks as Record<string, unknown[]>;
			expect(hooks_.SessionStart).toBeDefined();
			expect(hooks_.PreToolUse).toBeDefined();
			expect(hooks_.PostToolUse).toBeDefined();
			expect(hooks_.SessionEnd).toBeDefined();
			expect(hooks_.PreCompact).toBeDefined();
			// Qwen has no BeforeAgent
			expect(hooks_.BeforeAgent).toBeUndefined();
		});

		test("deployConfig without overlay deploys hooks but no AGENTS.md", async () => {
			await initCommand({ _spawner: noopSpawner });

			const worktreePath = join(tempDir, ".overstory", "worktrees", "qwen-coord");
			await runtime.deployConfig(worktreePath, undefined, {
				agentName: "qwen-coord",
				capability: "coordinator",
				worktreePath,
			});

			expect(await Bun.file(join(worktreePath, "AGENTS.md")).exists()).toBe(false);

			const settings = (await Bun.file(
				join(worktreePath, ".qwen", "settings.json"),
			).json()) as Record<string, unknown>;
			expect(settings.context).toEqual({ fileName: "AGENTS.md" });
			expect(settings.hooks).toBeDefined();
		});

		test("builder guards use Qwen tool names and deny format", async () => {
			await initCommand({ _spawner: noopSpawner });

			const worktreePath = join(tempDir, ".overstory", "worktrees", "qwen-b1");
			await runtime.deployConfig(
				worktreePath,
				{ content: "# Builder" },
				{ agentName: "qwen-b1", capability: "builder", worktreePath },
			);

			const text = await Bun.file(join(worktreePath, ".qwen", "settings.json")).text();

			expect(text).toContain("write_file");
			// Qwen uses "edit" not "replace" for the edit tool
			expect(text).toContain('"matcher": "edit"');
			expect(text).not.toContain('"matcher": "replace"');
			expect(text).toContain("run_shell_command");
			expect(text).toContain("deny");
			expect(text).not.toMatch(/"decision":"block"/);
			expect(text).toContain("qwen-b1");
		});

		test("reviewer capability blocks file modifications", async () => {
			await initCommand({ _spawner: noopSpawner });

			const worktreePath = join(tempDir, ".overstory", "worktrees", "qwen-reviewer");
			await runtime.deployConfig(
				worktreePath,
				{ content: "# Reviewer" },
				{ agentName: "qwen-reviewer", capability: "reviewer", worktreePath },
			);

			const text = await Bun.file(join(worktreePath, ".qwen", "settings.json")).text();
			expect(text).toContain("reviewer agents cannot modify files");
		});

		test("settings.json preserves context.fileName when merging", async () => {
			await initCommand({ _spawner: noopSpawner });

			const worktreePath = join(tempDir, ".overstory", "worktrees", "qwen-merge");
			const { mkdir } = await import("node:fs/promises");
			const settingsDir = join(worktreePath, ".qwen");
			await mkdir(settingsDir, { recursive: true });

			// Pre-existing settings with custom key
			await Bun.write(
				join(settingsDir, "settings.json"),
				JSON.stringify({ context: { fileName: "OLD.md" }, customSetting: true }),
			);

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{ agentName: "qwen-merge", capability: "builder", worktreePath },
			);

			const settings = (await Bun.file(
				join(settingsDir, "settings.json"),
			).json()) as Record<string, unknown>;

			// context.fileName overwritten to AGENTS.md (runtime sets it)
			expect(settings.context).toEqual({ fileName: "AGENTS.md" });
			// customSetting preserved
			expect(settings.customSetting).toBe(true);
			// hooks present
			expect(settings.hooks).toBeDefined();
		});
	});

	describe("cross-runtime comparison", () => {
		test("both runtimes produce equivalent guard structure for same capability", async () => {
			await initCommand({ _spawner: noopSpawner });

			const gemini = new GeminiRuntime();
			const qwen = new QwenRuntime();
			const capability = "builder";

			const geminiPath = join(tempDir, ".overstory", "worktrees", "cross-gemini");
			const qwenPath = join(tempDir, ".overstory", "worktrees", "cross-qwen");

			await gemini.deployConfig(
				geminiPath,
				{ content: "# Builder" },
				{ agentName: "cross-gemini", capability, worktreePath: geminiPath },
			);

			await qwen.deployConfig(
				qwenPath,
				{ content: "# Builder" },
				{ agentName: "cross-qwen", capability, worktreePath: qwenPath },
			);

			const geminiSettings = (await Bun.file(
				join(geminiPath, ".gemini", "settings.json"),
			).json()) as Record<string, unknown>;
			const qwenSettings = (await Bun.file(
				join(qwenPath, ".qwen", "settings.json"),
			).json()) as Record<string, unknown>;

			const geminiHooks = geminiSettings.hooks as Record<string, unknown[]>;
			const qwenHooks = qwenSettings.hooks as Record<string, unknown[]>;

			// Gemini uses BeforeTool/AfterTool/BeforeAgent/PreCompress
			expect(Object.keys(geminiHooks).sort()).toEqual(
				["AfterTool", "BeforeAgent", "BeforeTool", "PreCompress", "SessionEnd", "SessionStart"],
			);
			// Qwen uses PreToolUse/PostToolUse/PreCompact (no BeforeAgent)
			expect(Object.keys(qwenHooks).sort()).toEqual(
				["PostToolUse", "PreCompact", "PreToolUse", "SessionEnd", "SessionStart"],
			);

			// Same number of before-tool guards (different key names)
			expect(geminiHooks.BeforeTool?.length).toBe(qwenHooks.PreToolUse?.length);

			// Qwen has context.fileName, Gemini doesn't
			expect(qwenSettings.context).toEqual({ fileName: "AGENTS.md" });
			expect(geminiSettings.context).toBeUndefined();
		});

		test("different capabilities produce different guard counts", async () => {
			await initCommand({ _spawner: noopSpawner });

			const gemini = new GeminiRuntime();

			const builderPath = join(tempDir, ".overstory", "worktrees", "cap-builder");
			const scoutPath = join(tempDir, ".overstory", "worktrees", "cap-scout");

			await gemini.deployConfig(
				builderPath,
				{ content: "# Builder" },
				{ agentName: "cap-builder", capability: "builder", worktreePath: builderPath },
			);

			await gemini.deployConfig(
				scoutPath,
				{ content: "# Scout" },
				{ agentName: "cap-scout", capability: "scout", worktreePath: scoutPath },
			);

			const builderSettings = (await Bun.file(
				join(builderPath, ".gemini", "settings.json"),
			).json()) as Record<string, unknown>;
			const scoutSettings = (await Bun.file(
				join(scoutPath, ".gemini", "settings.json"),
			).json()) as Record<string, unknown>;

			const builderGuards = (builderSettings.hooks as Record<string, unknown[]>).BeforeTool ?? [];
			const scoutGuards = (scoutSettings.hooks as Record<string, unknown[]>).BeforeTool ?? [];

			// Scout has MORE guards (capability blocks for write_file, replace, bash file guard)
			expect(scoutGuards.length).toBeGreaterThan(builderGuards.length);
		});
	});

	describe("guard script validation", () => {
		test("guard scripts are valid shell (no syntax errors)", async () => {
			await initCommand({ _spawner: noopSpawner });

			const gemini = new GeminiRuntime();
			const worktreePath = join(tempDir, ".overstory", "worktrees", "shell-check");

			await gemini.deployConfig(
				worktreePath,
				{ content: "# Builder" },
				{ agentName: "shell-check", capability: "builder", worktreePath },
			);

			const settings = (await Bun.file(
				join(worktreePath, ".gemini", "settings.json"),
			).json()) as Record<string, unknown>;
			const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;

			// Extract all guard commands and validate they parse as shell
			const commands: string[] = [];
			for (const entries of Object.values(hooks)) {
				for (const entry of entries) {
					for (const hook of entry.hooks) {
						commands.push(hook.command);
					}
				}
			}

			expect(commands.length).toBeGreaterThan(0);

			// Each command should run without bash syntax errors
			// (we pass empty stdin so guards just exit 0 or fail gracefully)
			for (const cmd of commands) {
				const proc = Bun.spawn(["bash", "-n", "-c", cmd], {
					stdout: "pipe",
					stderr: "pipe",
				});
				const [stderr, exitCode] = await Promise.all([
					new Response(proc.stderr).text(),
					proc.exited,
				]);
				if (exitCode !== 0) {
					// bash -n checks syntax only
					throw new Error(`Shell syntax error in guard:\n  ${cmd}\n  ${stderr}`);
				}
			}
		});

		test("path boundary guard denies writes outside worktree", async () => {
			await initCommand({ _spawner: noopSpawner });

			const gemini = new GeminiRuntime();
			const worktreePath = join(tempDir, ".overstory", "worktrees", "boundary-test");

			await gemini.deployConfig(
				worktreePath,
				{ content: "# Builder" },
				{ agentName: "boundary-test", capability: "builder", worktreePath },
			);

			const settings = (await Bun.file(
				join(worktreePath, ".gemini", "settings.json"),
			).json()) as Record<string, unknown>;
			const hooks = settings.hooks as Record<
				string,
				Array<{ matcher?: string; hooks: Array<{ command: string }> }>
			>;

			// Find the write_file path boundary guard (first one with matcher "write_file")
			const writeFileGuard = hooks.BeforeTool?.find(
				(e) => e.matcher === "write_file" && e.hooks[0]?.command.includes("OVERSTORY_WORKTREE_PATH"),
			);
			expect(writeFileGuard).toBeDefined();

			const guardCmd = writeFileGuard!.hooks[0]!.command;

			// Simulate: file_path outside worktree → should output deny
			const outsideInput = JSON.stringify({
				tool_name: "write_file",
				tool_input: { file_path: "/etc/passwd" },
			});
			const proc = Bun.spawn(["bash", "-c", guardCmd], {
				stdin: new Blob([outsideInput]),
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					OVERSTORY_AGENT_NAME: "boundary-test",
					OVERSTORY_WORKTREE_PATH: worktreePath,
				},
			});
			const [stdout, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				proc.exited,
			]);

			expect(exitCode).toBe(0);
			expect(stdout).toContain("deny");
			expect(stdout).toContain("Path boundary violation");
		});

		test("path boundary guard allows writes inside worktree", async () => {
			await initCommand({ _spawner: noopSpawner });

			const gemini = new GeminiRuntime();
			const worktreePath = join(tempDir, ".overstory", "worktrees", "boundary-ok");

			await gemini.deployConfig(
				worktreePath,
				{ content: "# Builder" },
				{ agentName: "boundary-ok", capability: "builder", worktreePath },
			);

			const settings = (await Bun.file(
				join(worktreePath, ".gemini", "settings.json"),
			).json()) as Record<string, unknown>;
			const hooks = settings.hooks as Record<
				string,
				Array<{ matcher?: string; hooks: Array<{ command: string }> }>
			>;

			const writeFileGuard = hooks.BeforeTool?.find(
				(e) => e.matcher === "write_file" && e.hooks[0]?.command.includes("OVERSTORY_WORKTREE_PATH"),
			);
			expect(writeFileGuard).toBeDefined();

			const guardCmd = writeFileGuard!.hooks[0]!.command;

			// Simulate: file_path inside worktree → should output nothing (allow)
			const insideInput = JSON.stringify({
				tool_name: "write_file",
				tool_input: { file_path: `${worktreePath}/src/main.ts` },
			});
			const proc = Bun.spawn(["bash", "-c", guardCmd], {
				stdin: new Blob([insideInput]),
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					OVERSTORY_AGENT_NAME: "boundary-ok",
					OVERSTORY_WORKTREE_PATH: worktreePath,
				},
			});
			const [stdout, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				proc.exited,
			]);

			expect(exitCode).toBe(0);
			// No deny output — guard allows the write
			expect(stdout.trim()).toBe("");
		});

		test("bash danger guard blocks git push", async () => {
			await initCommand({ _spawner: noopSpawner });

			const gemini = new GeminiRuntime();
			const worktreePath = join(tempDir, ".overstory", "worktrees", "bash-danger");

			await gemini.deployConfig(
				worktreePath,
				{ content: "# Builder" },
				{ agentName: "bash-danger", capability: "builder", worktreePath },
			);

			const settings = (await Bun.file(
				join(worktreePath, ".gemini", "settings.json"),
			).json()) as Record<string, unknown>;
			const hooks = settings.hooks as Record<
				string,
				Array<{ matcher?: string; hooks: Array<{ command: string }> }>
			>;

			// Find the bash danger guard (run_shell_command with git push check)
			const bashGuard = hooks.BeforeTool?.find(
				(e) => e.matcher === "run_shell_command" && e.hooks[0]?.command.includes("git\\s+push"),
			);
			expect(bashGuard).toBeDefined();

			const guardCmd = bashGuard!.hooks[0]!.command;

			const pushInput = JSON.stringify({
				tool_name: "run_shell_command",
				tool_input: { command: "git push origin main" },
			});
			const proc = Bun.spawn(["bash", "-c", guardCmd], {
				stdin: new Blob([pushInput]),
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					OVERSTORY_AGENT_NAME: "bash-danger",
				},
			});
			const [stdout, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				proc.exited,
			]);

			expect(exitCode).toBe(0);
			expect(stdout).toContain("deny");
			expect(stdout).toContain("git push is blocked");
		});

		test("bash danger guard allows safe commands", async () => {
			await initCommand({ _spawner: noopSpawner });

			const gemini = new GeminiRuntime();
			const worktreePath = join(tempDir, ".overstory", "worktrees", "bash-safe");

			await gemini.deployConfig(
				worktreePath,
				{ content: "# Builder" },
				{ agentName: "bash-safe", capability: "builder", worktreePath },
			);

			const settings = (await Bun.file(
				join(worktreePath, ".gemini", "settings.json"),
			).json()) as Record<string, unknown>;
			const hooks = settings.hooks as Record<
				string,
				Array<{ matcher?: string; hooks: Array<{ command: string }> }>
			>;

			const bashGuard = hooks.BeforeTool?.find(
				(e) => e.matcher === "run_shell_command" && e.hooks[0]?.command.includes("git\\s+push"),
			);
			expect(bashGuard).toBeDefined();

			const guardCmd = bashGuard!.hooks[0]!.command;

			const safeInput = JSON.stringify({
				tool_name: "run_shell_command",
				tool_input: { command: "git status" },
			});
			const proc = Bun.spawn(["bash", "-c", guardCmd], {
				stdin: new Blob([safeInput]),
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					OVERSTORY_AGENT_NAME: "bash-safe",
				},
			});
			const [stdout, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				proc.exited,
			]);

			expect(exitCode).toBe(0);
			// No deny — allowed through
			expect(stdout.trim()).toBe("");
		});

		test("scout bash file guard blocks file-modifying commands", async () => {
			await initCommand({ _spawner: noopSpawner });

			const qwen = new QwenRuntime();
			const worktreePath = join(tempDir, ".overstory", "worktrees", "scout-bash");

			await qwen.deployConfig(
				worktreePath,
				{ content: "# Scout" },
				{ agentName: "scout-bash", capability: "scout", worktreePath },
			);

			const settings = (await Bun.file(
				join(worktreePath, ".qwen", "settings.json"),
			).json()) as Record<string, unknown>;
			const hooks = settings.hooks as Record<
				string,
				Array<{ matcher?: string; hooks: Array<{ command: string }> }>
			>;

			// Find the scout's bash file guard (Qwen uses PreToolUse, not BeforeTool)
			const fileGuard = hooks.PreToolUse?.find(
				(e) =>
					e.matcher === "run_shell_command" &&
					e.hooks[0]?.command.includes("cannot modify files"),
			);
			expect(fileGuard).toBeDefined();

			const guardCmd = fileGuard!.hooks[0]!.command;

			// sed -i is a dangerous file-modifying command for scouts
			const dangerInput = JSON.stringify({
				tool_name: "run_shell_command",
				tool_input: { command: "sed -i 's/foo/bar/' /tmp/test.txt" },
			});
			const proc = Bun.spawn(["bash", "-c", guardCmd], {
				stdin: new Blob([dangerInput]),
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					OVERSTORY_AGENT_NAME: "scout-bash",
				},
			});
			const [stdout, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				proc.exited,
			]);

			expect(exitCode).toBe(0);
			expect(stdout).toContain("deny");
			expect(stdout).toContain("scout agents cannot modify files");
		});

		test("tracker close guard blocks closing wrong task", async () => {
			await initCommand({ _spawner: noopSpawner });

			const gemini = new GeminiRuntime();
			const worktreePath = join(tempDir, ".overstory", "worktrees", "tracker-guard");

			await gemini.deployConfig(
				worktreePath,
				{ content: "# Builder" },
				{ agentName: "tracker-guard", capability: "builder", worktreePath },
			);

			const settings = (await Bun.file(
				join(worktreePath, ".gemini", "settings.json"),
			).json()) as Record<string, unknown>;
			const hooks = settings.hooks as Record<
				string,
				Array<{ matcher?: string; hooks: Array<{ command: string }> }>
			>;

			// Find the tracker close guard
			const trackerGuard = hooks.BeforeTool?.find(
				(e) =>
					e.matcher === "run_shell_command" &&
					e.hooks[0]?.command.includes("OVERSTORY_TASK_ID"),
			);
			expect(trackerGuard).toBeDefined();

			const guardCmd = trackerGuard!.hooks[0]!.command;

			// Try to close a different task
			const wrongCloseInput = JSON.stringify({
				tool_name: "run_shell_command",
				tool_input: { command: "sd close other-task-123" },
			});
			const proc = Bun.spawn(["bash", "-c", guardCmd], {
				stdin: new Blob([wrongCloseInput]),
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					OVERSTORY_AGENT_NAME: "tracker-guard",
					OVERSTORY_TASK_ID: "my-task-456",
				},
			});
			const [stdout, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				proc.exited,
			]);

			expect(exitCode).toBe(0);
			expect(stdout).toContain("deny");
			expect(stdout).toContain("Cannot close issue other-task-123");
			expect(stdout).toContain("my-task-456");
		});

		test("tracker close guard allows closing own task", async () => {
			await initCommand({ _spawner: noopSpawner });

			const gemini = new GeminiRuntime();
			const worktreePath = join(tempDir, ".overstory", "worktrees", "tracker-ok");

			await gemini.deployConfig(
				worktreePath,
				{ content: "# Builder" },
				{ agentName: "tracker-ok", capability: "builder", worktreePath },
			);

			const settings = (await Bun.file(
				join(worktreePath, ".gemini", "settings.json"),
			).json()) as Record<string, unknown>;
			const hooks = settings.hooks as Record<
				string,
				Array<{ matcher?: string; hooks: Array<{ command: string }> }>
			>;

			const trackerGuard = hooks.BeforeTool?.find(
				(e) =>
					e.matcher === "run_shell_command" &&
					e.hooks[0]?.command.includes("OVERSTORY_TASK_ID"),
			);
			expect(trackerGuard).toBeDefined();

			const guardCmd = trackerGuard!.hooks[0]!.command;

			// Close own task
			const ownCloseInput = JSON.stringify({
				tool_name: "run_shell_command",
				tool_input: { command: "sd close my-task-456" },
			});
			const proc = Bun.spawn(["bash", "-c", guardCmd], {
				stdin: new Blob([ownCloseInput]),
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					OVERSTORY_AGENT_NAME: "tracker-ok",
					OVERSTORY_TASK_ID: "my-task-456",
				},
			});
			const [stdout, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				proc.exited,
			]);

			expect(exitCode).toBe(0);
			// No deny — allowed
			expect(stdout.trim()).toBe("");
		});
	});
});
