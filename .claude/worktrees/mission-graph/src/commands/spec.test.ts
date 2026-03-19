/**
 * Tests for the `overstory spec` command.
 *
 * Uses real filesystem (temp dirs) for all tests. No mocks.
 * Philosophy: "never mock what you can use for real" (mx-252b16).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { computeBriefRevision } from "../missions/brief-refresh.ts";
import { readSpecMeta } from "../missions/spec-meta.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import { specWriteCommand, writeSpec } from "./spec.ts";

let tempDir: string;
let overstoryDir: string;
let originalCwd: string;
let stdoutOutput: string;
let _stderrOutput: string;
let originalStdoutWrite: typeof process.stdout.write;
let originalStderrWrite: typeof process.stderr.write;

beforeEach(async () => {
	tempDir = await createTempGitRepo();
	overstoryDir = join(tempDir, ".overstory");
	await mkdir(overstoryDir, { recursive: true });

	// Write minimal config.yaml so resolveProjectRoot works
	await Bun.write(
		join(overstoryDir, "config.yaml"),
		`project:\n  name: test-project\n  root: ${tempDir}\n  canonicalBranch: main\n`,
	);

	originalCwd = process.cwd();
	process.chdir(tempDir);

	// Capture stdout/stderr
	stdoutOutput = "";
	_stderrOutput = "";
	originalStdoutWrite = process.stdout.write;
	originalStderrWrite = process.stderr.write;
	process.stdout.write = ((chunk: string) => {
		stdoutOutput += chunk;
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string) => {
		_stderrOutput += chunk;
		return true;
	}) as typeof process.stderr.write;
});

afterEach(async () => {
	process.chdir(originalCwd);
	process.stdout.write = originalStdoutWrite;
	process.stderr.write = originalStderrWrite;
	await cleanupTempDir(tempDir);
});

// === validation ===

describe("validation", () => {
	test("write without task-id throws ValidationError", async () => {
		await expect(specWriteCommand("", {})).rejects.toThrow("Task ID is required");
	});

	test("write without body throws ValidationError", async () => {
		await expect(specWriteCommand("task-abc", { agent: "scout-1" })).rejects.toThrow(
			"Spec body is required",
		);
	});

	test("write with empty body throws ValidationError", async () => {
		await expect(specWriteCommand("task-abc", { body: "  " })).rejects.toThrow(
			"Spec body is required",
		);
	});

	test("mission spec metadata requires both workstream-id and brief-path", async () => {
		await expect(
			specWriteCommand("task-meta", {
				body: "# Spec",
				workstreamId: "ws-auth",
			}),
		).rejects.toThrow("requires both --workstream-id and --brief-path");
	});
});

// === writeSpec (core function) ===

describe("writeSpec", () => {
	test("writes spec file to .overstory/specs/<bead-id>.md", async () => {
		const specPath = await writeSpec(tempDir, "task-abc", "# My Spec\n\nDetails here.");

		expect(specPath).toBe(join(tempDir, ".overstory", "specs", "task-abc.md"));

		const content = await Bun.file(specPath).text();
		expect(content).toBe("# My Spec\n\nDetails here.\n");
	});

	test("creates specs directory if it does not exist", async () => {
		// Verify specs dir does not exist yet
		const specsDir = join(overstoryDir, "specs");
		expect(await Bun.file(join(specsDir, ".gitkeep")).exists()).toBe(false);

		await writeSpec(tempDir, "task-xyz", "content");

		const content = await Bun.file(join(specsDir, "task-xyz.md")).text();
		expect(content).toBe("content\n");
	});

	test("adds attribution header when agent is provided", async () => {
		const specPath = await writeSpec(tempDir, "task-123", "# Spec body", "scout-1");

		const content = await Bun.file(specPath).text();
		expect(content).toContain("<!-- written-by: scout-1 -->");
		expect(content).toContain("# Spec body");
	});

	test("does not add attribution header when agent is omitted", async () => {
		const specPath = await writeSpec(tempDir, "task-456", "# Spec body");

		const content = await Bun.file(specPath).text();
		expect(content).not.toContain("written-by");
		expect(content).toBe("# Spec body\n");
	});

	test("ensures trailing newline", async () => {
		const specPath = await writeSpec(tempDir, "task-nl", "no newline at end");

		const content = await Bun.file(specPath).text();
		expect(content.endsWith("\n")).toBe(true);
	});

	test("does not double trailing newline", async () => {
		const specPath = await writeSpec(tempDir, "task-nl2", "already has newline\n");

		const content = await Bun.file(specPath).text();
		expect(content).toBe("already has newline\n");
		expect(content.endsWith("\n\n")).toBe(false);
	});

	test("overwrites existing spec file", async () => {
		await writeSpec(tempDir, "task-ow", "version 1");
		await writeSpec(tempDir, "task-ow", "version 2");

		const specPath = join(overstoryDir, "specs", "task-ow.md");
		const content = await Bun.file(specPath).text();
		expect(content).toBe("version 2\n");
	});
});

// === specWriteCommand (CLI integration) ===

describe("specWriteCommand (integration)", () => {
	test("writes spec and prints success", async () => {
		await specWriteCommand("task-cmd", { body: "# CLI Spec" });

		expect(stdoutOutput).toContain("Spec written");
		expect(stdoutOutput).toContain("task-cmd");

		const specPath = join(tempDir, ".overstory", "specs", "task-cmd.md");
		const content = await Bun.file(specPath).text();
		expect(content).toBe("# CLI Spec\n");
	});

	test("writes spec with agent attribution", async () => {
		await specWriteCommand("task-attr", { body: "# Attributed", agent: "scout-2" });

		expect(stdoutOutput).toContain("Spec written");
		expect(stdoutOutput).toContain("task-attr");

		const specPath = join(tempDir, ".overstory", "specs", "task-attr.md");
		const content = await Bun.file(specPath).text();
		expect(content).toContain("<!-- written-by: scout-2 -->");
		expect(content).toContain("# Attributed");
	});

	test("writes spec without agent when agent is omitted", async () => {
		await specWriteCommand("task-noagent", { body: "# No Agent" });

		expect(stdoutOutput).toContain("Spec written");
		expect(stdoutOutput).toContain("task-noagent");

		const specPath = join(tempDir, ".overstory", "specs", "task-noagent.md");
		const content = await Bun.file(specPath).text();
		expect(content).not.toContain("written-by");
		expect(content).toBe("# No Agent\n");
	});

	test("writes companion spec metadata when mission flags are provided", async () => {
		await mkdir(join(tempDir, "briefs"), { recursive: true });
		const briefPath = join(tempDir, "briefs", "ws-auth.md");
		await Bun.write(briefPath, "# Workstream brief\n");

		await specWriteCommand("task-meta", {
			body: "# Mission Spec",
			agent: "lead-auth",
			workstreamId: "ws-auth",
			briefPath: "briefs/ws-auth.md",
		});

		const meta = await readSpecMeta(tempDir, "task-meta");
		expect(meta).not.toBeNull();
		expect(meta?.taskId).toBe("task-meta");
		expect(meta?.workstreamId).toBe("ws-auth");
		expect(meta?.briefPath).toBe("briefs/ws-auth.md");
		expect(meta?.status).toBe("current");
		expect(meta?.generatedBy).toBe("lead-auth");
		expect(meta?.briefRevision).toBe(await computeBriefRevision(briefPath));
		expect(meta?.specRevision).toHaveLength(64);
		expect(stdoutOutput).toContain("Meta:");
	});
});
