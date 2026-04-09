/**
 * Tests for profiler trace builder.
 *
 * Uses real bun:sqlite :memory: databases. No mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentSession } from "../agents/types.ts";
import { createEventStore } from "../events/store.ts";
import type { InsertEvent } from "../events/types.ts";
import { createMetricsStore } from "../metrics/store.ts";
import type { SessionMetrics } from "../metrics/types.ts";
import type { ExportSpan } from "../observability/types.ts";
import { createSessionStore } from "../sessions/store.ts";
import { buildProfilerTrace } from "./build.ts";
import { enrichSpanHierarchy } from "./enrich.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: "sess-1",
		agentName: "builder-1",
		capability: "builder",
		runtime: "claude",
		worktreePath: "/tmp/wt",
		branchName: "overstory/builder-1/task-1",
		taskId: "task-1",
		tmuxSession: "ov-test-builder-1",
		state: "completed",
		pid: null,
		parentAgent: null,
		depth: 0,
		runId: "run-001",
		startedAt: "2026-01-01T00:00:00.000Z",
		lastActivity: "2026-01-01T00:05:00.000Z",
		escalationLevel: 0,
		stalledSince: null,
		rateLimitedSince: null,
		runtimeSessionId: null,
		transcriptPath: null,
		originalRuntime: null,
		statusLine: null,
		...overrides,
	};
}

function makeEvent(overrides: Partial<InsertEvent> = {}): InsertEvent {
	return {
		runId: "run-001",
		agentName: "builder-1",
		sessionId: "sess-1",
		eventType: "tool_start",
		toolName: "Read",
		toolArgs: null,
		toolDurationMs: null,
		level: "info",
		data: null,
		...overrides,
	};
}

function makeMetrics(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
	return {
		agentName: "builder-1",
		taskId: "task-1",
		capability: "builder",
		startedAt: "2026-01-01T00:00:00.000Z",
		completedAt: "2026-01-01T00:05:00.000Z",
		durationMs: 300000,
		exitCode: 0,
		mergeResult: null,
		parentAgent: null,
		inputTokens: 10000,
		outputTokens: 3000,
		cacheReadTokens: 5000,
		cacheCreationTokens: 2000,
		estimatedCostUsd: 0.12,
		modelUsed: "claude-sonnet-4-6",
		runId: "run-001",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// enrichSpanHierarchy
// ---------------------------------------------------------------------------

describe("enrichSpanHierarchy", () => {
	test("stitches session spans to parent agent session spans", () => {
		const sessions = [
			makeSession({ agentName: "lead-1", id: "sess-lead" }),
			makeSession({
				agentName: "builder-1",
				id: "sess-b1",
				parentAgent: "lead-1",
				depth: 1,
			}),
		];

		const spans: ExportSpan[] = [
			{
				spanId: "span-lead",
				parentSpanId: null,
				traceId: "trace-1",
				name: "session:lead-1",
				kind: "session",
				startTime: "2026-01-01T00:00:00.000Z",
				endTime: "2026-01-01T00:10:00.000Z",
				durationMs: 600000,
				status: "ok",
				attributes: {},
				events: [],
				resource: {
					agentName: "lead-1",
					runId: "run-001",
					sessionId: "sess-lead",
					taskId: null,
					missionId: null,
					capability: null,
				},
			},
			{
				spanId: "span-b1",
				parentSpanId: null,
				traceId: "trace-1",
				name: "session:builder-1",
				kind: "session",
				startTime: "2026-01-01T00:01:00.000Z",
				endTime: "2026-01-01T00:05:00.000Z",
				durationMs: 240000,
				status: "ok",
				attributes: {},
				events: [],
				resource: {
					agentName: "builder-1",
					runId: "run-001",
					sessionId: "sess-b1",
					taskId: null,
					missionId: null,
					capability: null,
				},
			},
		];

		const enriched = enrichSpanHierarchy(spans, sessions);

		// lead-1 has no parent → still null
		expect(enriched[0]?.parentSpanId).toBeNull();
		// builder-1 → parentAgent is lead-1 → parent span is span-lead
		expect(enriched[1]?.parentSpanId).toBe("span-lead");
	});

	test("stitches tool spans to their agent session span", () => {
		const sessions = [makeSession({ agentName: "builder-1", id: "sess-1" })];

		const spans: ExportSpan[] = [
			{
				spanId: "span-sess",
				parentSpanId: null,
				traceId: "trace-1",
				name: "session:builder-1",
				kind: "session",
				startTime: "2026-01-01T00:00:00.000Z",
				endTime: null,
				durationMs: null,
				status: "unset",
				attributes: {},
				events: [],
				resource: {
					agentName: "builder-1",
					runId: "run-001",
					sessionId: "sess-1",
					taskId: null,
					missionId: null,
					capability: null,
				},
			},
			{
				spanId: "span-tool",
				parentSpanId: null,
				traceId: "trace-1",
				name: "tool:Read",
				kind: "tool",
				startTime: "2026-01-01T00:00:10.000Z",
				endTime: "2026-01-01T00:00:11.000Z",
				durationMs: 1000,
				status: "ok",
				attributes: {},
				events: [],
				resource: {
					agentName: "builder-1",
					runId: "run-001",
					sessionId: "sess-1",
					taskId: null,
					missionId: null,
					capability: null,
				},
			},
		];

		const enriched = enrichSpanHierarchy(spans, sessions);

		expect(enriched[0]?.parentSpanId).toBeNull(); // session is root
		expect(enriched[1]?.parentSpanId).toBe("span-sess"); // tool → session
	});

	test("does not mutate original spans", () => {
		const sessions = [
			makeSession({ agentName: "builder-1", parentAgent: "lead-1" }),
			makeSession({ agentName: "lead-1" }),
		];

		const span: ExportSpan = {
			spanId: "s1",
			parentSpanId: null,
			traceId: "t1",
			name: "session:builder-1",
			kind: "session",
			startTime: "2026-01-01T00:00:00.000Z",
			endTime: null,
			durationMs: null,
			status: "unset",
			attributes: {},
			events: [],
			resource: {
				agentName: "builder-1",
				runId: "run-001",
				sessionId: "sess-1",
				taskId: null,
				missionId: null,
				capability: null,
			},
		};

		enrichSpanHierarchy([span], sessions);
		expect(span.parentSpanId).toBeNull(); // original unchanged
	});
});

// ---------------------------------------------------------------------------
// buildProfilerTrace — integration tests with real SQLite stores
// ---------------------------------------------------------------------------

describe("buildProfilerTrace", () => {
	let eventStore: ReturnType<typeof createEventStore>;
	let sessionStore: ReturnType<typeof createSessionStore>;
	let metricsStore: ReturnType<typeof createMetricsStore>;

	beforeEach(() => {
		eventStore = createEventStore(":memory:");
		sessionStore = createSessionStore(":memory:");
		metricsStore = createMetricsStore(":memory:");
	});

	afterEach(() => {
		eventStore.close();
		sessionStore.close();
		metricsStore.close();
	});

	test("returns null for empty run", () => {
		const result = buildProfilerTrace({
			eventStore,
			sessionStore,
			metricsStore,
			runId: "run-nonexistent",
		});
		expect(result).toBeNull();
	});

	test("single agent with tool calls produces hierarchical tree", () => {
		sessionStore.upsert(makeSession());

		eventStore.insert(makeEvent({ eventType: "tool_start", toolName: "Read" }));
		eventStore.insert(makeEvent({ eventType: "tool_end", toolName: "Read", toolDurationMs: 100 }));
		eventStore.insert(makeEvent({ eventType: "tool_start", toolName: "Edit" }));
		eventStore.insert(makeEvent({ eventType: "tool_end", toolName: "Edit", toolDurationMs: 200 }));

		const trace = buildProfilerTrace({
			eventStore,
			sessionStore,
			metricsStore,
			runId: "run-001",
		});

		expect(trace).not.toBeNull();
		expect(trace?.runId).toBe("run-001");
		// 1 synthetic session span + 2 tool spans (no session_start event → synthetic injected)
		expect(trace?.flatSpans.length).toBe(3);
		// Session span should be present as root
		const sessionSpan = trace?.flatSpans.find((s) => s.kind === "session");
		expect(sessionSpan).toBeTruthy();
		// Tool spans should be children of the session span
		const toolSpans = trace?.flatSpans.filter((s) => s.kind === "tool") ?? [];
		expect(toolSpans.length).toBe(2);
		for (const ts of toolSpans) {
			expect(ts.parentSpanId).toBe(sessionSpan?.spanId);
		}
	});

	test("multi-agent hierarchy produces correct parent-child tree", () => {
		// lead → builder hierarchy
		sessionStore.upsert(
			makeSession({
				agentName: "lead-1",
				id: "sess-lead",
				capability: "lead",
				parentAgent: null,
				depth: 0,
			}),
		);
		sessionStore.upsert(
			makeSession({
				agentName: "builder-1",
				id: "sess-b1",
				parentAgent: "lead-1",
				depth: 1,
			}),
		);

		// Events for lead
		eventStore.insert(
			makeEvent({
				agentName: "lead-1",
				sessionId: "sess-lead",
				eventType: "session_start",
			}),
		);
		eventStore.insert(
			makeEvent({
				agentName: "lead-1",
				sessionId: "sess-lead",
				eventType: "session_end",
			}),
		);

		// Events for builder
		eventStore.insert(
			makeEvent({
				agentName: "builder-1",
				sessionId: "sess-b1",
				eventType: "session_start",
			}),
		);
		eventStore.insert(
			makeEvent({
				agentName: "builder-1",
				sessionId: "sess-b1",
				eventType: "tool_start",
				toolName: "Read",
			}),
		);
		eventStore.insert(
			makeEvent({
				agentName: "builder-1",
				sessionId: "sess-b1",
				eventType: "tool_end",
				toolName: "Read",
				toolDurationMs: 50,
			}),
		);
		eventStore.insert(
			makeEvent({
				agentName: "builder-1",
				sessionId: "sess-b1",
				eventType: "session_end",
			}),
		);

		const trace = buildProfilerTrace({
			eventStore,
			sessionStore,
			metricsStore,
			runId: "run-001",
		});

		expect(trace).not.toBeNull();
		// Root should be lead-1's session
		expect(trace?.rootSpans.length).toBe(1);
		expect(trace?.rootSpans[0]?.name).toBe("session:lead-1");
		// builder-1's session should be child of lead-1
		const leadChildren = trace?.rootSpans[0]?.children ?? [];
		const builderSession = leadChildren.find((c) => c.name === "session:builder-1");
		expect(builderSession).toBeDefined();
		// Read tool should be child of builder session
		const toolSpan = builderSession?.children.find((c) => c.name === "tool:Read");
		expect(toolSpan).toBeDefined();
	});

	test("metrics are enriched on session spans", () => {
		sessionStore.upsert(makeSession());
		metricsStore.recordSession(makeMetrics());

		eventStore.insert(makeEvent({ eventType: "session_start" }));
		eventStore.insert(makeEvent({ eventType: "session_end" }));

		const trace = buildProfilerTrace({
			eventStore,
			sessionStore,
			metricsStore,
			runId: "run-001",
		});

		expect(trace).not.toBeNull();
		const sessionSpan = trace?.flatSpans.find((s) => s.kind === "session");
		expect(sessionSpan).toBeDefined();
		expect(sessionSpan?.attributes["gen_ai.usage.input_tokens"]).toBe(10000);
		expect(sessionSpan?.attributes["ov.cost_usd"]).toBe(0.12);
		expect(sessionSpan?.attributes["gen_ai.request.model"]).toBe("claude-sonnet-4-6");
	});

	test("summary aggregates tokens and cost", () => {
		sessionStore.upsert(makeSession());
		metricsStore.recordSession(makeMetrics());

		eventStore.insert(makeEvent({ eventType: "session_start" }));
		eventStore.insert(makeEvent({ eventType: "session_end" }));

		const trace = buildProfilerTrace({
			eventStore,
			sessionStore,
			metricsStore,
			runId: "run-001",
		});

		expect(trace?.summary.agentCount).toBe(1);
		expect(trace?.summary.tokens.input).toBe(10000);
		expect(trace?.summary.tokens.output).toBe(3000);
		expect(trace?.summary.totalCostUsd).toBe(0.12);
		expect(trace?.summary.byCapability.builder).toBeDefined();
	});

	test("null-runId parent agents are resolved", () => {
		// Coordinator has null runId
		sessionStore.upsert(
			makeSession({
				agentName: "coordinator-1",
				id: "sess-coord",
				capability: "coordinator",
				runId: null, // key: null runId
			}),
		);
		sessionStore.upsert(
			makeSession({
				agentName: "builder-1",
				id: "sess-b1",
				parentAgent: "coordinator-1",
				depth: 1,
			}),
		);

		eventStore.insert(
			makeEvent({
				agentName: "builder-1",
				sessionId: "sess-b1",
				eventType: "session_start",
			}),
		);
		eventStore.insert(
			makeEvent({
				agentName: "builder-1",
				sessionId: "sess-b1",
				eventType: "session_end",
			}),
		);

		const trace = buildProfilerTrace({
			eventStore,
			sessionStore,
			metricsStore,
			runId: "run-001",
		});

		expect(trace).not.toBeNull();
		// Both builder and coordinator should have session spans (coordinator synthetic)
		const builderSpan = trace?.flatSpans.find((s) => s.name === "session:builder-1");
		const coordSpan = trace?.flatSpans.find((s) => s.name === "session:coordinator-1");
		expect(builderSpan).toBeTruthy();
		expect(coordSpan).toBeTruthy();
		// builder's session span should reference coordinator's session as parent
		expect(builderSpan?.parentSpanId).toBe(coordSpan?.spanId);
		expect(trace?.summary.agentCount).toBe(2);
	});

	test("flatSpans are in DFS order sorted by startTimeMs", () => {
		sessionStore.upsert(makeSession({ agentName: "agent-a", id: "s-a" }));
		sessionStore.upsert(makeSession({ agentName: "agent-b", id: "s-b" }));

		// agent-a events first, then agent-b
		eventStore.insert(
			makeEvent({
				agentName: "agent-a",
				sessionId: "s-a",
				eventType: "tool_start",
				toolName: "Read",
			}),
		);
		eventStore.insert(
			makeEvent({
				agentName: "agent-a",
				sessionId: "s-a",
				eventType: "tool_end",
				toolName: "Read",
				toolDurationMs: 10,
			}),
		);
		eventStore.insert(
			makeEvent({
				agentName: "agent-b",
				sessionId: "s-b",
				eventType: "tool_start",
				toolName: "Write",
			}),
		);
		eventStore.insert(
			makeEvent({
				agentName: "agent-b",
				sessionId: "s-b",
				eventType: "tool_end",
				toolName: "Write",
				toolDurationMs: 20,
			}),
		);

		const trace = buildProfilerTrace({
			eventStore,
			sessionStore,
			metricsStore,
			runId: "run-001",
		});

		expect(trace).not.toBeNull();
		const spans = trace?.flatSpans ?? [];
		// Verify flatSpans includes synthetic session spans + tool spans
		const sessionSpans = spans.filter((s) => s.kind === "session");
		const toolSpans = spans.filter((s) => s.kind === "tool");
		expect(sessionSpans.length).toBe(2); // agent-a, agent-b
		expect(toolSpans.length).toBe(2); // Read, Write
		// Tool spans should be children of their session spans
		for (const ts of toolSpans) {
			expect(ts.parentSpanId).toBeTruthy();
			expect(ts.depth).toBe(1);
		}
	});
});
