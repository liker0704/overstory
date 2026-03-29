/**
 * Tests for EvalRecommendationSource.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EvalResult } from "../eval/types.ts";
import { createEvalSource } from "./eval-source.ts";
import { computeScore } from "./score.ts";
import type { HealthSignals } from "./types.ts";

/** Build a HealthSignals object with all-healthy defaults. */
function healthySignals(overrides: Partial<HealthSignals> = {}): HealthSignals {
	return {
		totalActiveSessions: 4,
		stalledSessions: 0,
		zombieSessions: 0,
		bootingSessions: 0,
		workingSessions: 4,
		runtimeSwapCount: 0,
		totalSessionsRecorded: 10,
		completedSessionsRecorded: 10,
		mergeSuccessCount: 5,
		mergeTotalCount: 5,
		averageDurationMs: 60_000,
		costPerCompletedTask: 0.1,
		doctorFailCount: 0,
		doctorWarnCount: 0,
		completionRate: 1.0,
		stalledRate: 0.0,
		mergeSuccessRate: 1.0,
		openBreakerCount: 0,
		activeRetryCount: 0,
		recentRerouteCount: 0,
		lowestHeadroomPercent: null,
		criticalHeadroomCount: 0,
		activeMissionCount: 0,
		architectureMdExists: false,
		testPlanExists: false,
		holdoutChecksFailed: 0,
		collectedAt: new Date().toISOString(),
		...overrides,
	};
}

/** Write a summary.json into a run directory inside tempDir/eval-runs/<runId>/. */
function writeEvalRun(tempDir: string, runId: string, result: Partial<EvalResult>): void {
	const runDir = path.join(tempDir, "eval-runs", runId);
	mkdirSync(runDir, { recursive: true });
	const full: EvalResult = {
		runId,
		scenarioName: "test-scenario",
		scenarioPath: "/tmp/scenario",
		startedAt: new Date().toISOString(),
		completedAt: new Date().toISOString(),
		durationMs: 10_000,
		metrics: {
			totalAgents: 4,
			completedAgents: 4,
			zombieCount: 0,
			stallCount: 0,
			stallRate: 0,
			mergeSuccessCount: 4,
			mergeConflictCount: 0,
			mergeQueuePending: 0,
			tasksCompleted: 4,
			durationMs: 10_000,
			totalInputTokens: 1000,
			totalOutputTokens: 500,
			estimatedCostUsd: 0.05,
			nudgesSent: 0,
			runtimeSwaps: 0,
			medianSessionDurationMs: 2500,
		},
		assertions: [],
		passed: true,
		timedOut: false,
		...result,
	};
	writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(full, null, 2));
}

