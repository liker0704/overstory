/**
 * Staleness module tests.
 *
 * Uses real filesystem (temp directories) — no mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeStalenessState, detectStaleness, WATCHED_SURFACES } from "./staleness.ts";

describe("staleness", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "ov-staleness-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("computeStalenessState", () => {
		test("returns MISSING hash for non-existent files", async () => {
			const state = await computeStalenessState(tempDir, "session");
			for (const [, hash] of Object.entries(state.fileHashes)) {
				expect(hash).toBe("MISSING");
			}
		});

		test("returns SHA-256 hex hash for existing files", async () => {
			await mkdir(join(tempDir, "agents"), { recursive: true });
			await writeFile(join(tempDir, "agents/coordinator.md"), "test content");

			const state = await computeStalenessState(tempDir, "session");
			expect(state.fileHashes["agents/coordinator.md"]).not.toBe("MISSING");
			expect(state.fileHashes["agents/coordinator.md"]).toMatch(/^[0-9a-f]{64}$/);
		});

		test("produces consistent hashes for same content", async () => {
			await mkdir(join(tempDir, "agents"), { recursive: true });
			await writeFile(join(tempDir, "agents/builder.md"), "stable content");

			const state1 = await computeStalenessState(tempDir, "handoff");
			const state2 = await computeStalenessState(tempDir, "handoff");
			expect(state1.fileHashes["agents/builder.md"]).toBe(state2.fileHashes["agents/builder.md"]);
		});

		test("produces different hashes for different content", async () => {
			await mkdir(join(tempDir, "agents"), { recursive: true });
			await writeFile(join(tempDir, "agents/builder.md"), "version 1");
			const state1 = await computeStalenessState(tempDir, "handoff");

			await writeFile(join(tempDir, "agents/builder.md"), "version 2");
			const state2 = await computeStalenessState(tempDir, "handoff");

			expect(state1.fileHashes["agents/builder.md"]).not.toBe(
				state2.fileHashes["agents/builder.md"],
			);
		});

		test("has capturedAt ISO timestamp", async () => {
			const before = Date.now();
			const state = await computeStalenessState(tempDir, "spec");
			const after = Date.now();

			const capturedAt = new Date(state.capturedAt).getTime();
			expect(capturedAt).toBeGreaterThanOrEqual(before);
			expect(capturedAt).toBeLessThanOrEqual(after);
		});

		test("fileHashes keys match WATCHED_SURFACES for the subject type", async () => {
			const state = await computeStalenessState(tempDir, "handoff");
			const expectedKeys = WATCHED_SURFACES.handoff.slice().sort();
			expect(Object.keys(state.fileHashes).sort()).toEqual(expectedKeys);
		});

		test("covers all four subject types including mission", async () => {
			const session = await computeStalenessState(tempDir, "session");
			const handoff = await computeStalenessState(tempDir, "handoff");
			const spec = await computeStalenessState(tempDir, "spec");
			const mission = await computeStalenessState(tempDir, "mission");

			expect(Object.keys(session.fileHashes)).toHaveLength(WATCHED_SURFACES.session.length);
			expect(Object.keys(handoff.fileHashes)).toHaveLength(WATCHED_SURFACES.handoff.length);
			expect(Object.keys(spec.fileHashes)).toHaveLength(WATCHED_SURFACES.spec.length);
			expect(Object.keys(mission.fileHashes)).toHaveLength(WATCHED_SURFACES.mission.length);
		});
	});

	describe("detectStaleness", () => {
		test("returns empty array when stored is null (first run)", () => {
			const current = {
				fileHashes: { "foo.ts": "abc123" },
				capturedAt: new Date().toISOString(),
			};
			expect(detectStaleness(current, null)).toEqual([]);
		});

		test("returns empty array when nothing changed", () => {
			const state = {
				fileHashes: { "foo.ts": "abc123", "bar.ts": "def456" },
				capturedAt: new Date().toISOString(),
			};
			expect(detectStaleness(state, state)).toEqual([]);
		});

		test("returns changed file paths when hash differs", () => {
			const stored = {
				fileHashes: { "foo.ts": "abc123", "bar.ts": "def456" },
				capturedAt: new Date().toISOString(),
			};
			const current = {
				fileHashes: { "foo.ts": "abc999", "bar.ts": "def456" },
				capturedAt: new Date().toISOString(),
			};
			expect(detectStaleness(current, stored)).toEqual(["foo.ts"]);
		});

		test("detects file going MISSING as a change", () => {
			const stored = {
				fileHashes: { "foo.ts": "abc123" },
				capturedAt: new Date().toISOString(),
			};
			const current = {
				fileHashes: { "foo.ts": "MISSING" },
				capturedAt: new Date().toISOString(),
			};
			expect(detectStaleness(current, stored)).toEqual(["foo.ts"]);
		});

		test("detects file appearing from MISSING as a change", () => {
			const stored = {
				fileHashes: { "foo.ts": "MISSING" },
				capturedAt: new Date().toISOString(),
			};
			const current = {
				fileHashes: { "foo.ts": "newHash123" },
				capturedAt: new Date().toISOString(),
			};
			expect(detectStaleness(current, stored)).toEqual(["foo.ts"]);
		});

		test("returns all changed paths when multiple files change", async () => {
			await mkdir(join(tempDir, "agents"), { recursive: true });
			await writeFile(join(tempDir, "agents/coordinator.md"), "v1");
			await writeFile(join(tempDir, "agents/lead.md"), "v1");

			const state1 = await computeStalenessState(tempDir, "session");

			await writeFile(join(tempDir, "agents/coordinator.md"), "v2");
			await writeFile(join(tempDir, "agents/lead.md"), "v2");

			const state2 = await computeStalenessState(tempDir, "session");

			const changed = detectStaleness(state2, state1);
			expect(changed).toContain("agents/coordinator.md");
			expect(changed).toContain("agents/lead.md");
		});

		test("ignores paths not present in current (no false positives)", () => {
			const stored = {
				fileHashes: { "foo.ts": "abc123", "extra.ts": "xyz789" },
				capturedAt: new Date().toISOString(),
			};
			// current only has foo.ts unchanged
			const current = {
				fileHashes: { "foo.ts": "abc123" },
				capturedAt: new Date().toISOString(),
			};
			expect(detectStaleness(current, stored)).toEqual([]);
		});
	});
});
