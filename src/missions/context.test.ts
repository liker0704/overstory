import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import type { Mission } from "../types.ts";
import {
	buildMissionRoleBeacon,
	ensureMissionArtifacts,
	getMissionArtifactPaths,
	materializeMissionRolePrompt,
} from "./context.ts";

function makeMission(overrides: Partial<Mission> = {}): Mission {
	return {
		id: "mission-context-001",
		slug: "context-smoke",
		objective: "Verify mission prompt materialization and artifact scaffolding",
		runId: "run-context-001",
		state: "active",
		phase: "understand",
		firstFreezeAt: null,
		pendingUserInput: false,
		pendingInputKind: null,
		pendingInputThreadId: null,
		reopenCount: 0,
		artifactRoot: "",
		pausedWorkstreamIds: [],
		analystSessionId: null,
		executionDirectorSessionId: null,
		coordinatorSessionId: null,
		architectSessionId: null,
		pausedLeadNames: [],
		pauseReason: null,
		currentNode: null,
		startedAt: "2026-03-13T00:00:00.000Z",
		completedAt: null,
		createdAt: "2026-03-13T00:00:00.000Z",
		updatedAt: "2026-03-13T00:00:00.000Z",
		learningsExtracted: false,
		tier: null,
		...overrides,
	};
}

describe("mission context helpers", () => {
	let tempDir: string;
	let mission: Mission;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-mission-context-"));
		await mkdir(join(tempDir, "agent-defs"), { recursive: true });
		await Bun.write(
			join(tempDir, "agent-defs", "mission-analyst.md"),
			"Base prompt\n\nSee {{INSTRUCTION_PATH}}\n",
		);
		mission = makeMission({
			artifactRoot: join(tempDir, "missions", "mission-context-001"),
		});
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	test("ensureMissionArtifacts creates canonical mission files", async () => {
		const paths = await ensureMissionArtifacts(mission);

		expect(paths).toEqual(getMissionArtifactPaths(mission));
		expect(await Bun.file(paths.missionMd).exists()).toBe(true);
		expect(await Bun.file(paths.decisionsMd).exists()).toBe(true);
		expect(await Bun.file(paths.openQuestionsMd).exists()).toBe(true);
		expect(await Bun.file(paths.currentStateMd).exists()).toBe(true);
		expect(await Bun.file(paths.researchSummaryMd).exists()).toBe(true);
		expect(await Bun.file(paths.workstreamsJson).exists()).toBe(true);
	});

	test("materializeMissionRolePrompt renders context and resolved prompt", async () => {
		const materialized = await materializeMissionRolePrompt({
			overstoryDir: tempDir,
			agentName: "mission-analyst",
			capability: "mission-analyst",
			roleLabel: "Mission Analyst",
			mission,
		});

		const context = await Bun.file(materialized.contextPath).text();
		const prompt = await Bun.file(materialized.promptPath).text();

		expect(context).toContain("Mission ID: mission-context-001");
		expect(context).toContain("plan/workstreams.json");
		expect(context).toContain("## Workstream Handoff Contract");
		expect(context).toContain('"briefPath": "workstreams/docs-smoke/brief.md"');
		expect(context).toContain(
			"Do not use legacy/non-runtime fields like `name`, `capability`, `files`, or `dependencies`.",
		);
		expect(prompt).toContain(materialized.contextPath);
		expect(prompt).not.toContain("{{INSTRUCTION_PATH}}");
	});

	test("mission context states the canonical CLI agent name when capability differs", async () => {
		await Bun.write(
			join(tempDir, "agent-defs", "coordinator-mission.md"),
			"Mission coordinator\n\nSee {{INSTRUCTION_PATH}}\n",
		);

		const materialized = await materializeMissionRolePrompt({
			overstoryDir: tempDir,
			agentName: "coordinator",
			capability: "coordinator-mission",
			roleLabel: "Mission Coordinator",
			mission,
		});

		const context = await Bun.file(materialized.contextPath).text();
		expect(context).toContain("canonical CLI agent name is `coordinator`");
		expect(context).toContain("capability is `coordinator-mission`");
	});

	test("buildMissionRoleBeacon references context path and mission id", () => {
		const beacon = buildMissionRoleBeacon({
			agentName: "mission-analyst",
			missionId: "mission-context-001",
			contextPath: "/tmp/context.md",
		});

		expect(beacon).toContain("/tmp/context.md");
		expect(beacon).toContain("mission-context-001");
		expect(beacon).toContain("mission-analyst");
	});
});
