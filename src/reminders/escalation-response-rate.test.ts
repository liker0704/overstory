import { describe, expect, it } from "bun:test";
import type { MailMessage } from "../mail/types.ts";
import { escalationResponseRatePolicy } from "./escalation-response-rate.ts";
import type { TemporalSignals } from "./types.ts";

let msgIdCounter = 0;
function makeMessage(overrides: Partial<MailMessage> = {}): MailMessage {
	return {
		id: `msg-${++msgIdCounter}`,
		from: "agent-1",
		to: "orchestrator",
		subject: "escalation",
		body: "help",
		priority: "normal",
		type: "escalation",
		threadId: null,
		payload: null,
		read: false,
		createdAt: new Date().toISOString(),
		state: "queued",
		claimedAt: null,
		missionId: null,
		attempt: 0,
		nextRetryAt: null,
		failReason: null,
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

describe("escalationResponseRatePolicy", () => {
	it("returns [] when no messages", () => {
		expect(escalationResponseRatePolicy.evaluate(emptySignals())).toEqual([]);
	});

	it("returns [] when fewer than 2 escalations", () => {
		const signals: TemporalSignals = {
			...emptySignals(),
			recentMessages: [makeMessage({ type: "escalation" })],
		};
		expect(escalationResponseRatePolicy.evaluate(signals)).toEqual([]);
	});

	it("returns [] when response rate meets threshold", () => {
		// 2 escalations, both responded → rate = 1.0 >= 0.5
		const e1 = makeMessage({ type: "escalation" });
		const e2 = makeMessage({ type: "escalation" });
		const signals: TemporalSignals = {
			...emptySignals(),
			recentMessages: [
				e1,
				e2,
				makeMessage({ type: "worker_done", threadId: e1.id }),
				makeMessage({ type: "result", threadId: e2.id }),
			],
		};
		expect(escalationResponseRatePolicy.evaluate(signals)).toEqual([]);
	});

	it("fires when response rate is below threshold", () => {
		// 2 escalations, 0 responded → rate = 0.0 < 0.5
		const signals: TemporalSignals = {
			...emptySignals(),
			recentMessages: [makeMessage({ type: "escalation" }), makeMessage({ type: "escalation" })],
		};
		const results = escalationResponseRatePolicy.evaluate(signals);
		expect(results).toHaveLength(1);
		expect(results[0]?.factor).toBe("reminder_escalation_response_rate");
		expect(results[0]?.priority).toBe("medium");
		expect(results[0]?.source).toBe("temporal-reminders");
	});

	it("counts only worker_done and result as valid responses", () => {
		// 2 escalations, one gets a "status" reply (not a valid response)
		const e1 = makeMessage({ type: "escalation" });
		const e2 = makeMessage({ type: "escalation" });
		const signals: TemporalSignals = {
			...emptySignals(),
			recentMessages: [
				e1,
				e2,
				makeMessage({ type: "status", threadId: e1.id }), // not valid
			],
		};
		const results = escalationResponseRatePolicy.evaluate(signals);
		expect(results).toHaveLength(1);
	});

	it("custom minRate is respected", () => {
		// 2 escalations, 1 responded = 50% rate
		const e1 = makeMessage({ type: "escalation" });
		const e2 = makeMessage({ type: "escalation" });
		const signals: TemporalSignals = {
			...emptySignals(),
			recentMessages: [e1, e2, makeMessage({ type: "worker_done", threadId: e1.id })],
		};
		// Default threshold=0.5, rate=0.5 → should NOT fire (rate >= minRate)
		expect(escalationResponseRatePolicy.evaluate(signals)).toHaveLength(0);
		// With higher threshold=0.9, rate=0.5 → should fire
		const results = escalationResponseRatePolicy.evaluate(signals, {
			escalationResponseMinRate: 0.9,
		});
		expect(results).toHaveLength(1);
	});
});
