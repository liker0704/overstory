import type { Assertion, AssertionResult, EvalMetrics } from "./types.ts";

/**
 * Evaluate a list of assertions against collected eval metrics.
 *
 * @returns One AssertionResult per assertion, in the same order.
 */
export function evaluateAssertions(
	assertions: Assertion[],
	metrics: EvalMetrics,
): AssertionResult[] {
	return assertions.map((assertion) => evaluate(assertion, metrics));
}

function evaluate(assertion: Assertion, metrics: EvalMetrics): AssertionResult {
	const label = assertion.label ?? labelFromKind(assertion.kind);

	switch (assertion.kind) {
		case "min_workers_spawned": {
			const expected = assertion.expected as number;
			const actual = metrics.totalAgents;
			const passed = actual >= expected;
			return {
				assertion,
				passed,
				actual,
				message: passed
					? `${label}: ${actual} workers spawned (>= ${expected})`
					: `${label}: only ${actual} workers spawned, expected at least ${expected}`,
			};
		}

		case "no_zombies": {
			const actual = metrics.zombieCount;
			const passed = actual === 0;
			return {
				assertion,
				passed,
				actual,
				message: passed
					? `${label}: no zombie agents detected`
					: `${label}: ${actual} zombie agent(s) detected`,
			};
		}

		case "merge_queue_empty": {
			const actual = metrics.mergeQueuePending;
			const passed = actual === 0;
			return {
				assertion,
				passed,
				actual,
				message: passed
					? `${label}: merge queue is empty`
					: `${label}: merge queue has ${actual} pending entry/entries`,
			};
		}

		case "tasks_completed": {
			const expected = assertion.expected as number;
			const actual = metrics.tasksCompleted;
			const passed = actual >= expected;
			return {
				assertion,
				passed,
				actual,
				message: passed
					? `${label}: ${actual} tasks completed (>= ${expected})`
					: `${label}: only ${actual} tasks completed, expected at least ${expected}`,
			};
		}

		case "max_stall_rate": {
			const expected = assertion.expected as number;
			const actual = metrics.stallRate;
			const passed = actual <= expected;
			return {
				assertion,
				passed,
				actual,
				message: passed
					? `${label}: stall rate ${formatRate(actual)} (<= ${formatRate(expected)})`
					: `${label}: stall rate ${formatRate(actual)} exceeds limit ${formatRate(expected)}`,
			};
		}

		case "max_cost": {
			const expected = assertion.expected as number;
			const actual = metrics.estimatedCostUsd;
			const passed = actual <= expected;
			return {
				assertion,
				passed,
				actual,
				message: passed
					? `${label}: cost $${actual.toFixed(4)} USD (<= $${expected.toFixed(4)} USD)`
					: `${label}: cost $${actual.toFixed(4)} USD exceeds limit $${expected.toFixed(4)} USD`,
			};
		}

		case "max_duration_ms": {
			const expected = assertion.expected as number;
			const actual = metrics.durationMs;
			const passed = actual <= expected;
			return {
				assertion,
				passed,
				actual,
				message: passed
					? `${label}: duration ${actual}ms (<= ${expected}ms)`
					: `${label}: duration ${actual}ms exceeds limit ${expected}ms`,
			};
		}

		case "custom": {
			return {
				assertion,
				passed: true,
				actual: "custom",
				message: `${label}: custom assertion — always passes (LLM judge not yet implemented)`,
			};
		}
	}
}

function labelFromKind(kind: string): string {
	return kind.replace(/_/g, " ");
}

function formatRate(rate: number): string {
	return `${(rate * 100).toFixed(1)}%`;
}
