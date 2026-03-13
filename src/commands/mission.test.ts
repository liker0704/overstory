import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMissionStore } from "../missions/store.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import { createMissionCommand, resolveCurrentMissionId } from "./mission.ts";

let tempDir: string;
let overstoryDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "mission-command-test-"));
	overstoryDir = join(tempDir, ".overstory");
	await mkdir(overstoryDir, { recursive: true });
});

afterEach(async () => {
	await cleanupTempDir(tempDir);
});

describe("createMissionCommand", () => {
	test("returns a command named 'mission'", () => {
		const cmd = createMissionCommand();
		expect(cmd.name()).toBe("mission");
	});

	test("has mission lifecycle subcommands", () => {
		const cmd = createMissionCommand();
		const names = cmd.commands.map((command) => command.name());

		expect(names).toContain("start");
		expect(names).toContain("status");
		expect(names).toContain("output");
		expect(names).toContain("answer");
		expect(names).toContain("artifacts");
		expect(names).toContain("handoff");
		expect(names).toContain("pause");
		expect(names).toContain("resume");
		expect(names).toContain("refresh-briefs");
		expect(names).toContain("complete");
		expect(names).toContain("stop");
		expect(names).toContain("list");
		expect(names).toContain("show");
		expect(names).toContain("bundle");
		expect(names).toHaveLength(14);
	});

	test("answer subcommand supports --body and --file", () => {
		const cmd = createMissionCommand();
		const answer = cmd.commands.find((command) => command.name() === "answer");
		const options = answer?.options ?? [];

		expect(options.find((option) => option.long === "--body")).toBeDefined();
		expect(options.find((option) => option.long === "--file")).toBeDefined();
		expect(options.find((option) => option.long === "--json")).toBeDefined();
	});

	test("bundle subcommand supports mission selection and force", () => {
		const cmd = createMissionCommand();
		const bundle = cmd.commands.find((command) => command.name() === "bundle");
		const options = bundle?.options ?? [];

		expect(options.find((option) => option.long === "--mission-id")).toBeDefined();
		expect(options.find((option) => option.long === "--force")).toBeDefined();
		expect(options.find((option) => option.long === "--json")).toBeDefined();
	});

	test("pause and refresh-briefs subcommands expose control flags", () => {
		const cmd = createMissionCommand();
		const pause = cmd.commands.find((command) => command.name() === "pause");
		const refresh = cmd.commands.find((command) => command.name() === "refresh-briefs");

		expect(pause?.options.find((option) => option.long === "--reason")).toBeDefined();
		expect(pause?.options.find((option) => option.long === "--json")).toBeDefined();
		expect(refresh?.options.find((option) => option.long === "--workstream")).toBeDefined();
		expect(refresh?.options.find((option) => option.long === "--json")).toBeDefined();
	});

	test("resolveCurrentMissionId recovers from MissionStore when current-mission.txt is missing", async () => {
		const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			missionStore.create({
				id: "mission-001",
				slug: "mission-auth",
				objective: "Recover pointers",
				runId: "run-001",
			});
		} finally {
			missionStore.close();
		}

		const missionId = await resolveCurrentMissionId(overstoryDir);

		expect(missionId).toBe("mission-001");
		expect((await Bun.file(join(overstoryDir, "current-mission.txt")).text()).trim()).toBe(
			"mission-001",
		);
		expect((await Bun.file(join(overstoryDir, "current-run.txt")).text()).trim()).toBe("run-001");
	});

	test("resolveCurrentMissionId prefers the existing pointer file", async () => {
		await Bun.write(join(overstoryDir, "current-mission.txt"), "mission-pointed\n");

		const missionId = await resolveCurrentMissionId(overstoryDir);

		expect(missionId).toBe("mission-pointed");
		expect(await Bun.file(join(overstoryDir, "current-run.txt")).exists()).toBe(false);
	});

	test("resolveCurrentMissionId ignores a stale pointer when the pointed mission is terminal", async () => {
		const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			missionStore.create({
				id: "mission-active",
				slug: "mission-active",
				objective: "Recover from stale pointer",
				runId: "run-active",
			});
			missionStore.create({
				id: "mission-stopped",
				slug: "mission-stopped",
				objective: "Terminal mission",
				runId: "run-stopped",
			});
			missionStore.updateState("mission-stopped", "stopped");
			missionStore.updatePhase("mission-stopped", "done");
		} finally {
			missionStore.close();
		}

		await Bun.write(join(overstoryDir, "current-mission.txt"), "mission-stopped\n");

		const missionId = await resolveCurrentMissionId(overstoryDir);

		expect(missionId).toBe("mission-active");
		expect((await Bun.file(join(overstoryDir, "current-mission.txt")).text()).trim()).toBe(
			"mission-active",
		);
		expect((await Bun.file(join(overstoryDir, "current-run.txt")).text()).trim()).toBe("run-active");
	});
});
