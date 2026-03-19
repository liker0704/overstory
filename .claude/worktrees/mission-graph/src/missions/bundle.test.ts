/**
 * Tests for mission result bundle export.
 *
 * Uses real bun:sqlite with temp files and temp directories. No mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import { createReviewStore } from "../review/store.ts";
import { createRunStore, createSessionStore } from "../sessions/store.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import type { BundleManifest } from "./bundle.ts";
import { exportBundle } from "./bundle.ts";
import { createMissionStore } from "./store.ts";

let tempDir: string;
let overstoryDir: string;
let dbPath: string;
let missionId: string;
let runId: string;

/** Insert a minimal mission + run into sessions.db, return the missionId. */
async function seedMission(
	opts: { withRunId?: boolean } = { withRunId: true },
): Promise<{ missionId: string; runId: string }> {
	const id = `mission-test-${Date.now()}`;
	const rid = `run-test-${Date.now()}`;

	const runStore = createRunStore(dbPath);
	try {
		runStore.createRun({
			id: rid,
			startedAt: new Date().toISOString(),
			coordinatorSessionId: null,
			coordinatorName: null,
			status: "active",
		});
	} finally {
		runStore.close();
	}

	const missionStore = createMissionStore(dbPath);
	try {
		missionStore.create({
			id,
			slug: "test-mission",
			objective: "Test the bundle export",
			runId: opts.withRunId ? rid : undefined,
			artifactRoot: join(overstoryDir, "missions", id),
		});
	} finally {
		missionStore.close();
	}

	return { missionId: id, runId: rid };
}

/** Insert N events into events.db for the given runId. */
function seedEvents(eventsDbPath: string, rid: string, count: number): void {
	const store = createEventStore(eventsDbPath);
	try {
		for (let i = 0; i < count; i++) {
			store.insert({
				runId: rid,
				agentName: `agent-${i}`,
				sessionId: null,
				eventType: "session_start",
				toolName: null,
				toolArgs: null,
				toolDurationMs: null,
				level: "info",
				data: JSON.stringify({ index: i }),
			});
		}
	} finally {
		store.close();
	}
}

/** Insert a session linked to the given runId. */
function seedSession(rid: string): void {
	const store = createSessionStore(dbPath);
	try {
		store.upsert({
			id: `session-${Date.now()}`,
			agentName: "test-agent",
			capability: "builder",
			runtime: "claude",
			worktreePath: "/tmp/worktree",
			branchName: "test-branch",
			taskId: "task-001",
			tmuxSession: "test-tmux",
			state: "working",
			pid: null,
			parentAgent: null,
			depth: 0,
			runId: rid,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
			rateLimitedSince: null,
			runtimeSessionId: null,
			transcriptPath: null,
			originalRuntime: null,
			statusLine: null,
		});
	} finally {
		store.close();
	}
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "overstory-bundle-test-"));
	overstoryDir = tempDir;
	dbPath = join(overstoryDir, "sessions.db");
	const seed = await seedMission();
	missionId = seed.missionId;
	runId = seed.runId;
});

afterEach(async () => {
	await cleanupTempDir(tempDir);
});

