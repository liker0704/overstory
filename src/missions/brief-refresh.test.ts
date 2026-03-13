/**
 * Tests for brief-refresh module.
 *
 * Uses real temp directories (mkdtemp) for file I/O. No mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSpecStaleness, computeBriefRevision, refreshBriefChain } from "./brief-refresh.ts";
import type { SpecMeta } from "./spec-meta.ts";
import { writeSpecMeta } from "./spec-meta.ts";

let tempDir: string;
let briefPath: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "overstory-brief-refresh-test-"));
	briefPath = join(tempDir, "brief.md");
	await writeFile(briefPath, "# Initial brief content\n");
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

function makeMeta(overrides: Partial<SpecMeta> = {}): SpecMeta {
	return {
		taskId: "task-001",
		workstreamId: "ws-auth",
		briefPath: "plan/briefs/ws-auth.md",
		briefRevision: "placeholder",
		specRevision: "specrev",
		status: "current",
		generatedAt: "2026-03-12T00:00:00.000Z",
		generatedBy: "mission-analyst",
		...overrides,
	};
}

// === computeBriefRevision edge cases ===

describe("computeBriefRevision edge cases", () => {
	test("throws when file does not exist (fixed: descriptive error)", async () => {
		const missingPath = join(tempDir, "nonexistent-brief.md");
		// The fixed behavior checks file existence and throws a descriptive error.
		await expect(computeBriefRevision(missingPath)).rejects.toThrow();
	});
});

describe("checkSpecStaleness edge cases", () => {
	test("throws or rejects when brief file does not exist", async () => {
		const missingBrief = join(tempDir, "no-such-brief.md");
		// checkSpecStaleness calls computeBriefRevision which will throw for missing files.
		await expect(checkSpecStaleness(tempDir, "task-001", missingBrief)).rejects.toThrow();
	});
});

// === computeBriefRevision ===

describe("computeBriefRevision", () => {
	test("returns a 64-character hex string (SHA-256)", async () => {
		const rev = await computeBriefRevision(briefPath);
		expect(rev).toHaveLength(64);
		expect(/^[0-9a-f]+$/.test(rev)).toBe(true);
	});

	test("same content produces same hash", async () => {
		const rev1 = await computeBriefRevision(briefPath);
		const rev2 = await computeBriefRevision(briefPath);
		expect(rev1).toBe(rev2);
	});

	test("different content produces different hash", async () => {
		const rev1 = await computeBriefRevision(briefPath);
		await writeFile(briefPath, "# Changed brief content\n");
		const rev2 = await computeBriefRevision(briefPath);
		expect(rev1).not.toBe(rev2);
	});
});

// === checkSpecStaleness ===

describe("checkSpecStaleness", () => {
	test("isStale=true with reason when no meta exists", async () => {
		const result = await checkSpecStaleness(tempDir, "task-001", briefPath);
		expect(result.taskId).toBe("task-001");
		expect(result.isStale).toBe(true);
		expect(result.reason).toContain("No spec meta found");
		expect(result.currentBriefRevision).toHaveLength(64);
		expect(result.recordedBriefRevision).toBeNull();
	});

	test("isStale=false when brief revision matches", async () => {
		const currentRev = await computeBriefRevision(briefPath);
		await writeSpecMeta(tempDir, "task-001", makeMeta({ briefRevision: currentRev }));
		const result = await checkSpecStaleness(tempDir, "task-001", briefPath);
		expect(result.isStale).toBe(false);
		expect(result.reason).toBeNull();
		expect(result.currentBriefRevision).toBe(currentRev);
		expect(result.recordedBriefRevision).toBe(currentRev);
	});

	test("isStale=true when brief has changed since spec generation", async () => {
		const oldRev = await computeBriefRevision(briefPath);
		await writeSpecMeta(tempDir, "task-001", makeMeta({ briefRevision: oldRev }));
		// Mutate brief
		await writeFile(briefPath, "# Updated brief content\n");
		const result = await checkSpecStaleness(tempDir, "task-001", briefPath);
		expect(result.isStale).toBe(true);
		expect(result.reason).toContain("Brief has changed");
		expect(result.currentBriefRevision).not.toBe(oldRev);
		expect(result.recordedBriefRevision).toBe(oldRev);
	});
});

// === refreshBriefChain ===

describe("refreshBriefChain", () => {
	test("previousBriefRevision is null when no meta exists", async () => {
		const result = await refreshBriefChain(tempDir, "task-001", "ws-auth", briefPath);
		expect(result.taskId).toBe("task-001");
		expect(result.workstreamId).toBe("ws-auth");
		expect(result.previousBriefRevision).toBeNull();
		expect(result.currentBriefRevision).toHaveLength(64);
		expect(result.metaMissing).toBe(true);
		expect(result.revisionChanged).toBe(true);
		expect(result.specWasStale).toBe(false);
		expect(result.specMarkedStale).toBe(false);
		expect(result.regenerationRequired).toBe(true);
	});

	test("missing meta still requires regeneration even though nothing can be marked stale", async () => {
		const result = await refreshBriefChain(tempDir, "task-001", "ws-auth", briefPath);
		expect(result.specMarkedStale).toBe(false);
		expect(result.regenerationRequired).toBe(true);
	});

	test("no stale marking when revision is unchanged", async () => {
		const currentRev = await computeBriefRevision(briefPath);
		await writeSpecMeta(
			tempDir,
			"task-001",
			makeMeta({ briefRevision: currentRev, status: "current" }),
		);
		const result = await refreshBriefChain(tempDir, "task-001", "ws-auth", briefPath);
		expect(result.metaMissing).toBe(false);
		expect(result.revisionChanged).toBe(false);
		expect(result.specWasStale).toBe(false);
		expect(result.specMarkedStale).toBe(false);
		expect(result.regenerationRequired).toBe(false);
		expect(result.previousBriefRevision).toBe(currentRev);
		expect(result.currentBriefRevision).toBe(currentRev);
	});

	test("marks spec stale when brief has changed", async () => {
		const oldRev = await computeBriefRevision(briefPath);
		await writeSpecMeta(
			tempDir,
			"task-001",
			makeMeta({ briefRevision: oldRev, status: "current" }),
		);
		await writeFile(briefPath, "# Updated brief\n");
		const result = await refreshBriefChain(tempDir, "task-001", "ws-auth", briefPath);
		expect(result.previousBriefRevision).toBe(oldRev);
		expect(result.currentBriefRevision).not.toBe(oldRev);
		expect(result.revisionChanged).toBe(true);
		expect(result.specWasStale).toBe(false);
		expect(result.specMarkedStale).toBe(true);
		expect(result.regenerationRequired).toBe(true);
	});

	test("specWasStale=true and specMarkedStale=false when already stale", async () => {
		const oldRev = await computeBriefRevision(briefPath);
		await writeSpecMeta(tempDir, "task-001", makeMeta({ briefRevision: oldRev, status: "stale" }));
		await writeFile(briefPath, "# Further updated brief\n");
		const result = await refreshBriefChain(tempDir, "task-001", "ws-auth", briefPath);
		expect(result.specWasStale).toBe(true);
		expect(result.specMarkedStale).toBe(false);
		expect(result.regenerationRequired).toBe(true);
	});

	test("does not regenerate spec, only marks stale", async () => {
		const oldRev = await computeBriefRevision(briefPath);
		const meta = makeMeta({ briefRevision: oldRev, specRevision: "original-spec-rev" });
		await writeSpecMeta(tempDir, "task-001", meta);
		await writeFile(briefPath, "# New brief\n");
		await refreshBriefChain(tempDir, "task-001", "ws-auth", briefPath);
		// specRevision should be unchanged — we only mark stale, never regenerate
		const { readSpecMeta } = await import("./spec-meta.ts");
		const updated = await readSpecMeta(tempDir, "task-001");
		expect(updated?.specRevision).toBe("original-spec-rev");
		expect(updated?.status).toBe("stale");
	});
});
