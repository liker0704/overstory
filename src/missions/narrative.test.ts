/**
 * Tests for mission narrative export (buildNarrative, renderNarrative).
 *
 * Uses plain in-memory data — no SQLite, no filesystem, no mocks.
 */

import { describe, expect, test } from "bun:test";
import type { Mission, StoredEvent } from "../types.ts";
import type { MissionNarrative, NarrativeEvent } from "./narrative.ts";
import { buildNarrative, renderNarrative } from "./narrative.ts";

// === Test fixtures ===

function makeMission(overrides: Partial<Mission> = {}): Mission {
	return {
		id: "mission-001",
		slug: "test-mission",
		objective: "Ship the feature",
		runId: "run-1",
		state: "active",
		phase: "execute",
		firstFreezeAt: null,
		pendingUserInput: false,
		pendingInputKind: null,
		pendingInputThreadId: null,
		reopenCount: 0,
		artifactRoot: null,
		pausedWorkstreamIds: [],
		analystSessionId: null,
		executionDirectorSessionId: null,
		coordinatorSessionId: null,
		architectSessionId: null,
		pausedLeadNames: [],
		pauseReason: null,
		currentNode: null,
		startedAt: null,
		completedAt: null,
		createdAt: "2026-03-12T10:00:00.000Z",
		updatedAt: "2026-03-12T12:00:00.000Z",
		learningsExtracted: false,
		tier: null,
		...overrides,
	};
}

function makeEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
	return {
		id: 1,
		runId: "run-1",
		agentName: "test-agent",
		sessionId: null,
		eventType: "session_start",
		toolName: null,
		toolArgs: null,
		toolDurationMs: null,
		level: "info",
		data: null,
		createdAt: "2026-03-12T10:01:00.000Z",
		...overrides,
	};
}

// === buildNarrative ===

