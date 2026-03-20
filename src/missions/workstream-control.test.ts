import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import type { Mission } from "../types.ts";
import { computeBriefRevision } from "./brief-refresh.ts";
import { readSpecMeta, writeSpecMeta } from "./spec-meta.ts";
import {
	normalizeTrackedPath,
	refreshMissionBriefs,
	validateCurrentMissionSpec,
	validateWorkstreamResume,
} from "./workstream-control.ts";

let tempDir: string;
let mission: Mission;
let artifactRoot: string;
let briefPath: string;

function makeMission(): Mission {
	return {
		id: "mission-001",
		slug: "mission-auth",
		objective: "Improve auth flow",
		runId: "run-001",
		state: "active",
		phase: "execute",
		firstFreezeAt: null,
		pendingUserInput: false,
		pendingInputKind: null,
		pendingInputThreadId: null,
		reopenCount: 0,
		artifactRoot,
		pausedWorkstreamIds: [],
		analystSessionId: null,
		executionDirectorSessionId: null,
		coordinatorSessionId: null,
		pausedLeadNames: [],
		pauseReason: null,
		currentNode: null,
		startedAt: "2026-03-13T00:00:00.000Z",
		completedAt: null,
		createdAt: "2026-03-13T00:00:00.000Z",
		updatedAt: "2026-03-13T00:00:00.000Z",
		learningsExtracted: false,
	};
}

async function writeMissionPlan(): Promise<void> {
	await mkdir(join(artifactRoot, "plan"), { recursive: true });
	await Bun.write(
		join(artifactRoot, "plan", "workstreams.json"),
		`${JSON.stringify(
			{
				version: 1,
				workstreams: [
					{
						id: "ws-auth",
						taskId: "task-001",
						objective: "Implement auth changes",
						fileScope: ["src/auth.ts"],
						dependsOn: [],
						briefPath: "plan/ws-auth.md",
						status: "active",
					},
				],
			},
			null,
			2,
		)}\n`,
	);
}

beforeEach(async () => {
	tempDir = await createTempGitRepo();
	artifactRoot = join(tempDir, ".overstory", "missions", "mission-001");
	briefPath = join(artifactRoot, "plan", "ws-auth.md");
	await writeMissionPlan();
	await Bun.write(briefPath, "# Initial brief\n");
	mission = makeMission();
});

afterEach(async () => {
	await cleanupTempDir(tempDir);
});

describe("refreshMissionBriefs", () => {
	test("marks changed specs stale and reports project-relative brief path", async () => {
		const initialRevision = await computeBriefRevision(briefPath);
		await writeSpecMeta(tempDir, "task-001", {
			taskId: "task-001",
			workstreamId: "ws-auth",
			briefPath: normalizeTrackedPath(tempDir, briefPath),
			briefRevision: initialRevision,
			specRevision: "spec-revision",
			status: "current",
			generatedAt: "2026-03-13T00:00:00.000Z",
			generatedBy: "lead-auth",
		});
		await Bun.write(briefPath, "# Updated brief\n");

		const results = await refreshMissionBriefs(tempDir, mission);

		expect(results).toHaveLength(1);
		expect(results[0]?.workstream.id).toBe("ws-auth");
		expect(results[0]?.specMarkedStale).toBe(true);
		expect(results[0]?.projectRelativeBriefPath).toBe(normalizeTrackedPath(tempDir, briefPath));
		expect((await readSpecMeta(tempDir, "task-001"))?.status).toBe("stale");
	});
});

