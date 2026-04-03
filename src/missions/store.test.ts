/**
 * Tests for MissionStore (SQLite-backed mission tracking).
 *
 * Uses real bun:sqlite with temp files. No mocks.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import type { InsertMission, MissionStore, MissionTier } from "../types.ts";
import { createMissionStore } from "./store.ts";

let tempDir: string;
let dbPath: string;
let store: MissionStore;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "overstory-missions-test-"));
	dbPath = join(tempDir, "sessions.db");
	store = createMissionStore(dbPath);
});

afterEach(async () => {
	store.close();
	await cleanupTempDir(tempDir);
});

/** Helper to create an InsertMission with optional overrides. */
function makeMission(overrides: Partial<InsertMission> = {}): InsertMission {
	return {
		id: "mission-001",
		slug: "test-mission",
		objective: "Test the mission store",
		...overrides,
	};
}

// === create ===

describe("create", () => {
	test("inserts a new mission and returns it", () => {
		const inserted = makeMission();
		const mission = store.create(inserted);

		expect(mission.id).toBe("mission-001");
		expect(mission.slug).toBe("test-mission");
		expect(mission.objective).toBe("Test the mission store");
		expect(mission.state).toBe("active");
		expect(mission.phase).toBe("understand");
		expect(mission.pendingUserInput).toBe(false);
		expect(mission.pendingInputKind).toBeNull();
		expect(mission.pendingInputThreadId).toBeNull();
		expect(mission.reopenCount).toBe(0);
		expect(mission.runId).toBeNull();
		expect(mission.artifactRoot).toBeNull();
		expect(mission.pausedWorkstreamIds).toEqual([]);
		expect(mission.firstFreezeAt).toBeNull();
		expect(mission.createdAt).toBeTruthy();
		expect(mission.updatedAt).toBeTruthy();
	});

	test("accepts optional runId and artifactRoot", () => {
		const mission = store.create(
			makeMission({ runId: "run-abc", artifactRoot: "/tmp/missions/test" }),
		);
		expect(mission.runId).toBe("run-abc");
		expect(mission.artifactRoot).toBe("/tmp/missions/test");
	});

	test("all fields roundtrip correctly (camelCase TS -> snake_case SQLite -> camelCase TS)", () => {
		const inserted = makeMission({
			id: "mission-roundtrip",
			slug: "roundtrip-slug",
			objective: "Roundtrip objective",
			runId: "run-xyz",
			artifactRoot: "/artifacts/roundtrip",
		});
		const mission = store.create(inserted);

		const fetched = store.getById("mission-roundtrip");
		expect(fetched).not.toBeNull();
		expect(fetched).toEqual(mission);
	});

	test("fails on duplicate slug", () => {
		store.create(makeMission({ slug: "same-slug", id: "mission-001" }));
		expect(() => store.create(makeMission({ slug: "same-slug", id: "mission-002" }))).toThrow();
	});
});

// === getById / getBySlug ===

describe("getById", () => {
	test("returns null for unknown id", () => {
		expect(store.getById("nonexistent")).toBeNull();
	});

	test("returns the mission after create", () => {
		store.create(makeMission());
		const result = store.getById("mission-001");
		expect(result).not.toBeNull();
		expect(result?.slug).toBe("test-mission");
	});
});

describe("getBySlug", () => {
	test("returns null for unknown slug", () => {
		expect(store.getBySlug("nonexistent-slug")).toBeNull();
	});

	test("returns the mission by slug", () => {
		store.create(makeMission());
		const result = store.getBySlug("test-mission");
		expect(result).not.toBeNull();
		expect(result?.id).toBe("mission-001");
	});
});

// === getActive ===

