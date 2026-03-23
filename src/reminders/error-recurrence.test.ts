import { describe, expect, it } from "bun:test";
import type { StoredEvent } from "../events/types.ts";
import { errorRecurrencePolicy } from "./error-recurrence.ts";
import type { TemporalSignals } from "./types.ts";

function makeEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
	return {
		id: 1,
		runId: null,
		agentName: "agent-1",
		sessionId: null,
		eventType: "error",
		toolName: null,
		toolArgs: null,
		toolDurationMs: null,
		level: "error",
		data: "some error",
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

function emptySignals(): TemporalSignals {
	return {
		recentSessions: [],
		recentMessages: [],
		recentEvents: [],
		collectedAt: new Date().toISOString(),
	};
}

describe("errorRecurrencePolicy", () => {
	it("returns [] when no events", () => {
		expect(errorRecurrencePolicy.evaluate(emptySignals())).toEqual([]);
	});

	it("returns [] when count below threshold", () => {
		// Default minCount is 3, so 2 occurrences should not fire
		const signals: TemporalSignals = {
			...emptySignals(),
			recentEvents: [
				makeEvent({ data: "connection refused" }),
				makeEvent({ data: "connection refused" }),
			],
		};
		expect(errorRecurrencePolicy.evaluate(signals)).toEqual([]);
	});

	it("returns recommendation when count meets threshold", () => {
		const signals: TemporalSignals = {
			...emptySignals(),
			recentEvents: [
				makeEvent({ data: "connection refused" }),
				makeEvent({ data: "connection refused" }),
				makeEvent({ data: "connection refused" }),
			],
		};
		const results = errorRecurrencePolicy.evaluate(signals);
		expect(results).toHaveLength(1);
		expect(results[0]?.factor).toBe("reminder_error_recurrence");
		expect(results[0]?.priority).toBe("high");
		expect(results[0]?.source).toBe("temporal-reminders");
		expect(results[0]?.whyNow).toContain("3");
	});

	it("normalizes UUIDs in keys", () => {
		// Two events with UUID in data should be grouped together
		const signals: TemporalSignals = {
			...emptySignals(),
			recentEvents: [
				makeEvent({ data: "error: agent 550e8400-e29b-41d4-a716-446655440000 failed" }),
				makeEvent({ data: "error: agent 6ba7b810-9dad-11d1-80b4-00c04fd430c8 failed" }),
				makeEvent({ data: "error: agent 9c858901-8a57-4791-81fe-4c455b099bc9 failed" }),
			],
		};
		const results = errorRecurrencePolicy.evaluate(signals);
		expect(results).toHaveLength(1);
	});

	it("strips text before first colon for grouping", () => {
		// "Error: foo" and "Warning: foo" should both normalize to " foo" after stripping before colon
		// Actually after strip: both become " foo" → same key
		const signals: TemporalSignals = {
			...emptySignals(),
			recentEvents: [
				makeEvent({ data: "Error: database connection failed" }),
				makeEvent({ data: "Timeout: database connection failed" }),
				makeEvent({ data: "Retry: database connection failed" }),
			],
		};
		const results = errorRecurrencePolicy.evaluate(signals);
		expect(results).toHaveLength(1);
	});

	it("uses toolName as fallback when data is null", () => {
		const signals: TemporalSignals = {
			...emptySignals(),
			recentEvents: [
				makeEvent({ data: null, toolName: "Bash" }),
				makeEvent({ data: null, toolName: "Bash" }),
				makeEvent({ data: null, toolName: "Bash" }),
			],
		};
		const results = errorRecurrencePolicy.evaluate(signals);
		expect(results).toHaveLength(1);
	});

	it("custom minCount is respected", () => {
		const signals: TemporalSignals = {
			...emptySignals(),
			recentEvents: [makeEvent({ data: "some error" }), makeEvent({ data: "some error" })],
		};
		// With minCount=2, should fire
		const results = errorRecurrencePolicy.evaluate(signals, { errorRecurrenceMinCount: 2 });
		expect(results).toHaveLength(1);
	});
});
