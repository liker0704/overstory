import { describe, expect, it } from "bun:test";
import type { EventQueryOptions, EventStore, StoredEvent } from "../events/types.js";
import { normalizeEventsForAgent, normalizeEventsForRun, normalizeSpans } from "./normalize.js";
import type { ExportSpan, SpanResource } from "./types.js";

// ---- helpers ----------------------------------------------------------------

function makeEvent(
	overrides: Partial<StoredEvent> & { eventType: StoredEvent["eventType"] },
): StoredEvent {
	return {
		id: 1,
		runId: "run-1",
		agentName: "agent-a",
		sessionId: "sess-1",
		toolName: null,
		toolArgs: null,
		toolDurationMs: null,
		level: "info",
		data: null,
		createdAt: new Date("2024-01-01T10:00:00.000Z").toISOString(),
		...overrides,
	};
}

function ts(offsetMs: number): string {
	return new Date(new Date("2024-01-01T10:00:00.000Z").getTime() + offsetMs).toISOString();
}

// ---- tests ------------------------------------------------------------------

describe("normalizeSpans", () => {
	it("tool_start + tool_end pair → one tool span with correct duration and attributes", () => {
		const events: StoredEvent[] = [
			makeEvent({
				id: 1,
				eventType: "tool_start",
				toolName: "Read",
				toolArgs: JSON.stringify({ summary: "read: foo.ts", args: { file_path: "foo.ts" } }),
				createdAt: ts(0),
			}),
			makeEvent({
				id: 2,
				eventType: "tool_end",
				toolName: "Read",
				toolDurationMs: 42,
				createdAt: ts(42),
			}),
		];

		const spans = normalizeSpans(events, {});
		expect(spans).toHaveLength(1);
		const span = spans[0] as ExportSpan;
		expect(span.kind).toBe("tool");
		expect(span.name).toBe("tool:Read");
		expect(span.durationMs).toBe(42);
		expect(span.endTime).not.toBeNull();
		expect(span.attributes["tool.name"]).toBe("Read");
		expect(span.attributes["tool.args.summary"]).toBe("read: foo.ts");
		expect(span.attributes["tool.duration_ms"]).toBe(42);
		expect(span.status).toBe("ok");
	});

	it("session_start + session_end pair → one session span", () => {
		const events: StoredEvent[] = [
			makeEvent({ id: 1, eventType: "session_start", createdAt: ts(0) }),
			makeEvent({ id: 2, eventType: "session_end", createdAt: ts(1000) }),
		];

		const spans = normalizeSpans(events, {});
		expect(spans).toHaveLength(1);
		const span = spans[0] as ExportSpan;
		expect(span.kind).toBe("session");
		expect(span.durationMs).toBe(1000);
		expect(span.endTime).not.toBeNull();
	});

	it("turn_start + turn_end pair → one turn span", () => {
		const events: StoredEvent[] = [
			makeEvent({ id: 1, eventType: "turn_start", createdAt: ts(0) }),
			makeEvent({ id: 2, eventType: "turn_end", createdAt: ts(500) }),
		];

		const spans = normalizeSpans(events, {});
		expect(spans).toHaveLength(1);
		const span = spans[0] as ExportSpan;
		expect(span.kind).toBe("turn");
		expect(span.durationMs).toBe(500);
	});

	it("spawn event → instantaneous span (start=end, durationMs=0)", () => {
		const events: StoredEvent[] = [makeEvent({ id: 1, eventType: "spawn", createdAt: ts(0) })];

		const spans = normalizeSpans(events, {});
		expect(spans).toHaveLength(1);
		const span = spans[0] as ExportSpan;
		expect(span.kind).toBe("spawn");
		expect(span.durationMs).toBe(0);
		expect(span.startTime).toBe(span.endTime);
	});

	it("mail_sent event → instantaneous mail span", () => {
		const events: StoredEvent[] = [makeEvent({ id: 1, eventType: "mail_sent", createdAt: ts(0) })];

		const spans = normalizeSpans(events, {});
		expect(spans).toHaveLength(1);
		const span = spans[0] as ExportSpan;
		expect(span.kind).toBe("mail");
		expect(span.durationMs).toBe(0);
		expect(span.startTime).toBe(span.endTime);
	});

	it("mission event → instantaneous mission span", () => {
		const events: StoredEvent[] = [makeEvent({ id: 1, eventType: "mission", createdAt: ts(0) })];

		const spans = normalizeSpans(events, {});
		expect(spans).toHaveLength(1);
		const span = spans[0] as ExportSpan;
		expect(span.kind).toBe("mission");
		expect(span.durationMs).toBe(0);
	});

	it("unmatched tool_start (no matching end) → open span with endTime=null, durationMs=null", () => {
		const events: StoredEvent[] = [
			makeEvent({ id: 1, eventType: "tool_start", toolName: "Bash", createdAt: ts(0) }),
		];

		const spans = normalizeSpans(events, {});
		expect(spans).toHaveLength(1);
		const span = spans[0] as ExportSpan;
		expect(span.kind).toBe("tool");
		expect(span.endTime).toBeNull();
		expect(span.durationMs).toBeNull();
		expect(span.status).toBe("unset");
	});

	it("error event with open span → attached as SpanEvent to nearest open span", () => {
		const events: StoredEvent[] = [
			makeEvent({ id: 1, eventType: "tool_start", toolName: "Bash", createdAt: ts(0) }),
			makeEvent({ id: 2, eventType: "error", level: "error", createdAt: ts(10) }),
		];

		const spans = normalizeSpans(events, {});
		// tool_start is open (no tool_end), flushed at end
		expect(spans).toHaveLength(1);
		const span = spans[0] as ExportSpan;
		expect(span.kind).toBe("tool");
		expect(span.events).toHaveLength(1);
		const ev = span.events[0];
		expect(ev).toBeDefined();
		expect(ev?.name).toBe("error");
	});

	it("error event with no open span → standalone error span (kind=custom)", () => {
		const events: StoredEvent[] = [
			makeEvent({ id: 1, eventType: "error", level: "error", createdAt: ts(0) }),
		];

		const spans = normalizeSpans(events, {});
		expect(spans).toHaveLength(1);
		const span = spans[0] as ExportSpan;
		expect(span.kind).toBe("custom");
		expect(span.status).toBe("error");
	});

	it("events with null runId/sessionId → handled gracefully", () => {
		const events: StoredEvent[] = [
			makeEvent({ id: 1, eventType: "spawn", runId: null, sessionId: null, createdAt: ts(0) }),
		];

		const spans = normalizeSpans(events, {});
		expect(spans).toHaveLength(1);
		const span = spans[0] as ExportSpan;
		expect(span.resource.runId).toBeNull();
		expect(span.resource.sessionId).toBeNull();
		// traceId should still be populated (generated)
		expect(span.traceId).toBeTruthy();
		expect(span.traceId.length).toBeGreaterThan(0);
	});

	it("toolArgs with FilteredToolArgs.summary → extracted correctly", () => {
		const events: StoredEvent[] = [
			makeEvent({
				id: 1,
				eventType: "tool_start",
				toolName: "Grep",
				toolArgs: JSON.stringify({ summary: "grep: pattern in src/", args: {} }),
				createdAt: ts(0),
			}),
			makeEvent({
				id: 2,
				eventType: "tool_end",
				toolName: "Grep",
				toolDurationMs: 5,
				createdAt: ts(5),
			}),
		];

		const spans = normalizeSpans(events, {});
		const span = spans[0] as ExportSpan;
		expect(span.attributes["tool.args.summary"]).toBe("grep: pattern in src/");
	});

	it("data JSON with event. prefix → attributes populated correctly", () => {
		const events: StoredEvent[] = [
			makeEvent({
				id: 1,
				eventType: "spawn",
				data: JSON.stringify({ target: "worker-1", depth: 2, active: true }),
				createdAt: ts(0),
			}),
		];

		const spans = normalizeSpans(events, {});
		const span = spans[0] as ExportSpan;
		expect(span.attributes["event.target"]).toBe("worker-1");
		expect(span.attributes["event.depth"]).toBe(2);
		expect(span.attributes["event.active"]).toBe(true);
	});

	it("LIFO turn matching — nested turns resolved in correct order", () => {
		const events: StoredEvent[] = [
			makeEvent({ id: 1, eventType: "turn_start", createdAt: ts(0) }),
			makeEvent({ id: 2, eventType: "turn_start", createdAt: ts(100) }),
			makeEvent({ id: 3, eventType: "turn_end", createdAt: ts(200) }), // closes inner
			makeEvent({ id: 4, eventType: "turn_end", createdAt: ts(300) }), // closes outer
		];

		const spans = normalizeSpans(events, {});
		expect(spans).toHaveLength(2);
		// Both complete with proper end times
		for (const s of spans) {
			expect(s.endTime).not.toBeNull();
		}
		// Inner turn duration = 100ms, outer = 300ms
		const durations = spans.map((s) => s.durationMs).sort((a, b) => (a ?? 0) - (b ?? 0));
		expect(durations[0]).toBe(100);
		expect(durations[1]).toBe(300);
	});

	it("resource fields from partial resource are propagated", () => {
		const partialResource: Partial<SpanResource> = {
			taskId: "task-42",
			missionId: "mission-7",
			capability: "builder",
		};
		const events: StoredEvent[] = [makeEvent({ id: 1, eventType: "spawn", createdAt: ts(0) })];

		const spans = normalizeSpans(events, partialResource);
		const span = spans[0] as ExportSpan;
		expect(span.resource.taskId).toBe("task-42");
		expect(span.resource.missionId).toBe("mission-7");
		expect(span.resource.capability).toBe("builder");
		expect(span.resource.agentName).toBe("agent-a");
	});
});