describe("validateCurrentMissionSpec", () => {
	test("fails when no companion metadata exists", async () => {
		const specPath = join(tempDir, ".overstory", "specs", "task-001.md");
		await mkdir(join(tempDir, ".overstory", "specs"), { recursive: true });
		await Bun.write(specPath, "# Spec\n");

		const result = await validateCurrentMissionSpec(tempDir, specPath);

		expect(result.ok).toBe(false);
		expect(result.taskId).toBe("task-001");
		expect(result.reason).toContain("No spec metadata found");
	});

	test("fails when the provided spec path belongs to a different task than the requested task", async () => {
		const specPath = join(tempDir, ".overstory", "specs", "task-001.md");
		await mkdir(join(tempDir, ".overstory", "specs"), { recursive: true });
		await Bun.write(specPath, "# Spec\n");
		const currentRevision = await computeBriefRevision(briefPath);
		await writeSpecMeta(tempDir, "task-001", {
			taskId: "task-001",
			workstreamId: "ws-auth",
			briefPath: normalizeTrackedPath(tempDir, briefPath),
			briefRevision: currentRevision,
			specRevision: "spec-revision",
			status: "current",
			generatedAt: "2026-03-13T00:00:00.000Z",
			generatedBy: "lead-auth",
		});

		const result = await validateCurrentMissionSpec(tempDir, specPath, {
			expectedTaskId: "task-002",
		});

		expect(result.ok).toBe(false);
		expect(result.taskId).toBe("task-001");
		expect(result.reason).toContain("does not match requested task task-002");
	});

	test("passes when metadata is current and brief revision matches", async () => {
		const specPath = join(tempDir, ".overstory", "specs", "task-001.md");
		await mkdir(join(tempDir, ".overstory", "specs"), { recursive: true });
		await Bun.write(specPath, "# Spec\n");
		const currentRevision = await computeBriefRevision(briefPath);
		await writeSpecMeta(tempDir, "task-001", {
			taskId: "task-001",
			workstreamId: "ws-auth",
			briefPath: normalizeTrackedPath(tempDir, briefPath),
			briefRevision: currentRevision,
			specRevision: "spec-revision",
			status: "current",
			generatedAt: "2026-03-13T00:00:00.000Z",
			generatedBy: "lead-auth",
		});

		const result = await validateCurrentMissionSpec(tempDir, specPath);

		expect(result.ok).toBe(true);
		expect(result.taskId).toBe("task-001");
		expect(result.reason).toBeNull();
	});
});

describe("validateWorkstreamResume", () => {
	test("blocks resume when current spec metadata is missing for a brief-backed workstream", async () => {
		const result = await validateWorkstreamResume(tempDir, mission, "ws-auth");

		expect(result.ok).toBe(false);
		expect(result.specCount).toBe(0);
		expect(result.reason).toContain("No current spec metadata found");
	});

	test("blocks resume when a workstream spec is stale", async () => {
		const initialRevision = await computeBriefRevision(briefPath);
		await writeSpecMeta(tempDir, "task-001", {
			taskId: "task-001",
			workstreamId: "ws-auth",
			briefPath: normalizeTrackedPath(tempDir, briefPath),
			briefRevision: initialRevision,
			specRevision: "spec-revision",
			status: "current",
			generatedAt: "2026-03-13T00:00:00.000Z",
			generatedBy: "lead-auth",
		});
		await Bun.write(briefPath, "# Changed brief\n");

		const result = await validateWorkstreamResume(tempDir, mission, "ws-auth");

		expect(result.ok).toBe(false);
		expect(result.specCount).toBe(1);
		expect(result.reason).toContain("Brief has changed");
	});

	test("allows resume when current spec metadata matches the latest brief", async () => {
		const currentRevision = await computeBriefRevision(briefPath);
		await writeSpecMeta(tempDir, "task-001", {
			taskId: "task-001",
			workstreamId: "ws-auth",
			briefPath: normalizeTrackedPath(tempDir, briefPath),
			briefRevision: currentRevision,
			specRevision: "spec-revision",
			status: "current",
			generatedAt: "2026-03-13T00:00:00.000Z",
			generatedBy: "lead-auth",
		});

		const result = await validateWorkstreamResume(tempDir, mission, "ws-auth");

		expect(result.ok).toBe(true);
		expect(result.specCount).toBe(1);
		expect(result.reason).toBeNull();
	});
});
