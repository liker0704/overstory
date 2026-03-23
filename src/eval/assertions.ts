import { resolve } from "node:path";
import type { StoredEvent } from "../events/types.ts";
import type { Assertion, AssertionResult, EvalContext, EventSelector } from "./types.ts";

/**
 * Evaluate a list of assertions against collected eval context.
 *
 * @returns One AssertionResult per assertion, in the same order.
 */
export async function evaluateAssertions(
	assertions: Assertion[],
	context: EvalContext,
): Promise<AssertionResult[]> {
	const results: AssertionResult[] = [];
	for (const assertion of assertions) {
		results.push(await evaluate(assertion, context));
	}
	return results;
}

async function evaluate(assertion: Assertion, context: EvalContext): Promise<AssertionResult> {
	const label = assertion.label ?? labelFromKind(assertion.kind);
	const metrics = context.metrics;

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

		case "before": {
			const eventA = assertion.eventA;
			const eventB = assertion.eventB;
			if (!eventA || !eventB) {
				return {
					assertion,
					passed: false,
					actual: "missing",
					message: `${label}: before assertion requires eventA and eventB`,
				};
			}
			const a = findEvent(context.events, eventA);
			const b = findEvent(context.events, eventB);
			if (!a || !b) {
				return {
					assertion,
					passed: false,
					actual: "not found",
					message: `${label}: event not found — ${!a ? "eventA" : "eventB"} missing`,
				};
			}
			const passed = a.createdAt < b.createdAt;
			return {
				assertion,
				passed,
				actual: a.createdAt,
				message: passed
					? `${label}: ${a.createdAt} is before ${b.createdAt}`
					: `${label}: ${a.createdAt} is NOT before ${b.createdAt}`,
			};
		}

		case "after": {
			const eventA = assertion.eventA;
			const eventB = assertion.eventB;
			if (!eventA || !eventB) {
				return {
					assertion,
					passed: false,
					actual: "missing",
					message: `${label}: after assertion requires eventA and eventB`,
				};
			}
			const a = findEvent(context.events, eventA);
			const b = findEvent(context.events, eventB);
			if (!a || !b) {
				return {
					assertion,
					passed: false,
					actual: "not found",
					message: `${label}: event not found — ${!a ? "eventA" : "eventB"} missing`,
				};
			}
			const passed = a.createdAt > b.createdAt;
			return {
				assertion,
				passed,
				actual: a.createdAt,
				message: passed
					? `${label}: ${a.createdAt} is after ${b.createdAt}`
					: `${label}: ${a.createdAt} is NOT after ${b.createdAt}`,
			};
		}

		case "within": {
			const eventA = assertion.eventA;
			const eventB = assertion.eventB;
			const windowMs = assertion.windowMs;
			if (!eventA || !eventB || windowMs === undefined) {
				return {
					assertion,
					passed: false,
					actual: "missing",
					message: `${label}: within assertion requires eventA, eventB, and windowMs`,
				};
			}
			const a = findEvent(context.events, eventA);
			const b = findEvent(context.events, eventB);
			if (!a || !b) {
				return {
					assertion,
					passed: false,
					actual: "not found",
					message: `${label}: event not found — ${!a ? "eventA" : "eventB"} missing`,
				};
			}
			const diffMs = Math.abs(new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
			const passed = diffMs <= windowMs;
			return {
				assertion,
				passed,
				actual: diffMs,
				message: passed
					? `${label}: events are ${diffMs}ms apart (<= ${windowMs}ms)`
					: `${label}: events are ${diffMs}ms apart, exceeds window of ${windowMs}ms`,
			};
		}

		case "event_count": {
			const selector = assertion.selector;
			const expected = assertion.expected as number;
			if (!selector) {
				return {
					assertion,
					passed: false,
					actual: 0,
					message: `${label}: event_count assertion requires selector`,
				};
			}
			const count = context.events.filter((e) => matchesSelector(e, selector)).length;
			const passed = count >= expected;
			return {
				assertion,
				passed,
				actual: count,
				message: passed
					? `${label}: ${count} events matching selector (>= ${expected})`
					: `${label}: only ${count} events matching selector, expected at least ${expected}`,
			};
		}

		case "custom": {
			const hookPath = assertion.hookPath;
			if (!hookPath) {
				return {
					assertion,
					passed: false,
					actual: "missing",
					message: `${label}: custom assertion missing hookPath`,
				};
			}
			try {
				const absolutePath = resolve(hookPath);
				const mod = await import(absolutePath);
				const result = (await mod.default(context)) as { passed: boolean; message: string };
				return {
					assertion,
					passed: result.passed,
					actual: result.passed ? "passed" : "failed",
					message: result.message,
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					assertion,
					passed: false,
					actual: "error",
					message: `${label}: custom hook error — ${msg}`,
				};
			}
		}

		case "success_ratio":
		case "percentile_bound":
		case "max_retry_frequency": {
			return {
				assertion,
				passed: false,
				actual: 0,
				message: `${label}: ${assertion.kind} is a stochastic assertion — evaluate via runProbabilisticEval`,
			};
		}
	}
}

function findEvent(events: StoredEvent[], selector: EventSelector): StoredEvent | undefined {
	return events.find((e) => matchesSelector(e, selector));
}

function matchesSelector(e: StoredEvent, selector: EventSelector): boolean {
	if (e.eventType !== selector.eventType) return false;
	if (selector.agentName !== undefined && e.agentName !== selector.agentName) return false;
	if (selector.dataMatch !== undefined) {
		if (e.data === null || !e.data.includes(selector.dataMatch)) return false;
	}
	return true;
}

function labelFromKind(kind: string): string {
	return kind.replace(/_/g, " ");
}

function formatRate(rate: number): string {
	return `${(rate * 100).toFixed(1)}%`;
}
