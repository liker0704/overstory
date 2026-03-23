/**
 * Tests for ReviewRecommendationSource.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createReviewStore } from "../review/store.ts";
import { createReviewSource } from "./review-source.ts";
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
		collectedAt: new Date().toISOString(),
		...overrides,
	};
}

describe("createReviewSource", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "review-source-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns empty array when reviews.db does not exist", () => {
		const source = createReviewSource(tempDir);
		const score = computeScore(healthySignals());
		const recs = source.collect(score);
		expect(recs).toEqual([]);
	});

	it("returns review_coverage recommendation when no reviews exist in DB", () => {
		// Create empty reviews.db
		const store = createReviewStore(path.join(tempDir, "reviews.db"));
		store.close();

		const source = createReviewSource(tempDir);
		const score = computeScore(healthySignals());
		const recs = source.collect(score);

		const coverage = recs.find((r) => r.factor === "review_coverage");
		expect(coverage).toBeDefined();
		expect(coverage?.priority).toBe("medium");
		expect(coverage?.source).toBe("review-quality");
		expect(coverage?.sourceArtifact).toBe("none");
	});

	it("returns review_session_quality when session avg score < 60", () => {
		const store = createReviewStore(path.join(tempDir, "reviews.db"));
		// Insert a low-scoring session review
		store.insert({
			subjectType: "session",
			subjectId: "agent-1",
			dimensions: [
				{ dimension: "clarity", score: 40, details: "unclear" },
				{ dimension: "actionability", score: 40, details: "vague" },
				{ dimension: "completeness", score: 40, details: "incomplete" },
				{ dimension: "signal-to-noise", score: 40, details: "noisy" },
				{ dimension: "correctness-confidence", score: 40, details: "uncertain" },
				{ dimension: "coordination-fit", score: 40, details: "misaligned" },
			],
			overallScore: 40,
			notes: [],
			reviewerSource: "deterministic",
		});
		store.close();

		const source = createReviewSource(tempDir);
		const score = computeScore(healthySignals());
		const recs = source.collect(score);

		const rec = recs.find((r) => r.factor === "review_session_quality");
		expect(rec).toBeDefined();
		expect(rec?.priority).toBe("high");
		expect(rec?.source).toBe("review-quality");
		expect(rec?.sourceArtifact).toBe("session");
	});

	it("returns review_spec_quality when spec avg score < 60", () => {
		const store = createReviewStore(path.join(tempDir, "reviews.db"));
		store.insert({
			subjectType: "spec",
			subjectId: "overstory-1234",
			dimensions: [
				{ dimension: "clarity", score: 30, details: "very unclear" },
				{ dimension: "actionability", score: 30, details: "not actionable" },
				{ dimension: "completeness", score: 30, details: "very incomplete" },
				{ dimension: "signal-to-noise", score: 30, details: "very noisy" },
				{ dimension: "correctness-confidence", score: 30, details: "very uncertain" },
				{ dimension: "coordination-fit", score: 30, details: "very misaligned" },
			],
			overallScore: 30,
			notes: [],
			reviewerSource: "deterministic",
		});
		store.close();

		const source = createReviewSource(tempDir);
		const score = computeScore(healthySignals());
		const recs = source.collect(score);

		const rec = recs.find((r) => r.factor === "review_spec_quality");
		expect(rec).toBeDefined();
		expect(rec?.priority).toBe("high");
		expect(rec?.source).toBe("review-quality");
		expect(rec?.sourceArtifact).toBe("spec");
	});

	it("returns review_staleness when > 50% stale", () => {
		const store = createReviewStore(path.join(tempDir, "reviews.db"));
		// Insert 3 session reviews: 2 stale, 1 fresh → >50% stale
		for (let i = 0; i < 3; i++) {
			store.insert({
				subjectType: "session",
				subjectId: `agent-${i}`,
				dimensions: [
					{ dimension: "clarity", score: 80, details: "clear" },
					{ dimension: "actionability", score: 80, details: "actionable" },
					{ dimension: "completeness", score: 80, details: "complete" },
					{ dimension: "signal-to-noise", score: 80, details: "clean" },
					{ dimension: "correctness-confidence", score: 80, details: "confident" },
					{ dimension: "coordination-fit", score: 80, details: "aligned" },
				],
				overallScore: 80,
				notes: [],
				reviewerSource: "deterministic",
			});
		}
		// Mark 2 as stale
		store.markStale("session", "test staleness");
		store.close();

		const source = createReviewSource(tempDir);
		const score = computeScore(healthySignals());
		const recs = source.collect(score);

		const rec = recs.find((r) => r.factor === "review_staleness");
		expect(rec).toBeDefined();
		expect(rec?.priority).toBe("medium");
		expect(rec?.source).toBe("review-quality");
		expect(rec?.sourceArtifact).toBeDefined();
	});

	it("returns review_coordination when coordination-fit avg < 50", () => {
		const store = createReviewStore(path.join(tempDir, "reviews.db"));
		store.insert({
			subjectType: "session",
			subjectId: "agent-1",
			dimensions: [
				{ dimension: "clarity", score: 80, details: "clear" },
				{ dimension: "actionability", score: 80, details: "actionable" },
				{ dimension: "completeness", score: 80, details: "complete" },
				{ dimension: "signal-to-noise", score: 80, details: "clean" },
				{ dimension: "correctness-confidence", score: 80, details: "confident" },
				{ dimension: "coordination-fit", score: 30, details: "poor coordination" },
			],
			overallScore: 72,
			notes: [],
			reviewerSource: "deterministic",
		});
		store.close();

		const source = createReviewSource(tempDir);
		const score = computeScore(healthySignals());
		const recs = source.collect(score);

		const rec = recs.find((r) => r.factor === "review_coordination");
		expect(rec).toBeDefined();
		expect(rec?.priority).toBe("medium");
		expect(rec?.source).toBe("review-quality");
		expect(rec?.sourceArtifact).toBe("session");
	});

	it("all recommendations have source = review-quality and sourceArtifact set", () => {
		const store = createReviewStore(path.join(tempDir, "reviews.db"));
		// Insert low session score to trigger recommendation
		store.insert({
			subjectType: "session",
			subjectId: "agent-1",
			dimensions: [
				{ dimension: "clarity", score: 40, details: "unclear" },
				{ dimension: "actionability", score: 40, details: "vague" },
				{ dimension: "completeness", score: 40, details: "incomplete" },
				{ dimension: "signal-to-noise", score: 40, details: "noisy" },
				{ dimension: "correctness-confidence", score: 40, details: "uncertain" },
				{ dimension: "coordination-fit", score: 40, details: "misaligned" },
			],
			overallScore: 40,
			notes: [],
			reviewerSource: "deterministic",
		});
		store.close();

		const source = createReviewSource(tempDir);
		const score = computeScore(healthySignals());
		const recs = source.collect(score);

		for (const rec of recs) {
			expect(rec.source).toBe("review-quality");
			expect(rec.sourceArtifact).toBeDefined();
			expect(rec.sourceArtifact).not.toBe("");
		}
	});
});
