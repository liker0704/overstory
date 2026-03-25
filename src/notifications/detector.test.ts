import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createEventStore } from "../events/store.ts";
import type { EventStore } from "../events/types.ts";
import type { MailStore } from "../mail/store.ts";
import { createMailStore } from "../mail/store.ts";
import { createNotificationDetector } from "./detector.ts";

function makeMailStore(): MailStore {
	return createMailStore(":memory:");
}

function makeEventStore(): EventStore {
	return createEventStore(":memory:");
}

describe("NotificationDetector", () => {
	let mailStore: MailStore;
	let eventStore: EventStore;

	beforeEach(() => {
		mailStore = makeMailStore();
		eventStore = makeEventStore();
	});

	afterEach(() => {
		mailStore.close?.();
		eventStore.close();
	});

	test("poll() returns empty array initially with no data", () => {
		const detector = createNotificationDetector();
		expect(detector.poll(mailStore, eventStore)).toEqual([]);
	});

	test("null mailStore and eventStore do not throw", () => {
		const detector = createNotificationDetector();
		expect(detector.poll(null, null)).toEqual([]);
	});

	test("mail error messages generate error notifications", () => {
		mailStore.insert({
			id: "msg-err-001",
			from: "agent-a",
			to: "orchestrator",
			subject: "Something broke",
			body: "Stack trace here",
			type: "error",
			priority: "high",
			threadId: null,
		});

		const detector = createNotificationDetector();
		const notifications = detector.poll(mailStore, null);

		expect(notifications).toHaveLength(1);
		const notif = notifications[0];
		expect(notif).toBeDefined();
		if (!notif) return;
		expect(notif.kind).toBe("error");
		expect(notif.severity).toBe("high");
		expect(notif.title).toBe("Something broke");
		expect(notif.body).toBe("Stack trace here");
		expect(notif.id).toBe("notif-mail-msg-err-001");
	});

	test("mail worker_done messages generate completion notifications", () => {
		mailStore.insert({
			id: "msg-wd-001",
			from: "builder-agent",
			to: "lead",
			subject: "Task overstory-xyz done",
			body: "All tests pass",
			type: "worker_done",
			priority: "normal",
			threadId: null,
		});

		const detector = createNotificationDetector();
		const notifications = detector.poll(mailStore, null);

		expect(notifications).toHaveLength(1);
		const notif = notifications[0];
		expect(notif).toBeDefined();
		if (!notif) return;
		expect(notif.kind).toBe("completion");
		expect(notif.severity).toBe("medium");
		expect(notif.title).toBe("Worker completed: builder-agent");
		expect(notif.body).toBe("Task overstory-xyz done");
	});

	test("mail result messages generate completion notifications with low severity", () => {
		mailStore.insert({
			id: "msg-res-001",
			from: "reviewer-agent",
			to: "lead",
			subject: "Review complete",
			body: "All good",
			type: "result",
			priority: "normal",
			threadId: null,
		});

		const detector = createNotificationDetector();
		const notifications = detector.poll(mailStore, null);

		expect(notifications).toHaveLength(1);
		const notif = notifications[0];
		expect(notif).toBeDefined();
		if (!notif) return;
		expect(notif.kind).toBe("completion");
		expect(notif.severity).toBe("low");
		expect(notif.title).toBe("Result from reviewer-agent");
		expect(notif.body).toBe("Review complete");
	});

	test("event errors generate error notifications", () => {
		eventStore.insert({
			runId: null,
			agentName: "agent-x",
			sessionId: null,
			eventType: "error",
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			level: "error",
			data: "Something failed hard",
		});

		const detector = createNotificationDetector();
		const notifications = detector.poll(null, eventStore);

		expect(notifications).toHaveLength(1);
		const notif = notifications[0];
		expect(notif).toBeDefined();
		if (!notif) return;
		expect(notif.kind).toBe("error");
		expect(notif.severity).toBe("high");
		expect(notif.title).toBe("Error: agent-x");
		expect(notif.body).toContain("error:");
		expect(notif.id).toMatch(/^notif-event-\d+$/);
	});

	test("events with eventType='spawn' generate info notifications", () => {
		eventStore.insert({
			runId: null,
			agentName: "builder-001",
			sessionId: null,
			eventType: "spawn",
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			level: "info",
			data: "spawned in worktree /tmp/abc",
		});

		const detector = createNotificationDetector();
		const notifications = detector.poll(null, eventStore);

		expect(notifications).toHaveLength(1);
		const notif = notifications[0];
		expect(notif).toBeDefined();
		if (!notif) return;
		expect(notif.kind).toBe("info");
		expect(notif.severity).toBe("low");
		expect(notif.title).toBe("Agent spawned: builder-001");
		expect(notif.body).toBe("spawned in worktree /tmp/abc");
	});

	test("watermark tracking: second poll() returns only new items", async () => {
		mailStore.insert({
			id: "msg-first-001",
			from: "agent-a",
			to: "lead",
			subject: "First error",
			body: "body",
			type: "error",
			priority: "high",
			threadId: null,
		});

		const detector = createNotificationDetector();

		const first = detector.poll(mailStore, null);
		expect(first).toHaveLength(1);

		// No new messages — should return empty
		const second = detector.poll(mailStore, null);
		expect(second).toHaveLength(0);

		// Wait to ensure a different createdAt timestamp
		await new Promise((resolve) => setTimeout(resolve, 5));

		// Add another message
		mailStore.insert({
			id: "msg-second-001",
			from: "agent-b",
			to: "lead",
			subject: "Second error",
			body: "body2",
			type: "error",
			priority: "high",
			threadId: null,
		});

		const third = detector.poll(mailStore, null);
		expect(third).toHaveLength(1);
		const notif = third[0];
		expect(notif).toBeDefined();
		if (!notif) return;
		expect(notif.title).toBe("Second error");
	});

	test("event watermark tracking: second poll returns only new events", () => {
		eventStore.insert({
			runId: null,
			agentName: "agent-a",
			sessionId: null,
			eventType: "error",
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			level: "error",
			data: "first error",
		});

		const detector = createNotificationDetector();

		const first = detector.poll(null, eventStore);
		expect(first).toHaveLength(1);

		const second = detector.poll(null, eventStore);
		expect(second).toHaveLength(0);

		eventStore.insert({
			runId: null,
			agentName: "agent-b",
			sessionId: null,
			eventType: "spawn",
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			level: "info",
			data: "new spawn",
		});

		const third = detector.poll(null, eventStore);
		expect(third).toHaveLength(1);
		const notif = third[0];
		expect(notif).toBeDefined();
		if (!notif) return;
		expect(notif.kind).toBe("info");
	});

	test("eviction cap: inserts 60 error messages, poll returns max 50", () => {
		for (let i = 0; i < 60; i++) {
			mailStore.insert({
				id: `msg-cap-${String(i).padStart(3, "0")}`,
				from: "agent-a",
				to: "lead",
				subject: `Error ${i}`,
				body: "body",
				type: "error",
				priority: "high",
				threadId: null,
			});
		}

		const detector = createNotificationDetector();
		const notifications = detector.poll(mailStore, null);

		expect(notifications.length).toBeLessThanOrEqual(50);
	});

	test("eviction cap is configurable", () => {
		for (let i = 0; i < 20; i++) {
			mailStore.insert({
				id: `msg-cfg-${String(i).padStart(3, "0")}`,
				from: "agent-a",
				to: "lead",
				subject: `Error ${i}`,
				body: "body",
				type: "error",
				priority: "high",
				threadId: null,
			});
		}

		const detector = createNotificationDetector({ maxPerTick: 5 });
		const notifications = detector.poll(mailStore, null);
		expect(notifications).toHaveLength(5);
	});
});