describe("getActive", () => {
	test("returns null when no active mission", () => {
		expect(store.getActive()).toBeNull();
	});

	test("returns active mission", () => {
		store.create(makeMission());
		const result = store.getActive();
		expect(result).not.toBeNull();
		expect(result?.id).toBe("mission-001");
	});

	test("returns frozen mission as active (pending input)", () => {
		store.create(makeMission());
		store.freeze("mission-001", "question", null);
		const result = store.getActive();
		expect(result).not.toBeNull();
		expect(result?.state).toBe("frozen");
	});

	test("returns null after mission is completed", () => {
		store.create(makeMission());
		store.updateState("mission-001", "completed");
		expect(store.getActive()).toBeNull();
	});
});

// === getActiveList ===

describe("getActiveList", () => {
	test("returns empty array when no active missions", () => {
		expect(store.getActiveList()).toEqual([]);
	});

	test("returns multiple active missions", () => {
		store.create(makeMission({ id: "mission-001", slug: "slug-one" }));
		store.create(makeMission({ id: "mission-002", slug: "slug-two" }));
		const result = store.getActiveList();
		expect(result).toHaveLength(2);
		const ids = result.map((m) => m.id);
		expect(ids).toContain("mission-001");
		expect(ids).toContain("mission-002");
	});

	test("includes both active and frozen missions", () => {
		store.create(makeMission({ id: "mission-001", slug: "slug-one" }));
		store.create(makeMission({ id: "mission-002", slug: "slug-two" }));
		store.freeze("mission-002", "question", null);
		const result = store.getActiveList();
		expect(result).toHaveLength(2);
		const states = result.map((m) => m.state);
		expect(states).toContain("active");
		expect(states).toContain("frozen");
	});

	test("excludes completed, stopped, failed, and suspended missions", () => {
		store.create(makeMission({ id: "mission-active", slug: "slug-active" }));
		store.create(makeMission({ id: "mission-completed", slug: "slug-completed" }));
		store.create(makeMission({ id: "mission-stopped", slug: "slug-stopped" }));
		store.create(makeMission({ id: "mission-failed", slug: "slug-failed" }));
		store.create(makeMission({ id: "mission-suspended", slug: "slug-suspended" }));
		store.updateState("mission-completed", "completed");
		store.updateState("mission-stopped", "stopped");
		store.updateState("mission-failed", "failed");
		store.updateState("mission-suspended", "suspended");
		const result = store.getActiveList();
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("mission-active");
	});
});

// === list ===

describe("list", () => {
	test("returns empty array when no missions", () => {
		expect(store.list()).toEqual([]);
	});

	test("returns all missions", () => {
		store.create(makeMission({ id: "mission-001", slug: "slug-one" }));
		store.create(makeMission({ id: "mission-002", slug: "slug-two" }));
		const result = store.list();
		expect(result).toHaveLength(2);
		const ids = result.map((m) => m.id);
		expect(ids).toContain("mission-001");
		expect(ids).toContain("mission-002");
	});

	test("filters by state", () => {
		store.create(makeMission({ id: "mission-001", slug: "slug-one" }));
		store.create(makeMission({ id: "mission-002", slug: "slug-two" }));
		store.updateState("mission-001", "completed");

		const active = store.list({ state: "active" });
		expect(active).toHaveLength(1);
		expect(active[0]?.id).toBe("mission-002");

		const completed = store.list({ state: "completed" });
		expect(completed).toHaveLength(1);
		expect(completed[0]?.id).toBe("mission-001");
	});

	test("limits results", () => {
		store.create(makeMission({ id: "mission-001", slug: "slug-one" }));
		store.create(makeMission({ id: "mission-002", slug: "slug-two" }));
		store.create(makeMission({ id: "mission-003", slug: "slug-three" }));

		const result = store.list({ limit: 2 });
		expect(result).toHaveLength(2);
	});
});

// === updateState ===