describe("buildNarrative", () => {
	test("returns empty events for empty input", () => {
		const mission = makeMission();
		const narrative = buildNarrative(mission, []);

		expect(narrative.mission.id).toBe("mission-001");
		expect(narrative.mission.slug).toBe("test-mission");
		expect(narrative.mission.objective).toBe("Ship the feature");
		expect(narrative.mission.state).toBe("active");
		expect(narrative.mission.phase).toBe("execute");
		expect(narrative.events).toHaveLength(0);
		expect(narrative.generatedAt).toBeTruthy();
	});

	test("includes mission snapshot from the provided mission", () => {
		const mission = makeMission({ state: "completed", phase: "done" });
		const narrative = buildNarrative(mission, []);

		expect(narrative.mission.state).toBe("completed");
		expect(narrative.mission.phase).toBe("done");
	});

	test("converts session_start events", () => {
		const events = [makeEvent({ eventType: "session_start", agentName: "builder-1" })];
		const narrative = buildNarrative(makeMission(), events);

		expect(narrative.events).toHaveLength(1);
		const entry = narrative.events[0] as NarrativeEvent;
		expect(entry.label).toBe("Agent started");
		expect(entry.agentName).toBe("builder-1");
		expect(entry.description).toContain("builder-1");
	});

	test("converts session_end events", () => {
		const events = [makeEvent({ eventType: "session_end", agentName: "builder-1" })];
		const narrative = buildNarrative(makeMission(), events);

		expect(narrative.events).toHaveLength(1);
		const entry = narrative.events[0] as NarrativeEvent;
		expect(entry.label).toBe("Agent completed");
	});

	test("converts error events with data", () => {
		const events = [
			makeEvent({
				eventType: "error",
				agentName: "scout-1",
				data: "test failed",
				level: "error",
			}),
		];
		const narrative = buildNarrative(makeMission(), events);

		expect(narrative.events).toHaveLength(1);
		const entry = narrative.events[0] as NarrativeEvent;
		expect(entry.label).toBe("Error");
		expect(entry.description).toContain("scout-1");
		expect(entry.description).toContain("test failed");
	});

	test("converts result events", () => {
		const events = [makeEvent({ eventType: "result", data: "all tests pass" })];
		const narrative = buildNarrative(makeMission(), events);

		expect(narrative.events).toHaveLength(1);
		const entry = narrative.events[0] as NarrativeEvent;
		expect(entry.label).toBe("Result");
		expect(entry.description).toContain("all tests pass");
	});

	test("converts progress events", () => {
		const events = [makeEvent({ eventType: "progress", data: "50% complete" })];
		const narrative = buildNarrative(makeMission(), events);

		expect(narrative.events).toHaveLength(1);
		const entry = narrative.events[0] as NarrativeEvent;
		expect(entry.label).toBe("Progress");
	});

	test("converts mail_sent events", () => {
		const events = [makeEvent({ eventType: "mail_sent" })];
		const narrative = buildNarrative(makeMission(), events);

		expect(narrative.events).toHaveLength(1);
		const entry = narrative.events[0] as NarrativeEvent;
		expect(entry.label).toBe("Mail sent");
	});

	test("converts mail_received events", () => {
		const events = [makeEvent({ eventType: "mail_received" })];
		const narrative = buildNarrative(makeMission(), events);

		expect(narrative.events).toHaveLength(1);
		const entry = narrative.events[0] as NarrativeEvent;
		expect(entry.label).toBe("Mail received");
	});

	test("skips tool_start and tool_end events", () => {
		const events = [
			makeEvent({ eventType: "tool_start", id: 1 }),
			makeEvent({ eventType: "tool_end", id: 2 }),
		];
		const narrative = buildNarrative(makeMission(), events);
		expect(narrative.events).toHaveLength(0);
	});

	test("skips turn_start, turn_end, and custom events", () => {
		const events = [
			makeEvent({ eventType: "turn_start", id: 1 }),
			makeEvent({ eventType: "turn_end", id: 2 }),
			makeEvent({ eventType: "custom", id: 3 }),
		];
		const narrative = buildNarrative(makeMission(), events);
		expect(narrative.events).toHaveLength(0);
	});

	describe("mission events", () => {
		test("converts phase_change mission events", () => {
			const events = [
				makeEvent({
					eventType: "mission",
					data: JSON.stringify({ kind: "phase_change", from: "understand", to: "execute" }),
				}),
			];
			const narrative = buildNarrative(makeMission(), events);

			expect(narrative.events).toHaveLength(1);
			const entry = narrative.events[0] as NarrativeEvent;
			expect(entry.label).toBe("Phase: execute");
			expect(entry.description).toContain("understand");
			expect(entry.description).toContain("execute");
		});

		test("converts state_change mission events", () => {
			const events = [
				makeEvent({
					eventType: "mission",
					data: JSON.stringify({ kind: "state_change", from: "active", to: "completed" }),
				}),
			];
			const narrative = buildNarrative(makeMission(), events);

			expect(narrative.events).toHaveLength(1);
			const entry = narrative.events[0] as NarrativeEvent;
			expect(entry.label).toBe("State: completed");
			expect(entry.description).toContain("active");
			expect(entry.description).toContain("completed");
		});

		test("handles mission events with unknown kind", () => {
			const events = [
				makeEvent({
					eventType: "mission",
					data: JSON.stringify({ kind: "custom_event", detail: "something happened" }),
				}),
			];
			const narrative = buildNarrative(makeMission(), events);

			expect(narrative.events).toHaveLength(1);
			const entry = narrative.events[0] as NarrativeEvent;
			expect(entry.label).toContain("custom_event");
			expect(entry.description).toContain("something happened");
		});

		test("handles mission events with null data", () => {
			const events = [makeEvent({ eventType: "mission", data: null })];
			const narrative = buildNarrative(makeMission(), events);

			expect(narrative.events).toHaveLength(1);
			const entry = narrative.events[0] as NarrativeEvent;
			expect(entry.label).toBe("Mission event");
		});

		test("handles mission events with invalid JSON data", () => {
			const events = [makeEvent({ eventType: "mission", data: "not-json" })];
			const narrative = buildNarrative(makeMission(), events);

			expect(narrative.events).toHaveLength(1);
			const entry = narrative.events[0] as NarrativeEvent;
			expect(entry.label).toBe("Mission event");
		});
	});

	test("converts spawn events with agentName in data", () => {
		const events = [
			makeEvent({
				eventType: "spawn",
				data: JSON.stringify({ agentName: "builder-42" }),
			}),
		];
		const narrative = buildNarrative(makeMission(), events);

		expect(narrative.events).toHaveLength(1);
		const entry = narrative.events[0] as NarrativeEvent;
		expect(entry.label).toBe("Spawn");
		expect(entry.description).toContain("builder-42");
	});

	test("converts spawn events with no data", () => {
		const events = [makeEvent({ eventType: "spawn", data: null })];
		const narrative = buildNarrative(makeMission(), events);

		expect(narrative.events).toHaveLength(1);
		const entry = narrative.events[0] as NarrativeEvent;
		expect(entry.label).toBe("Spawn");
		expect(entry.description).toContain("sub-agent");
	});

	test("sorts events chronologically by createdAt", () => {
		const events = [
			makeEvent({ eventType: "session_end", createdAt: "2026-03-12T10:03:00.000Z", id: 3 }),
			makeEvent({ eventType: "session_start", createdAt: "2026-03-12T10:01:00.000Z", id: 1 }),
			makeEvent({ eventType: "result", createdAt: "2026-03-12T10:02:00.000Z", id: 2 }),
		];
		const narrative = buildNarrative(makeMission(), events);

		expect(narrative.events).toHaveLength(3);
		expect(narrative.events[0]?.label).toBe("Agent started");
		expect(narrative.events[1]?.label).toBe("Result");
		expect(narrative.events[2]?.label).toBe("Agent completed");
	});

	test("does not mutate the input events array", () => {
		const events = [
			makeEvent({ eventType: "session_end", createdAt: "2026-03-12T10:03:00.000Z", id: 2 }),
			makeEvent({ eventType: "session_start", createdAt: "2026-03-12T10:01:00.000Z", id: 1 }),
		];
		const original = [...events];
		buildNarrative(makeMission(), events);
		expect(events[0]?.id).toBe(original[0]?.id);
		expect(events[1]?.id).toBe(original[1]?.id);
	});
});

