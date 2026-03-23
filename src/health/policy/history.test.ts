import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventStore } from "../../events/store.ts";
import type { EventStore } from "../../types.ts";
import { loadRecentActions } from "./history.ts";
import { recordPolicyEvent } from "./recorder.ts";
import type { PolicyEvaluation } from "./types.ts";

function makeEvaluation(overrides: Partial<PolicyEvaluation> = {}): PolicyEvaluation {
	return {
		rule: {
			id: "rule-1",
			action: "pause_spawning",
			condition: { factor: "completion_rate", threshold: 50, operator: "lt" },
			cooldownMs: 60_000,
			priority: "medium",
		},
		triggered: true,
		suppressed: false,
		dryRun: false,
		...overrides,
	};
}

let tmpDir: string;
let eventStore: EventStore;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "history-test-"));
	eventStore = createEventStore(join(tmpDir, "events.db"));
});

afterEach(async () => {
	eventStore.close();
	await rm(tmpDir, { recursive: true, force: true });
});

describe("loadRecentActions", () => {
	test("empty store → returns []", () => {
		const records = loadRecentActions(eventStore, 60_000);
		expect(records).toEqual([]);
	});

	test("events within window → returns parsed PolicyActionRecord[]", () => {
		recordPolicyEvent(eventStore, makeEvaluation(), null);

		const records = loadRecentActions(eventStore, 60_000);
		expect(records).toHaveLength(1);
		expect(records[0]!.action).toBe("pause_spawning");
		expect(records[0]!.ruleId).toBe("rule-1");
		expect(records[0]!.triggered).toBe(true);
	});

	test("events outside window → not returned", async () => {
		recordPolicyEvent(eventStore, makeEvaluation(), null);

		// Wait long enough that the inserted event is older than the query window
		await Bun.sleep(10);

		// Use a 5ms window — the event was inserted >10ms ago, so it falls outside
		const records = loadRecentActions(eventStore, 5);
		expect(records).toHaveLength(0);
	});

	test("malformed data JSON → skipped gracefully", () => {
		eventStore.insert({
			runId: null,
			agentName: "health-policy",
			sessionId: null,
			eventType: "custom",
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			level: "info",
			data: "{not valid json",
		});

		const records = loadRecentActions(eventStore, 60_000);
		expect(records).toEqual([]);
	});

	test("non-health_action custom events → skipped", () => {
		eventStore.insert({
			runId: null,
			agentName: "health-policy",
			sessionId: null,
			eventType: "custom",
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			level: "info",
			data: JSON.stringify({ type: "other_event", foo: "bar" }),
		});

		const records = loadRecentActions(eventStore, 60_000);
		expect(records).toEqual([]);
	});

	test("LIMIT enforcement (insert >100, get ≤100)", () => {
		for (let i = 0; i < 120; i++) {
			recordPolicyEvent(
				eventStore,
				makeEvaluation({
					rule: {
						id: `rule-${i}`,
						action: "pause_spawning",
						condition: { factor: "completion_rate", threshold: 50, operator: "lt" },
						cooldownMs: 60_000,
						priority: "medium",
					},
				}),
				null,
			);
		}

		const records = loadRecentActions(eventStore, 60_000);
		expect(records.length).toBeLessThanOrEqual(100);
	});

	test("round-trip (record via recorder, load via history) → data matches", () => {
		const evaluation = makeEvaluation();
		recordPolicyEvent(eventStore, evaluation, "run-42");

		const records = loadRecentActions(eventStore, 60_000);
		expect(records).toHaveLength(1);

		const record = records[0]!;
		expect(record.action).toBe(evaluation.rule.action);
		expect(record.ruleId).toBe(evaluation.rule.id);
		expect(record.triggered).toBe(true);
		expect(record.suppressed).toBe(false);
		expect(record.dryRun).toBe(false);
		expect(typeof record.timestamp).toBe("string");
	});
});