describe("updateState", () => {
	test("transitions mission state", () => {
		store.create(makeMission());
		store.updateState("mission-001", "completed");
		const result = store.getById("mission-001");
		expect(result?.state).toBe("completed");
	});

	test("updates updated_at on state change", () => {
		store.create(makeMission());
		const before = store.getById("mission-001");
		store.updateState("mission-001", "stopped");
		const after = store.getById("mission-001");
		// updated_at may be equal if very fast, but should be >= before
		const afterUpdatedAt = after?.updatedAt ?? "";
		const beforeUpdatedAt = before?.updatedAt ?? "";
		expect(afterUpdatedAt >= beforeUpdatedAt).toBe(true);
	});
});

// === delete ===

describe("delete", () => {
	test("removes the mission record", () => {
		store.create(makeMission());
		store.delete("mission-001");
		expect(store.getById("mission-001")).toBeNull();
	});
});

// === updatePhase ===

describe("updatePhase", () => {
	test("transitions mission phase", () => {
		store.create(makeMission());
		store.updatePhase("mission-001", "align");
		const result = store.getById("mission-001");
		expect(result?.phase).toBe("align");
	});
});

// === freeze / unfreeze ===

describe("freeze", () => {
	test("sets state=frozen, pendingUserInput=true, records kind and threadId", () => {
		store.create(makeMission());
		store.freeze("mission-001", "question", "thread-abc");
		const result = store.getById("mission-001");
		expect(result?.state).toBe("frozen");
		expect(result?.pendingUserInput).toBe(true);
		expect(result?.pendingInputKind).toBe("question");
		expect(result?.pendingInputThreadId).toBe("thread-abc");
	});

	test("sets firstFreezeAt on first freeze", () => {
		store.create(makeMission());
		store.freeze("mission-001", "approval", null);
		const result = store.getById("mission-001");
		expect(result?.firstFreezeAt).not.toBeNull();
	});

	test("preserves firstFreezeAt on subsequent freezes", () => {
		store.create(makeMission());
		store.freeze("mission-001", "question", null);
		const firstFreeze = store.getById("mission-001")?.firstFreezeAt;

		store.unfreeze("mission-001");
		store.freeze("mission-001", "decision", null);
		const secondFreeze = store.getById("mission-001")?.firstFreezeAt;

		expect(firstFreeze).toBe(secondFreeze);
	});

	test("accepts null threadId", () => {
		store.create(makeMission());
		store.freeze("mission-001", "clarification", null);
		const result = store.getById("mission-001");
		expect(result?.pendingInputThreadId).toBeNull();
	});

	test("does NOT clobber currentNode on freeze", () => {
		store.create(makeMission());
		store.updateCurrentNode("mission-001", "understand-phase:evaluate");
		store.freeze("mission-001", "question", null);
		const result = store.getById("mission-001");
		// currentNode should be preserved — engine manages subgraph position
		expect(result?.currentNode).toBe("understand-phase:evaluate");
	});
});

describe("unfreeze", () => {
	test("sets state=active, clears pending fields, increments reopenCount", () => {
		store.create(makeMission());
		store.freeze("mission-001", "question", "thread-abc");
		store.unfreeze("mission-001");

		const result = store.getById("mission-001");
		expect(result?.state).toBe("active");
		expect(result?.pendingUserInput).toBe(false);
		expect(result?.pendingInputKind).toBeNull();
		expect(result?.pendingInputThreadId).toBeNull();
		expect(result?.reopenCount).toBe(1);
	});

	test("increments reopenCount on each unfreeze", () => {
		store.create(makeMission());

		store.freeze("mission-001", "question", null);
		store.unfreeze("mission-001");
		store.freeze("mission-001", "decision", null);
		store.unfreeze("mission-001");

		const result = store.getById("mission-001");
		expect(result?.reopenCount).toBe(2);
	});

	test("does NOT clobber currentNode on unfreeze", () => {
		store.create(makeMission());
		store.updateCurrentNode("mission-001", "understand-phase:evaluate");
		store.freeze("mission-001", "question", null);
		// currentNode preserved through freeze
		expect(store.getById("mission-001")?.currentNode).toBe("understand-phase:evaluate");

		store.unfreeze("mission-001");
		// currentNode preserved through unfreeze too
		expect(store.getById("mission-001")?.currentNode).toBe("understand-phase:evaluate");
	});
});