describe("exportBundle", () => {
	test("exports all required files for a mission with events and sessions", async () => {
		const eventsDbPath = join(overstoryDir, "events.db");
		seedEvents(eventsDbPath, runId, 3);
		seedSession(runId);

		const result = await exportBundle({ overstoryDir, dbPath, missionId });

		expect(result.outputDir).toBe(join(overstoryDir, "missions", missionId, "results"));
		expect(result.filesWritten).toContain("summary.json");
		expect(result.filesWritten).toContain("events.jsonl");
		expect(result.filesWritten).toContain("narrative.json");
		expect(result.filesWritten).toContain("narrative.md");
		expect(result.filesWritten).toContain("sessions.json");
		expect(result.filesWritten).toContain("metrics.json");
		expect(result.filesWritten).toContain("manifest.json");
	});

	test("manifest.json has correct structure and file list", async () => {
		const result = await exportBundle({ overstoryDir, dbPath, missionId });

		const manifestPath = join(result.outputDir, "manifest.json");
		const manifest = (await Bun.file(manifestPath).json()) as BundleManifest;

		expect(manifest.missionId).toBe(missionId);
		expect(manifest.slug).toBe("test-mission");
		expect(manifest.objective).toBe("Test the bundle export");
		expect(Array.isArray(manifest.files)).toBe(true);
		expect(manifest.files).toContain("summary.json");
		expect(manifest.files).toContain("manifest.json");
		expect(typeof manifest.generatedAt).toBe("string");
	});

	test("events.jsonl has correct line count matching seeded events", async () => {
		const eventsDbPath = join(overstoryDir, "events.db");
		seedEvents(eventsDbPath, runId, 5);

		const result = await exportBundle({ overstoryDir, dbPath, missionId });

		const eventsPath = join(result.outputDir, "events.jsonl");
		const content = await Bun.file(eventsPath).text();
		const lines = content.split("\n").filter((l) => l.trim().length > 0);
		expect(lines).toHaveLength(5);
	});

	test("force=true regenerates bundle even when fresh", async () => {
		// First export
		const first = await exportBundle({ overstoryDir, dbPath, missionId });
		expect(first.filesWritten.length).toBeGreaterThan(0);

		// Second export without force — should be fresh (no files written)
		const second = await exportBundle({ overstoryDir, dbPath, missionId });
		expect(second.filesWritten).toHaveLength(0);

		// Third export with force — should regenerate
		const third = await exportBundle({ overstoryDir, dbPath, missionId, force: true });
		expect(third.filesWritten.length).toBeGreaterThan(0);
		expect(third.filesWritten).toContain("manifest.json");
	});

	test("fresh bundle returns early without rewriting files", async () => {
		// First export
		const first = await exportBundle({ overstoryDir, dbPath, missionId });
		expect(first.filesWritten.length).toBeGreaterThan(0);

		// Second export — manifest is fresh, should return early
		const second = await exportBundle({ overstoryDir, dbPath, missionId });
		expect(second.filesWritten).toHaveLength(0);
		expect(second.manifest.missionId).toBe(missionId);
	});

	test("missing metrics.db writes empty metrics.json", async () => {
		// No metrics.db created
		const result = await exportBundle({ overstoryDir, dbPath, missionId });

		expect(result.filesWritten).toContain("metrics.json");
		const metricsPath = join(result.outputDir, "metrics.json");
		const metrics = await Bun.file(metricsPath).json();
		expect(Array.isArray(metrics)).toBe(true);
		expect(metrics).toHaveLength(0);
	});

	test("missing reviews.db skips review.json", async () => {
		// No reviews.db created
		const result = await exportBundle({ overstoryDir, dbPath, missionId });

		expect(result.filesWritten).not.toContain("review.json");
		const reviewPath = join(result.outputDir, "review.json");
		expect(await Bun.file(reviewPath).exists()).toBe(false);
	});

	test("exports latest mission review when reviews exist", async () => {
		const reviewStore = createReviewStore(join(overstoryDir, "reviews.db"));
		try {
			reviewStore.insert({
				subjectType: "mission",
				subjectId: missionId,
				dimensions: [],
				overallScore: 45,
				notes: ["older"],
				reviewerSource: "deterministic",
			});
			await Bun.sleep(5);
			reviewStore.insert({
				subjectType: "mission",
				subjectId: missionId,
				dimensions: [],
				overallScore: 91,
				notes: ["latest"],
				reviewerSource: "deterministic",
			});
		} finally {
			reviewStore.close();
		}

		const result = await exportBundle({ overstoryDir, dbPath, missionId });
		expect(result.filesWritten).toContain("review.json");

		const review = (await Bun.file(join(result.outputDir, "review.json")).json()) as {
			overallScore: number;
			notes: string[];
		};
		expect(review.overallScore).toBe(91);
		expect(review.notes).toContain("latest");
	});

	test("freshness: bundle with generatedAt newer than mission.updatedAt → skips rewrite", async () => {
		// First export generates a manifest.
		const first = await exportBundle({ overstoryDir, dbPath, missionId });
		expect(first.filesWritten.length).toBeGreaterThan(0);

		// Second call without force — manifest.generatedAt >= mission.updatedAt → skip.
		const second = await exportBundle({ overstoryDir, dbPath, missionId });
		expect(second.filesWritten).toHaveLength(0);
		expect(second.manifest.missionId).toBe(missionId);
	});

	test("freshness: stale manifest (generatedAt older than mission.updatedAt) → rewrites", async () => {
		// Create the output directory and write a manifest with an ancient timestamp.
		const outputDir = join(overstoryDir, "missions", missionId, "results");
		await mkdir(outputDir, { recursive: true });

		const staleManifest = {
			missionId,
			slug: "test-mission",
			objective: "Test the bundle export",
			state: "active",
			generatedAt: "1970-01-01T00:00:00.000Z",
			files: ["manifest.json"],
		};
		await Bun.write(join(outputDir, "manifest.json"), `${JSON.stringify(staleManifest, null, 2)}\n`);

		// exportBundle should detect the stale manifest and rewrite all files.
		const result = await exportBundle({ overstoryDir, dbPath, missionId });
		expect(result.filesWritten.length).toBeGreaterThan(0);
		expect(result.filesWritten).toContain("manifest.json");
	});

	test("throws when mission not found", async () => {
		expect(exportBundle({ overstoryDir, dbPath, missionId: "nonexistent-id" })).rejects.toThrow(
			"Mission not found",
		);
	});
});
