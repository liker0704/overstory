/**
 * Tests for review dimension constants and scoring helpers.
 */

import { describe, expect, it } from "bun:test";
import {
	computeOverallScore,
	REVIEW_DIMENSIONS,
	scorePresence,
	scoreTextQuality,
} from "./dimensions.ts";

describe("REVIEW_DIMENSIONS", () => {
	it("has exactly 6 entries", () => {
		expect(REVIEW_DIMENSIONS).toHaveLength(6);
	});

	it("contains all expected dimension keys", () => {
		const keys = REVIEW_DIMENSIONS.map((d) => d.key);
		expect(keys).toContain("clarity");
		expect(keys).toContain("actionability");
		expect(keys).toContain("completeness");
		expect(keys).toContain("signal-to-noise");
		expect(keys).toContain("correctness-confidence");
		expect(keys).toContain("coordination-fit");
	});

	it("each entry has key, label, and description", () => {
		for (const dim of REVIEW_DIMENSIONS) {
			expect(dim.key).toBeTruthy();
			expect(dim.label).toBeTruthy();
			expect(dim.description).toBeTruthy();
		}
	});
});

describe("scorePresence", () => {
	it("returns 60 for scorePresence(3, 5)", () => {
		expect(scorePresence(3, 5)).toBe(60);
	});

	it("returns 100 for scorePresence(0, 0)", () => {
		expect(scorePresence(0, 0)).toBe(100);
	});

	it("returns 100 for full presence", () => {
		expect(scorePresence(5, 5)).toBe(100);
	});

	it("returns 0 for scorePresence(0, 5)", () => {
		expect(scorePresence(0, 5)).toBe(0);
	});

	it("rounds fractional scores", () => {
		// 1/3 = 33.33... -> rounds to 33
		expect(scorePresence(1, 3)).toBe(33);
	});

	it("clamps to 100 max", () => {
		expect(scorePresence(10, 5)).toBe(100);
	});
});

describe("scoreTextQuality", () => {
	it("returns 0 for empty string", () => {
		expect(scoreTextQuality("")).toBe(0);
	});

	it("returns > 0 for non-empty text", () => {
		expect(scoreTextQuality("hello")).toBeGreaterThan(0);
	});

	it("awards points for length > 0", () => {
		// Single char: length > 0 (20pts), no excessive rep (10pts) = 30
		expect(scoreTextQuality("x")).toBe(30);
	});

	it("awards extra points for length > 50", () => {
		const text = "a".repeat(51);
		// length>0 (20) + length>50 (10) + no excessive rep... wait, 'a' repeated 51 times
		// 'a' is only 1 char, not 4+, so freq won't trigger. no rep (10) = 40
		expect(scoreTextQuality(text)).toBe(40);
	});

	it("awards points for list markers", () => {
		const text = "Items:\n- first item\n- second item";
		// length>0 (20) + length>50 check fails (32 chars) + list markers (15) + multiple lines (10) + no rep (10) = 55
		expect(scoreTextQuality(text)).toBeGreaterThanOrEqual(55);
	});

	it("awards points for section headers", () => {
		const text = "## Section\nsome content here";
		// length>0 (20) + no >50 + no list + headers (15) + multiple lines (10) + no rep (10) = 55
		expect(scoreTextQuality(text)).toBeGreaterThanOrEqual(55);
	});

	it("awards points for concrete refs (file paths)", () => {
		const text = "See src/review/types.ts for details";
		// length>0 (20) + no >50 + no list + no header + no newline + no rep (10) + concrete refs (20) = 50
		expect(scoreTextQuality(text)).toBeGreaterThanOrEqual(50);
	});

	it("caps score at 100", () => {
		const text = [
			"## Overview",
			"This is a detailed spec with many useful sections.",
			"- Item one",
			"- Item two",
			"See src/review/types.ts and src/review/dimensions.ts for the implementation.",
			"Additional context and `code` references.",
		].join("\n");
		expect(scoreTextQuality(text)).toBeLessThanOrEqual(100);
	});
});

describe("computeOverallScore", () => {
	it("returns 0 for empty array", () => {
		expect(computeOverallScore([])).toBe(0);
	});

	it("returns the score for a single dimension", () => {
		expect(computeOverallScore([{ dimension: "clarity", score: 80, details: "ok" }])).toBe(80);
	});

	it("returns average of multiple dimensions", () => {
		expect(
			computeOverallScore([
				{ dimension: "clarity", score: 60, details: "ok" },
				{ dimension: "actionability", score: 80, details: "ok" },
				{ dimension: "completeness", score: 100, details: "ok" },
			]),
		).toBe(80);
	});

	it("rounds fractional averages", () => {
		expect(
			computeOverallScore([
				{ dimension: "clarity", score: 0, details: "ok" },
				{ dimension: "actionability", score: 1, details: "ok" },
			]),
		).toBe(1); // Math.round(0.5) = 1
	});
});
