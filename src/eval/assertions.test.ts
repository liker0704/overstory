import { describe, expect, test } from "bun:test";
import { evaluateAssertions } from "./assertions.ts";
import type { Assertion, EvalMetrics } from "./types.ts";

const BASE_METRICS: EvalMetrics = {
	totalAgents: 3,
	completedAgents: 3,
	zombieCount: 0,
	stallCount: 0,
	stallRate: 0,
	mergeSuccessCount: 2,
	mergeConflictCount: 0,
	mergeQueuePending: 0,
	tasksCompleted: 2,
	durationMs: 60_000,
	totalInputTokens: 1000,
	totalOutputTokens: 500,
	estimatedCostUsd: 0.05,
	nudgesSent: 1,
};

describe("evaluateAssertions", () => {
	test("returns empty array for empty assertions", () => {
		expect(evaluateAssertions([], BASE_METRICS)).toEqual([]);
	});

	describe("min_workers_spawned", () => {
		test("passes when totalAgents >= expected", () => {
			const assertions: Assertion[] = [{ kind: "min_workers_spawned", expected: 3 }];
			const [result] = evaluateAssertions(assertions, BASE_METRICS);
			expect(result?.passed).toBe(true);
			expect(result?.actual).toBe(3);
		});

		test("fails when totalAgents < expected", () => {
			const assertions: Assertion[] = [{ kind: "min_workers_spawned", expected: 5 }];
			const [result] = evaluateAssertions(assertions, BASE_METRICS);
			expect(result?.passed).toBe(false);
			expect(result?.actual).toBe(3);
		});
	});

	describe("no_zombies", () => {
		test("passes when zombieCount is 0", () => {
			const assertions: Assertion[] = [{ kind: "no_zombies", expected: true }];
			const [result] = evaluateAssertions(assertions, BASE_METRICS);
			expect(result?.passed).toBe(true);
			expect(result?.actual).toBe(0);
		});

		test("fails when zombieCount > 0", () => {
			const metrics = { ...BASE_METRICS, zombieCount: 2 };
			const assertions: Assertion[] = [{ kind: "no_zombies", expected: true }];
			const [result] = evaluateAssertions(assertions, metrics);
			expect(result?.passed).toBe(false);
			expect(result?.actual).toBe(2);
		});
	});

	describe("merge_queue_empty", () => {
		test("passes when mergeQueuePending is 0", () => {
			const assertions: Assertion[] = [{ kind: "merge_queue_empty", expected: true }];
			const [result] = evaluateAssertions(assertions, BASE_METRICS);
			expect(result?.passed).toBe(true);
			expect(result?.actual).toBe(0);
		});

		test("fails when mergeQueuePending > 0", () => {
			const metrics = { ...BASE_METRICS, mergeQueuePending: 3 };
			const assertions: Assertion[] = [{ kind: "merge_queue_empty", expected: true }];
			const [result] = evaluateAssertions(assertions, metrics);
			expect(result?.passed).toBe(false);
		});
	});

	describe("tasks_completed", () => {
		test("passes when tasksCompleted >= expected", () => {
			const assertions: Assertion[] = [{ kind: "tasks_completed", expected: 2 }];
			const [result] = evaluateAssertions(assertions, BASE_METRICS);
			expect(result?.passed).toBe(true);
		});

		test("fails when tasksCompleted < expected", () => {
			const assertions: Assertion[] = [{ kind: "tasks_completed", expected: 10 }];
			const [result] = evaluateAssertions(assertions, BASE_METRICS);
			expect(result?.passed).toBe(false);
		});
	});

	describe("max_stall_rate", () => {
		test("passes when stallRate <= expected", () => {
			const assertions: Assertion[] = [{ kind: "max_stall_rate", expected: 0.1 }];
			const [result] = evaluateAssertions(assertions, BASE_METRICS);
			expect(result?.passed).toBe(true);
		});

		test("fails when stallRate > expected", () => {
			const metrics = { ...BASE_METRICS, stallRate: 0.5 };
			const assertions: Assertion[] = [{ kind: "max_stall_rate", expected: 0.1 }];
			const [result] = evaluateAssertions(assertions, metrics);
			expect(result?.passed).toBe(false);
		});
	});

	describe("max_cost", () => {
		test("passes when estimatedCostUsd <= expected", () => {
			const assertions: Assertion[] = [{ kind: "max_cost", expected: 1.0 }];
			const [result] = evaluateAssertions(assertions, BASE_METRICS);
			expect(result?.passed).toBe(true);
		});

		test("fails when estimatedCostUsd > expected", () => {
			const assertions: Assertion[] = [{ kind: "max_cost", expected: 0.01 }];
			const [result] = evaluateAssertions(assertions, BASE_METRICS);
			expect(result?.passed).toBe(false);
		});
	});

	describe("max_duration_ms", () => {
		test("passes when durationMs <= expected", () => {
			const assertions: Assertion[] = [{ kind: "max_duration_ms", expected: 120_000 }];
			const [result] = evaluateAssertions(assertions, BASE_METRICS);
			expect(result?.passed).toBe(true);
		});

		test("fails when durationMs > expected", () => {
			const assertions: Assertion[] = [{ kind: "max_duration_ms", expected: 30_000 }];
			const [result] = evaluateAssertions(assertions, BASE_METRICS);
			expect(result?.passed).toBe(false);
		});
	});

	describe("custom", () => {
		test("always passes", () => {
			const assertions: Assertion[] = [{ kind: "custom", expected: "anything" }];
			const [result] = evaluateAssertions(assertions, BASE_METRICS);
			expect(result?.passed).toBe(true);
		});
	});

	test("uses assertion label in message when provided", () => {
		const assertions: Assertion[] = [
			{ kind: "no_zombies", label: "No zombies please", expected: true },
		];
		const [result] = evaluateAssertions(assertions, BASE_METRICS);
		expect(result?.message).toContain("No zombies please");
	});

	test("auto-generates label from kind when omitted", () => {
		const assertions: Assertion[] = [{ kind: "min_workers_spawned", expected: 1 }];
		const [result] = evaluateAssertions(assertions, BASE_METRICS);
		expect(result?.message).toContain("min workers spawned");
	});

	test("preserves assertion reference in result", () => {
		const assertion: Assertion = { kind: "no_zombies", expected: true };
		const [result] = evaluateAssertions([assertion], BASE_METRICS);
		expect(result?.assertion).toBe(assertion);
	});
});
