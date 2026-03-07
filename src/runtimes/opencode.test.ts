import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import type { ResolvedModel } from "../types.ts";
import { OpenCodeRuntime } from "./opencode.ts";
import type { SpawnOpts } from "./types.ts";

describe("OpenCodeRuntime", () => {
	const runtime = new OpenCodeRuntime();

	describe("id and instructionPath", () => {
		test("id is 'opencode'", () => {
			expect(runtime.id).toBe("opencode");
		});

		test("instructionPath is AGENTS.md", () => {
			expect(runtime.instructionPath).toBe("AGENTS.md");
		});
	});

	describe("buildSpawnCommand", () => {
		test("includes --model flag", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe("opencode --model sonnet");
		});

		test("permissionMode is ignored (opencode has no permission flag)", () => {
			const bypass: SpawnOpts = {
				model: "opus",
				permissionMode: "bypass",
				cwd: "/tmp",
				env: {},
			};
			const ask: SpawnOpts = { ...bypass, permissionMode: "ask" };
			expect(runtime.buildSpawnCommand(bypass)).toBe("opencode --model opus");
			expect(runtime.buildSpawnCommand(ask)).toBe("opencode --model opus");
		});

		test("resumeSessionId adds --session flag", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
				resumeSessionId: "ses_abc123",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("--session ses_abc123");
		});

		test("sessionId is ignored (opencode generates its own IDs)", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
				sessionId: "some-uuid",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe("opencode --model sonnet");
			expect(cmd).not.toContain("some-uuid");
		});

		test("cwd and env are not embedded in command string", () => {
			const opts: SpawnOpts = {
				model: "sonnet",
				permissionMode: "bypass",
				cwd: "/some/specific/path",
				env: { OPENAI_API_KEY: "sk-test-123" },
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("/some/specific/path");
			expect(cmd).not.toContain("sk-test-123");
		});

		test("all model names pass through unchanged", () => {
			for (const model of ["sonnet", "opus", "haiku", "gpt-4o", "openrouter/gpt-5"]) {
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
	});

	describe("buildPrintCommand", () => {
		test("uses opencode run subcommand with --format json", () => {
			const argv = runtime.buildPrintCommand("Summarize this diff");
			expect(argv).toEqual(["opencode", "run", "--format", "json", "Summarize this diff"]);
		});

		test("command with model override inserts --model flag", () => {
			const argv = runtime.buildPrintCommand("Classify this error", "haiku");
			expect(argv).toEqual([
				"opencode",
				"run",
				"--model",
				"haiku",
				"--format",
				"json",
				"Classify this error",
			]);
		});

		test("model undefined omits --model flag", () => {
			const argv = runtime.buildPrintCommand("Hello", undefined);
			expect(argv).not.toContain("--model");
			expect(argv).toContain("--format");
			expect(argv).toContain("json");
		});
	});

	describe("detectReady", () => {
		test("returns loading for empty pane", () => {
			expect(runtime.detectReady("")).toEqual({ phase: "loading" });
		});

		test("returns ready when Ask anything and controls are visible", () => {
			const pane = `
                OPENCODE
                Ask anything... "Fix a TODO"
                Build  GPT-5.3 Codex OpenAI
                ctrl+t variants  tab agents  ctrl+p commands
                /tmp  1.2.20`;
			expect(runtime.detectReady(pane)).toEqual({ phase: "ready" });
		});

		test("returns loading when only banner is visible (no prompt yet)", () => {
			const pane = "OPENCODE\nLoading...";
			expect(runtime.detectReady(pane)).toEqual({ phase: "loading" });
		});

		test("returns loading when prompt visible but no controls", () => {
			const pane = "Ask anything...";
			expect(runtime.detectReady(pane)).toEqual({ phase: "loading" });
		});

		test("never returns dialog phase", () => {
			const state = runtime.detectReady("trust this folder?");
			expect(state.phase).not.toBe("dialog");
		});
	});

	describe("parseTranscript", () => {
		test("returns null (SQLite-based, not file-based)", async () => {
			const result = await runtime.parseTranscript("/any/path");
			expect(result).toBeNull();
		});
	});

	describe("getTranscriptDir", () => {
		test("returns opencode data directory", () => {
			const dir = runtime.getTranscriptDir("/some/project");
			expect(dir).toContain(".local/share/opencode");
		});
	});

	describe("buildEnv", () => {
		test("returns empty object when model has no env", () => {
			const model: ResolvedModel = { model: "sonnet" };
			expect(runtime.buildEnv(model)).toEqual({});
		});

		test("returns model.env when present", () => {
			const model: ResolvedModel = {
				model: "gpt-4o",
				env: { OPENAI_API_KEY: "sk-test-123", OPENCODE_API_URL: "https://api.openai.com" },
			};
			expect(runtime.buildEnv(model)).toEqual({
				OPENAI_API_KEY: "sk-test-123",
				OPENCODE_API_URL: "https://api.openai.com",
			});
		});

		test("returns empty object when model.env is undefined", () => {
			const model: ResolvedModel = { model: "opus", env: undefined };
			expect(runtime.buildEnv(model)).toEqual({});
		});
	});

	describe("detectRateLimit", () => {
		test("detects 429 status code", () => {
			const state = runtime.detectRateLimit("Error: 429 Too Many Requests");
			expect(state.limited).toBe(true);
		});

		test("detects rate limit text", () => {
			const state = runtime.detectRateLimit("API rate limit exceeded, please wait");
			expect(state.limited).toBe(true);
		});

		test("returns not limited for normal content", () => {
			const state = runtime.detectRateLimit("Working on task...\nFile written successfully");
			expect(state.limited).toBe(false);
		});
	});

	describe("deployConfig", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), "overstory-opencode-test-"));
		});

		afterEach(async () => {
			await cleanupTempDir(tempDir);
		});

		test("writes overlay to AGENTS.md when provided", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Agent Instructions\nYou are a builder." },
				{ agentName: "test-builder", capability: "builder", worktreePath },
			);

			const content = await Bun.file(join(worktreePath, "AGENTS.md")).text();
			expect(content).toBe("# Agent Instructions\nYou are a builder.");
		});

		test("creates worktree directory if it does not exist", async () => {
			const worktreePath = join(tempDir, "new-worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Instructions" },
				{ agentName: "test", capability: "builder", worktreePath },
			);

			const exists = await Bun.file(join(worktreePath, "AGENTS.md")).exists();
			expect(exists).toBe(true);
		});

		test("skips overlay write when overlay is undefined", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(worktreePath, undefined, {
				agentName: "coordinator",
				capability: "coordinator",
				worktreePath,
			});

			const exists = await Bun.file(join(worktreePath, "AGENTS.md")).exists();
			expect(exists).toBe(false);
			// Guard plugin and config are still written
			const guardExists = await Bun.file(
				join(worktreePath, ".opencode", "plugin", "overstory-guard.ts"),
			).exists();
			expect(guardExists).toBe(true);
		});

		test("writes opencode.json with permission bypass", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Instructions" },
				{ agentName: "test-builder", capability: "builder", worktreePath },
			);

			const configContent = JSON.parse(await Bun.file(join(worktreePath, "opencode.json")).text());
			expect(configContent.permission).toBe("allow");
			expect(configContent.plugin).toContain(".opencode/plugin/overstory-guard.ts");
			expect(configContent.instructions).toContain("AGENTS.md");
		});

		test("writes guard plugin with correct capability", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Instructions" },
				{ agentName: "test-scout", capability: "scout", worktreePath },
			);

			const guardContent = await Bun.file(
				join(worktreePath, ".opencode", "plugin", "overstory-guard.ts"),
			).text();
			expect(guardContent).toContain("overstory-guard");
			expect(guardContent).toContain("test-scout");
			expect(guardContent).toContain("READ_ONLY = true");
		});

		test("guard plugin sets READ_ONLY=false for builders", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Instructions" },
				{ agentName: "test-builder", capability: "builder", worktreePath },
			);

			const guardContent = await Bun.file(
				join(worktreePath, ".opencode", "plugin", "overstory-guard.ts"),
			).text();
			expect(guardContent).toContain("READ_ONLY = false");
		});

		test("does not write settings.local.json (no Claude hook deployment)", async () => {
			const worktreePath = join(tempDir, "worktree");

			await runtime.deployConfig(
				worktreePath,
				{ content: "# Instructions" },
				{ agentName: "test-builder", capability: "builder", worktreePath },
			);

			const settingsExists = await Bun.file(
				join(worktreePath, ".claude", "settings.local.json"),
			).exists();
			expect(settingsExists).toBe(false);
		});

		test("overwrites existing AGENTS.md", async () => {
			const worktreePath = join(tempDir, "worktree");
			await mkdir(worktreePath, { recursive: true });
			await Bun.write(join(worktreePath, "AGENTS.md"), "old content");

			await runtime.deployConfig(
				worktreePath,
				{ content: "new content" },
				{ agentName: "test", capability: "builder", worktreePath },
			);

			const content = await Bun.file(join(worktreePath, "AGENTS.md")).text();
			expect(content).toBe("new content");
		});
	});
});

describe("OpenCodeRuntime integration: registry resolves 'opencode'", () => {
	test("getRuntime('opencode') returns OpenCodeRuntime", async () => {
		const { getRuntime } = await import("./registry.ts");
		const rt = getRuntime("opencode");
		expect(rt).toBeInstanceOf(OpenCodeRuntime);
		expect(rt.id).toBe("opencode");
		expect(rt.instructionPath).toBe("AGENTS.md");
	});
});
