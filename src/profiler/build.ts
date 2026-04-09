/**
 * Trace builder: assembles a ProfilerTrace from event, session, and metrics stores.
 *
 * Pipeline: EventStore → normalizeSpans() → enrichSpanHierarchy() → ProfilerSpan tree
 */

import type { AgentSession } from "../agents/types.ts";
import type { EventStore, StoredEvent } from "../events/types.ts";
import type { MetricsStore } from "../metrics/store.ts";
import type { SessionMetrics } from "../metrics/types.ts";
import { normalizeSpans } from "../observability/normalize.ts";
import type { ExportSpan } from "../observability/types.ts";
import type { SessionStore } from "../sessions/store.ts";
import type { Run, RunStore } from "../sessions/types.ts";
import { enrichSpanHierarchy } from "./enrich.ts";
import type { StateLogEntry } from "../sessions/store.ts";
import type { ProfilerSpan, ProfilerTrace, RunInfo, StateSegment, TraceSummary } from "./types.ts";

/** Instant span kinds that should be collapsed by (agentName, kind). */
const INSTANT_KINDS = new Set(["mission", "mail", "spawn", "custom"]);

/** Parse ISO timestamp as UTC even if it lacks a Z suffix (SQLite stores without Z). */
function utcMs(ts: string): number {
	if (ts.endsWith("Z") || ts.includes("+") || ts.includes("-", 10)) return new Date(ts).getTime();
	return new Date(`${ts}Z`).getTime();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildTraceOpts {
	eventStore: EventStore;
	sessionStore: SessionStore;
	metricsStore: MetricsStore | null;
	runId: string;
}

/**
 * Build a complete ProfilerTrace for a given run.
 */
export function buildProfilerTrace(opts: BuildTraceOpts): ProfilerTrace | null {
	const { eventStore, sessionStore, metricsStore, runId } = opts;

	// 1. Fetch sessions first — we need agent names to find events with null runId
	const sessions = resolveSessionsWithParents(sessionStore, runId);

	// 2. Fetch events: by runId + by agent names (tool/session events have runId=null)
	const events = fetchAllRunEvents(eventStore, runId, sessions);
	if (events.length === 0) return null;

	const exportSpans = normalizeSpans(events, {});

	// 3. Synthesize session spans from AgentSession records (no session_start hook exists)
	const withSessions = injectSyntheticSessionSpans(exportSpans, sessions, runId);

	// 4. Enrich with hierarchy
	const enrichedSpans = enrichSpanHierarchy(withSessions, sessions);

	// 4. Collapse instant spans (mission, mail, spawn) by (agentName, kind)
	const collapsed = collapseInstantSpans(enrichedSpans);

	// 5. Enrich with metrics
	const metricsMap = buildMetricsMap(metricsStore, runId);
	const withMetrics = attachMetrics(collapsed, metricsMap, sessions);

	// 6. Convert to ProfilerSpans, attach state segments, build tree
	const profilerSpans = withMetrics.map(toProfilerSpan);
	const stateLog = sessionStore.getStateLog(runId);
	attachStateSegments(profilerSpans, stateLog, sessions);
	const rootSpans = buildTree(profilerSpans);
	assignDepths(rootSpans, 0);
	const flatSpans = flattenDfs(rootSpans);

	// 7. Compute summary
	const summary = computeSummary(flatSpans, metricsMap, sessions);

	// 8. Compute trace bounds (loop instead of spread to avoid stack overflow on large arrays)
	let startTimeMs = 0;
	let endTimeMs = 0;
	if (flatSpans.length > 0) {
		startTimeMs = Number.POSITIVE_INFINITY;
		const now = Date.now();
		for (const s of flatSpans) {
			if (s.startTimeMs < startTimeMs) startTimeMs = s.startTimeMs;
			const end = s.endTimeMs ?? now;
			if (end > endTimeMs) endTimeMs = end;
		}
	}

	const traceId = exportSpans[0]?.traceId ?? runId.replace(/-/g, "");

	return {
		traceId,
		runId,
		rootSpans,
		startTimeMs,
		endTimeMs,
		totalDurationMs: endTimeMs - startTimeMs,
		summary,
		flatSpans,
	};
}

/**
 * List available runs for the run selector.
 */
export function listAvailableRuns(runStore: RunStore, limit = 20): RunInfo[] {
	const runs = runStore.listRuns({ limit });
	return runs.map(runToInfo);
}

// ---------------------------------------------------------------------------
// Event Fetching — merge run events + per-agent events (tool/session have null runId)
// ---------------------------------------------------------------------------

function fetchAllRunEvents(
	eventStore: EventStore,
	runId: string,
	sessions: AgentSession[],
): StoredEvent[] {
	const runEvents = eventStore.getByRun(runId);

	// Find the run's time bounds for scoping agent event queries
	let runStart: string | undefined;
	for (const s of sessions) {
		if (!runStart || s.startedAt < runStart) {
			runStart = s.startedAt;
		}
	}
	if (!runStart && runEvents.length > 0) {
		runStart = runEvents[0]?.createdAt;
	}

	// Fetch per-agent events (tool_start, tool_end, session_start, etc. have runId=null)
	const seenIds = new Set<number>();
	for (const e of runEvents) {
		seenIds.add(e.id);
	}

	const allEvents = [...runEvents];
	for (const session of sessions) {
		const agentEvents = eventStore.getByAgent(session.agentName, {
			since: runStart,
		});
		for (const e of agentEvents) {
			if (!seenIds.has(e.id)) {
				seenIds.add(e.id);
				allEvents.push(e);
			}
		}
	}

	// Sort by createdAt for correct span pairing
	allEvents.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
	return allEvents;
}

// ---------------------------------------------------------------------------
// Collapse Instant Spans — group by (agentName, kind)
// ---------------------------------------------------------------------------

function collapseInstantSpans(spans: ExportSpan[]): ExportSpan[] {
	const result: ExportSpan[] = [];
	const groups = new Map<string, ExportSpan[]>();

	for (const span of spans) {
		if (INSTANT_KINDS.has(span.kind) && span.durationMs === 0) {
			const key = `${span.resource.agentName}:${span.kind}`;
			let group = groups.get(key);
			if (!group) {
				group = [];
				groups.set(key, group);
			}
			group.push(span);
		} else {
			result.push(span);
		}
	}

	// For each group, keep one representative span with count attribute
	for (const [, group] of groups) {
		const first = group[0];
		if (!first) continue;
		const attrs = { ...first.attributes, "ov.collapsed_count": group.length };
		result.push({
			...first,
			attributes: attrs,
		});
	}

	return result;
}

// ---------------------------------------------------------------------------
// Synthetic Session Spans — no session_start hook exists, so synthesize from AgentSession records
// ---------------------------------------------------------------------------

function genSpanId(): string {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function injectSyntheticSessionSpans(
	spans: ExportSpan[],
	sessions: AgentSession[],
	runId: string,
): ExportSpan[] {
	// Check which agents already have session spans
	const agentsWithSession = new Set<string>();
	for (const span of spans) {
		if (span.kind === "session") {
			agentsWithSession.add(span.resource.agentName);
		}
	}

	const traceId = runId.replace(/-/g, "");
	const synthetic: ExportSpan[] = [];

	for (const session of sessions) {
		if (agentsWithSession.has(session.agentName)) continue;

		const now = new Date().toISOString();
		const endTime = session.state === "completed" ? (session.lastActivity ?? now) : null;
		const startMs = utcMs(session.startedAt);
		const endMs = endTime ? utcMs(endTime) : null;
		const durationMs = endMs !== null ? endMs - startMs : null;

		synthetic.push({
			spanId: genSpanId(),
			parentSpanId: null,
			traceId,
			name: `session:${session.agentName}`,
			kind: "session",
			startTime: session.startedAt,
			endTime,
			durationMs,
			status: session.state === "completed" ? "ok" : "unset",
			attributes: {
				"ov.agent.capability": session.capability,
				"ov.agent.state": session.state,
				"ov.synthetic": true,
			},
			events: [],
			resource: {
				agentName: session.agentName,
				runId: session.runId,
				sessionId: session.runtimeSessionId ?? null,
				taskId: session.taskId ?? null,
				missionId: null,
				capability: session.capability,
			},
		});
	}

	return [...spans, ...synthetic];
}

// ---------------------------------------------------------------------------
// Session Resolution
// ---------------------------------------------------------------------------

/**
 * Fetch sessions for a run, plus any parent agents with null runId.
 */
function resolveSessionsWithParents(store: SessionStore, runId: string): AgentSession[] {
	const sessions = [...store.getByRun(runId)];
	const nameSet = new Set(sessions.map((s) => s.agentName));

	// Find referenced parents not in the run
	const missingParents = new Set<string>();
	for (const s of sessions) {
		if (s.parentAgent && !nameSet.has(s.parentAgent)) {
			missingParents.add(s.parentAgent);
		}
	}

	// Fetch missing parents individually
	for (const parentName of missingParents) {
		const parent = store.getByName(parentName);
		if (parent) {
			sessions.push(parent);
			nameSet.add(parent.agentName);
		}
	}

	return sessions;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function buildMetricsMap(store: MetricsStore | null, runId: string): Map<string, SessionMetrics> {
	if (!store) return new Map();
	try {
		const metrics = store.getSessionsByRun(runId);
		const map = new Map<string, SessionMetrics>();
		for (const m of metrics) {
			map.set(m.agentName, m);
		}

		// Fallback: for agents without a session record, use latest snapshot
		const snapshots = store.getLatestSnapshots(runId);
		for (const snap of snapshots) {
			if (!map.has(snap.agentName)) {
				map.set(snap.agentName, {
					agentName: snap.agentName,
					taskId: "",
					startedAt: snap.createdAt,
					durationMs: 0,
					mergeResult: null,
					parentAgent: null,
					inputTokens: snap.inputTokens,
					outputTokens: snap.outputTokens,
					cacheReadTokens: snap.cacheReadTokens,
					cacheCreationTokens: snap.cacheCreationTokens,
					estimatedCostUsd: snap.estimatedCostUsd,
					modelUsed: snap.modelUsed,
					runId: snap.runId,
				});
			}
		}

		return map;
	} catch {
		// Metrics DB may be corrupted — degrade gracefully without cost/token data
		return new Map();
	}
}

function countToolsPerAgent(spans: ExportSpan[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const s of spans) {
		if (s.kind === "tool") {
			const name = s.resource.agentName;
			counts.set(name, (counts.get(name) ?? 0) + 1);
		}
	}
	return counts;
}

function attachMetrics(
	spans: ExportSpan[],
	metricsMap: Map<string, SessionMetrics>,
	sessions: AgentSession[],
): ExportSpan[] {
	const capabilityMap = new Map<string, string>();
	const stateMap = new Map<string, string>();
	for (const s of sessions) {
		capabilityMap.set(s.agentName, s.capability);
		stateMap.set(s.agentName, s.state);
	}
	const toolCounts = countToolsPerAgent(spans);

	return spans.map((span) => {
		if (span.kind !== "session") return span;

		const metrics = metricsMap.get(span.resource.agentName);
		const capability = capabilityMap.get(span.resource.agentName);
		const state = stateMap.get(span.resource.agentName);
		const toolCount = toolCounts.get(span.resource.agentName);

		const attrs = { ...span.attributes };
		if (capability) {
			attrs["ov.agent.capability"] = capability;
		}
		if (state) {
			attrs["ov.agent.state"] = state;
		}
		if (toolCount !== undefined) {
			attrs["ov.agent.tool_count"] = toolCount;
		}
		if (metrics) {
			attrs["gen_ai.usage.input_tokens"] = metrics.inputTokens;
			attrs["gen_ai.usage.output_tokens"] = metrics.outputTokens;
			attrs["gen_ai.usage.cache_read.input_tokens"] = metrics.cacheReadTokens;
			attrs["gen_ai.usage.cache_creation.input_tokens"] = metrics.cacheCreationTokens;
			if (metrics.estimatedCostUsd !== null) {
				attrs["ov.cost_usd"] = metrics.estimatedCostUsd;
			}
			if (metrics.modelUsed) {
				attrs["gen_ai.request.model"] = metrics.modelUsed;
			}
		}
		return { ...span, attributes: attrs };
	});
}

// ---------------------------------------------------------------------------
// ExportSpan → ProfilerSpan conversion
// ---------------------------------------------------------------------------

function toProfilerSpan(span: ExportSpan): ProfilerSpan {
	const startTimeMs = utcMs(span.startTime);
	const endTimeMs = span.endTime ? utcMs(span.endTime) : null;
	return {
		spanId: span.spanId,
		parentSpanId: span.parentSpanId,
		traceId: span.traceId,
		name: span.name,
		kind: span.kind,
		startTimeMs,
		endTimeMs,
		durationMs: span.durationMs,
		status: span.status,
		agentName: span.resource.agentName,
		depth: 0, // assigned later by assignDepths
		attributes: span.attributes,
		children: [],
	};
}

// ---------------------------------------------------------------------------
// State Segments — build from agent_state_log trigger data
// ---------------------------------------------------------------------------

function attachStateSegments(
	spans: ProfilerSpan[],
	stateLog: StateLogEntry[],
	sessions: AgentSession[],
): void {
	// Group log entries by agent
	const logByAgent = new Map<string, StateLogEntry[]>();
	for (const entry of stateLog) {
		let list = logByAgent.get(entry.agentName);
		if (!list) {
			list = [];
			logByAgent.set(entry.agentName, list);
		}
		list.push(entry);
	}

	// Build initial state map from sessions
	const initialState = new Map<string, string>();
	for (const s of sessions) {
		initialState.set(s.agentName, "booting");
	}

	const now = Date.now();

	for (const span of spans) {
		if (span.kind !== "session") continue;

		const entries = logByAgent.get(span.agentName);
		const spanStart = span.startTimeMs;
		const spanEnd = span.endTimeMs ?? now;

		if (!entries || entries.length === 0) {
			// No transitions recorded — single segment with current state
			const state = String(span.attributes["ov.agent.state"] ?? "working");
			span.stateSegments = [{ state, startMs: spanStart, endMs: spanEnd }];
			continue;
		}

		const segments: StateSegment[] = [];
		let currentState = initialState.get(span.agentName) ?? "booting";
		let segmentStart = spanStart;

		for (const entry of entries) {
			const changeMs = utcMs(entry.changedAt);
			if (changeMs > segmentStart) {
				segments.push({ state: currentState, startMs: segmentStart, endMs: changeMs });
			}
			currentState = entry.toState;
			segmentStart = changeMs;
		}

		// Final segment to span end
		if (segmentStart < spanEnd) {
			segments.push({ state: currentState, startMs: segmentStart, endMs: spanEnd });
		}

		span.stateSegments = segments;
	}
}

// ---------------------------------------------------------------------------
// Tree Building
// ---------------------------------------------------------------------------

function buildTree(spans: ProfilerSpan[]): ProfilerSpan[] {
	const byId = new Map<string, ProfilerSpan>();
	for (const s of spans) {
		byId.set(s.spanId, s);
	}

	const roots: ProfilerSpan[] = [];
	for (const span of spans) {
		if (span.parentSpanId) {
			const parent = byId.get(span.parentSpanId);
			if (parent) {
				parent.children.push(span);
				continue;
			}
		}
		roots.push(span);
	}

	// Sort children by startTimeMs
	for (const span of byId.values()) {
		if (span.children.length > 1) {
			span.children.sort((a, b) => a.startTimeMs - b.startTimeMs);
		}
	}

	// Sort roots by startTimeMs
	roots.sort((a, b) => a.startTimeMs - b.startTimeMs);

	return roots;
}

function assignDepths(spans: ProfilerSpan[], depth: number): void {
	for (const span of spans) {
		span.depth = depth;
		assignDepths(span.children, depth + 1);
	}
}

function flattenDfs(roots: ProfilerSpan[]): ProfilerSpan[] {
	const result: ProfilerSpan[] = [];
	const visited = new Set<string>();
	function walk(span: ProfilerSpan): void {
		if (visited.has(span.spanId)) return;
		visited.add(span.spanId);
		result.push(span);
		for (const child of span.children) {
			walk(child);
		}
	}
	for (const root of roots) {
		walk(root);
	}
	return result;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function computeSummary(
	flatSpans: ProfilerSpan[],
	metricsMap: Map<string, SessionMetrics>,
	sessions: AgentSession[],
): TraceSummary {
	const agentNames = new Set<string>();
	for (const s of flatSpans) {
		if (s.kind === "session") {
			agentNames.add(s.agentName);
		}
	}

	let totalCostUsd = 0;
	let hasCost = false;
	const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
	const byCapability: Record<string, { count: number; durationMs: number; costUsd: number }> = {};

	const capMap = new Map<string, string>();
	for (const s of sessions) {
		capMap.set(s.agentName, s.capability);
	}

	for (const [agentName, metrics] of metricsMap) {
		tokens.input += metrics.inputTokens;
		tokens.output += metrics.outputTokens;
		tokens.cacheRead += metrics.cacheReadTokens;
		tokens.cacheCreation += metrics.cacheCreationTokens;
		if (metrics.estimatedCostUsd !== null) {
			totalCostUsd += metrics.estimatedCostUsd;
			hasCost = true;
		}

		const cap = capMap.get(agentName) ?? "unknown";
		const entry = byCapability[cap] ?? { count: 0, durationMs: 0, costUsd: 0 };
		entry.count += 1;
		entry.durationMs += metrics.durationMs;
		entry.costUsd += metrics.estimatedCostUsd ?? 0;
		byCapability[cap] = entry;
	}

	// Total duration = trace extent
	let start = 0;
	let end = 0;
	if (flatSpans.length > 0) {
		start = Number.POSITIVE_INFINITY;
		for (const s of flatSpans) {
			if (s.startTimeMs < start) start = s.startTimeMs;
			const e = s.endTimeMs ?? s.startTimeMs;
			if (e > end) end = e;
		}
	}

	return {
		agentCount: agentNames.size,
		spanCount: flatSpans.length,
		totalDurationMs: end - start,
		totalCostUsd: hasCost ? totalCostUsd : null,
		tokens,
		byCapability,
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runToInfo(run: Run): RunInfo {
	return {
		id: run.id,
		startedAt: run.startedAt,
		completedAt: run.completedAt,
		status: run.status,
		agentCount: run.agentCount,
		coordinatorName: run.coordinatorName,
	};
}
