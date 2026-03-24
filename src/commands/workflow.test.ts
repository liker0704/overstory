/**
 * Tests for `ov workflow import` and `ov workflow sync`.
 *
 * Tests executeWorkflowImport() and executeWorkflowSync() directly.
 * Uses a temp directory with a minimal .overstory/ structure.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMissionStore } from "../missions/store.ts";
import { executeWorkflowImport, executeWorkflowSync } from "./workflow.ts";

// ─── Stdout/Stderr capture helpers ────────────────────────────────────────

function captureStdout(): { stop: () => string } {
	let captured = "";
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = (chunk: string | Uint8Array): boolean => {
		captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	};
	return {
		stop: () => {
			process.stdout.write = original;
			return captured;
		},
	};
}

function captureStderr(): { stop: () => string } {
	let captured = "";
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = (chunk: string | Uint8Array): boolean => {
		captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	};
	return {
		stop: () => {
			process.stderr.write = original;
			return captured;
		},
	};
}

// ─── Minimal project scaffold ──────────────────────────────────────────────

async function createMinimalProject(): Promise<{
	projectDir: string;
	overstoryDir: string;
	sessionsDbPath: string;
}> {
	const projectDir = await mkdtemp(join(tmpdir(), "ov-workflow-test-"));
	const overstoryDir = join(projectDir, ".overstory");
	await mkdir(overstoryDir, { recursive: true });

	const config = ["project:", `  name: test-project`, `  root: ${projectDir}`].join("\n");
	await writeFile(join(overstoryDir, "config.yaml"), config);

	const sessionsDbPath = join(overstoryDir, "sessions.db");
	return { projectDir, overstoryDir, sessionsDbPath };
}

async function createWorkflowSource(baseDir: string): Promise<string> {
	const sourceDir = join(baseDir, "source");
	await mkdir(join(sourceDir, "plan"), { recursive: true });

	// task.md
	await writeFile(
		join(sourceDir, "task.md"),
		`Status: executing\nCreated: 2026-01-01\nLast-updated: 2026-01-02\n\n# Task: test-workflow\n\nTest workflow description.`,
	);

	// plan/tasks.md
	await writeFile(
		join(sourceDir, "plan", "tasks.md"),
		`# Task Breakdown\n\n## Task 1: task-alpha\n\n**ID:** task-alpha\n**Dependencies:** none\n\nImplement the alpha feature.`,
	);

	// plan/plan.md
	await writeFile(join(sourceDir, "plan", "plan.md"), `# Plan\n\nImplementation plan summary.`);

	// plan/risks.md
	await writeFile(
		join(sourceDir, "plan", "risks.md"),
		`# Risks\n\n| Risk | Likelihood | Impact | Mitigation |\n|------|-----------|--------|------------|\n| Breaking change | Medium | High | Add tests |`,
	);

	// plan/acceptance.md
	await writeFile(
		join(sourceDir, "plan", "acceptance.md"),
		`# Acceptance Criteria\n\n- [ ] Feature works\n- [ ] Tests pass`,
	);

	// architecture.md
	await writeFile(
		join(sourceDir, "architecture.md"),
		`# Architecture\n\n## Components\n\n| Action | Path | Purpose |\n|--------|------|---------||\n| CREATE | src/alpha.ts | Alpha implementation |`,
	);

	return sourceDir;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("executeWorkflowImport", () => {
	let projectDir: string;
	let overstoryDir: string;
	let sessionsDbPath: string;
	let origCwd: string;

	beforeEach(async () => {
		({ projectDir, overstoryDir, sessionsDbPath } = await createMinimalProject());
		origCwd = process.cwd();
		process.chdir(projectDir);
		process.exitCode = 0;
	});

	afterEach(async () => {
		process.chdir(origCwd);
		await rm(projectDir, { recursive: true, force: true });
	});

	test("errors when no sessions.db found", async () => {
		const err = captureStderr();
		const sourceDir = await createWorkflowSource(projectDir);
		await executeWorkflowImport(sourceDir, {});
		const out = err.stop();
		expect(out).toContain("No sessions.db");
		expect(process.exitCode).toBe(1);
	});

	test("errors when no active mission and no --mission", async () => {
		// Create sessions.db without any missions
		const store = createMissionStore(sessionsDbPath);
		store.close();

		const err = captureStderr();
		const sourceDir = await createWorkflowSource(projectDir);
		await executeWorkflowImport(sourceDir, {});
		const out = err.stop();
		expect(out).toContain("No active mission");
		expect(process.exitCode).toBe(1);
	});

	test("errors when --mission slug not found", async () => {
		const store = createMissionStore(sessionsDbPath);
		store.close();

		const err = captureStderr();
		const sourceDir = await createWorkflowSource(projectDir);
		await executeWorkflowImport(sourceDir, { mission: "nonexistent" });
		const out = err.stop();
		expect(out).toContain("Mission not found");
		expect(process.exitCode).toBe(1);
	});

	test("imports workflow in dry-run mode without writing files", async () => {
		const store = createMissionStore(sessionsDbPath);
		const missionDir = join(overstoryDir, "missions", "mission-001");
		await mkdir(join(missionDir, "plan"), { recursive: true });
		store.create({
			id: "mission-001",
			slug: "test-mission",
			objective: "Test",
			runId: null,
			artifactRoot: missionDir,
		});
		store.close();

		const sourceDir = await createWorkflowSource(projectDir);
		const cap = captureStdout();
		await executeWorkflowImport(sourceDir, { dryRun: true, mission: "test-mission" });
		const out = cap.stop();

		expect(out).toContain("dry-run");
		expect(process.exitCode).toBe(0);

		// workstreams.json should NOT exist in dry-run
		const workstreamsPath = join(missionDir, "plan", "workstreams.json");
		const exists = await Bun.file(workstreamsPath)
			.text()
			.then(() => true)
			.catch(() => false);
		expect(exists).toBe(false);
	});

	test("imports workflow and writes workstreams.json", async () => {
		const store = createMissionStore(sessionsDbPath);
		const missionDir = join(overstoryDir, "missions", "mission-002");
		await mkdir(join(missionDir, "plan"), { recursive: true });
		// Create workstream dirs
		store.create({
			id: "mission-002",
			slug: "test-mission-2",
			objective: "Test",
			runId: null,
			artifactRoot: missionDir,
			startedAt: null,
		});
		store.close();

		const sourceDir = await createWorkflowSource(projectDir);
		const cap = captureStdout();
		await executeWorkflowImport(sourceDir, { mission: "test-mission-2" });
		const out = cap.stop();

		expect(out).toContain("Import complete");
		expect(process.exitCode).toBe(0);

		// workstreams.json should exist
		const workstreamsPath = join(missionDir, "plan", "workstreams.json");
		const text = await Bun.file(workstreamsPath).text();
		const parsed = JSON.parse(text);
		expect(parsed.version).toBe(1);
		expect(Array.isArray(parsed.workstreams)).toBe(true);
	});

	test("errors when workstreams.json exists without --overwrite", async () => {
		const store = createMissionStore(sessionsDbPath);
		const missionDir = join(overstoryDir, "missions", "mission-003");
		await mkdir(join(missionDir, "plan"), { recursive: true });
		store.create({
			id: "mission-003",
			slug: "test-mission-3",
			objective: "Test",
			runId: null,
			artifactRoot: missionDir,
			startedAt: null,
		});
		store.close();

		// Pre-create workstreams.json
		await writeFile(join(missionDir, "plan", "workstreams.json"), '{"version":1,"workstreams":[]}');

		const sourceDir = await createWorkflowSource(projectDir);
		const err = captureStderr();
		await executeWorkflowImport(sourceDir, { mission: "test-mission-3" });
		const out = err.stop();
		expect(out).toContain("already exists");
		expect(process.exitCode).toBe(1);
	});

	test("--json output has expected structure", async () => {
		const store = createMissionStore(sessionsDbPath);
		const missionDir = join(overstoryDir, "missions", "mission-004");
		await mkdir(join(missionDir, "plan"), { recursive: true });
		store.create({
			id: "mission-004",
			slug: "test-mission-4",
			objective: "Test",
			runId: null,
			artifactRoot: missionDir,
			startedAt: null,
		});
		store.close();

		const sourceDir = await createWorkflowSource(projectDir);
		const chunks: string[] = [];
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = (chunk: string | Uint8Array): boolean => {
			chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		};

		await executeWorkflowImport(sourceDir, { json: true, mission: "test-mission-4" });
		process.stdout.write = original;

		const output = JSON.parse(chunks.join(""));
		expect(output.command).toBe("workflow:import");
		expect(Array.isArray(output.workstreams)).toBe(true);
		expect(typeof output.dryRun).toBe("boolean");
	});
});

describe("executeWorkflowSync", () => {
	let projectDir: string;
	let overstoryDir: string;
	let sessionsDbPath: string;
	let origCwd: string;

	beforeEach(async () => {
		({ projectDir, overstoryDir, sessionsDbPath } = await createMinimalProject());
		origCwd = process.cwd();
		process.chdir(projectDir);
		process.exitCode = 0;
	});

	afterEach(async () => {
		process.chdir(origCwd);
		await rm(projectDir, { recursive: true, force: true });
	});

	test("errors when no sessions.db found", async () => {
		const err = captureStderr();
		await executeWorkflowSync({});
		const out = err.stop();
		expect(out).toContain("No sessions.db");
		expect(process.exitCode).toBe(1);
	});

	test("errors when no active mission", async () => {
		const store = createMissionStore(sessionsDbPath);
		store.close();

		const err = captureStderr();
		await executeWorkflowSync({});
		const out = err.stop();
		expect(out).toContain("No active mission");
		expect(process.exitCode).toBe(1);
	});

	test("errors when no import manifest exists", async () => {
		const store = createMissionStore(sessionsDbPath);
		const missionDir = join(overstoryDir, "missions", "mission-sync-001");
		await mkdir(join(missionDir, "plan"), { recursive: true });
		store.create({
			id: "mission-sync-001",
			slug: "sync-mission-1",
			objective: "Test",
			runId: null,
			artifactRoot: missionDir,
			startedAt: null,
		});
		store.close();

		const err = captureStderr();
		await executeWorkflowSync({ mission: "sync-mission-1" });
		const out = err.stop();
		expect(out).toContain("No import manifest");
		expect(process.exitCode).toBe(1);
	});

	test("detects no drift when source is unchanged", async () => {
		const store = createMissionStore(sessionsDbPath);
		const missionDir = join(overstoryDir, "missions", "mission-sync-002");
		await mkdir(join(missionDir, "plan"), { recursive: true });
		store.create({
			id: "mission-sync-002",
			slug: "sync-mission-2",
			objective: "Test",
			runId: null,
			artifactRoot: missionDir,
			startedAt: null,
		});
		store.close();

		// First import to create manifest
		const sourceDir = await createWorkflowSource(projectDir);
		const cap1 = captureStdout();
		await executeWorkflowImport(sourceDir, { mission: "sync-mission-2" });
		cap1.stop();

		process.exitCode = 0;

		// Sync should detect no drift
		const cap2 = captureStdout();
		await executeWorkflowSync({ mission: "sync-mission-2" });
		const out = cap2.stop();

		expect(out).toContain("No drift detected");
		expect(process.exitCode).toBe(0);
	});

	test("--json output has syncResult field", async () => {
		const store = createMissionStore(sessionsDbPath);
		const missionDir = join(overstoryDir, "missions", "mission-sync-003");
		await mkdir(join(missionDir, "plan"), { recursive: true });
		store.create({
			id: "mission-sync-003",
			slug: "sync-mission-3",
			objective: "Test",
			runId: null,
			artifactRoot: missionDir,
			startedAt: null,
		});
		store.close();

		// First import
		const sourceDir = await createWorkflowSource(projectDir);
		const cap1 = captureStdout();
		await executeWorkflowImport(sourceDir, { mission: "sync-mission-3" });
		cap1.stop();

		process.exitCode = 0;

		// Sync with --json
		const chunks: string[] = [];
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = (chunk: string | Uint8Array): boolean => {
			chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		};

		await executeWorkflowSync({ json: true, mission: "sync-mission-3" });
		process.stdout.write = original;

		const output = JSON.parse(chunks.join(""));
		expect(output.command).toBe("workflow:sync");
		expect(output).toHaveProperty("syncResult");
		expect(output).toHaveProperty("updated");
	});
});
