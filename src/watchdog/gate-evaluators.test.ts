import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MailStore } from "../mail/store.ts";
import type { MailMessage } from "../mail/types.ts";
import { makeMission } from "../missions/test-mocks.ts";
import type { SessionStore } from "../sessions/store.ts";
import {
	evaluateArchitectDesign,
	evaluateAwaitPlan,
	evaluateAwaitResearch,
	evaluateGate,
	evaluateUnderstandReady,
	evaluateWsCompletion,
} from "./gate-evaluators.ts";

type TestMessage = {
	from: string;
	to: string;
	type: MailMessage["type"];
	subject: string;
	body?: string;
	createdAt?: string;
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
		createdAt: m.createdAt ?? new Date().toISOString(),
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
		getById: () => null,
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
	it("no analyst session → met:false without nudge (spawn in progress)", () => {
		const mission = makeMission({ analystSessionId: null });
		const mailStore = createTestMailStore([]);
		const result = evaluateAwaitResearch(mission, mailStore);
		expect(result.met).toBe(false);
		expect(result.nudgeTarget).toBeUndefined();
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

	it("all dispatched scouts returned but analyst hasn't aggregated → specific nudge to analyst", () => {
		const mission = makeMission({ analystSessionId: "sess-1", slug: "test" });
		const mailStore = createTestMailStore([
			{
				from: "mission-analyst-test",
				to: "scout-a",
				type: "dispatch",
				subject: "Dispatch: task-a",
				createdAt: "2026-04-14T20:00:00.000Z",
			},
			{
				from: "mission-analyst-test",
				to: "scout-b",
				type: "dispatch",
				subject: "Dispatch: task-b",
				createdAt: "2026-04-14T20:00:05.000Z",
			},
			{
				from: "scout-a",
				to: "mission-analyst-test",
				type: "result",
				subject: "Done a",
				createdAt: "2026-04-14T20:05:00.000Z",
			},
			{
				from: "scout-b",
				to: "mission-analyst-test",
				type: "result",
				subject: "Done b",
				createdAt: "2026-04-14T20:06:00.000Z",
			},
		]);
		const result = evaluateAwaitResearch(mission, mailStore, "2026-04-14T19:59:00.000Z");
		expect(result.met).toBe(false);
		expect(result.nudgeTarget).toBe("mission-analyst-test");
		expect(result.nudgeMessage).toContain("2 dispatched scouts");
		expect(result.nudgeMessage).toContain("coordinator-test");
	});

	it("partial scout completion → met:false, nudge analyst", () => {
		const mission = makeMission({ analystSessionId: "sess-1", slug: "test" });
		const mailStore = createTestMailStore([
			{
				from: "mission-analyst-test",
				to: "scout-a",
				type: "dispatch",
				subject: "Dispatch: task-a",
				createdAt: "2026-04-14T20:00:00.000Z",
			},
			{
				from: "mission-analyst-test",
				to: "scout-b",
				type: "dispatch",
				subject: "Dispatch: task-b",
				createdAt: "2026-04-14T20:00:05.000Z",
			},
			{
				from: "scout-a",
				to: "mission-analyst-test",
				type: "result",
				subject: "Done a",
				createdAt: "2026-04-14T20:05:00.000Z",
			},
		]);
		const result = evaluateAwaitResearch(mission, mailStore, "2026-04-14T19:59:00.000Z");
		expect(result.met).toBe(false);
		expect(result.nudgeTarget).toBe("mission-analyst-test");
	});

	it("stale dispatches before gateEnteredAt are ignored", () => {
		const mission = makeMission({ analystSessionId: "sess-1", slug: "test" });
		const mailStore = createTestMailStore([
			{
				from: "mission-analyst-test",
				to: "scout-a",
				type: "dispatch",
				subject: "Dispatch: old",
				createdAt: "2026-01-01T00:00:00.000Z",
			},
			{
				from: "scout-a",
				to: "mission-analyst-test",
				type: "result",
				subject: "Done old",
				createdAt: "2026-01-01T00:05:00.000Z",
			},
		]);
		const result = evaluateAwaitResearch(mission, mailStore, "2026-04-14T00:00:00.000Z");
		expect(result.met).toBe(false);
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

	it("ignores stale Plan complete mail before gateEnteredAt", () => {
		const mission = makeMission({ state: "active", phase: "understand", slug: "test" });
		const mailStore = createTestMailStore([
			{
				from: "mission-analyst-test",
				to: "coordinator-test",
				type: "result",
				subject: "Plan complete",
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		]);
		const result = evaluateUnderstandReady(mission, mailStore, "2026-04-01T00:00:00.000Z");
		expect(result.met).toBe(false);
	});

	it("accepts fresh Plan complete mail after gateEnteredAt", () => {
		const mission = makeMission({ state: "active", phase: "understand", slug: "test" });
		const mailStore = createTestMailStore([
			{
				from: "mission-analyst-test",
				to: "coordinator-test",
				type: "result",
				subject: "Plan complete",
				createdAt: "2026-04-02T00:00:00.000Z",
			},
		]);
		const result = evaluateUnderstandReady(mission, mailStore, "2026-04-01T00:00:00.000Z");
		expect(result.met).toBe(true);
	});

	it("planning dispatch resolves gate (coordinator evaluated research)", () => {
		const mission = makeMission({ state: "active", phase: "understand", slug: "test" });
		const mailStore = createTestMailStore([
			{
				from: "coordinator-test",
				to: "mission-analyst-test",
				type: "dispatch",
				subject: "Planning phase: create workstream plan",
				createdAt: "2026-04-02T00:00:00.000Z",
			},
		]);
		const result = evaluateUnderstandReady(mission, mailStore, "2026-04-01T00:00:00.000Z");
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("ready");
	});

	it("ignores stale planning dispatch before gateEnteredAt", () => {
		const mission = makeMission({ state: "active", phase: "understand", slug: "test" });
		const mailStore = createTestMailStore([
			{
				from: "coordinator-test",
				to: "mission-analyst-test",
				type: "dispatch",
				subject: "Planning phase: create workstream plan",
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		]);
		const result = evaluateUnderstandReady(mission, mailStore, "2026-04-01T00:00:00.000Z");
		expect(result.met).toBe(false);
	});
});

describe("evaluateArchitectDesign", () => {
	it("no architect session → met:false without nudge", async () => {
		const mission = makeMission({ architectSessionId: null, slug: "test" });
		const mailStore = createTestMailStore([]);
		const result = await evaluateArchitectDesign(mission, "/tmp/nonexistent", mailStore);
		expect(result.met).toBe(false);
		expect(result.nudgeTarget).toBeUndefined();
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

describe("evaluateWsCompletion", () => {
	// Legacy path is triggered via OVERSTORY_LEGACY_WS_COMPLETION=true (opt-out flag).
	// The default (SSOT-based) path requires artifactRoot + missionStore + workstreams.json.

	it("legacy: ignores merged mail before gateEnteredAt", async () => {
		process.env.OVERSTORY_LEGACY_WS_COMPLETION = "true";
		try {
			const mission = makeMission({ slug: "test" });
			const mailStore = createTestMailStore([
				{
					from: "merger-test",
					to: "execution-director-test",
					type: "merged",
					subject: "Merged ws-1",
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			]);
			const result = await evaluateWsCompletion(
				mission,
				mailStore,
				"/tmp/nope",
				null,
				"2026-04-01T00:00:00.000Z",
			);
			expect(result.met).toBe(false);
		} finally {
			process.env.OVERSTORY_LEGACY_WS_COMPLETION = undefined;
		}
	});

	it("legacy: accepts merged mail after gateEnteredAt", async () => {
		process.env.OVERSTORY_LEGACY_WS_COMPLETION = "true";
		try {
			const mission = makeMission({ slug: "test" });
			const mailStore = createTestMailStore([
				{
					from: "merger-test",
					to: "execution-director-test",
					type: "merged",
					subject: "Merged ws-1",
					body: "ws-1 merged",
					createdAt: "2026-04-02T00:00:00.000Z",
				},
			]);
			const result = await evaluateWsCompletion(
				mission,
				mailStore,
				"/tmp/nope",
				null,
				"2026-04-01T00:00:00.000Z",
			);
			expect(result.met).toBe(true);
		} finally {
			process.env.OVERSTORY_LEGACY_WS_COMPLETION = undefined;
		}
	});

	it("SSOT: pre-handoff (no workstreams.json) → not met", async () => {
		const mission = makeMission({ slug: "test" });
		const mailStore = createTestMailStore([]);
		const result = await evaluateWsCompletion(mission, mailStore, "/tmp/nope-missing", null);
		expect(result.met).toBe(false);
	});

	it("SSOT sticky fallback: no producer write yet + merged mail → advance with warning", async () => {
		// hasEmittedWsProducerWrite=false (default on makeMission) triggers fallback
		const mission = makeMission({ slug: "test", hasEmittedWsProducerWrite: false });
		// workstreams.json write + existing merged mail
		const tempDir = await mkdtemp(join(tmpdir(), "ws-completion-sticky-"));
		try {
			await mkdir(join(tempDir, "plan"), { recursive: true });
			await writeFile(
				join(tempDir, "plan", "workstreams.json"),
				JSON.stringify({ workstreams: [{ id: "ws-1" }] }),
			);
			const mailStore = createTestMailStore([
				{
					from: "coord-test",
					to: "execution-director-test",
					type: "merged",
					subject: "Merged ws-1",
					body: "ok",
					createdAt: "2026-04-10T00:00:00.000Z",
				},
			]);
			// missionStore returns false for areAllWorkstreamsDone (no status table entries).
			const missionStore = {
				areAllWorkstreamsDone: () => false,
			} as unknown as import("../missions/types.ts").MissionStore;
			const result = await evaluateWsCompletion(
				mission,
				mailStore,
				tempDir,
				missionStore,
				"2026-04-01T00:00:00.000Z",
			);
			expect(result.met).toBe(true);
			expect(result.nudgeMessage?.startsWith("[ws_status_not_populated]")).toBe(true);
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
		// analystSessionId is null → no nudge (spawn in progress)
		expect(result.met).toBe(false);
		expect(result.nudgeTarget).toBeUndefined();
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
