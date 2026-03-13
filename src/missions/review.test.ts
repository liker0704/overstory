import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { createReviewStore } from "../review/store.ts";
import { createSessionStore } from "../sessions/store.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import type { Mission } from "../types.ts";
import { ensureMissionArtifacts } from "./context.ts";
import { buildMissionReviewInput, generateMissionReview } from "./review.ts";
import { createMissionStore } from "./store.ts";

describe("mission review generation", () => {
	let tempDir: string;
	let overstoryDir: string;
	let dbPath: string;
	let mission: Mission;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-mission-review-"));
		overstoryDir = tempDir;
		dbPath = join(overstoryDir, "sessions.db");

		const missionStore = createMissionStore(dbPath);
		try {
			mission = missionStore.create({
				id: "mission-review-001",
				slug: "mission-review-smoke",
				objective: "Exercise deterministic mission review generation",
				runId: "run-review-001",
				artifactRoot: join(overstoryDir, "missions", "mission-review-001"),
				startedAt: "2026-03-13T00:00:00.000Z",
			});
		} finally {
			missionStore.close();
		}

		await ensureMissionArtifacts(mission);

		const eventStore = createEventStore(join(overstoryDir, "events.db"));
		try {
			eventStore.insert({
				runId: mission.runId,
				agentName: "mission-analyst",
				sessionId: "session-analyst-1",
				eventType: "mission",
				toolName: null,
				toolArgs: null,
				toolDurationMs: null,
				level: "info",
				data: JSON.stringify({ kind: "mission_started", detail: "Mission started" }),
			});
			eventStore.insert({
				runId: mission.runId,
				agentName: "execution-director",
				sessionId: "session-director-1",
				eventType: "progress",
				toolName: null,
				toolArgs: null,
				toolDurationMs: null,
				level: "info",
				data: "Dispatching leads",
			});
		} finally {
			eventStore.close();
		}

		const sessionStore = createSessionStore(dbPath);
		try {
			sessionStore.upsert({
				id: "session-analyst-1",
				agentName: "mission-analyst",
				capability: "mission-analyst",
				runtime: "claude",
				worktreePath: "/tmp/project",
				branchName: "main",
				taskId: "",
				tmuxSession: "ov-mission-analyst",
				state: "completed",
				pid: null,
				parentAgent: null,
				depth: 0,
				runId: mission.runId,
				startedAt: "2026-03-13T00:00:00.000Z",
				lastActivity: "2026-03-13T00:05:00.000Z",
				escalationLevel: 0,
				stalledSince: null,
				rateLimitedSince: null,
				runtimeSessionId: null,
				transcriptPath: null,
				originalRuntime: null,
			});
		} finally {
			sessionStore.close();
		}

		const metricsStore = createMetricsStore(join(overstoryDir, "metrics.db"));
		try {
			metricsStore.recordSession({
				agentName: "mission-analyst",
				taskId: "mission-review-001",
				capability: "mission-analyst",
				startedAt: "2026-03-13T00:00:00.000Z",
				completedAt: "2026-03-13T00:05:00.000Z",
				durationMs: 300000,
				exitCode: 0,
				mergeResult: null,
				parentAgent: null,
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				estimatedCostUsd: 0.12,
				modelUsed: "sonnet",
				runId: mission.runId,
			});
		} finally {
			metricsStore.close();
		}
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	test("buildMissionReviewInput derives artifacts, narrative, metrics, and bundle freshness", async () => {
		const input = buildMissionReviewInput(overstoryDir, mission);

		expect(input.eventCount).toBe(2);
		expect(input.totalSessionCount).toBe(1);
		expect(input.completedSessionCount).toBe(1);
		expect(input.agentCount).toBe(1);
		expect(input.artifactFileCount).toBe(6);
		expect(input.metricsCount).toBe(1);
		expect(input.narrativeEntryCount).toBeGreaterThan(0);
		expect(input.hasBundleExport).toBe(false);
		expect(input.durationMs).toBeGreaterThanOrEqual(0);
	});

	test("generateMissionReview persists a mission review record", async () => {
		const generated = generateMissionReview({ overstoryDir, mission });

		expect(generated.record.subjectType).toBe("mission");
		expect(generated.record.subjectId).toBe(mission.id);
		expect(generated.record.overallScore).toBeGreaterThanOrEqual(0);

		const reviewStore = createReviewStore(join(overstoryDir, "reviews.db"));
		try {
			const latest = reviewStore.getLatest("mission", mission.id);
			expect(latest?.id).toBe(generated.record.id);
		} finally {
			reviewStore.close();
		}
	});
});