// === buildNarrative edge cases ===

describe("buildNarrative edge cases", () => {
	test("empty events array produces narrative with empty events", () => {
		const narrative = buildNarrative(makeMission(), []);
		expect(narrative.events).toHaveLength(0);
		expect(Array.isArray(narrative.events)).toBe(true);
	});

	test("only skippable events (tool_start, tool_end, turn_start, turn_end, custom) → events array is empty", () => {
		const events = [
			makeEvent({ eventType: "tool_start", id: 1 }),
			makeEvent({ eventType: "tool_end", id: 2 }),
			makeEvent({ eventType: "turn_start", id: 3 }),
			makeEvent({ eventType: "turn_end", id: 4 }),
			makeEvent({ eventType: "custom", id: 5 }),
		];
		const narrative = buildNarrative(makeMission(), events);
		expect(narrative.events).toHaveLength(0);
	});

	test("events with corrupted data JSON still produce narrative events", () => {
		const events = [
			makeEvent({ eventType: "mission", data: "{ corrupted json }" }),
			makeEvent({ eventType: "error", data: "{ also broken", id: 2 }),
		];
		const narrative = buildNarrative(makeMission(), events);
		// Both events should still appear — corrupted data falls back gracefully.
		expect(narrative.events).toHaveLength(2);
		// mission event with bad JSON falls back to "Mission event" label
		expect(narrative.events[0]?.label).toBe("Mission event");
		// error event with bad data string still renders
		expect(narrative.events[1]?.label).toBe("Error");
	});
});

// === renderNarrative ===

describe("renderNarrative", () => {
	function makeNarrative(overrides: Partial<MissionNarrative> = {}): MissionNarrative {
		return {
			mission: {
				id: "mission-001",
				slug: "test-mission",
				objective: "Ship the feature",
				state: "completed",
				phase: "done",
			},
			events: [],
			generatedAt: "2026-03-12T12:00:00.000Z",
			...overrides,
		};
	}

	test("includes mission slug and state in header", () => {
		const output = renderNarrative(makeNarrative());
		expect(output).toContain("test-mission");
		expect(output).toContain("completed");
	});

	test("includes objective in output", () => {
		const output = renderNarrative(makeNarrative());
		expect(output).toContain("Ship the feature");
	});

	test("includes phase in output", () => {
		const output = renderNarrative(makeNarrative());
		expect(output).toContain("done");
	});

	test("includes separator lines", () => {
		const output = renderNarrative(makeNarrative());
		expect(output).toContain("─");
	});

	test("includes generatedAt in footer", () => {
		const output = renderNarrative(makeNarrative());
		expect(output).toContain("2026-03-12T12:00:00.000Z");
	});

	test("shows placeholder for empty events", () => {
		const output = renderNarrative(makeNarrative({ events: [] }));
		expect(output).toContain("no events recorded");
	});

	test("renders event lines when events are present", () => {
		const event = makeEvent({ eventType: "session_start", agentName: "coord" });
		const narrative = buildNarrative(makeMission(), [event]);
		const output = renderNarrative(narrative);

		expect(output).toContain("Agent started");
		expect(output).toContain("coord");
	});

	test("formats timestamps as HH:MM:SS", () => {
		const event = makeEvent({
			eventType: "session_start",
			createdAt: "2026-03-12T18:48:41.946Z",
		});
		const narrative = buildNarrative(makeMission(), [event]);
		const output = renderNarrative(narrative);

		expect(output).toContain("18:48:41");
	});

	test("returns a non-empty multi-line string", () => {
		const output = renderNarrative(makeNarrative());
		const lines = output.split("\n");
		expect(lines.length).toBeGreaterThan(3);
	});
});
