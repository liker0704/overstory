/**
 * Tests for MissionStore (SQLite-backed mission tracking).
 *
 * Uses real bun:sqlite with temp files. No mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import type { InsertMission, Mission, MissionStore } from "../types.ts";
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
		expect(mission.phase).toBe("planning");
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
		store.updateState("mission-001", "cancelled");
		const after = store.getById("mission-001");
		// updated_at may be equal if very fast, but should be >= before
		const afterUpdatedAt = after?.updatedAt ?? "";
		const beforeUpdatedAt = before?.updatedAt ?? "";
		expect(afterUpdatedAt >= beforeUpdatedAt).toBe(true);
	});
});

// === updatePhase ===

describe("updatePhase", () => {
	test("transitions mission phase", () => {
		store.create(makeMission());
		store.updatePhase("mission-001", "scouting");
		const result = store.getById("mission-001");
		expect(result?.phase).toBe("scouting");
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

// === idempotency: create table twice ===

describe("schema idempotency", () => {
	test("creating a second store on the same db path does not throw", () => {
		const store2 = createMissionStore(dbPath);
		store2.close();
	});
});
