/**
 * Tests for mission score computation (pure function only).
 *
 * Uses computeMissionScoreFromSignals() to avoid filesystem dependencies.
 */

import { describe, expect, test } from "bun:test";
import { computeMissionScoreFromSignals } from "./score.ts";
import type { MissionScoreSignals } from "./score.ts";

const DEFAULT_SIGNALS: MissionScoreSignals = {
	phase: "understand",
	totalEvents: 0,
	errorEvents: 0,
	totalSessions: 0,
	completedSessions: 0,
	reviewScore: null,
	bundleFileCount: 0,
	expectedBundleFiles: 7,
};

describe("computeMissionScoreFromSignals", () => {
	test("default signals (phase=understand, empty): grade C, overall ~56", () => {
		// execution_progress: 10*0.30 = 3
		// error_rate: 100*0.25 = 25
		// session_completion: 100*0.20 = 20
		// review_quality: 50*0.15 = 7.5
		// artifact_completeness: 0*0.10 = 0
		// total = 55.5 -> rounds to 56
		const result = computeMissionScoreFromSignals(DEFAULT_SIGNALS);
		expect(result.overall).toBe(56);
		expect(result.grade).toBe("C");
		expect(result.factors).toHaveLength(5);
	});

	test("all perfect signals (phase=done, no errors, all sessions complete, review=95, 7/7 files): grade A", () => {
		const signals: MissionScoreSignals = {
			phase: "done",
			totalEvents: 100,
			errorEvents: 0,
			totalSessions: 10,
			completedSessions: 10,
			reviewScore: 95,
			bundleFileCount: 7,
			expectedBundleFiles: 7,
		};
		const result = computeMissionScoreFromSignals(signals);
		// execution_progress: 100*0.30 = 30
		// error_rate: 100*0.25 = 25
		// session_completion: 100*0.20 = 20
		// review_quality: 95*0.15 = 14.25
		// artifact_completeness: 100*0.10 = 10
		// total = 99.25 -> rounds to 99
		expect(result.overall).toBe(99);
		expect(result.grade).toBe("A");
	});

	test("high error rate (50/100 errors): error_rate score = 0", () => {
		const signals: MissionScoreSignals = {
			...DEFAULT_SIGNALS,
			phase: "execute",
			totalEvents: 100,
			errorEvents: 50,
		};
		const result = computeMissionScoreFromSignals(signals);
		const errorFactor = result.factors.find((f) => f.name === "error_rate");
		expect(errorFactor).toBeDefined();
		expect(errorFactor!.score).toBe(0);
	});

	test("error rate at 5% (half threshold): error_rate score = 50", () => {
		const signals: MissionScoreSignals = {
			...DEFAULT_SIGNALS,
			totalEvents: 100,
			errorEvents: 5,
		};
		const result = computeMissionScoreFromSignals(signals);
		const errorFactor = result.factors.find((f) => f.name === "error_rate");
		expect(errorFactor).toBeDefined();
		expect(errorFactor!.score).toBe(50);
	});

	test("grade A boundary: overall >= 85", () => {
		const signals: MissionScoreSignals = {
			phase: "done",
			totalEvents: 10,
			errorEvents: 0,
			totalSessions: 5,
			completedSessions: 5,
			reviewScore: 90,
			bundleFileCount: 7,
			expectedBundleFiles: 7,
		};
		const result = computeMissionScoreFromSignals(signals);
		expect(result.overall).toBeGreaterThanOrEqual(85);
		expect(result.grade).toBe("A");
	});

	test("grade B boundary: overall >= 70 and < 85", () => {
		// execution_progress=75 (execute)*0.30=22.5
		// error_rate=100*0.25=25
		// session_completion=100*0.20=20
		// review_quality=50*0.15=7.5 (no review)
		// artifact_completeness=100*0.10=10
		// total=85 -> grade A... let me try a weaker scenario
		const signals: MissionScoreSignals = {
			phase: "plan",
			totalEvents: 0,
			errorEvents: 0,
			totalSessions: 0,
			completedSessions: 0,
			reviewScore: 70,
			bundleFileCount: 7,
			expectedBundleFiles: 7,
		};
		// execution_progress: 55*0.30=16.5
		// error_rate: 100*0.25=25
		// session_completion: 100*0.20=20
		// review_quality: 70*0.15=10.5
		// artifact_completeness: 100*0.10=10
		// total=82 -> B
		const result = computeMissionScoreFromSignals(signals);
		expect(result.overall).toBeGreaterThanOrEqual(70);
		expect(result.overall).toBeLessThan(85);
		expect(result.grade).toBe("B");
	});

	test("grade F boundary: overall < 40", () => {
		const signals: MissionScoreSignals = {
			phase: "understand",
			totalEvents: 100,
			errorEvents: 100,
			totalSessions: 10,
			completedSessions: 0,
			reviewScore: 0,
			bundleFileCount: 0,
			expectedBundleFiles: 7,
		};
		// execution_progress: 10*0.30=3
		// error_rate: 0*0.25=0
		// session_completion: 0*0.20=0
		// review_quality: 0*0.15=0
		// artifact_completeness: 0*0.10=0
		// total=3 -> F
		const result = computeMissionScoreFromSignals(signals);
		expect(result.overall).toBeLessThan(40);
		expect(result.grade).toBe("F");
	});

	test("partial session completion", () => {
		const signals: MissionScoreSignals = {
			...DEFAULT_SIGNALS,
			totalSessions: 4,
			completedSessions: 3,
		};
		const result = computeMissionScoreFromSignals(signals);
		const sessionFactor = result.factors.find((f) => f.name === "session_completion");
		expect(sessionFactor).toBeDefined();
		expect(sessionFactor!.score).toBe(75);
	});

	test("review score is used when available", () => {
		const signals: MissionScoreSignals = {
			...DEFAULT_SIGNALS,
			reviewScore: 80,
		};
		const result = computeMissionScoreFromSignals(signals);
		const reviewFactor = result.factors.find((f) => f.name === "review_quality");
		expect(reviewFactor).toBeDefined();
		expect(reviewFactor!.score).toBe(80);
	});

	test("collectedAt is a valid ISO timestamp", () => {
		const result = computeMissionScoreFromSignals(DEFAULT_SIGNALS);
		expect(() => new Date(result.collectedAt)).not.toThrow();
		expect(new Date(result.collectedAt).getTime()).toBeGreaterThan(0);
	});

	test("contributions sum approximately to overall", () => {
		const result = computeMissionScoreFromSignals(DEFAULT_SIGNALS);
		const sum = result.factors.reduce((acc, f) => acc + f.contribution, 0);
		expect(Math.abs(Math.round(sum) - result.overall)).toBeLessThanOrEqual(1);
	});
});