// === updatePausedWorkstreams ===

describe("updatePausedWorkstreams", () => {
	test("sets paused workstream ids as JSON array", () => {
		store.create(makeMission());
		store.updatePausedWorkstreams("mission-001", ["ws-a", "ws-b"]);
		const result = store.getById("mission-001");
		expect(result?.pausedWorkstreamIds).toEqual(["ws-a", "ws-b"]);
	});

	test("clears workstreams when passed empty array", () => {
		store.create(makeMission());
		store.updatePausedWorkstreams("mission-001", ["ws-a"]);
		store.updatePausedWorkstreams("mission-001", []);
		const result = store.getById("mission-001");
		expect(result?.pausedWorkstreamIds).toEqual([]);
	});
});

// === updateArtifactRoot ===

describe("updateArtifactRoot", () => {
	test("sets artifact root path", () => {
		store.create(makeMission());
		store.updateArtifactRoot("mission-001", "/missions/mission-001/artifacts");
		const result = store.getById("mission-001");
		expect(result?.artifactRoot).toBe("/missions/mission-001/artifacts");
	});
});

// === bindSessions ===

describe("updateCurrentNode phase sync", () => {
	test("auto-syncs phase when nodeId is a lifecycle node", () => {
		store.create(makeMission());
		expect(store.getById("mission-001")?.phase).toBe("understand");

		store.updateCurrentNode("mission-001", "plan:active");
		expect(store.getById("mission-001")?.phase).toBe("plan");
		expect(store.getById("mission-001")?.currentNode).toBe("plan:active");
	});

	test("syncs phase for execute:active", () => {
		store.create(makeMission());
		store.updateCurrentNode("mission-001", "execute:active");
		expect(store.getById("mission-001")?.phase).toBe("execute");
	});

	test("syncs phase for done:completed", () => {
		store.create(makeMission());
		store.updateCurrentNode("mission-001", "done:completed");
		expect(store.getById("mission-001")?.phase).toBe("done");
	});

	test("does NOT sync phase for subgraph nodes", () => {
		store.create(makeMission());
		store.updateCurrentNode("mission-001", "understand-phase:evaluate");
		// Subgraph node — phase should stay at original "understand"
		expect(store.getById("mission-001")?.phase).toBe("understand");
		expect(store.getById("mission-001")?.currentNode).toBe("understand-phase:evaluate");
	});

	test("does NOT sync phase for non-phase prefixes", () => {
		store.create(makeMission());
		store.updateCurrentNode("mission-001", "custom:node");
		// "custom" is not a valid MissionPhase
		expect(store.getById("mission-001")?.phase).toBe("understand");
	});
});

describe("bindSessions", () => {
	test("new missions have null session IDs by default", () => {
		store.create(makeMission());
		const mission = store.getById("mission-001");
		expect(mission?.analystSessionId).toBeNull();
		expect(mission?.executionDirectorSessionId).toBeNull();
	});

	test("binds analystSessionId", () => {
		store.create(makeMission());
		store.bindSessions("mission-001", { analystSessionId: "session-analyst-abc" });
		const mission = store.getById("mission-001");
		expect(mission?.analystSessionId).toBe("session-analyst-abc");
		expect(mission?.executionDirectorSessionId).toBeNull();
	});

	test("binds executionDirectorSessionId", () => {
		store.create(makeMission());
		store.bindSessions("mission-001", { executionDirectorSessionId: "session-director-xyz" });
		const mission = store.getById("mission-001");
		expect(mission?.analystSessionId).toBeNull();
		expect(mission?.executionDirectorSessionId).toBe("session-director-xyz");
	});

	test("binds both session IDs independently", () => {
		store.create(makeMission());
		store.bindSessions("mission-001", { analystSessionId: "session-analyst-1" });
		store.bindSessions("mission-001", { executionDirectorSessionId: "session-director-1" });
		const mission = store.getById("mission-001");
		expect(mission?.analystSessionId).toBe("session-analyst-1");
		expect(mission?.executionDirectorSessionId).toBe("session-director-1");
	});

	test("session IDs round-trip through create and read", () => {
		store.create(makeMission());
		store.bindSessions("mission-001", {
			analystSessionId: "session-a",
			executionDirectorSessionId: "session-b",
		});
		const mission = store.getById("mission-001");
		expect(mission?.analystSessionId).toBe("session-a");
		expect(mission?.executionDirectorSessionId).toBe("session-b");
	});
});

