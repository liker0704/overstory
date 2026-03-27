import { describe, expect, test } from "bun:test";
import {
	formatBuilderTddOverlay,
	formatLeadTddOverlay,
	formatReviewerTddOverlay,
	formatTddOverlay,
} from "./tdd.ts";

describe("formatBuilderTddOverlay", () => {
	test("full mode includes read-only constraint", () => {
		const result = formatBuilderTddOverlay("full");
		expect(result).toContain("READ-ONLY");
	});

	test("full mode includes TEST_FILE_MODIFICATION failure mode", () => {
		const result = formatBuilderTddOverlay("full");
		expect(result).toContain("TEST_FILE_MODIFICATION");
	});

	test("full mode includes test plan path when provided", () => {
		const result = formatBuilderTddOverlay("full", ".overstory/specs/test-plan.md");
		expect(result).toContain(".overstory/specs/test-plan.md");
	});

	test("full mode includes architecture path when provided", () => {
		const result = formatBuilderTddOverlay("full", undefined, ".overstory/specs/arch.md");
		expect(result).toContain(".overstory/specs/arch.md");
	});

	test("full mode omits test plan section when path undefined", () => {
		const result = formatBuilderTddOverlay("full");
		expect(result).not.toContain("Test Plan");
	});

	test("light mode includes test plan reference", () => {
		const result = formatBuilderTddOverlay("light", ".overstory/specs/test-plan.md");
		expect(result).toContain(".overstory/specs/test-plan.md");
	});

	test("light mode does not include read-only constraint", () => {
		const result = formatBuilderTddOverlay("light");
		expect(result).not.toContain("READ-ONLY");
	});

	test("skip mode returns empty string", () => {
		const result = formatBuilderTddOverlay("skip");
		expect(result).toBe("");
	});

	test("refactor mode includes behavior-unchanged constraint", () => {
		const result = formatBuilderTddOverlay("refactor");
		expect(result).toContain("unchanged");
	});

	test("refactor mode includes BEHAVIOR_CHANGE failure mode", () => {
		const result = formatBuilderTddOverlay("refactor");
		expect(result).toContain("BEHAVIOR_CHANGE");
	});
});

describe("formatReviewerTddOverlay", () => {
	test("full mode includes git diff test check", () => {
		const result = formatReviewerTddOverlay("full");
		expect(result).toContain("git diff");
	});

	test("full mode includes architecture alignment check", () => {
		const result = formatReviewerTddOverlay("full");
		expect(result).toContain("architecture");
	});

	test("light mode includes architecture alignment only", () => {
		const result = formatReviewerTddOverlay("light");
		expect(result).toContain("architecture");
	});

	test("light mode does not include git diff check", () => {
		const result = formatReviewerTddOverlay("light");
		expect(result).not.toContain("git diff");
	});

	test("skip mode returns empty string", () => {
		const result = formatReviewerTddOverlay("skip");
		expect(result).toBe("");
	});

	test("refactor mode includes test file integrity check", () => {
		const result = formatReviewerTddOverlay("refactor");
		expect(result).toContain("git diff");
		expect(result).toContain("TEST_FILE_MODIFICATION");
	});

	test("refactor mode includes behavior preservation check", () => {
		const result = formatReviewerTddOverlay("refactor");
		expect(result).toContain("Behavior preservation");
	});
});

describe("formatLeadTddOverlay", () => {
	test("full mode includes tester ordering", () => {
		const result = formatLeadTddOverlay("full");
		expect(result).toContain("tester");
		expect(result).toContain("BEFORE builders");
	});

	test("full mode includes TDD_ORDER_VIOLATION", () => {
		const result = formatLeadTddOverlay("full");
		expect(result).toContain("TDD_ORDER_VIOLATION");
	});

	test("light mode returns empty string", () => {
		const result = formatLeadTddOverlay("light");
		expect(result).toBe("");
	});

	test("skip mode returns empty string", () => {
		const result = formatLeadTddOverlay("skip");
		expect(result).toBe("");
	});

	test("refactor mode returns empty string", () => {
		const result = formatLeadTddOverlay("refactor");
		expect(result).toBe("");
	});
});

describe("formatTddOverlay", () => {
	test("undefined tddMode returns empty string", () => {
		const result = formatTddOverlay("builder", undefined);
		expect(result).toBe("");
	});

	test("dispatches to builder formatter for capability 'builder'", () => {
		const result = formatTddOverlay("builder", "full");
		expect(result).toContain("TDD Mode: Full");
		expect(result).toContain("READ-ONLY");
	});

	test("dispatches to reviewer formatter for capability 'reviewer'", () => {
		const result = formatTddOverlay("reviewer", "full");
		expect(result).toContain("TDD Review Checks");
		expect(result).toContain("git diff");
	});

	test("dispatches to lead formatter for capability 'lead'", () => {
		const result = formatTddOverlay("lead", "full");
		expect(result).toContain("TDD Orchestration");
	});

	test("dispatches to lead formatter for capability 'lead-mission'", () => {
		const result = formatTddOverlay("lead-mission", "full");
		expect(result).toContain("TDD Orchestration");
	});

	test("returns empty string for unknown capability like 'scout'", () => {
		const result = formatTddOverlay("scout", "full");
		expect(result).toBe("");
	});
});
