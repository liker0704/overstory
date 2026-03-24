import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MissionCommandDeps } from "../missions/lifecycle.ts";
import { missionStart, missionStop } from "../missions/lifecycle.ts";
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
		expect(names).toContain("graph");
		expect(names).toContain("update");
		expect(names).toContain("extract-learnings");
		expect(names).toHaveLength(17);
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
		expect((await Bun.file(join(overstoryDir, "current-run.txt")).text()).trim()).toBe(
			"run-active",
		);
	});
});

describe("missionStart concurrency guard", () => {
	let guardDir: string;
	let guardOverstoryDir: string;
	let originalStdout: typeof process.stdout.write;
	let originalStderr: typeof process.stderr.write;

	beforeEach(async () => {
		guardDir = await mkdtemp(join(tmpdir(), "mission-guard-test-"));
		guardOverstoryDir = join(guardDir, ".overstory");
		await mkdir(guardOverstoryDir, { recursive: true });
		process.exitCode = 0;
		originalStdout = process.stdout.write;
		originalStderr = process.stderr.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
		process.stderr.write = (() => true) as typeof process.stderr.write;
	});

	afterEach(async () => {
		process.exitCode = 0;
		process.stdout.write = originalStdout;
		process.stderr.write = originalStderr;
		await cleanupTempDir(guardDir);
	});

	test("blocks start when active mission exists (default maxConcurrent=1)", async () => {
		const store = createMissionStore(join(guardOverstoryDir, "sessions.db"));
		try {
			store.create({ id: "m-active", slug: "active", objective: "obj", runId: "run-1" });
			store.start("m-active");
		} finally {
			store.close();
		}

		await missionStart(guardOverstoryDir, guardDir, {});
		expect(process.exitCode).toBe(1);
	});

	test("counts frozen missions toward the concurrency limit", async () => {
		const store = createMissionStore(join(guardOverstoryDir, "sessions.db"));
		try {
			store.create({ id: "m-frozen", slug: "frozen", objective: "obj", runId: "run-1" });
			store.start("m-frozen");
			store.updateState("m-frozen", "frozen");
		} finally {
			store.close();
		}

		await missionStart(guardOverstoryDir, guardDir, {});
		expect(process.exitCode).toBe(1);
	});

	test("does not count suspended missions toward the limit", async () => {
		const store = createMissionStore(join(guardOverstoryDir, "sessions.db"));
		try {
			store.create({ id: "m-suspended", slug: "suspended", objective: "obj", runId: "run-1" });
			store.start("m-suspended");
			store.updateState("m-suspended", "suspended");
		} finally {
			store.close();
		}

		// A suspended mission should not block missionStart (guard should pass)
		// Mock the role-starting deps so the function doesn't actually spawn agents
		const mockDeps: MissionCommandDeps = {
			startMissionCoordinator: async () =>
				({ session: { id: "sess-coord" }, runId: null, pid: 0 }) as never,
			startMissionAnalyst: async () =>
				({ session: { id: "sess-analyst" }, runId: null, pid: 0 }) as never,
		};

		await missionStart(guardOverstoryDir, guardDir, {}, mockDeps);
		// Guard did not block — active list has only the new mission
		const store2 = createMissionStore(join(guardOverstoryDir, "sessions.db"));
		try {
			const active = store2.getActiveList();
			expect(active.some((m) => m.id !== "m-suspended")).toBe(true);
		} finally {
			store2.close();
		}
	});
});

describe("missionId parameter threading", () => {
	let threadDir: string;
	let threadOverstoryDir: string;
	let originalStdout: typeof process.stdout.write;
	let originalStderr: typeof process.stderr.write;

	beforeEach(async () => {
		threadDir = await mkdtemp(join(tmpdir(), "mission-thread-test-"));
		threadOverstoryDir = join(threadDir, ".overstory");
		await mkdir(threadOverstoryDir, { recursive: true });
		process.exitCode = 0;
		originalStdout = process.stdout.write;
		originalStderr = process.stderr.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
		process.stderr.write = (() => true) as typeof process.stderr.write;
	});

	afterEach(async () => {
		process.exitCode = 0;
		process.stdout.write = originalStdout;
		process.stderr.write = originalStderr;
		await cleanupTempDir(threadDir);
	});

	test("missionStop uses explicit missionId to suspend a specific mission", async () => {
		const store = createMissionStore(join(threadOverstoryDir, "sessions.db"));
		try {
			store.create({ id: "target-mission", slug: "target", objective: "obj", runId: "run-1" });
			store.start("target-mission");
		} finally {
			store.close();
		}

		// Set pointer to a nonexistent mission so resolveCurrentMissionId would return null/other
		await Bun.write(join(threadOverstoryDir, "current-mission.txt"), "nonexistent-pointer\n");

		// Call missionStop with explicit missionId — should suspend target-mission
		await missionStop(threadOverstoryDir, threadDir, false, false, {}, "target-mission");

		const store2 = createMissionStore(join(threadOverstoryDir, "sessions.db"));
		try {
			expect(store2.getById("target-mission")?.state).toBe("suspended");
		} finally {
			store2.close();
		}
	});
});
