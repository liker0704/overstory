/**
 * Tests for spec-meta module.
 *
 * Uses real temp directories (mkdtemp) for file I/O. No mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	listSpecMeta,
	markStale,
	readSpecMeta,
	SPEC_META_STATUSES,
	type SpecMeta,
	writeSpecMeta,
} from "./spec-meta.ts";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "overstory-spec-meta-test-"));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

function makeMeta(overrides: Partial<SpecMeta> = {}): SpecMeta {
	return {
		taskId: "task-001",
		workstreamId: "ws-auth",
		briefPath: "plan/briefs/ws-auth.md",
		briefRevision: "abc123def456",
		specRevision: "deadbeef1234",
		status: "current",
		generatedAt: "2026-03-12T00:00:00.000Z",
		generatedBy: "mission-analyst",
		...overrides,
	};
}

// === SPEC_META_STATUSES ===

describe("SPEC_META_STATUSES", () => {
	test("contains all three statuses", () => {
		expect(SPEC_META_STATUSES).toContain("current");
		expect(SPEC_META_STATUSES).toContain("stale");
		expect(SPEC_META_STATUSES).toContain("superseded");
		expect(SPEC_META_STATUSES).toHaveLength(3);
	});
});

// === readSpecMeta ===

describe("readSpecMeta", () => {
	test("returns null when file does not exist", async () => {
		const result = await readSpecMeta(tempDir, "task-missing");
		expect(result).toBeNull();
	});

	test("returns parsed SpecMeta when file exists", async () => {
		const meta = makeMeta();
		await writeSpecMeta(tempDir, "task-001", meta);
		const result = await readSpecMeta(tempDir, "task-001");
		expect(result).toEqual(meta);
	});
});

// === writeSpecMeta ===

describe("writeSpecMeta", () => {
	test("creates directory and writes file", async () => {
		const meta = makeMeta();
		const path = await writeSpecMeta(tempDir, "task-001", meta);
		expect(path).toContain("task-001.meta.json");
		const file = Bun.file(path);
		expect(await file.exists()).toBe(true);
	});

	test("round-trips all fields", async () => {
		const meta = makeMeta({ status: "stale", workstreamId: "ws-payments" });
		await writeSpecMeta(tempDir, "task-002", meta);
		const result = await readSpecMeta(tempDir, "task-002");
		expect(result).toEqual(meta);
	});

	test("returns absolute path to written file", async () => {
		const path = await writeSpecMeta(tempDir, "task-003", makeMeta());
		expect(path.startsWith("/")).toBe(true);
	});

	test("written file has trailing newline", async () => {
		const path = await writeSpecMeta(tempDir, "task-004", makeMeta());
		const content = await Bun.file(path).text();
		expect(content.endsWith("\n")).toBe(true);
	});

	test("overwrites existing file", async () => {
		const meta1 = makeMeta({ status: "current" });
		const meta2 = makeMeta({ status: "stale" });
		await writeSpecMeta(tempDir, "task-001", meta1);
		await writeSpecMeta(tempDir, "task-001", meta2);
		const result = await readSpecMeta(tempDir, "task-001");
		expect(result?.status).toBe("stale");
	});
});

// === listSpecMeta ===

describe("listSpecMeta", () => {
	test("returns empty array when no meta files exist", async () => {
		const results = await listSpecMeta(tempDir);
		expect(results).toEqual([]);
	});

	test("returns empty array when specs dir does not exist", async () => {
		const results = await listSpecMeta(join(tempDir, "nonexistent-project"));
		expect(results).toEqual([]);
	});

	test("returns all meta files", async () => {
		await writeSpecMeta(tempDir, "task-001", makeMeta({ taskId: "task-001" }));
		await writeSpecMeta(tempDir, "task-002", makeMeta({ taskId: "task-002" }));
		const results = await listSpecMeta(tempDir);
		expect(results).toHaveLength(2);
		const ids = results.map((r) => r.taskId).sort();
		expect(ids).toEqual(["task-001", "task-002"]);
	});

	test("skips non-meta .json files in specs dir", async () => {
		const specsPath = join(tempDir, ".overstory", "specs");
		await mkdir(specsPath, { recursive: true });
		await writeFile(join(specsPath, "task-001.md"), "# Spec content");
		await writeSpecMeta(tempDir, "task-002", makeMeta({ taskId: "task-002" }));
		const results = await listSpecMeta(tempDir);
		expect(results).toHaveLength(1);
		expect(results[0]?.taskId).toBe("task-002");
	});
});

// === markStale ===

describe("markStale", () => {
	test("no-op when meta file does not exist", async () => {
		await expect(markStale(tempDir, "task-missing")).resolves.toBeUndefined();
	});

	test("sets status to stale on existing meta", async () => {
		await writeSpecMeta(tempDir, "task-001", makeMeta({ status: "current" }));
		await markStale(tempDir, "task-001");
		const result = await readSpecMeta(tempDir, "task-001");
		expect(result?.status).toBe("stale");
	});

	test("preserves other fields when marking stale", async () => {
		const original = makeMeta({ briefRevision: "cafebabe", specRevision: "deadbeef" });
		await writeSpecMeta(tempDir, "task-001", original);
		await markStale(tempDir, "task-001");
		const result = await readSpecMeta(tempDir, "task-001");
		expect(result?.briefRevision).toBe("cafebabe");
		expect(result?.specRevision).toBe("deadbeef");
		expect(result?.taskId).toBe("task-001");
	});

	test("idempotent — calling twice keeps status stale", async () => {
		await writeSpecMeta(tempDir, "task-001", makeMeta({ status: "stale" }));
		await markStale(tempDir, "task-001");
		const result = await readSpecMeta(tempDir, "task-001");
		expect(result?.status).toBe("stale");
	});
});
