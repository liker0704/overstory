import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateAssertions } from "./assertions.ts";
import type { Assertion, EvalContext, EvalMetrics } from "./types.ts";

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
	runtimeSwaps: 0,
	medianSessionDurationMs: 30_000,
};

const BASE_CONTEXT: EvalContext = {
	metrics: BASE_METRICS,
	events: [],
	mailMessages: [],
	missionEvents: [],
};

const TIMELINE_CONTEXT: EvalContext = {
	metrics: BASE_METRICS,
	events: [
		{
			id: 1,
			runId: "r1",
			agentName: "scout-1",
			sessionId: "s1",
			eventType: "spawn",
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			level: "info",
			data: null,
			createdAt: "2026-01-01T00:00:00Z",
		},
		{
			id: 2,
			runId: "r1",
			agentName: "builder-1",
			sessionId: "s1",
			eventType: "spawn",
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			level: "info",
			data: null,
			createdAt: "2026-01-01T00:01:00Z",
		},
		{
			id: 3,
			runId: "r1",
			agentName: "builder-1",
			sessionId: "s1",
			eventType: "tool_start",
			toolName: "Write",
			toolArgs: null,
			toolDurationMs: null,
			level: "info",
			data: "writing file",
			createdAt: "2026-01-01T00:02:00Z",
		},
		{
			id: 4,
			runId: "r1",
			agentName: "builder-1",
			sessionId: "s1",
			eventType: "result",
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			level: "info",
			data: "build complete",
			createdAt: "2026-01-01T00:05:00Z",
		},
	],
	mailMessages: [],
	missionEvents: [],
};

