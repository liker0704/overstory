/**
 * Tests for missionStart() and missionResumeAll().
 *
 * Strategy:
 * - missionStart() has deep tmux/agent-spawn dependencies that cannot be
 *   exercised without a live tmux + Claude runtime. We test one observable
 *   side-effect that happens before any role is spawned: the artifact
 *   directory is created. We verify this by injecting stub deps that return
 *   immediately without spawning anything.
 * - missionResumeAll() is tested for its error path when no suspended mission
 *   exists — a pure DB + exitCode test with no tmux required.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missionResumeAll, missionStart } from "./lifecycle-start.ts";
import { createMissionStore } from "./store.ts";

let tempDir: string;
let overstoryDir: string;
let projectRoot: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "ov-lifecycle-start-test-"));
	overstoryDir = join(tempDir, ".overstory");
	projectRoot = tempDir;
	await Bun.write(join(overstoryDir, ".keep"), "");

	// Minimal config.yaml so loadConfig() succeeds
	await Bun.write(
		join(projectRoot, ".overstory", "config.yaml"),
		[
			"version: 1",
			"watchdog:",
			"  tier0Enabled: false",
			"mission:",
			"  maxConcurrent: 1",
		].join("\n"),
	);
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

/** Minimal stub for startMissionCoordinator / startMissionAnalyst injected via deps. */
function makeRoleStub(sessionId: string) {
	return async (_opts: unknown) => ({
		session: {
			id: sessionId,
			agentName: "stub",
			tmuxSession: null,
			pid: null,
			worktreePath: null,
			state: "active" as const,
			depth: 0,
			runId: null,
			runtimeSessionId: null,
			capability: null,
			branchName: null,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		},
	});
}

describe("missionStart", () => {
	test("scaffolds the artifact directory before any role is spawned", async () => {
		// Use injected stubs that resolve without touching tmux/Claude
		const deps = {
			startMissionCoordinator: makeRoleStub("coord-session-stub"),
			startMissionAnalyst: makeRoleStub("analyst-session-stub"),
			stopMissionRole: async () => {},
		};

		await missionStart(
			overstoryDir,
			projectRoot,
			{ slug: "test-scaffold", objective: "scaffold test", json: true },
			deps,
		);

		// Find the created mission to locate its artifactRoot
		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		let artifactRoot: string | null = null;
		try {
			const missions = store.list();
			const created = missions.find((m) => m.slug === "test-scaffold");
			artifactRoot = created?.artifactRoot ?? null;
		} finally {
			store.close();
		}

		expect(artifactRoot).not.toBeNull();
		// The directory must exist on disk — access() resolves without throwing on success
		let accessError: unknown;
		try {
			await access(artifactRoot!);
		} catch (err) {
			accessError = err;
		}
		expect(accessError).toBeUndefined();
	});
});

describe("missionResumeAll", () => {
	test("sets exitCode=1 and returns when no suspended mission exists", async () => {
		process.exitCode = 0;

		await missionResumeAll(overstoryDir, projectRoot, true /* json */);

		expect(process.exitCode).toBe(1);

		// Reset so subsequent tests are unaffected
		process.exitCode = 0;
	});
});
