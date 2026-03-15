import { describe, expect, test } from "bun:test";
import type { PlanCriticVerdictPayload } from "../types.ts";
import {
	computeConfidence,
	criticsToRerun,
	detectStuck,
	extractBlockingConcernIds,
} from "./plan-review.ts";

// --- detectStuck ---

describe("detectStuck", () => {
	test("returns false when no overlap", () => {
		expect(detectStuck(["a", "b"], ["c", "d"])).toBe(false);
	});

	test("returns true when any overlap", () => {
		expect(detectStuck(["a", "b"], ["b", "c"])).toBe(true);
	});

	test("returns false when both arrays are empty", () => {
		expect(detectStuck([], [])).toBe(false);
	});

	test("returns false when current is empty", () => {
		expect(detectStuck([], ["a", "b"])).toBe(false);
	});

	test("returns false when previous is empty", () => {
		expect(detectStuck(["a", "b"], [])).toBe(false);
	});

	test("returns true when identical", () => {
		expect(detectStuck(["a", "b"], ["a", "b"])).toBe(true);
	});
});

// --- computeConfidence ---

describe("computeConfidence", () => {
	const makeVerdict = (
		verdict: PlanCriticVerdictPayload["verdict"],
		concerns: PlanCriticVerdictPayload["concerns"] = [],
	): PlanCriticVerdictPayload => ({
		criticType: "devil-advocate",
		verdict,
		concerns,
		notes: [],
		round: 1,
		confidence: 0.8,
	});

	test("returns 0 for empty verdicts", () => {
		expect(computeConfidence([], 1)).toBe(0);
	});

	test("returns high confidence for all APPROVE, round 1, no concerns", () => {
		const verdicts = [makeVerdict("APPROVE"), makeVerdict("APPROVE")];
		const score = computeConfidence(verdicts, 1);
		expect(score).toBeGreaterThan(0.8);
		expect(score).toBeLessThanOrEqual(1.0);
	});

	test("returns lower confidence for later rounds", () => {
		const verdicts = [makeVerdict("APPROVE")];
		const round1 = computeConfidence(verdicts, 1);
		const round3 = computeConfidence(verdicts, 3);
		expect(round1).toBeGreaterThan(round3);
	});

	test("handles round=0 without throwing", () => {
		const verdicts = [makeVerdict("APPROVE")];
		const score = computeConfidence(verdicts, 0);
		expect(score).toBeGreaterThan(0);
		expect(score).toBeLessThanOrEqual(1.0);
	});

	test("lowers confidence when critical concerns exist", () => {
		const clean = [makeVerdict("APPROVE")];
		const withConcerns = [
			makeVerdict("APPROVE_WITH_NOTES", [
				{
					id: "da-01",
					severity: "critical",
					summary: "test",
					detail: "test",
					affectedWorkstreams: [],
				},
			]),
		];
		expect(computeConfidence(clean, 1)).toBeGreaterThan(computeConfidence(withConcerns, 1));
	});

	test("result is always in [0, 1]", () => {
		const verdicts = [
			makeVerdict("BLOCK", [
				{
					id: "x",
					severity: "critical",
					summary: "s",
					detail: "d",
					affectedWorkstreams: ["ws-1", "ws-2", "ws-3"],
				},
			]),
		];
		const score = computeConfidence(verdicts, 10);
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});
});

// --- extractBlockingConcernIds ---

describe("extractBlockingConcernIds", () => {
	const makeVerdict = (
		verdict: PlanCriticVerdictPayload["verdict"],
		concerns: PlanCriticVerdictPayload["concerns"],
	): PlanCriticVerdictPayload => ({
		criticType: "security",
		verdict,
		concerns,
		notes: [],
		round: 1,
		confidence: 0.7,
	});

	test("extracts high/critical concerns from BLOCK verdicts", () => {
		const ids = extractBlockingConcernIds([
			makeVerdict("BLOCK", [
				{ id: "sec-01", severity: "critical", summary: "", detail: "", affectedWorkstreams: [] },
				{ id: "sec-02", severity: "low", summary: "", detail: "", affectedWorkstreams: [] },
			]),
		]);
		expect(ids).toEqual(["sec-01"]);
	});

	test("extracts from RECOMMEND_CHANGES as well", () => {
		const ids = extractBlockingConcernIds([
			makeVerdict("RECOMMEND_CHANGES", [
				{ id: "perf-01", severity: "high", summary: "", detail: "", affectedWorkstreams: [] },
			]),
		]);
		expect(ids).toEqual(["perf-01"]);
	});

	test("ignores APPROVE verdicts", () => {
		const ids = extractBlockingConcernIds([
			makeVerdict("APPROVE", [
				{ id: "da-01", severity: "critical", summary: "", detail: "", affectedWorkstreams: [] },
			]),
		]);
		expect(ids).toEqual([]);
	});

	test("returns empty for no verdicts", () => {
		expect(extractBlockingConcernIds([])).toEqual([]);
	});
});

// --- criticsToRerun ---

describe("criticsToRerun", () => {
	const makeVerdict = (
		criticType: PlanCriticVerdictPayload["criticType"],
		verdict: PlanCriticVerdictPayload["verdict"],
	): PlanCriticVerdictPayload => ({
		criticType,
		verdict,
		concerns: [],
		notes: [],
		round: 1,
		confidence: 0.8,
	});

	test("returns only critics with BLOCK or RECOMMEND_CHANGES", () => {
		const types = criticsToRerun([
			makeVerdict("devil-advocate", "APPROVE"),
			makeVerdict("security", "BLOCK"),
			makeVerdict("performance", "RECOMMEND_CHANGES"),
			makeVerdict("second-opinion", "APPROVE_WITH_NOTES"),
		]);
		expect(types).toContain("security");
		expect(types).toContain("performance");
		expect(types).not.toContain("devil-advocate");
		expect(types).not.toContain("second-opinion");
	});

	test("deduplicates", () => {
		const types = criticsToRerun([
			makeVerdict("security", "BLOCK"),
			makeVerdict("security", "BLOCK"),
		]);
		expect(types).toEqual(["security"]);
	});

	test("returns empty for all APPROVE", () => {
		const types = criticsToRerun([
			makeVerdict("devil-advocate", "APPROVE"),
			makeVerdict("second-opinion", "APPROVE"),
		]);
		expect(types).toEqual([]);
	});
});
