/**
 * Tests for checkpoint and transition store (mission graph execution persistence).
 *
 * Uses real bun:sqlite with temp files. No mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import type { CheckpointStore } from "../types.ts";
import { createMissionStore } from "./store.ts";

let tempDir: string;
let dbPath: string;
let checkpoints: CheckpointStore;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "overstory-checkpoints-test-"));
	dbPath = join(tempDir, "sessions.db");
	const store = createMissionStore(dbPath);
	checkpoints = store.checkpoints;
	// Keep store open via checkpoints (shared db connection)
});

afterEach(async () => {
	await cleanupTempDir(tempDir);
});

// === saveCheckpoint / getCheckpoint ===

describe("saveCheckpoint / getCheckpoint", () => {
	test("returns null for unknown mission/node", () => {
		expect(checkpoints.getCheckpoint("mission-x", "node-a")).toBeNull();
	});

	test("round-trips primitive data", () => {
		checkpoints.saveCheckpoint("mission-1", "node-a", { count: 42 });
		const result = checkpoints.getCheckpoint("mission-1", "node-a");
		expect(result).not.toBeNull();
		expect(result?.data).toEqual({ count: 42 });
	});

	test("stores schemaVersion in snapshot_data envelope", () => {
		checkpoints.saveCheckpoint("mission-1", "node-a", { x: 1 });
		const result = checkpoints.getCheckpoint("mission-1", "node-a");
		expect(result?.schemaVersion).toBe(1);
	});

	test("increments version on each save", () => {
		checkpoints.saveCheckpoint("mission-1", "node-a", { step: 1 });
		checkpoints.saveCheckpoint("mission-1", "node-a", { step: 2 });
		checkpoints.saveCheckpoint("mission-1", "node-a", { step: 3 });
		const result = checkpoints.getCheckpoint("mission-1", "node-a");
		expect(result?.version).toBe(3);
		expect(result?.data).toEqual({ step: 3 });
	});

	test("different nodes have independent versions", () => {
		checkpoints.saveCheckpoint("mission-1", "node-a", { val: "a" });
		checkpoints.saveCheckpoint("mission-1", "node-b", { val: "b" });
		checkpoints.saveCheckpoint("mission-1", "node-b", { val: "b2" });

		const a = checkpoints.getCheckpoint("mission-1", "node-a");
		const b = checkpoints.getCheckpoint("mission-1", "node-b");
		expect(a?.version).toBe(1);
		expect(b?.version).toBe(2);
	});

	test("different missions are isolated", () => {
		checkpoints.saveCheckpoint("mission-1", "node-a", { m: 1 });
		checkpoints.saveCheckpoint("mission-2", "node-a", { m: 2 });

		expect(checkpoints.getCheckpoint("mission-1", "node-a")?.data).toEqual({ m: 1 });
		expect(checkpoints.getCheckpoint("mission-2", "node-a")?.data).toEqual({ m: 2 });
	});

	test("round-trips complex nested data", () => {
		const data = { nested: { arr: [1, 2, 3], flag: true }, str: "hello" };
		checkpoints.saveCheckpoint("mission-1", "node-a", data);
		const result = checkpoints.getCheckpoint("mission-1", "node-a");
		expect(result?.data).toEqual(data);
	});

	test("round-trips null data", () => {
		checkpoints.saveCheckpoint("mission-1", "node-a", null);
		const result = checkpoints.getCheckpoint("mission-1", "node-a");
		expect(result?.data).toBeNull();
	});
});

// === getLatestCheckpoint ===

describe("getLatestCheckpoint", () => {
	test("returns null when no checkpoints", () => {
		expect(checkpoints.getLatestCheckpoint("mission-x")).toBeNull();
	});

	test("returns the most recently saved checkpoint", () => {
		checkpoints.saveCheckpoint("mission-1", "node-a", { step: 1 });
		checkpoints.saveCheckpoint("mission-1", "node-b", { step: 2 });
		const result = checkpoints.getLatestCheckpoint("mission-1");
		expect(result?.nodeId).toBe("node-b");
		expect(result?.data).toEqual({ step: 2 });
	});

	test("reflects version correctly", () => {
		checkpoints.saveCheckpoint("mission-1", "node-a", { v: 1 });
		checkpoints.saveCheckpoint("mission-1", "node-a", { v: 2 });
		const result = checkpoints.getLatestCheckpoint("mission-1");
		expect(result?.version).toBe(2);
	});
});

// === listCheckpoints ===

describe("listCheckpoints", () => {
	test("returns empty array when no checkpoints", () => {
		expect(checkpoints.listCheckpoints("mission-x")).toEqual([]);
	});

	test("lists all checkpoints for a mission", () => {
		checkpoints.saveCheckpoint("mission-1", "node-a", {});
		checkpoints.saveCheckpoint("mission-1", "node-b", {});
		checkpoints.saveCheckpoint("mission-1", "node-a", {});

		const list = checkpoints.listCheckpoints("mission-1");
		expect(list).toHaveLength(3);
		expect(list.every((c) => c.createdAt)).toBe(true);
	});

	test("does not include checkpoints from other missions", () => {
		checkpoints.saveCheckpoint("mission-1", "node-a", {});
		checkpoints.saveCheckpoint("mission-2", "node-b", {});

		expect(checkpoints.listCheckpoints("mission-1")).toHaveLength(1);
		expect(checkpoints.listCheckpoints("mission-2")).toHaveLength(1);
	});
});

// === recordTransition / getTransitionHistory ===

describe("recordTransition / getTransitionHistory", () => {
	test("returns empty array when no transitions", () => {
		expect(checkpoints.getTransitionHistory("mission-x")).toEqual([]);
	});

	test("records a transition and retrieves it", () => {
		checkpoints.recordTransition("mission-1", "node-a", "node-b", "complete");
		const history = checkpoints.getTransitionHistory("mission-1");
		expect(history).toHaveLength(1);
		const t = history[0];
		expect(t?.fromNode).toBe("node-a");
		expect(t?.toNode).toBe("node-b");
		expect(t?.trigger).toBe("complete");
		expect(t?.createdAt).toBeTruthy();
		expect(t?.error).toBeUndefined();
	});

	test("records transition with optional error", () => {
		checkpoints.recordTransition(
			"mission-1",
			"node-a",
			"node-b",
			"fail",
			undefined,
			"handler crashed",
		);
		const history = checkpoints.getTransitionHistory("mission-1");
		expect(history[0]?.error).toBe("handler crashed");
	});

	test("records transition with optional data (ignored in history output)", () => {
		checkpoints.recordTransition("mission-1", "node-a", "node-b", "next", { result: "ok" });
		const history = checkpoints.getTransitionHistory("mission-1");
		expect(history).toHaveLength(1);
	});

	test("returns transitions in insertion order", () => {
		checkpoints.recordTransition("mission-1", "a", "b", "t1");
		checkpoints.recordTransition("mission-1", "b", "c", "t2");
		checkpoints.recordTransition("mission-1", "c", "d", "t3");
		const history = checkpoints.getTransitionHistory("mission-1");
		expect(history.map((h) => h.trigger)).toEqual(["t1", "t2", "t3"]);
	});

	test("isolates transitions by mission", () => {
		checkpoints.recordTransition("mission-1", "a", "b", "t");
		checkpoints.recordTransition("mission-2", "x", "y", "t");
		expect(checkpoints.getTransitionHistory("mission-1")).toHaveLength(1);
		expect(checkpoints.getTransitionHistory("mission-2")).toHaveLength(1);
	});
});

// === getTransitionHistory pagination ===

describe("getTransitionHistory pagination", () => {
	beforeEach(() => {
		for (let i = 0; i < 5; i++) {
			checkpoints.recordTransition("mission-1", `node-${i}`, `node-${i + 1}`, `trigger-${i}`);
		}
	});

	test("limit restricts result count", () => {
		const result = checkpoints.getTransitionHistory("mission-1", { limit: 2 });
		expect(result).toHaveLength(2);
		expect(result[0]?.trigger).toBe("trigger-0");
	});

	test("offset skips entries", () => {
		const result = checkpoints.getTransitionHistory("mission-1", { offset: 3 });
		expect(result).toHaveLength(2);
		expect(result[0]?.trigger).toBe("trigger-3");
	});

	test("limit + offset pages correctly", () => {
		const page1 = checkpoints.getTransitionHistory("mission-1", { limit: 2, offset: 0 });
		const page2 = checkpoints.getTransitionHistory("mission-1", { limit: 2, offset: 2 });
		const page3 = checkpoints.getTransitionHistory("mission-1", { limit: 2, offset: 4 });

		expect(page1.map((t) => t.trigger)).toEqual(["trigger-0", "trigger-1"]);
		expect(page2.map((t) => t.trigger)).toEqual(["trigger-2", "trigger-3"]);
		expect(page3.map((t) => t.trigger)).toEqual(["trigger-4"]);
	});
});

// === saveStepResult (atomic transaction) ===

describe("saveStepResult", () => {
	test("atomically saves checkpoint and transition", () => {
		checkpoints.saveStepResult("mission-1", "node-a", "node-b", "complete", { progress: 100 });

		const cp = checkpoints.getCheckpoint("mission-1", "node-b");
		expect(cp).not.toBeNull();
		expect(cp?.data).toEqual({ progress: 100 });
		expect(cp?.schemaVersion).toBe(1);

		const history = checkpoints.getTransitionHistory("mission-1");
		expect(history).toHaveLength(1);
		expect(history[0]?.fromNode).toBe("node-a");
		expect(history[0]?.toNode).toBe("node-b");
		expect(history[0]?.trigger).toBe("complete");
	});

	test("checkpoint version increments on repeated saveStepResult", () => {
		checkpoints.saveStepResult("mission-1", "node-a", "node-b", "t1", { x: 1 });
		checkpoints.saveStepResult("mission-1", "node-b", "node-b", "t2", { x: 2 });

		const cp = checkpoints.getCheckpoint("mission-1", "node-b");
		expect(cp?.version).toBe(2);
		expect(cp?.data).toEqual({ x: 2 });

		const history = checkpoints.getTransitionHistory("mission-1");
		expect(history).toHaveLength(2);
	});
});

// === deleteCheckpoints ===

describe("deleteCheckpoints", () => {
	test("removes all checkpoints for a mission", () => {
		checkpoints.saveCheckpoint("mission-1", "node-a", {});
		checkpoints.saveCheckpoint("mission-1", "node-b", {});
		checkpoints.deleteCheckpoints("mission-1");
		expect(checkpoints.listCheckpoints("mission-1")).toEqual([]);
	});

	test("does not affect other missions", () => {
		checkpoints.saveCheckpoint("mission-1", "node-a", {});
		checkpoints.saveCheckpoint("mission-2", "node-a", {});
		checkpoints.deleteCheckpoints("mission-1");
		expect(checkpoints.listCheckpoints("mission-2")).toHaveLength(1);
	});
});

// === schema idempotency ===

describe("schema idempotency", () => {
	test("creating a second store on the same db does not throw", () => {
		const store2 = createMissionStore(dbPath);
		store2.close();
	});

	test("checkpoint tables exist after store creation", () => {
		// If we can save and retrieve, tables are present
		checkpoints.saveCheckpoint("mission-idem", "node-x", { ok: true });
		expect(checkpoints.getCheckpoint("mission-idem", "node-x")).not.toBeNull();
	});
});
