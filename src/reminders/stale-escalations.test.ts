import { describe, expect, it } from "bun:test";
import type { MailMessage } from "../mail/types.ts";
import { staleEscalationsPolicy } from "./stale-escalations.ts";
import type { TemporalSignals } from "./types.ts";

function makeMessage(overrides: Partial<MailMessage> = {}): MailMessage {
	return {
		id: "msg-test",
		from: "agent-1",
		to: "orchestrator",
		subject: "Need help",
		body: "Please advise",
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

function emptySignals(collectedAt?: string): TemporalSignals {
	return {
		recentSessions: [],
		recentMessages: [],
		recentEvents: [],
		collectedAt: collectedAt ?? new Date().toISOString(),
	};
}

describe("staleEscalationsPolicy", () => {
	it("returns [] when no messages", () => {
		expect(staleEscalationsPolicy.evaluate(emptySignals())).toEqual([]);
	});

	it("returns [] when escalation is recent (within window)", () => {
		const collectedAt = new Date().toISOString();
		const signals: TemporalSignals = {
			...emptySignals(collectedAt),
			recentMessages: [
				makeMessage({
					id: "msg-1",
					type: "escalation",
					createdAt: new Date(Date.now() - 1000).toISOString(), // 1s ago, well within 4h
				}),
			],
		};
		expect(staleEscalationsPolicy.evaluate(signals)).toEqual([]);
	});

	it("returns [] when escalation has a reply", () => {
		const collectedAt = new Date().toISOString();
		const escalationId = "msg-esc";
		const escalationAge = 6 * 3600000; // 6h old → stale
		const signals: TemporalSignals = {
			...emptySignals(collectedAt),
			recentMessages: [
				makeMessage({
					id: escalationId,
					type: "escalation",
					createdAt: new Date(Date.now() - escalationAge).toISOString(),
				}),
				// Reply referencing the escalation
				makeMessage({
					id: "msg-reply",
					type: "result",
					threadId: escalationId,
					createdAt: new Date().toISOString(),
				}),
			],
		};
		expect(staleEscalationsPolicy.evaluate(signals)).toEqual([]);
	});

	it("fires with high priority when escalation is 4-8h old", () => {
		const collectedAt = new Date().toISOString();
		const signals: TemporalSignals = {
			...emptySignals(collectedAt),
			recentMessages: [
				makeMessage({
					id: "msg-stale",
					type: "escalation",
					createdAt: new Date(Date.now() - 5 * 3600000).toISOString(), // 5h old
				}),
			],
		};
		const results = staleEscalationsPolicy.evaluate(signals);
		expect(results).toHaveLength(1);
		expect(results[0]?.priority).toBe("high");
		expect(results[0]?.factor).toBe("reminder_stale_escalations");
		expect(results[0]?.source).toBe("temporal-reminders");
	});

	it("fires with critical priority when escalation is > 8h old", () => {
		const collectedAt = new Date().toISOString();
		const signals: TemporalSignals = {
			...emptySignals(collectedAt),
			recentMessages: [
				makeMessage({
					id: "msg-critical",
					type: "escalation",
					createdAt: new Date(Date.now() - 10 * 3600000).toISOString(), // 10h old
				}),
			],
		};
		const results = staleEscalationsPolicy.evaluate(signals);
		expect(results).toHaveLength(1);
		expect(results[0]?.priority).toBe("critical");
	});

	it("handles decision_gate type as well", () => {
		const collectedAt = new Date().toISOString();
		const signals: TemporalSignals = {
			...emptySignals(collectedAt),
			recentMessages: [
				makeMessage({
					id: "msg-gate",
					type: "decision_gate",
					createdAt: new Date(Date.now() - 6 * 3600000).toISOString(),
				}),
			],
		};
		const results = staleEscalationsPolicy.evaluate(signals);
		expect(results).toHaveLength(1);
		expect(results[0]?.factor).toBe("reminder_stale_escalations");
	});

	it("custom maxAge is respected", () => {
		// 2h old escalation with default 4h maxAge → no fire
		const collectedAt = new Date().toISOString();
		const signals: TemporalSignals = {
			...emptySignals(collectedAt),
			recentMessages: [
				makeMessage({
					id: "msg-esc",
					type: "escalation",
					createdAt: new Date(Date.now() - 2 * 3600000).toISOString(),
				}),
			],
		};
		expect(staleEscalationsPolicy.evaluate(signals)).toEqual([]);

		// With maxAge=1h (3600000ms), 2h old → fire
		const results = staleEscalationsPolicy.evaluate(signals, { staleEscalationMaxAgeMs: 3600000 });
		expect(results).toHaveLength(1);
	});
});
