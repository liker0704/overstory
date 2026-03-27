/**
 * Tests for artifact-staleness module.
 *
 * Uses real temp directories (mkdtemp) for file I/O. No mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ARTIFACT_DEPENDENCIES,
	type ArtifactStalenessSnapshot,
	checkArtifactStaleness,
	computeArtifactStaleness,
	computeDependencyHashes,
	computeFileHash,
	MISSING,
	readSnapshot,
	SNAPSHOT_FILENAME,
	writeSnapshot,
} from "./artifact-staleness.ts";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "overstory-artifact-staleness-test-"));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

// === computeFileHash ===

describe("computeFileHash", () => {
	test("returns a 64-character hex string for an existing file", async () => {
		const filePath = join(tempDir, "test.md");
		await writeFile(filePath, "# Hello\n");
		const hash = await computeFileHash(filePath);
		expect(hash).toHaveLength(64);
		expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
	});

	test("returns MISSING for a non-existent file", async () => {
		const filePath = join(tempDir, "nonexistent.md");
		const hash = await computeFileHash(filePath);
		expect(hash).toBe(MISSING);
	});

	test("same content produces same hash (deterministic)", async () => {
		const filePath = join(tempDir, "stable.md");
		await writeFile(filePath, "stable content");
		const hash1 = await computeFileHash(filePath);
		const hash2 = await computeFileHash(filePath);
		expect(hash1).toBe(hash2);
	});

	test("different content produces different hash", async () => {
		const filePath = join(tempDir, "changing.md");
		await writeFile(filePath, "first content");
		const hash1 = await computeFileHash(filePath);
		await writeFile(filePath, "second content");
		const hash2 = await computeFileHash(filePath);
		expect(hash1).not.toBe(hash2);
	});
});

// === computeDependencyHashes ===

describe("computeDependencyHashes", () => {
	test("returns hashes for all dependency files", async () => {
		// Create dependency files for 'brief' type
		await writeFile(join(tempDir, "mission.md"), "# Mission\n");
		await mkdir(join(tempDir, "plan"), { recursive: true });
		await writeFile(join(tempDir, "plan", "workstreams.json"), '{"workstreams":[]}');

		const hashes = await computeDependencyHashes(tempDir, "brief");
		const deps = ARTIFACT_DEPENDENCIES.brief;
		expect(Object.keys(hashes)).toHaveLength(deps.length);
		for (const dep of deps) {
			expect(hashes[dep]).toBeDefined();
			expect(hashes[dep]).not.toBe(undefined);
		}
	});

	test("marks missing dependency files as MISSING", async () => {
		// Do not create any files
		const hashes = await computeDependencyHashes(tempDir, "brief");
		expect(hashes["mission.md"]).toBe(MISSING);
		expect(hashes["plan/workstreams.json"]).toBe(MISSING);
	});

	test("returns valid hashes for existing files and MISSING for absent ones", async () => {
		// Only create mission.md, leave workstreams.json missing
		await writeFile(join(tempDir, "mission.md"), "# Mission\n");
		const hashes = await computeDependencyHashes(tempDir, "brief");
		expect(hashes["mission.md"]).toHaveLength(64);
		expect(hashes["plan/workstreams.json"]).toBe(MISSING);
	});
});

// === readSnapshot / writeSnapshot ===

describe("readSnapshot", () => {
	test("returns null when snapshot file does not exist", async () => {
		const result = await readSnapshot(tempDir);
		expect(result).toBeNull();
	});

	test("returns null for invalid JSON", async () => {
		await writeFile(join(tempDir, SNAPSHOT_FILENAME), "not-json");
		const result = await readSnapshot(tempDir);
		expect(result).toBeNull();
	});

	test("returns null for JSON that is not an object", async () => {
		await writeFile(join(tempDir, SNAPSHOT_FILENAME), '"just a string"\n');
		const result = await readSnapshot(tempDir);
		expect(result).toBeNull();
	});

	test("returns null for JSON missing required fields", async () => {
		await writeFile(join(tempDir, SNAPSHOT_FILENAME), '{"fileHashes":{}}\n');
		const result = await readSnapshot(tempDir);
		expect(result).toBeNull();
	});
});

describe("writeSnapshot / readSnapshot round-trip", () => {
	test("round-trips a snapshot correctly", async () => {
		const snapshot: ArtifactStalenessSnapshot = {
			fileHashes: { "mission.md": "abc123", "decisions.md": MISSING },
			capturedAt: "2026-03-14T00:00:00.000Z",
		};
		await writeSnapshot(tempDir, snapshot);
		const result = await readSnapshot(tempDir);
		expect(result).not.toBeNull();
		expect(result?.fileHashes["mission.md"]).toBe("abc123");
		expect(result?.fileHashes["decisions.md"]).toBe(MISSING);
		expect(result?.capturedAt).toBe("2026-03-14T00:00:00.000Z");
	});

	test("written file has trailing newline", async () => {
		const snapshot: ArtifactStalenessSnapshot = {
			fileHashes: {},
			capturedAt: "2026-03-14T00:00:00.000Z",
		};
		await writeSnapshot(tempDir, snapshot);
		const content = await Bun.file(join(tempDir, SNAPSHOT_FILENAME)).text();
		expect(content.endsWith("\n")).toBe(true);
	});
});

// === checkArtifactStaleness ===

describe("checkArtifactStaleness", () => {
	test("not stale on first run (stored=null)", async () => {
		const result = await checkArtifactStaleness(tempDir, "brief", null);
		expect(result.status).toBe("fresh");
		expect(result.changedDependencies).toHaveLength(0);
		expect(result.storedHashes).toBeNull();
	});

	test("reports missing dependencies even on first run", async () => {
		const result = await checkArtifactStaleness(tempDir, "brief", null);
		expect(result.missingDependencies).toContain("mission.md");
		expect(result.missingDependencies).toContain("plan/workstreams.json");
	});

	test("not stale when hashes are unchanged", async () => {
		await writeFile(join(tempDir, "mission.md"), "# Mission\n");
		await mkdir(join(tempDir, "plan"), { recursive: true });
		await writeFile(join(tempDir, "plan", "workstreams.json"), "{}");

		const currentHashes = await computeDependencyHashes(tempDir, "brief");
		const stored: ArtifactStalenessSnapshot = {
			fileHashes: currentHashes,
			capturedAt: new Date().toISOString(),
		};

		const result = await checkArtifactStaleness(tempDir, "brief", stored);
		expect(result.status).toBe("fresh");
		expect(result.changedDependencies).toHaveLength(0);
	});

	test("stale when a dependency hash changes", async () => {
		await writeFile(join(tempDir, "mission.md"), "# Original\n");
		await mkdir(join(tempDir, "plan"), { recursive: true });
		await writeFile(join(tempDir, "plan", "workstreams.json"), "{}");

		const oldHashes = await computeDependencyHashes(tempDir, "brief");
		const stored: ArtifactStalenessSnapshot = {
			fileHashes: oldHashes,
			capturedAt: new Date().toISOString(),
		};

		// Mutate a dependency
		await writeFile(join(tempDir, "mission.md"), "# Updated\n");

		const result = await checkArtifactStaleness(tempDir, "brief", stored);
		expect(result.status).toBe("stale");
		expect(result.changedDependencies).toContain("mission.md");
	});

	test("tracks missing dependencies when file disappears", async () => {
		await writeFile(join(tempDir, "mission.md"), "# Mission\n");
		const oldHashes = await computeDependencyHashes(tempDir, "brief");

		// Now remove the file to simulate disappearance
		await rm(join(tempDir, "mission.md"));

		const stored: ArtifactStalenessSnapshot = {
			fileHashes: oldHashes,
			capturedAt: new Date().toISOString(),
		};

		const result = await checkArtifactStaleness(tempDir, "brief", stored);
		expect(result.status).toBe("stale");
		expect(result.changedDependencies).toContain("mission.md");
		expect(result.missingDependencies).toContain("mission.md");
	});

	test("detects multiple changed dependencies", async () => {
		await writeFile(join(tempDir, "mission.md"), "# Mission\n");
		await mkdir(join(tempDir, "plan"), { recursive: true });
		await writeFile(join(tempDir, "plan", "workstreams.json"), "{}");

		const oldHashes = await computeDependencyHashes(tempDir, "brief");
		const stored: ArtifactStalenessSnapshot = {
			fileHashes: oldHashes,
			capturedAt: new Date().toISOString(),
		};

		await writeFile(join(tempDir, "mission.md"), "# Updated\n");
		await writeFile(join(tempDir, "plan", "workstreams.json"), '{"updated":true}');

		const result = await checkArtifactStaleness(tempDir, "brief", stored);
		expect(result.status).toBe("stale");
		expect(result.changedDependencies).toContain("mission.md");
		expect(result.changedDependencies).toContain("plan/workstreams.json");
	});
});

// === computeArtifactStaleness ===

describe("computeArtifactStaleness", () => {
	test("returns empty report for non-existent directory", async () => {
		const nonExistentDir = join(tempDir, "no-such-mission");
		const report = await computeArtifactStaleness(nonExistentDir);
		expect(report.missionDir).toBe(nonExistentDir);
		expect(report.results).toHaveLength(0);
		expect(report.overallStatus).toBe("fresh");
	});

	test("returns results for all 7 artifact types on fresh run", async () => {
		const report = await computeArtifactStaleness(tempDir);
		expect(report.results).toHaveLength(7);
		const types = report.results.map((r) => r.artifactType);
		expect(types).toContain("brief");
		expect(types).toContain("spec");
		expect(types).toContain("mission-plan");
		expect(types).toContain("review-output");
		expect(types).toContain("mission-score");
		expect(types).toContain("architecture");
		expect(types).toContain("test-plan");
	});

	test("not stale on first run (fresh state)", async () => {
		const report = await computeArtifactStaleness(tempDir);
		expect(report.overallStatus).toBe("fresh");
		for (const result of report.results) {
			expect(result.status).toBe("fresh");
		}
	});

	test("stale after dependency changes on second run", async () => {
		// Create a dependency file
		await writeFile(join(tempDir, "mission.md"), "# Mission\n");
		await mkdir(join(tempDir, "plan"), { recursive: true });
		await writeFile(join(tempDir, "plan", "workstreams.json"), "{}");

		// First run establishes baseline
		await computeArtifactStaleness(tempDir);

		// Mutate a dependency
		await writeFile(join(tempDir, "mission.md"), "# Updated mission\n");

		// Second run should detect change
		const report = await computeArtifactStaleness(tempDir);
		expect(report.overallStatus).toBe("stale");

		const briefResult = report.results.find((r) => r.artifactType === "brief");
		expect(briefResult?.status).toBe("stale");
		expect(briefResult?.changedDependencies).toContain("mission.md");
	});

	test("persists snapshot after each run", async () => {
		await computeArtifactStaleness(tempDir);
		const snapshot = await readSnapshot(tempDir);
		expect(snapshot).not.toBeNull();
		expect(snapshot?.capturedAt).toBeDefined();
	});

	test("snapshot contains hashes for all dependency files", async () => {
		await writeFile(join(tempDir, "mission.md"), "# Mission\n");
		await computeArtifactStaleness(tempDir);
		const snapshot = await readSnapshot(tempDir);
		expect(snapshot?.fileHashes["mission.md"]).toHaveLength(64);
	});
});
