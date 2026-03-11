/**
 * Compile-time and structural tests for review types.
 *
 * These tests verify that the types are correctly defined and can be
 * instantiated as expected. No mocks needed — all types are pure TS.
 */

import { describe, expect, it } from "bun:test";
import type {
	DimensionScore,
	InsertReviewRecord,
	ReviewDimension,
	ReviewRecord,
	ReviewSubjectType,
	ReviewSummary,
	StalenessState,
} from "./types.ts";

describe("ReviewDimension", () => {
	it("accepts all six valid dimension values", () => {
		const dimensions: ReviewDimension[] = [
			"clarity",
			"actionability",
			"completeness",
			"signal-to-noise",
			"correctness-confidence",
			"coordination-fit",
		];
		expect(dimensions).toHaveLength(6);
	});
});

describe("ReviewSubjectType", () => {
	it("accepts all three valid subject types", () => {
		const types: ReviewSubjectType[] = ["session", "handoff", "spec"];
		expect(types).toHaveLength(3);
	});
});

describe("DimensionScore", () => {
	it("can be constructed with required fields", () => {
		const score: DimensionScore = {
			dimension: "clarity",
			score: 80,
			details: "Well structured with clear headings",
		};
		expect(score.dimension).toBe("clarity");
		expect(score.score).toBe(80);
		expect(score.details).toBe("Well structured with clear headings");
	});
});

describe("ReviewRecord", () => {
	it("can be constructed with required fields", () => {
		const record: ReviewRecord = {
			id: "abc-123",
			subjectType: "spec",
			subjectId: "overstory-4bd6",
			timestamp: "2026-03-11T00:00:00.000Z",
			dimensions: [
				{ dimension: "clarity", score: 90, details: "Clear" },
				{ dimension: "actionability", score: 85, details: "Actionable" },
			],
			overallScore: 87,
			notes: ["Looks good"],
			reviewerSource: "deterministic",
			stale: false,
			staleSince: null,
			staleReason: null,
		};
		expect(record.reviewerSource).toBe("deterministic");
		expect(record.stale).toBe(false);
		expect(record.staleSince).toBeNull();
		expect(record.staleReason).toBeNull();
	});

	it("supports stale state", () => {
		const record: ReviewRecord = {
			id: "def-456",
			subjectType: "session",
			subjectId: "builder-agent",
			timestamp: "2026-03-10T00:00:00.000Z",
			dimensions: [],
			overallScore: 0,
			notes: [],
			reviewerSource: "deterministic",
			stale: true,
			staleSince: "2026-03-11T00:00:00.000Z",
			staleReason: "Subject files modified since review",
		};
		expect(record.stale).toBe(true);
		expect(record.staleSince).toBe("2026-03-11T00:00:00.000Z");
		expect(record.staleReason).toBe("Subject files modified since review");
	});
});

describe("StalenessState", () => {
	it("can be constructed with file hashes", () => {
		const state: StalenessState = {
			fileHashes: {
				"src/review/types.ts": "abc123def456",
				"src/review/dimensions.ts": "789abc012def",
			},
			capturedAt: "2026-03-11T00:00:00.000Z",
		};
		expect(Object.keys(state.fileHashes)).toHaveLength(2);
		expect(state.fileHashes["src/review/types.ts"]).toBe("abc123def456");
	});
});

describe("ReviewSummary", () => {
	it("can be constructed with required fields", () => {
		const summary: ReviewSummary = {
			subjectType: "spec",
			totalReviewed: 5,
			averageScore: 78,
			staleCount: 1,
			recentReviews: [],
		};
		expect(summary.totalReviewed).toBe(5);
		expect(summary.staleCount).toBe(1);
	});
});

describe("InsertReviewRecord", () => {
	it("can be constructed without id and timestamp", () => {
		const insert: InsertReviewRecord = {
			subjectType: "handoff",
			subjectId: "handoff-001",
			dimensions: [{ dimension: "completeness", score: 70, details: "Missing some fields" }],
			overallScore: 70,
			notes: [],
			reviewerSource: "deterministic",
		};
		expect(insert.reviewerSource).toBe("deterministic");
		expect(insert.dimensions).toHaveLength(1);
	});
});
