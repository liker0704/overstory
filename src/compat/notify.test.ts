import { describe, expect, it } from "bun:test";
import type { AgentSession } from "../agents/types.ts";
import type { MailClient } from "../mail/client.ts";
import type { MergeEntry } from "../merge/types.ts";
import { notifyCompatFailure } from "./notify.ts";
import type { CompatGateDecision } from "./types.ts";

// === Fixtures ===

function makeEntry(): MergeEntry {
	return {
		branchName: "overstory/test-builder/task-42",
		taskId: "task-42",
		agentName: "test-builder",
		filesModified: ["src/foo.ts"],
		enqueuedAt: "2026-01-01T00:00:00.000Z",
		status: "compat_failed",
		resolvedTier: null,
	};
}

function makeDecision(action: CompatGateDecision["action"] = "reject"): CompatGateDecision {
	return {
		action,
		reason: "exported symbol removed",
		result: {
			compatible: false,
			branchA: "main",
			branchB: "overstory/test-builder/task-42",
			summary: "Breaking changes detected",
			staticOnly: true,
			analyzedAt: "2026-01-01T00:00:00.000Z",
			changes: [
				{
					kind: "removed",
					severity: "breaking",
					symbol: {
						name: "MyFunc",
						kind: "function",
						signature: "() => void",
						filePath: "src/foo.ts",
						line: 10,
					},
				},
				{
					kind: "modified",
					severity: "warning",
					symbol: {
						name: "MyIface",
						kind: "interface",
						signature: "{ x: number }",
						filePath: "src/bar.ts",
						line: 20,
					},
					previousSignature: "{ x: string }",
				},
			],
		},
	};
}

function makeMockMail() {
	const sent: Array<{
		from: string;
		to: string;
		subject: string;
		body: string;
		type?: string;
		priority?: string;
		payload?: string;
	}> = [];
	const client = {
		send(msg: (typeof sent)[number]) {
			sent.push(msg);
			return "msg-test";
		},
	} as unknown as MailClient;
	return { sent, client };
}

function makeMockSessionStore(parentAgent?: string | null) {
	return {
		getByName: (_agentName: string): AgentSession | null => {
			if (parentAgent === undefined) {
				return null;
			}
			return {
				id: "ses-test",
				agentName: "test-builder",
				capability: "builder",
				runtime: "claude",
				worktreePath: "/tmp/test",
				branchName: "overstory/test-builder/task-42",
				taskId: "task-42",
				tmuxSession: "test-session",
				state: "working",
				pid: null,
				parentAgent: parentAgent ?? null,
				depth: 1,
				runId: null,
				startedAt: "2026-01-01T00:00:00.000Z",
				lastActivity: "2026-01-01T00:00:00.000Z",
				escalationLevel: 0,
				stalledSince: null,
				rateLimitedSince: null,
				runtimeSessionId: null,
				transcriptPath: null,
				originalRuntime: null,
				statusLine: null,
			};
		},
	};
}

// === Tests ===

describe("notifyCompatFailure", () => {
	it("sends merge_failed mail with correct fields", () => {
		const { sent, client } = makeMockMail();
		const deps = { sessionStore: makeMockSessionStore(null) };
		notifyCompatFailure(client, makeEntry(), makeDecision(), "/tmp/report.json", deps);

		expect(sent[0]).toBeDefined();
		expect(sent[0]?.from).toBe("compat-gate");
		expect(sent[0]?.to).toBe("test-builder");
		expect(sent[0]?.type).toBe("merge_failed");
		expect(sent[0]?.priority).toBe("high");
		expect(sent[0]?.subject).toContain("overstory/test-builder/task-42");
	});

	it("includes breaking changes in mail body", () => {
		const { sent, client } = makeMockMail();
		const deps = { sessionStore: makeMockSessionStore(null) };
		notifyCompatFailure(client, makeEntry(), makeDecision(), "/tmp/report.json", deps);

		const body = sent[0]?.body ?? "";
		expect(body).toContain("MyFunc");
		expect(body).toContain("src/foo.ts");
		expect(body).toContain("REMOVED");
	});

	it("includes warnings in mail body", () => {
		const { sent, client } = makeMockMail();
		const deps = { sessionStore: makeMockSessionStore(null) };
		notifyCompatFailure(client, makeEntry(), makeDecision(), "/tmp/report.json", deps);

		const body = sent[0]?.body ?? "";
		expect(body).toContain("MyIface");
		expect(body).toContain("Warnings");
	});

	it("sends reroute_recommendation to parent", () => {
		const { sent, client } = makeMockMail();
		const deps = { sessionStore: makeMockSessionStore("my-lead") };
		notifyCompatFailure(client, makeEntry(), makeDecision(), "/tmp/report.json", deps);

		expect(sent[1]).toBeDefined();
		expect(sent[1]?.to).toBe("my-lead");
		expect(sent[1]?.type).toBe("reroute_recommendation");
	});

	it("falls back to coordinator when parent is null", () => {
		const { sent, client } = makeMockMail();
		const deps = { sessionStore: makeMockSessionStore(null) };
		notifyCompatFailure(client, makeEntry(), makeDecision(), "/tmp/report.json", deps);

		expect(sent[1]?.to).toBe("coordinator");
	});

	it("handles missing agent session gracefully", () => {
		const { sent, client } = makeMockMail();
		const deps = { sessionStore: makeMockSessionStore(undefined) };
		notifyCompatFailure(client, makeEntry(), makeDecision(), "/tmp/report.json", deps);

		expect(sent[1]?.to).toBe("coordinator");
	});

	it("handles sessionStore.getByName throwing", () => {
		const { sent, client } = makeMockMail();
		const deps = {
			sessionStore: {
				getByName: (_name: string): AgentSession | null => {
					throw new Error("store error");
				},
			},
		};
		notifyCompatFailure(client, makeEntry(), makeDecision(), "/tmp/report.json", deps);

		expect(sent[1]?.to).toBe("coordinator");
	});
});
