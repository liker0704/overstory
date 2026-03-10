import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedModel } from "../types.ts";
import { QwenRuntime } from "./qwen.ts";
import type { SpawnOpts } from "./types.ts";

describe("QwenRuntime", () => {
	const runtime = new QwenRuntime();

	describe("id and instructionPath", () => {
		test("id is 'qwen'", () => {
			expect(runtime.id).toBe("qwen");
		});

		test("instructionPath is AGENTS.md", () => {
			expect(runtime.instructionPath).toBe("AGENTS.md");
		});

		test("stability is experimental", () => {
			expect(runtime.stability).toBe("experimental");
		});
	});

	describe("buildSpawnCommand", () => {
		test("basic command with --yolo and --model", () => {
			const opts: SpawnOpts = {
				model: "qwen-coder-plus",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("qwen");
			expect(cmd).toContain("--yolo");
			expect(cmd).toContain("--model qwen-coder-plus");
			expect(cmd).toContain("Read AGENTS.md");
		});

		test("ask permissionMode omits --yolo", () => {
			const opts: SpawnOpts = {
				model: "qwen-coder-plus",
				permissionMode: "ask",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("--yolo");
		});

		test("Anthropic aliases omit --model", () => {
			for (const alias of ["sonnet", "opus", "haiku", "default"]) {
				const opts: SpawnOpts = {
					model: alias,
					permissionMode: "bypass",
					cwd: "/tmp/worktree",
					env: {},
				};
				const cmd = runtime.buildSpawnCommand(opts);
				expect(cmd).not.toContain(" --model ");
			}
		});

		test("non-alias models pass through unchanged", () => {
			for (const model of ["qwen-coder-plus", "qwen3-235b", "gpt-5"]) {
				const opts: SpawnOpts = {
					model,
					permissionMode: "bypass",
					cwd: "/tmp",
					env: {},
				};
				const cmd = runtime.buildSpawnCommand(opts);
				expect(cmd).toContain(`--model ${model}`);
			}
		});

		test("with appendSystemPrompt includes prompt and AGENTS.md instruction", () => {
			const opts: SpawnOpts = {
				model: "qwen-coder-plus",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
				appendSystemPrompt: "You are a builder agent.",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("You are a builder agent.");
			expect(cmd).toContain("Read AGENTS.md");
			expect(cmd).toContain("--prompt-interactive");
		});

		test("with appendSystemPromptFile uses $(cat ...) expansion", () => {
			const opts: SpawnOpts = {
				model: "qwen-coder-plus",
				permissionMode: "bypass",
				cwd: "/project",
				env: {},
				appendSystemPromptFile: "/project/.overstory/agent-defs/coordinator.md",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("$(cat '/project/.overstory/agent-defs/coordinator.md')");
			expect(cmd).toContain("Read AGENTS.md");
			expect(cmd).toContain("--prompt-interactive");
		});

		test("appendSystemPromptFile takes precedence over appendSystemPrompt", () => {
			const opts: SpawnOpts = {
				model: "qwen-coder-plus",
				permissionMode: "bypass",
				cwd: "/project",
				env: {},
				appendSystemPromptFile: "/project/agent.md",
				appendSystemPrompt: "This should be ignored",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("$(cat ");
			expect(cmd).not.toContain("This should be ignored");
		});

		test("with resumeSessionId uses --resume flag", () => {
			const opts: SpawnOpts = {
				model: "qwen-coder-plus",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
				resumeSessionId: "abc-123-def",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("qwen --resume abc-123-def");
		});

		test("without appendSystemPrompt uses default AGENTS.md prompt", () => {
			const opts: SpawnOpts = {
				model: "qwen-coder-plus",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("--prompt-interactive");
			expect(cmd).toContain("Read AGENTS.md for your task assignment and begin immediately.");
		});

		test("cwd and env are not embedded in command string", () => {
			const opts: SpawnOpts = {
				model: "qwen-coder-plus",
				permissionMode: "bypass",
				cwd: "/some/specific/path",
				env: { DASHSCOPE_API_KEY: "sk-test-123" },
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("/some/specific/path");
			expect(cmd).not.toContain("sk-test-123");
			expect(cmd).not.toContain("DASHSCOPE_API_KEY");
		});

		test("systemPrompt field is ignored", () => {
			const opts: SpawnOpts = {
				model: "qwen-coder-plus",
				permissionMode: "bypass",
				cwd: "/tmp",
				env: {},
				systemPrompt: "This should not appear",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("This should not appear");
		});
	});

	describe("buildPrintCommand", () => {
		test("basic command without model", () => {
			const argv = runtime.buildPrintCommand("Summarize this diff");
			expect(argv).toEqual(["qwen", "--yolo", "-p", "Summarize this diff"]);
		});

		test("command with model override", () => {
			const argv = runtime.buildPrintCommand("Classify this error", "qwen-coder-plus");
			expect(argv).toEqual([
				"qwen",
				"--yolo",
				"-p",
				"Classify this error",
				"--model",
				"qwen-coder-plus",
			]);
		});

		test("model undefined omits --model flag", () => {
			const argv = runtime.buildPrintCommand("Hello", undefined);
			expect(argv).not.toContain("--model");
		});

		test("prompt is positional after -p", () => {
			const prompt = "My test prompt";
			const argv = runtime.buildPrintCommand(prompt);
			expect(argv[3]).toBe(prompt);
		});
	});

	describe("detectReady", () => {
		test("returns ready when prompt and qwen branding are present", () => {
			const pane = "Qwen Code v1.0\n> \ntype your message";
			const state = runtime.detectReady(pane);
			expect(state).toEqual({ phase: "ready" });
		});

		test("returns ready with ❯ prompt character", () => {
			const pane = "Qwen Code\n❯ ";
			const state = runtime.detectReady(pane);
			expect(state).toEqual({ phase: "ready" });
		});

		test("returns loading for empty pane", () => {
			const state = runtime.detectReady("");
			expect(state).toEqual({ phase: "loading" });
		});

		test("returns loading when only prompt is present (no branding)", () => {
			const state = runtime.detectReady("> \ntype your message");
			expect(state).toEqual({ phase: "loading" });
		});

		test("returns loading when only branding is present (no prompt)", () => {
			const state = runtime.detectReady("Loading Qwen...");
			expect(state).toEqual({ phase: "loading" });
		});

		test("no dialog phase — Qwen has no trust dialog", () => {
			const state = runtime.detectReady("trust this folder qwen");
			expect(state.phase).not.toBe("dialog");
		});
	});

	describe("requiresBeaconVerification", () => {
		test("returns false", () => {
			expect(runtime.requiresBeaconVerification()).toBe(false);
		});
	});

	describe("buildEnv", () => {
		test("returns empty object when model has no env", () => {
			const model: ResolvedModel = { model: "qwen-coder-plus" };
			const env = runtime.buildEnv(model);
			expect(env).toEqual({});
		});

		test("returns model.env when present", () => {
			const model: ResolvedModel = {
				model: "qwen-coder-plus",
				env: { DASHSCOPE_API_KEY: "sk-test-123" },
			};
			const env = runtime.buildEnv(model);
			expect(env).toEqual({ DASHSCOPE_API_KEY: "sk-test-123" });
		});

		test("returns empty object when model.env is undefined", () => {
			const model: ResolvedModel = { model: "qwen-coder-plus", env: undefined };
			const env = runtime.buildEnv(model);
			expect(env).toEqual({});
		});
	});

	describe("deployConfig", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), "overstory-qwen-test-"));
		});

		afterEach(async () => {
			await rm(tempDir, { recursive: true, force: true });
		});

		test("writes overlay to AGENTS.md", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Agent Overlay\nTask spec here." },
				{ agentName: "test-builder", capability: "builder", worktreePath },
			);

			const agentsPath = join(worktreePath, "AGENTS.md");
			const content = await Bun.file(agentsPath).text();
			expect(content).toBe("# Agent Overlay\nTask spec here.");
		});

		test("writes .qwen/settings.json with context.fileName", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{ agentName: "test-builder", capability: "builder", worktreePath },
			);

			const settingsPath = join(worktreePath, ".qwen", "settings.json");
			const settings = await Bun.file(settingsPath).json();
			expect(settings).toEqual({ context: { fileName: "AGENTS.md" } });
		});

		test("no-op when overlay is undefined", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(worktreePath, undefined, {
				agentName: "coordinator",
				capability: "coordinator",
				worktreePath,
			});

			const agentsExists = await Bun.file(join(worktreePath, "AGENTS.md")).exists();
			expect(agentsExists).toBe(false);
			const settingsExists = await Bun.file(join(worktreePath, ".qwen", "settings.json")).exists();
			expect(settingsExists).toBe(false);
		});

		test("creates nested directories if needed", async () => {
			const worktreePath = join(tempDir, "deep", "nested", "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{ agentName: "builder-1", capability: "builder", worktreePath },
			);

			const exists = await Bun.file(join(worktreePath, "AGENTS.md")).exists();
			expect(exists).toBe(true);
		});
	});

	describe("parseTranscript", () => {
		test("returns null (not yet implemented)", async () => {
			const result = await runtime.parseTranscript("/nonexistent/path.jsonl");
			expect(result).toBeNull();
		});
	});

	describe("getTranscriptDir", () => {
		test("returns null (not yet implemented)", () => {
			expect(runtime.getTranscriptDir("/project")).toBeNull();
		});
	});

	describe("detectRateLimit", () => {
		test("detects HTTP 429", () => {
			const result = runtime.detectRateLimit("Error: 429 Too Many Requests");
			expect(result.limited).toBe(true);
		});

		test("detects rate limit text", () => {
			const result = runtime.detectRateLimit("Rate limit exceeded, please retry");
			expect(result.limited).toBe(true);
		});

		test("detects too many requests", () => {
			const result = runtime.detectRateLimit("Error: Too many requests");
			expect(result.limited).toBe(true);
		});

		test("detects quota exceeded", () => {
			const result = runtime.detectRateLimit("Error: quota exceeded for org");
			expect(result.limited).toBe(true);
		});

		test("returns not limited for normal output", () => {
			const result = runtime.detectRateLimit("File created: src/main.ts\nDone.");
			expect(result.limited).toBe(false);
		});

		test("returns not limited for empty string", () => {
			const result = runtime.detectRateLimit("");
			expect(result.limited).toBe(false);
		});
	});
});

describe("QwenRuntime integration: registry resolves 'qwen'", () => {
	test("getRuntime('qwen') returns QwenRuntime", async () => {
		const { getRuntime } = await import("./registry.ts");
		const rt = getRuntime("qwen");
		expect(rt).toBeInstanceOf(QwenRuntime);
		expect(rt.id).toBe("qwen");
		expect(rt.instructionPath).toBe("AGENTS.md");
	});
});