// === bindCoordinatorSession ===

describe("bindCoordinatorSession", () => {
	test("new missions have null coordinatorSessionId by default", () => {
		store.create(makeMission());
		const mission = store.getById("mission-001");
		expect(mission?.coordinatorSessionId).toBeNull();
	});

	test("binds coordinatorSessionId directly", () => {
		store.create(makeMission());
		store.bindCoordinatorSession("mission-001", "session-coord-abc");
		const mission = store.getById("mission-001");
		expect(mission?.coordinatorSessionId).toBe("session-coord-abc");
	});
});

// === updatePausedLeads ===

describe("updatePausedLeads", () => {
	test("new missions have empty pausedLeadNames by default", () => {
		store.create(makeMission());
		const mission = store.getById("mission-001");
		expect(mission?.pausedLeadNames).toEqual([]);
	});

	test("sets paused lead names as JSON array", () => {
		store.create(makeMission());
		store.updatePausedLeads("mission-001", ["lead-a", "lead-b"]);
		const result = store.getById("mission-001");
		expect(result?.pausedLeadNames).toEqual(["lead-a", "lead-b"]);
	});

	test("clears leads when passed empty array", () => {
		store.create(makeMission());
		store.updatePausedLeads("mission-001", ["lead-a"]);
		store.updatePausedLeads("mission-001", []);
		const result = store.getById("mission-001");
		expect(result?.pausedLeadNames).toEqual([]);
	});
});

// === updatePauseReason ===

describe("updatePauseReason", () => {
	test("new missions have null pauseReason by default", () => {
		store.create(makeMission());
		const mission = store.getById("mission-001");
		expect(mission?.pauseReason).toBeNull();
	});

	test("sets pause reason", () => {
		store.create(makeMission());
		store.updatePauseReason("mission-001", "waiting for user input");
		const result = store.getById("mission-001");
		expect(result?.pauseReason).toBe("waiting for user input");
	});

	test("clears pause reason when null passed", () => {
		store.create(makeMission());
		store.updatePauseReason("mission-001", "some reason");
		store.updatePauseReason("mission-001", null);
		const result = store.getById("mission-001");
		expect(result?.pauseReason).toBeNull();
	});
});

// === start / complete ===

describe("start", () => {
	test("new missions have null startedAt by default", () => {
		store.create(makeMission());
		const mission = store.getById("mission-001");
		expect(mission?.startedAt).toBeNull();
	});

	test("sets startedAt", () => {
		store.create(makeMission());
		store.start("mission-001");
		const result = store.getById("mission-001");
		expect(result?.startedAt).not.toBeNull();
	});

	test("start is idempotent (does not overwrite existing startedAt)", () => {
		store.create(makeMission());
		store.start("mission-001");
		const first = store.getById("mission-001")?.startedAt;
		store.start("mission-001");
		const second = store.getById("mission-001")?.startedAt;
		expect(first).toBe(second);
	});
});

describe("completeMission", () => {
	test("new missions have null completedAt by default", () => {
		store.create(makeMission());
		const mission = store.getById("mission-001");
		expect(mission?.completedAt).toBeNull();
	});

	test("sets completedAt and state=completed atomically", () => {
		store.create(makeMission());
		store.completeMission("mission-001");
		const result = store.getById("mission-001");
		expect(result?.completedAt).not.toBeNull();
		expect(result?.state).toBe("completed");
	});

	test("clears pending input fields", () => {
		store.create(makeMission());
		store.freeze("mission-001", "question", "msg-123");
		store.completeMission("mission-001");
		const result = store.getById("mission-001");
		expect(result?.pendingUserInput).toBe(false);
		expect(result?.pendingInputKind).toBeNull();
		expect(result?.pendingInputThreadId).toBeNull();
	});
});

