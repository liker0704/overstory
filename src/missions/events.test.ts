import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMissionEvents, recordMissionEvent } from "./events.ts";
import { makeMission } from "./test-mocks.ts";

describe("recordMissionEvent / loadMissionEvents", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "ov-events-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("inserts event with correct runId and data kind", () => {
		const mission = makeMission({ runId: "run-abc" });
		recordMissionEvent({
			overstoryDir: tempDir,
			mission,
			agentName: "coordinator",
			data: { kind: "test_event", detail: "hello" },
		});
		const events = loadMissionEvents(tempDir, mission);
		expect(events.length).toBe(1);
		const event = events[0];
		expect(event?.runId).toBe("run-abc");
		expect(event?.agentName).toBe("coordinator");
		const parsed = JSON.parse(event?.data ?? "{}");
		expect(parsed.kind).toBe("test_event");
		expect(parsed.missionId).toBe(mission.id);
	});

	test("loadMissionEvents filters events by runId", () => {
		const missionA = makeMission({ id: "m-a", runId: "run-1" });
		const missionB = makeMission({ id: "m-b", runId: "run-2" });
		recordMissionEvent({
			overstoryDir: tempDir,
			mission: missionA,
			agentName: "coordinator",
			data: { kind: "event_a" },
		});
		recordMissionEvent({
			overstoryDir: tempDir,
			mission: missionB,
			agentName: "coordinator",
			data: { kind: "event_b" },
		});

		const eventsA = loadMissionEvents(tempDir, missionA);
		expect(eventsA.length).toBe(1);
		expect(JSON.parse(eventsA[0]?.data ?? "{}").kind).toBe("event_a");

		const eventsB = loadMissionEvents(tempDir, missionB);
		expect(eventsB.length).toBe(1);
		expect(JSON.parse(eventsB[0]?.data ?? "{}").kind).toBe("event_b");
	});

	test("loadMissionEvents returns empty array when runId is null", () => {
		const missionWithRun = makeMission({ runId: "run-x" });
		recordMissionEvent({
			overstoryDir: tempDir,
			mission: missionWithRun,
			agentName: "coordinator",
			data: { kind: "some_event" },
		});
		const nullRunMission = makeMission({ runId: null });
		const events = loadMissionEvents(tempDir, nullRunMission);
		expect(events).toEqual([]);
	});

	test("loadMissionEvents returns empty array for unknown runId", () => {
		const mission = makeMission({ runId: "run-real" });
		recordMissionEvent({
			overstoryDir: tempDir,
			mission,
			agentName: "coordinator",
			data: { kind: "some_event" },
		});
		const ghost = makeMission({ runId: "run-ghost" });
		const events = loadMissionEvents(tempDir, ghost);
		expect(events).toEqual([]);
	});
});