describe("normalizeEventsForRun", () => {
	it("calls eventStore.getByRun with the given runId and normalizes", () => {
		const fakeEvents: StoredEvent[] = [
			makeEvent({ id: 1, eventType: "spawn", runId: "run-abc", createdAt: ts(0) }),
		];
		const store: Partial<EventStore> & Pick<EventStore, "getByRun"> = {
			getByRun: (runId: string) => {
				expect(runId).toBe("run-abc");
				return fakeEvents;
			},
		};

		const spans = normalizeEventsForRun(store as EventStore, "run-abc");
		expect(spans).toHaveLength(1);
		expect(spans[0]?.kind).toBe("spawn");
	});
});

describe("normalizeEventsForAgent", () => {
	it("calls eventStore.getByAgent with agentName and opts, then normalizes", () => {
		const fakeEvents: StoredEvent[] = [
			makeEvent({
				id: 1,
				eventType: "mail_sent",
				agentName: "agent-b",
				runId: null,
				createdAt: ts(0),
			}),
		];
		const opts: EventQueryOptions = { limit: 10 };
		const store: Partial<EventStore> & Pick<EventStore, "getByAgent"> = {
			getByAgent: (name: string, passedOpts?: EventQueryOptions) => {
				expect(name).toBe("agent-b");
				expect(passedOpts).toEqual(opts);
				return fakeEvents;
			},
		};

		const spans = normalizeEventsForAgent(store as EventStore, "agent-b", opts);
		expect(spans).toHaveLength(1);
		expect(spans[0]?.kind).toBe("mail");
	});
});