describe("createEvalSource", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "eval-source-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns empty array when eval-runs dir does not exist", () => {
		const source = createEvalSource(tempDir);
		const score = computeScore(healthySignals());
		expect(source.collect(score)).toEqual([]);
	});

	it("returns empty array when no eval runs exist", () => {
		mkdirSync(path.join(tempDir, "eval-runs"));
		const source = createEvalSource(tempDir);
		const score = computeScore(healthySignals());
		expect(source.collect(score)).toEqual([]);
	});

	it("returns eval_assertions recommendation when assertions fail", () => {
		writeEvalRun(tempDir, "run-001", {
			passed: false,
			assertions: [
				{
					assertion: { kind: "no_zombies", expected: 0 },
					passed: false,
					actual: 2,
					message: "2 zombies detected",
				},
			],
		});

		const source = createEvalSource(tempDir);
		const score = computeScore(healthySignals());
		const recs = source.collect(score);

		const rec = recs.find((r) => r.factor === "eval_assertions");
		expect(rec).toBeDefined();
		expect(rec?.priority).toBe("high");
		expect(rec?.source).toBe("eval-results");
		expect(rec?.sourceArtifact).toBe("run-001");
	});

	it("returns eval_stall_rate when stallRate > 0.2", () => {
		writeEvalRun(tempDir, "run-002", {
			metrics: {
				totalAgents: 4,
				completedAgents: 3,
				zombieCount: 0,
				stallCount: 2,
				stallRate: 0.5,
				mergeSuccessCount: 3,
				mergeConflictCount: 0,
				mergeQueuePending: 0,
				tasksCompleted: 3,
				durationMs: 10_000,
				totalInputTokens: 1000,
				totalOutputTokens: 500,
				estimatedCostUsd: 0.05,
				nudgesSent: 2,
				runtimeSwaps: 0,
				medianSessionDurationMs: 2500,
			},
		});

		const source = createEvalSource(tempDir);
		const score = computeScore(healthySignals());
		const recs = source.collect(score);

		const rec = recs.find((r) => r.factor === "eval_stall_rate");
		expect(rec).toBeDefined();
		expect(rec?.priority).toBe("medium");
		expect(rec?.source).toBe("eval-results");
		expect(rec?.sourceArtifact).toBe("run-002");
	});

	it("returns eval_timeout when timedOut is true", () => {
		writeEvalRun(tempDir, "run-003", { timedOut: true, passed: false });

		const source = createEvalSource(tempDir);
		const score = computeScore(healthySignals());
		const recs = source.collect(score);

		const rec = recs.find((r) => r.factor === "eval_timeout");
		expect(rec).toBeDefined();
		expect(rec?.priority).toBe("high");
		expect(rec?.source).toBe("eval-results");
		expect(rec?.sourceArtifact).toBe("run-003");
	});

	it("returns eval_merge_conflicts when mergeConflictCount > 0", () => {
		writeEvalRun(tempDir, "run-004", {
			metrics: {
				totalAgents: 4,
				completedAgents: 4,
				zombieCount: 0,
				stallCount: 0,
				stallRate: 0,
				mergeSuccessCount: 2,
				mergeConflictCount: 3,
				mergeQueuePending: 0,
				tasksCompleted: 4,
				durationMs: 10_000,
				totalInputTokens: 1000,
				totalOutputTokens: 500,
				estimatedCostUsd: 0.05,
				nudgesSent: 0,
				runtimeSwaps: 0,
				medianSessionDurationMs: 2500,
			},
		});

		const source = createEvalSource(tempDir);
		const score = computeScore(healthySignals());
		const recs = source.collect(score);

		const rec = recs.find((r) => r.factor === "eval_merge_conflicts");
		expect(rec).toBeDefined();
		expect(rec?.priority).toBe("medium");
		expect(rec?.source).toBe("eval-results");
		expect(rec?.sourceArtifact).toBe("run-004");
	});

	it("all recommendations have source = eval-results and sourceArtifact = runId", () => {
		writeEvalRun(tempDir, "run-005", {
			passed: false,
			timedOut: true,
			assertions: [
				{
					assertion: { kind: "tasks_completed", expected: 4 },
					passed: false,
					actual: 2,
					message: "only 2 tasks completed",
				},
			],
		});

		const source = createEvalSource(tempDir);
		const score = computeScore(healthySignals());
		const recs = source.collect(score);

		expect(recs.length).toBeGreaterThan(0);
		for (const rec of recs) {
			expect(rec.source).toBe("eval-results");
			expect(rec.sourceArtifact).toBe("run-005");
		}
	});

	it("picks the most recent run when multiple runs exist", () => {
		writeEvalRun(tempDir, "run-001", { passed: true });
		writeEvalRun(tempDir, "run-002", {
			passed: false,
			timedOut: true,
		});

		const source = createEvalSource(tempDir);
		const score = computeScore(healthySignals());
		const recs = source.collect(score);

		// Should read run-002 (alphabetically last), which has timedOut=true
		const rec = recs.find((r) => r.factor === "eval_timeout");
		expect(rec).toBeDefined();
		expect(rec?.sourceArtifact).toBe("run-002");
	});
});
