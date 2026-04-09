/**
 * Profiler data model: hierarchical spans for waterfall visualization.
 *
 * ProfilerSpan extends the ExportSpan concept with:
 * - Epoch-ms timestamps for easy arithmetic
 * - Pre-built parent-child tree (children array)
 * - Visual depth for waterfall indentation
 */

import type { SpanKind, SpanStatus } from "../observability/types.ts";

/** A time segment within a session bar, colored by agent state. */
export interface StateSegment {
	state: string;
	startMs: number;
	endMs: number;
}

/** A span with hierarchy, ready for waterfall rendering. */
export interface ProfilerSpan {
	spanId: string;
	parentSpanId: string | null;
	traceId: string;
	name: string;
	kind: SpanKind;
	startTimeMs: number;
	endTimeMs: number | null;
	durationMs: number | null;
	status: SpanStatus;
	agentName: string;
	depth: number;
	attributes: Record<string, string | number | boolean>;
	children: ProfilerSpan[];
	/** State transition segments for session spans (working/waiting/completed). */
	stateSegments?: StateSegment[];
}

/** A complete trace for one run, ready for waterfall rendering. */
export interface ProfilerTrace {
	traceId: string;
	runId: string;
	rootSpans: ProfilerSpan[];
	startTimeMs: number;
	endTimeMs: number;
	totalDurationMs: number;
	summary: TraceSummary;
	/** Flattened DFS order for sequential waterfall rendering. */
	flatSpans: ProfilerSpan[];
}

/** Aggregate statistics for a trace. */
export interface TraceSummary {
	agentCount: number;
	spanCount: number;
	totalDurationMs: number;
	totalCostUsd: number | null;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheCreation: number;
	};
	byCapability: Record<string, { count: number; durationMs: number; costUsd: number }>;
}

/** Lightweight run info for the run selector dropdown. */
export interface RunInfo {
	id: string;
	startedAt: string;
	completedAt: string | null;
	status: string;
	agentCount: number;
	coordinatorName: string | null;
}
