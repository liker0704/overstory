import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resolveCurrentMissionId,
	resolveMissionRoleStates,
	toSummary,
} from "./lifecycle-helpers.ts";
import { makeMission } from "./test-mocks.ts";

describe("toSummary", () => {
	test("converts Mission fields to MissionSummary correctly", () => {
		const mission = makeMission({
			id: "m-1",
			slug: "my-mission",
			objective: "build something",
			state: "active",
			phase: "execute",
			pendingUserInput: false,
			pendingInputKind: null,
			firstFreezeAt: null,
			reopenCount: 2,
			pausedWorkstreamIds: [],
			pauseReason: null,
			createdAt: "2024-01-01T00:00:00Z",
			updatedAt: "2024-01-02T00:00:00Z",
		});
		const summary = toSummary(mission);
		expect(summary.id).toBe("m-1");
		expect(summary.slug).toBe("my-mission");
		expect(summary.objective).toBe("build something");
		expect(summary.state).toBe("active");
		expect(summary.phase).toBe("execute");
		expect(summary.pendingUserInput).toBe(false);
		expect(summary.pendingInputKind).toBeNull();
		expect(summary.firstFreezeAt).toBeNull();
		expect(summary.reopenCount).toBe(2);
		expect(summary.pausedWorkstreamCount).toBe(0);
		expect(summary.pauseReason).toBeNull();
		expect(summary.createdAt).toBe("2024-01-01T00:00:00Z");
		expect(summary.updatedAt).toBe("2024-01-02T00:00:00Z");
	});

	test("computes pausedWorkstreamCount from pausedWorkstreamIds length", () => {
		const mission = makeMission({
			pausedWorkstreamIds: ["ws-1", "ws-2", "ws-3"],
		});
		const summary = toSummary(mission);
		expect(summary.pausedWorkstreamCount).toBe(3);
	});

	test("toSummary does not include pausedWorkstreamIds array directly", () => {
		const mission = makeMission({ pausedWorkstreamIds: ["ws-a"] });
		const summary = toSummary(mission);
		expect("pausedWorkstreamIds" in summary).toBe(false);
	});
});

describe("resolveCurrentMissionId", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "ov-lifecycle-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("returns null when overstory dir has no pointer file", async () => {
		const result = await resolveCurrentMissionId(tempDir);
		expect(result).toBeNull();
	});

	test("returns missionId when current-mission.txt pointer exists", async () => {
		await Bun.write(join(tempDir, "current-mission.txt"), "m-xyz\n");
		// sessions.db absent, so resolveActiveMissionContext returns the pointer value
		const result = await resolveCurrentMissionId(tempDir);
		expect(result).toBe("m-xyz");
	});
});

describe("resolveMissionRoleStates", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "ov-lifecycle-roles-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("returns not-started for all roles when no sessions exist", () => {
		const mission = makeMission();
		const states = resolveMissionRoleStates(tempDir, mission);
		// No sessions in DB — all roles show "not started"
		expect(states.coordinator).toBe("not started");
		expect(states.analyst).toBe("not started");
		expect(states.executionDirector).toBe("not started");
	});
});
