import { describe, expect, test } from "bun:test";
import type { ArtifactStalenessResult } from "../missions/artifact-staleness.ts";
import { classifyMissionArtifact, classifyReviewRecord, classifySpecMeta } from "./classify.ts";

const baseResult: ArtifactStalenessResult = {
	artifactType: "brief",
	isStale: false,
	changedDependencies: [],
	missingDependencies: [],
	currentHashes: {},
	storedHashes: null,
};

describe("classifyMissionArtifact", () => {
	test("fresh when not stale", () => {
		expect(classifyMissionArtifact({ ...baseResult, isStale: false })).toBe("fresh");
	});

	test("stale when stale", () => {
		expect(classifyMissionArtifact({ ...baseResult, isStale: true })).toBe("stale");
	});

	test("fresh even with missing deps (not stale)", () => {
		expect(
			classifyMissionArtifact({
				...baseResult,
				isStale: false,
				missingDependencies: ["some-file.md"],
			}),
		).toBe("fresh");
	});
});

describe("classifyReviewRecord", () => {
	test("null -> unscored", () => {
		expect(classifyReviewRecord(null)).toBe("unscored");
	});

	test("stale -> stale", () => {
		expect(classifyReviewRecord({ stale: true, overallScore: 90 })).toBe("stale");
	});

	test("low score -> under-target", () => {
		expect(classifyReviewRecord({ stale: false, overallScore: 50 })).toBe("under-target");
	});

	test("good score -> fresh", () => {
		expect(classifyReviewRecord({ stale: false, overallScore: 85 })).toBe("fresh");
	});

	test("boundary: score exactly 70 -> fresh", () => {
		expect(classifyReviewRecord({ stale: false, overallScore: 70 })).toBe("fresh");
	});

	test("boundary: score 69 -> under-target", () => {
		expect(classifyReviewRecord({ stale: false, overallScore: 69 })).toBe("under-target");
	});

	test("custom threshold", () => {
		expect(classifyReviewRecord({ stale: false, overallScore: 80 }, 90)).toBe("under-target");
		expect(classifyReviewRecord({ stale: false, overallScore: 90 }, 90)).toBe("fresh");
	});

	test("stale takes precedence over low score", () => {
		expect(classifyReviewRecord({ stale: true, overallScore: 0 })).toBe("stale");
	});

	test("zero score -> under-target", () => {
		expect(classifyReviewRecord({ stale: false, overallScore: 0 })).toBe("under-target");
	});
});

describe("classifySpecMeta", () => {
	test("null -> unscored", () => {
		expect(classifySpecMeta(null)).toBe("unscored");
	});

	test("current -> fresh", () => {
		expect(classifySpecMeta({ status: "current" })).toBe("fresh");
	});

	test("stale -> stale", () => {
		expect(classifySpecMeta({ status: "stale" })).toBe("stale");
	});

	test("superseded -> superseded", () => {
		expect(classifySpecMeta({ status: "superseded" })).toBe("superseded");
	});
});
