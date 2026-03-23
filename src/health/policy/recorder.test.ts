import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventStore } from "../../events/store.ts";
import type { EventStore } from "../../types.ts";
import type { PolicyActionRecord, PolicyEvaluation } from "./types.ts";
import { recordPolicyEvaluationResult, recordPolicyEvent } from "./recorder.ts";

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
	tmpDir = await mkdtemp(join(tmpdir(), "recorder-test-"));
	eventStore = createEventStore(join(tmpDir, "events.db"));
});

afterEach(async () => {
	eventStore.close();
	await rm(tmpDir, { recursive: true, force: true });
});

describe("recordPolicyEvent", () => {
	test("non-triggered evaluation → no event inserted", () => {
		const evaluation = makeEvaluation({ triggered: false });
		recordPolicyEvent(eventStore, evaluation, null);

		const events = eventStore.getByAgent("health-policy");
		expect(events).toHaveLength(0);
	});

	test("triggered + executed → event with level info, data roundtrips to PolicyActionRecord", () => {
		const evaluation = makeEvaluation({ executedAt: new Date().toISOString() });
		recordPolicyEvent(eventStore, evaluation, "run-1");

		const events = eventStore.getByAgent("health-policy");
		expect(events).toHaveLength(1);

		const event = events[0]!;
		expect(event.level).toBe("info");
		expect(event.agentName).toBe("health-policy");
		expect(event.runId).toBe("run-1");

		const data = JSON.parse(event.data!);
		expect(data.type).toBe("health_action");
		expect(data.action).toBe("pause_spawning");
		expect(data.ruleId).toBe("rule-1");
		expect(data.triggered).toBe(true);
		expect(data.suppressed).toBe(false);
		expect(data.dryRun).toBe(false);
		expect(typeof data.details).toBe("string");
		expect(typeof data.timestamp).toBe("string");
	});

	test("triggered + dry-run → event with level warn, dryRun: true in data", () => {
		const evaluation = makeEvaluation({ dryRun: true });
		recordPolicyEvent(eventStore, evaluation, null);

		const events = eventStore.getByAgent("health-policy");
		expect(events).toHaveLength(1);

		const event = events[0]!;
		expect(event.level).toBe("warn");

		const data = JSON.parse(event.data!);
		expect(data.dryRun).toBe(true);
	});

	test("triggered + suppressed (first time) → event recorded with level warn", () => {
		const evaluation = makeEvaluation({ suppressed: true, suppressReason: "cooldown" });
		recordPolicyEvent(eventStore, evaluation, null, []);

		const events = eventStore.getByAgent("health-policy");
		expect(events).toHaveLength(1);
		expect(events[0]!.level).toBe("warn");
	});

	test("triggered + suppressed (duplicate in history) → no event recorded (dedup works)", () => {
		const existingRecord: PolicyActionRecord = {
			action: "pause_spawning",
			ruleId: "rule-1",
			triggered: true,
			suppressed: true,
			dryRun: false,
			details: "suppressed: cooldown",
			timestamp: new Date().toISOString(),
		};
		const evaluation = makeEvaluation({ suppressed: true, suppressReason: "cooldown" });
		recordPolicyEvent(eventStore, evaluation, null, [existingRecord]);

		const events = eventStore.getByAgent("health-policy");
		expect(events).toHaveLength(0);
	});

	test("eventStore.insert throws → no exception propagates (fire-and-forget)", () => {
		// Close the db to make insert throw
		eventStore.close();
		const evaluation = makeEvaluation();
		// Must not throw
		expect(() => recordPolicyEvent(eventStore, evaluation, null)).not.toThrow();
	});

	test("recordPolicyEvaluationResult records multiple evaluations", () => {
		const evaluations: PolicyEvaluation[] = [
			makeEvaluation(),
			makeEvaluation({
				rule: {
					id: "rule-2",
					action: "resume_spawning",
					condition: { factor: "completion_rate", threshold: 80, operator: "gt" },
					cooldownMs: 60_000,
					priority: "low",
				},
			}),
			makeEvaluation({ triggered: false }),
		];

		recordPolicyEvaluationResult(eventStore, evaluations, null);

		const events = eventStore.getByAgent("health-policy");
		// Only the 2 triggered evaluations should be recorded
		expect(events).toHaveLength(2);
	});
});
