import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MailStore } from "../mail/store.ts";
import type { MailMessage } from "../mail/types.ts";
import { makeMission } from "../missions/test-mocks.ts";
import type { SessionStore } from "../sessions/store.ts";
import {
	evaluateAwaitPlan,
	evaluateAwaitResearch,
	evaluateGate,
	evaluateUnderstandReady,
} from "./gate-evaluators.ts";

type TestMessage = {
	from: string;
	to: string;
	type: MailMessage["type"];
	subject: string;
	body?: string;
};

function toMailMessage(m: TestMessage, i: number): MailMessage {
	return {
		id: `msg-${i}`,
		from: m.from,
		to: m.to,
		subject: m.subject,
		body: m.body ?? "",
		type: m.type,
		priority: "normal",
		threadId: null,
		payload: null,
		read: false,
		createdAt: new Date().toISOString(),
		state: "acked",
		claimedAt: null,
		attempt: 0,
		nextRetryAt: null,
		failReason: null,
		missionId: null,
	};
}

function createTestMailStore(messages: TestMessage[]): MailStore {
	const store = {
		getAll(filters?: { to?: string }): MailMessage[] {
			const to = filters?.to;
			return messages.filter((m) => !to || m.to === to).map((m, i) => toMailMessage(m, i));
		},
	};
	return store as unknown as MailStore;
}

function createTestSessionStore(): SessionStore {
	return {
		getByName: () => null,
		getActive: () => [],
		getAll: () => [],
		count: () => 0,
		getByRun: () => [],
		upsert: () => {},
		updateState: () => {},
		updateLastActivity: () => {},
		updateEscalation: () => {},
		updateTranscriptPath: () => {},
		updateRuntimeSessionId: () => {},
		updateRateLimitedSince: () => {},
		updateRateLimitResumesAt: () => {},
		updateOriginalRuntime: () => {},
		updateStatusLine: () => {},
		getResumable: () => [],
		remove: () => {},
		purge: () => 0,
		close: () => {},
	} as unknown as SessionStore;
}

describe("evaluateAwaitResearch", () => {
	it("no analyst session → met:false with coordinator nudge", () => {
		const mission = makeMission({ analystSessionId: null });
		const mailStore = createTestMailStore([]);
		const result = evaluateAwaitResearch(mission, mailStore);
		expect(result.met).toBe(false);
		expect(result.nudgeTarget).toInclude("coordinator");
	});

	it("result mail present from analyst → met:true with research_complete trigger", () => {
		const mission = makeMission({ analystSessionId: "sess-1", slug: "test" });
		const mailStore = createTestMailStore([
			{
				from: "mission-analyst-test",
				to: "coordinator-test",
				type: "result",
				subject: "Research done",
			},
		]);
		const result = evaluateAwaitResearch(mission, mailStore);
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("research_complete");
	});
});

describe("evaluateUnderstandReady", () => {
	it("mission frozen → met:true", () => {
		const mission = makeMission({ state: "frozen" });
		const result = evaluateUnderstandReady(mission);
		expect(result.met).toBe(true);
	});

	it("phase unchanged and not frozen → met:false", () => {
		const mission = makeMission({ state: "active", phase: "understand" });
		const result = evaluateUnderstandReady(mission);
		expect(result.met).toBe(false);
	});
});

describe("evaluateAwaitPlan", () => {
	it("valid workstreams.json → met:true", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "gate-eval-test-"));
		try {
			await mkdir(join(tempDir, "plan"), { recursive: true });
			await writeFile(
				join(tempDir, "plan", "workstreams.json"),
				JSON.stringify({ workstreams: [{ id: "ws-1" }] }),
			);
			const mission = makeMission({});
			const result = await evaluateAwaitPlan(mission, tempDir);
			expect(result.met).toBe(true);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("evaluateGate", () => {
	it("dispatches to evaluateAwaitResearch for understand-phase:await-research", async () => {
		const mission = makeMission({ analystSessionId: null });
		const stores = {
			mailStore: createTestMailStore([]),
			sessionStore: createTestSessionStore(),
		};
		const result = await evaluateGate("understand-phase:await-research", mission, stores, "/tmp");
		// analystSessionId is null → coordinator nudge
		expect(result.met).toBe(false);
		expect(result.nudgeTarget).toInclude("coordinator");
	});

	it("unknown node → met:false with unknown:true", async () => {
		const mission = makeMission({});
		const stores = {
			mailStore: null,
			sessionStore: createTestSessionStore(),
		};
		const result = await evaluateGate("nonexistent:bogus-node", mission, stores, "/tmp");
		expect(result.met).toBe(false);
		expect(result.unknown).toBe(true);
	});
});