// === checkpoints accessor ===

describe("checkpoints", () => {
	test("store exposes checkpoints accessor", () => {
		expect(store.checkpoints).toBeDefined();
	});

	test("checkpoints save and retrieve via store.checkpoints", () => {
		store.create(makeMission());
		store.checkpoints.saveCheckpoint("mission-001", "node-a", { data: "test" });
		const result = store.checkpoints.getCheckpoint("mission-001", "node-a");
		expect(result).not.toBeNull();
		expect(result?.data).toEqual({ data: "test" });
	});

	test("checkpoints accessor backed by same db (transitions visible)", () => {
		store.checkpoints.recordTransition("mission-001", "node-a", "node-b", "done");
		const history = store.checkpoints.getTransitionHistory("mission-001");
		expect(history).toHaveLength(1);
	});
});

// === idempotency: create table twice ===

describe("schema idempotency", () => {
	test("creating a second store on the same db path does not throw", () => {
		const store2 = createMissionStore(dbPath);
		store2.close();
	});

	test("legacy missions table with cancelled state is migrated to stopped", () => {
		store.close();

		const legacyDb = new Database(dbPath);
		legacyDb.exec("DROP TABLE IF EXISTS missions");
		legacyDb.exec(`
			CREATE TABLE missions (
				id TEXT PRIMARY KEY,
				slug TEXT NOT NULL UNIQUE,
				objective TEXT NOT NULL,
				run_id TEXT,
				state TEXT NOT NULL DEFAULT 'active'
					CHECK(state IN ('active','frozen','completed','failed','cancelled')),
				phase TEXT NOT NULL DEFAULT 'understand'
					CHECK(phase IN ('understand','align','decide','plan','execute','done')),
				first_freeze_at TEXT,
				pending_user_input INTEGER NOT NULL DEFAULT 0,
				pending_input_kind TEXT,
				pending_input_thread_id TEXT,
				reopen_count INTEGER NOT NULL DEFAULT 0,
				artifact_root TEXT,
				paused_workstream_ids TEXT NOT NULL DEFAULT '[]',
				analyst_session_id TEXT,
				execution_director_session_id TEXT,
				coordinator_session_id TEXT,
				paused_lead_names TEXT NOT NULL DEFAULT '[]',
				pause_reason TEXT,
				started_at TEXT,
				completed_at TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`);
		legacyDb.exec(`
			INSERT INTO missions (
				id, slug, objective, state, phase, paused_workstream_ids, paused_lead_names, created_at, updated_at
			) VALUES (
				'legacy-mission',
				'legacy-mission',
				'Legacy mission objective',
				'cancelled',
				'execute',
				'[]',
				'[]',
				'2026-01-01T00:00:00.000Z',
				'2026-01-01T00:00:00.000Z'
			)
		`);
		legacyDb.close();

		const migratedStore = createMissionStore(dbPath);
		try {
			const mission = migratedStore.getById("legacy-mission");
			expect(mission?.state).toBe("stopped");
			migratedStore.updateState("legacy-mission", "stopped");
			expect(migratedStore.getById("legacy-mission")?.state).toBe("stopped");
		} finally {
			migratedStore.close();
		}

		store = createMissionStore(dbPath);
	});

	test("legacy missions table missing newer runtime columns is rebuilt in place", () => {
		store.close();

		const legacyDb = new Database(dbPath);
		legacyDb.exec("DROP TABLE IF EXISTS missions");
		legacyDb.exec(`
			CREATE TABLE missions (
				id TEXT PRIMARY KEY,
				slug TEXT NOT NULL UNIQUE,
				objective TEXT NOT NULL,
				run_id TEXT,
				state TEXT NOT NULL DEFAULT 'active'
					CHECK(state IN ('active','frozen','completed','failed','cancelled')),
				phase TEXT NOT NULL DEFAULT 'planning'
					CHECK(phase IN ('planning','scouting','building','reviewing','merging','done')),
				first_freeze_at TEXT,
				pending_user_input INTEGER NOT NULL DEFAULT 0,
				pending_input_kind TEXT CHECK(pending_input_kind IS NULL OR pending_input_kind IN ('question','approval','decision','clarification')),
				pending_input_thread_id TEXT,
				reopen_count INTEGER NOT NULL DEFAULT 0,
				artifact_root TEXT,
				paused_workstream_ids TEXT NOT NULL DEFAULT '[]',
				analyst_session_id TEXT,
				execution_director_session_id TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`);
		legacyDb.exec(`
			INSERT INTO missions (
				id, slug, objective, run_id, state, phase, first_freeze_at,
				pending_user_input, pending_input_kind, pending_input_thread_id,
				reopen_count, artifact_root, paused_workstream_ids, analyst_session_id,
				execution_director_session_id, created_at, updated_at
			) VALUES (
				'legacy-runtime-mission',
				'legacy-runtime-mission',
				'Legacy runtime mission',
				'run-legacy',
				'cancelled',
				'planning',
				'2026-01-01T00:00:00.000Z',
				1,
				'clarification',
				'thread-legacy',
				2,
				'/tmp/legacy-artifacts',
				'["ws-auth"]',
				'sess-analyst',
				'sess-director',
				'2026-01-01T00:00:00.000Z',
				'2026-01-02T00:00:00.000Z'
			)
		`);
		legacyDb.close();

		const migratedStore = createMissionStore(dbPath);
		try {
			const mission = migratedStore.getById("legacy-runtime-mission");
			expect(mission).not.toBeNull();
			expect(mission?.state).toBe("stopped");
			expect(mission?.phase).toBe("plan");
			expect(mission?.coordinatorSessionId).toBeNull();
			expect(mission?.pausedLeadNames).toEqual([]);
			expect(mission?.pauseReason).toBeNull();
			expect(mission?.startedAt).toBe("2026-01-01T00:00:00.000Z");
			expect(mission?.completedAt).toBeNull();

			migratedStore.bindCoordinatorSession("legacy-runtime-mission", "sess-coordinator");
			migratedStore.updatePausedLeads("legacy-runtime-mission", ["lead-auth"]);
			migratedStore.updatePauseReason("legacy-runtime-mission", "Waiting on regenerated spec");
			migratedStore.start("legacy-runtime-mission");

			const updated = migratedStore.getById("legacy-runtime-mission");
			expect(updated?.coordinatorSessionId).toBe("sess-coordinator");
			expect(updated?.pausedLeadNames).toEqual(["lead-auth"]);
			expect(updated?.pauseReason).toBe("Waiting on regenerated spec");
			expect(updated?.startedAt).toBe("2026-01-01T00:00:00.000Z");
		} finally {
			migratedStore.close();
		}

		store = createMissionStore(dbPath);
	});
});