describe("evaluateAssertions", () => {
	test("returns empty array for empty assertions", async () => {
		expect(await evaluateAssertions([], BASE_CONTEXT)).toEqual([]);
	});

	describe("min_workers_spawned", () => {
		test("passes when totalAgents >= expected", async () => {
			const assertions: Assertion[] = [{ kind: "min_workers_spawned", expected: 3 }];
			const [result] = await evaluateAssertions(assertions, BASE_CONTEXT);
			expect(result?.passed).toBe(true);
			expect(result?.actual).toBe(3);
		});

		test("fails when totalAgents < expected", async () => {
			const assertions: Assertion[] = [{ kind: "min_workers_spawned", expected: 5 }];
			const [result] = await evaluateAssertions(assertions, BASE_CONTEXT);
			expect(result?.passed).toBe(false);
			expect(result?.actual).toBe(3);
		});
	});

	describe("no_zombies", () => {
		test("passes when zombieCount is 0", async () => {
			const assertions: Assertion[] = [{ kind: "no_zombies", expected: true }];
			const [result] = await evaluateAssertions(assertions, BASE_CONTEXT);
			expect(result?.passed).toBe(true);
			expect(result?.actual).toBe(0);
		});

		test("fails when zombieCount > 0", async () => {
			const ctx = { ...BASE_CONTEXT, metrics: { ...BASE_METRICS, zombieCount: 2 } };
			const assertions: Assertion[] = [{ kind: "no_zombies", expected: true }];
			const [result] = await evaluateAssertions(assertions, ctx);
			expect(result?.passed).toBe(false);
			expect(result?.actual).toBe(2);
		});
	});

	describe("merge_queue_empty", () => {
		test("passes when mergeQueuePending is 0", async () => {
			const assertions: Assertion[] = [{ kind: "merge_queue_empty", expected: true }];
			const [result] = await evaluateAssertions(assertions, BASE_CONTEXT);
			expect(result?.passed).toBe(true);
			expect(result?.actual).toBe(0);
		});

		test("fails when mergeQueuePending > 0", async () => {
			const ctx = { ...BASE_CONTEXT, metrics: { ...BASE_METRICS, mergeQueuePending: 3 } };
			const assertions: Assertion[] = [{ kind: "merge_queue_empty", expected: true }];
			const [result] = await evaluateAssertions(assertions, ctx);
			expect(result?.passed).toBe(false);
		});
	});

	describe("tasks_completed", () => {
		test("passes when tasksCompleted >= expected", async () => {
			const assertions: Assertion[] = [{ kind: "tasks_completed", expected: 2 }];
			const [result] = await evaluateAssertions(assertions, BASE_CONTEXT);
			expect(result?.passed).toBe(true);
		});

		test("fails when tasksCompleted < expected", async () => {
			const assertions: Assertion[] = [{ kind: "tasks_completed", expected: 10 }];
			const [result] = await evaluateAssertions(assertions, BASE_CONTEXT);
			expect(result?.passed).toBe(false);
		});
	});

	describe("max_stall_rate", () => {
		test("passes when stallRate <= expected", async () => {
			const assertions: Assertion[] = [{ kind: "max_stall_rate", expected: 0.1 }];
			const [result] = await evaluateAssertions(assertions, BASE_CONTEXT);
			expect(result?.passed).toBe(true);
		});

		test("fails when stallRate > expected", async () => {
			const ctx = { ...BASE_CONTEXT, metrics: { ...BASE_METRICS, stallRate: 0.5 } };
			const assertions: Assertion[] = [{ kind: "max_stall_rate", expected: 0.1 }];
			const [result] = await evaluateAssertions(assertions, ctx);
			expect(result?.passed).toBe(false);
		});
	});

	describe("max_cost", () => {
		test("passes when estimatedCostUsd <= expected", async () => {
			const assertions: Assertion[] = [{ kind: "max_cost", expected: 1.0 }];
			const [result] = await evaluateAssertions(assertions, BASE_CONTEXT);
			expect(result?.passed).toBe(true);
		});

		test("fails when estimatedCostUsd > expected", async () => {
			const assertions: Assertion[] = [{ kind: "max_cost", expected: 0.01 }];
			const [result] = await evaluateAssertions(assertions, BASE_CONTEXT);
			expect(result?.passed).toBe(false);
		});
	});

	describe("max_duration_ms", () => {
		test("passes when durationMs <= expected", async () => {
			const assertions: Assertion[] = [{ kind: "max_duration_ms", expected: 120_000 }];
			const [result] = await evaluateAssertions(assertions, BASE_CONTEXT);
			expect(result?.passed).toBe(true);
		});

		test("fails when durationMs > expected", async () => {
			const assertions: Assertion[] = [{ kind: "max_duration_ms", expected: 30_000 }];
			const [result] = await evaluateAssertions(assertions, BASE_CONTEXT);
			expect(result?.passed).toBe(false);
		});
	});

	describe("before", () => {
		test("passes when eventA.createdAt < eventB.createdAt", async () => {
			const assertions: Assertion[] = [
				{
					kind: "before",
					expected: true,
					eventA: { eventType: "spawn", agentName: "scout-1" },
					eventB: { eventType: "spawn", agentName: "builder-1" },
				},
			];
			const [result] = await evaluateAssertions(assertions, TIMELINE_CONTEXT);
			expect(result?.passed).toBe(true);
		});

		test("fails when eventA.createdAt > eventB.createdAt", async () => {
			const assertions: Assertion[] = [
				{
					kind: "before",
					expected: true,
					eventA: { eventType: "spawn", agentName: "builder-1" },
					eventB: { eventType: "spawn", agentName: "scout-1" },
				},
			];
			const [result] = await evaluateAssertions(assertions, TIMELINE_CONTEXT);
			expect(result?.passed).toBe(false);
		});

		test("fails when event not found", async () => {
			const assertions: Assertion[] = [
				{
					kind: "before",
					expected: true,
					eventA: { eventType: "spawn", agentName: "nonexistent" },
					eventB: { eventType: "spawn", agentName: "builder-1" },
				},
			];
			const [result] = await evaluateAssertions(assertions, TIMELINE_CONTEXT);
			expect(result?.passed).toBe(false);
		});
	});

	describe("after", () => {
		test("passes when eventA.createdAt > eventB.createdAt", async () => {
			const assertions: Assertion[] = [
				{
					kind: "after",
					expected: true,
					eventA: { eventType: "spawn", agentName: "builder-1" },
					eventB: { eventType: "spawn", agentName: "scout-1" },
				},
			];
			const [result] = await evaluateAssertions(assertions, TIMELINE_CONTEXT);
			expect(result?.passed).toBe(true);
		});
	});

	describe("within", () => {
		test("passes when events are within window", async () => {
			const assertions: Assertion[] = [
				{
					kind: "within",
					expected: true,
					eventA: { eventType: "spawn", agentName: "scout-1" },
					eventB: { eventType: "spawn", agentName: "builder-1" },
					windowMs: 120_000, // 2 minutes — events are 1 minute apart
				},
			];
			const [result] = await evaluateAssertions(assertions, TIMELINE_CONTEXT);
			expect(result?.passed).toBe(true);
		});

		test("fails when events are outside window", async () => {
			const assertions: Assertion[] = [
				{
					kind: "within",
					expected: true,
					eventA: { eventType: "spawn", agentName: "scout-1" },
					eventB: { eventType: "result", agentName: "builder-1" },
					windowMs: 1_000, // 1 second — events are 5 minutes apart
				},
			];
			const [result] = await evaluateAssertions(assertions, TIMELINE_CONTEXT);
			expect(result?.passed).toBe(false);
		});
	});

	describe("event_count", () => {
		test("passes when count >= expected", async () => {
			const assertions: Assertion[] = [
				{
					kind: "event_count",
					expected: 2,
					selector: { eventType: "spawn" },
				},
			];
			const [result] = await evaluateAssertions(assertions, TIMELINE_CONTEXT);
			expect(result?.passed).toBe(true);
			expect(result?.actual).toBe(2);
		});

		test("fails when count < expected", async () => {
			const assertions: Assertion[] = [
				{
					kind: "event_count",
					expected: 10,
					selector: { eventType: "spawn" },
				},
			];
			const [result] = await evaluateAssertions(assertions, TIMELINE_CONTEXT);
			expect(result?.passed).toBe(false);
		});
	});

	describe("custom", () => {
		test("fails when hookPath missing", async () => {
			const assertions: Assertion[] = [{ kind: "custom", expected: "anything" }];
			const [result] = await evaluateAssertions(assertions, BASE_CONTEXT);
			expect(result?.passed).toBe(false);
			expect(result?.message).toContain("missing hookPath");
		});

		test("executes real hook file", async () => {
			const tempDir = await mkdtemp(join(tmpdir(), "overstory-hook-test-"));
			try {
				const hookPath = join(tempDir, "hook.ts");
				await writeFile(
					hookPath,
					`export default function(_ctx: unknown): { passed: boolean; message: string } {
  return { passed: true, message: "ok" };
}\n`,
					"utf8",
				);
				const assertions: Assertion[] = [{ kind: "custom", expected: "anything", hookPath }];
				const [result] = await evaluateAssertions(assertions, BASE_CONTEXT);
				expect(result?.passed).toBe(true);
				expect(result?.message).toBe("ok");
			} finally {
				await rm(tempDir, { recursive: true, force: true });
			}
		});
	});

	test("uses assertion label in message when provided", async () => {
		const assertions: Assertion[] = [
			{ kind: "no_zombies", label: "No zombies please", expected: true },
		];
		const [result] = await evaluateAssertions(assertions, BASE_CONTEXT);
		expect(result?.message).toContain("No zombies please");
	});

	test("auto-generates label from kind when omitted", async () => {
		const assertions: Assertion[] = [{ kind: "min_workers_spawned", expected: 1 }];
		const [result] = await evaluateAssertions(assertions, BASE_CONTEXT);
		expect(result?.message).toContain("min workers spawned");
	});

	test("preserves assertion reference in result", async () => {
		const assertion: Assertion = { kind: "no_zombies", expected: true };
		const [result] = await evaluateAssertions([assertion], BASE_CONTEXT);
		expect(result?.assertion).toBe(assertion);
	});
});
