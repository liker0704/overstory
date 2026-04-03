import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	drainAgentInbox,
	pendingMissionQuestionSender,
	sendMissionDispatchMail,
} from "./messaging.ts";

describe("drainAgentInbox", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "ov-messaging-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("returns 0 when no messages exist", () => {
		const count = drainAgentInbox(tempDir, "coordinator");
		expect(count).toBe(0);
	});

	test("returns count of messages after sending some", async () => {
		await sendMissionDispatchMail({
			overstoryDir: tempDir,
			to: "coordinator",
			subject: "Task 1",
			body: "Do the thing",
		});
		await sendMissionDispatchMail({
			overstoryDir: tempDir,
			to: "coordinator",
			subject: "Task 2",
			body: "Do the other thing",
		});
		const count = drainAgentInbox(tempDir, "coordinator");
		expect(count).toBe(2);
	});

	test("returns 0 on subsequent call after messages are drained", async () => {
		await sendMissionDispatchMail({
			overstoryDir: tempDir,
			to: "coordinator",
			subject: "Task",
			body: "Do it",
		});
		drainAgentInbox(tempDir, "coordinator");
		// Messages are claimed+acked by the first call; second call should see 0
		const secondCount = drainAgentInbox(tempDir, "coordinator");
		expect(secondCount).toBe(0);
	});

	test("returns 0 for a different agent when messages target another agent", async () => {
		await sendMissionDispatchMail({
			overstoryDir: tempDir,
			to: "coordinator",
			subject: "Task",
			body: "Do it",
		});
		const count = drainAgentInbox(tempDir, "mission-analyst");
		expect(count).toBe(0);
	});
});

describe("sendMissionDispatchMail", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "ov-messaging-dispatch-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("creates a mail record and returns a message id", async () => {
		const id = await sendMissionDispatchMail({
			overstoryDir: tempDir,
			to: "coordinator",
			subject: "Hello",
			body: "World",
		});
		expect(typeof id).toBe("string");
		expect(id.length).toBeGreaterThan(0);
	});

	test("sent message is visible via drainAgentInbox", async () => {
		await sendMissionDispatchMail({
			overstoryDir: tempDir,
			to: "coordinator",
			subject: "Hello",
			body: "World",
			missionId: "m-1",
		});
		const count = drainAgentInbox(tempDir, "coordinator");
		expect(count).toBe(1);
	});
});

describe("pendingMissionQuestionSender", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "ov-messaging-question-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("returns null for an unknown message id", async () => {
		const result = await pendingMissionQuestionSender(tempDir, "nonexistent-id");
		expect(result).toBeNull();
	});

	test("returns the sender of a known message", async () => {
		const msgId = await sendMissionDispatchMail({
			overstoryDir: tempDir,
			to: "coordinator",
			subject: "Question?",
			body: "What should I do?",
		});
		// sendMissionDispatchMail sends from "operator"
		const sender = await pendingMissionQuestionSender(tempDir, msgId);
		expect(sender).toBe("operator");
	});
});