// === tier operations ===

describe("tier operations", () => {
	test("updateTier stores and retrieves correctly", () => {
		store.create(makeMission());
		store.updateTier("mission-001", "direct");
		const result = store.getById("mission-001");
		expect(result?.tier).toBe("direct");
	});

	test("updateTier upgrades from direct to planned", () => {
		store.create(makeMission());
		store.updateTier("mission-001", "direct");
		store.updateTier("mission-001", "planned");
		const result = store.getById("mission-001");
		expect(result?.tier).toBe("planned");
	});

	test("updateTier rejects downgrades (planned to direct throws)", () => {
		store.create(makeMission());
		store.updateTier("mission-001", "planned");
		expect(() => store.updateTier("mission-001", "direct")).toThrow(
			"Cannot downgrade mission tier from planned to direct",
		);
	});

	test("updateTier rejects same-tier update (full to full throws)", () => {
		store.create(makeMission());
		store.updateTier("mission-001", "full");
		expect(() => store.updateTier("mission-001", "full")).toThrow(
			"Cannot downgrade mission tier from full to full",
		);
	});

	test("updateTier records transition in mission_tier_transitions", () => {
		store.create(makeMission());
		store.updateTier("mission-001", "direct", "auto-detect");

		const db = new Database(dbPath, { readonly: true });
		const rows = db
			.prepare(
				"SELECT mission_id, from_tier, to_tier, triggered_by FROM mission_tier_transitions WHERE mission_id = ?",
			)
			.all("mission-001") as Array<{
			mission_id: string;
			from_tier: string | null;
			to_tier: string;
			triggered_by: string | null;
		}>;
		db.close();

		expect(rows).toHaveLength(1);
		const row = rows[0]!;
		expect(row.mission_id).toBe("mission-001");
		expect(row.from_tier).toBeNull();
		expect(row.to_tier).toBe("direct");
		expect(row.triggered_by).toBe("auto-detect");
	});

	test("updateTier records multiple transitions on upgrade path", () => {
		store.create(makeMission());
		store.updateTier("mission-001", "direct", "init");
		store.updateTier("mission-001", "planned", "escalation");
		store.updateTier("mission-001", "full", "user-request");

		const db = new Database(dbPath, { readonly: true });
		const rows = db
			.prepare(
				"SELECT from_tier, to_tier, triggered_by FROM mission_tier_transitions WHERE mission_id = ? ORDER BY id",
			)
			.all("mission-001") as Array<{
			from_tier: string | null;
			to_tier: string;
			triggered_by: string | null;
		}>;
		db.close();

		expect(rows).toHaveLength(3);
		expect(rows[0]!.from_tier).toBeNull();
		expect(rows[0]!.to_tier).toBe("direct");
		expect(rows[1]!.from_tier).toBe("direct");
		expect(rows[1]!.to_tier).toBe("planned");
		expect(rows[2]!.from_tier).toBe("planned");
		expect(rows[2]!.to_tier).toBe("full");
	});

	test("clearGateStates clears gate state rows", () => {
		store.create(makeMission());
		// Insert a gate state via the store API
		store.ensureGateState("mission-001", "execute:active", 120_000, 3_600_000);

		// Verify gate state exists
		const db = new Database(dbPath, { readonly: true });
		const before = db
			.prepare("SELECT COUNT(*) as cnt FROM mission_gate_state WHERE mission_id = ?")
			.get("mission-001") as { cnt: number };
		expect(before.cnt).toBeGreaterThan(0);
		db.close();

		// Clear and verify
		store.clearGateStates("mission-001");

		const db2 = new Database(dbPath, { readonly: true });
		const after = db2
			.prepare("SELECT COUNT(*) as cnt FROM mission_gate_state WHERE mission_id = ?")
			.get("mission-001") as { cnt: number };
		db2.close();

		expect(after.cnt).toBe(0);
	});

	test("clearCheckpoints clears checkpoint rows", () => {
		store.create(makeMission());
		// Insert a checkpoint via the checkpoints accessor
		store.checkpoints.saveCheckpoint("mission-001", "understand:active", { step: 1 });

		// Verify checkpoint exists
		const cp = store.checkpoints.getCheckpoint("mission-001", "understand:active");
		expect(cp).not.toBeNull();

		// Clear and verify
		store.clearCheckpoints("mission-001");

		const after = store.checkpoints.getCheckpoint("mission-001", "understand:active");
		expect(after).toBeNull();
	});

	test("legacy missions created without tier have tier: null", () => {
		const mission = store.create(makeMission());
		expect(mission.tier).toBeNull();

		const fetched = store.getById("mission-001");
		expect(fetched?.tier).toBeNull();
	});
});
