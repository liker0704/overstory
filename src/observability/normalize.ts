/**
 * Span normalizer: reconstructs ExportSpan records from StoredEvent data.
 *
 * Correlates paired events (tool_start/tool_end, session_start/session_end,
 * turn_start/turn_end) into spans with duration, and maps instantaneous events
 * (spawn, mail_sent, mission) to zero-duration spans.
 */

import type { EventQueryOptions, EventStore, StoredEvent } from "../events/types.js";
import type { ExportSpan, SpanEvent, SpanKind, SpanResource, SpanStatus } from "./types.js";

// Internal pending span awaiting its matching end event
interface PendingSpan {
	spanId: string;
	traceId: string;
	name: string;
	kind: SpanKind;
	startTime: string;
	attributes: Record<string, string | number | boolean>;
	events: SpanEvent[];
	resource: SpanResource;
	// Correlation keys
	agentName: string;
	toolName?: string;
	sessionId?: string | null;
}

function genSpanId(): string {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function genTraceId(): string {
	return crypto.randomUUID().replace(/-/g, "");
}

function buildResource(event: StoredEvent, partial: Partial<SpanResource>): SpanResource {
	return {
		agentName: event.agentName,
		runId: event.runId,
		sessionId: event.sessionId,
		taskId: partial.taskId ?? null,
		missionId: partial.missionId ?? null,
		capability: partial.capability ?? null,
	};
}

function parseData(raw: string | null): Record<string, string | number | boolean> {
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		const result: Record<string, string | number | boolean> = {};
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
				result[`event.${k}`] = v;
			}
		}
		return result;
	} catch {
		return {};
	}
}

function parseToolArgsSummary(raw: string | null): string | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			const obj = parsed as Record<string, unknown>;
			if (typeof obj.summary === "string") {
				return obj.summary;
			}
		}
		// Fallback: truncated JSON
		return raw.length > 120 ? `${raw.slice(0, 120)}...` : raw;
	} catch {
		return null;
	}
}

function completeSpan(
	pending: PendingSpan,
	endTime: string,
	durationMs: number | null,
	extraAttributes?: Record<string, string | number | boolean>,
): ExportSpan {
	return {
		spanId: pending.spanId,
		parentSpanId: null,
		traceId: pending.traceId,
		name: pending.name,
		kind: pending.kind,
		startTime: pending.startTime,
		endTime,
		durationMs,
		status: "ok" as SpanStatus,
		attributes: { ...pending.attributes, ...(extraAttributes ?? {}) },
		events: pending.events,
		resource: pending.resource,
	};
}

function openSpan(pending: PendingSpan): ExportSpan {
	return {
		spanId: pending.spanId,
		parentSpanId: null,
		traceId: pending.traceId,
		name: pending.name,
		kind: pending.kind,
		startTime: pending.startTime,
		endTime: null,
		durationMs: null,
		status: "unset" as SpanStatus,
		attributes: pending.attributes,
		events: pending.events,
		resource: pending.resource,
	};
}

function instantSpan(
	event: StoredEvent,
	name: string,
	kind: SpanKind,
	attributes: Record<string, string | number | boolean>,
	resource: SpanResource,
): ExportSpan {
	const traceId = event.runId ? event.runId.replace(/-/g, "") : genTraceId();
	return {
		spanId: genSpanId(),
		parentSpanId: null,
		traceId,
		name,
		kind,
		startTime: event.createdAt,
		endTime: event.createdAt,
		durationMs: 0,
		status: "ok" as SpanStatus,
		attributes,
		events: [],
		resource,
	};
}

/**
 * Reconstruct ExportSpan records from a list of StoredEvent objects.
 *
 * Pure function — no I/O. Errors in per-event processing are logged via
 * console.warn and that event is skipped so normalization continues.
 */
export function normalizeSpans(
	events: StoredEvent[],
	resource: Partial<SpanResource>,
): ExportSpan[] {
	const output: ExportSpan[] = [];

	// Pending state for paired events
	// Key for tool: `${agentName}:${toolName}`
	const pendingTools = new Map<string, PendingSpan>();
	// Key for session: `${agentName}:${sessionId ?? ""}`
	const pendingSession = new Map<string, PendingSpan>();
	// Stack per agent for LIFO turn matching
	const pendingTurnStacks = new Map<string, PendingSpan[]>();

	// All currently open spans (for attaching error events) — ordered by insertion
	// We store references so mutations (push to events[]) propagate to output via openSpan finalization,
	// but since we need to finalize open spans at end, we track them separately.
	const openSpans: PendingSpan[] = [];

	function getOrCreateTurnStack(agentName: string): PendingSpan[] {
		let stack = pendingTurnStacks.get(agentName);
		if (!stack) {
			stack = [];
			pendingTurnStacks.set(agentName, stack);
		}
		return stack;
	}

	for (const event of events) {
		try {
			const res = buildResource(event, resource);
			const traceId = event.runId ? event.runId.replace(/-/g, "") : genTraceId();
			const dataAttrs = parseData(event.data);
			const baseAttrs: Record<string, string | number | boolean> = {
				"event.level": event.level,
				...dataAttrs,
			};

			switch (event.eventType) {
				case "tool_start": {
					if (!event.toolName) break;
					const key = `${event.agentName}:${event.toolName}`;
					const argsSummary = parseToolArgsSummary(event.toolArgs);
					const attrs: Record<string, string | number | boolean> = {
						...baseAttrs,
						"tool.name": event.toolName,
					};
					if (argsSummary !== null) {
						attrs["tool.args.summary"] = argsSummary;
					}
					const pending: PendingSpan = {
						spanId: genSpanId(),
						traceId,
						name: `tool:${event.toolName}`,
						kind: "tool",
						startTime: event.createdAt,
						attributes: attrs,
						events: [],
						resource: res,
						agentName: event.agentName,
						toolName: event.toolName,
					};
					pendingTools.set(key, pending);
					openSpans.push(pending);
					break;
				}

				case "tool_end": {
					if (!event.toolName) break;
					const key = `${event.agentName}:${event.toolName}`;
					const pending = pendingTools.get(key);
					if (!pending) break;
					pendingTools.delete(key);
					const idx = openSpans.indexOf(pending);
					if (idx !== -1) openSpans.splice(idx, 1);
					const durationMs = event.toolDurationMs ?? null;
					const endAttrs: Record<string, string | number | boolean> = { ...baseAttrs };
					if (durationMs !== null) {
						endAttrs["tool.duration_ms"] = durationMs;
					}
					output.push(completeSpan(pending, event.createdAt, durationMs, endAttrs));
					break;
				}

				case "session_start": {
					const sessionKey = `${event.agentName}:${event.sessionId ?? ""}`;
					const pending: PendingSpan = {
						spanId: genSpanId(),
						traceId,
						name: `session:${event.agentName}`,
						kind: "session",
						startTime: event.createdAt,
						attributes: { ...baseAttrs },
						events: [],
						resource: res,
						agentName: event.agentName,
						sessionId: event.sessionId,
					};
					pendingSession.set(sessionKey, pending);
					openSpans.push(pending);
					break;
				}

				case "session_end": {
					const sessionKey = `${event.agentName}:${event.sessionId ?? ""}`;
					const pending = pendingSession.get(sessionKey);
					if (!pending) break;
					pendingSession.delete(sessionKey);
					const idx = openSpans.indexOf(pending);
					if (idx !== -1) openSpans.splice(idx, 1);
					const startMs = new Date(pending.startTime).getTime();
					const endMs = new Date(event.createdAt).getTime();
					const durationMs = Number.isFinite(endMs - startMs) ? endMs - startMs : null;
					output.push(completeSpan(pending, event.createdAt, durationMs, baseAttrs));
					break;
				}

				case "turn_start": {
					const stack = getOrCreateTurnStack(event.agentName);
					const pending: PendingSpan = {
						spanId: genSpanId(),
						traceId,
						name: `turn:${event.agentName}`,
						kind: "turn",
						startTime: event.createdAt,
						attributes: { ...baseAttrs },
						events: [],
						resource: res,
						agentName: event.agentName,
					};
					stack.push(pending);
					openSpans.push(pending);
					break;
				}

				case "turn_end": {
					const stack = getOrCreateTurnStack(event.agentName);
					const pending = stack.pop();
					if (!pending) break;
					const idx = openSpans.indexOf(pending);
					if (idx !== -1) openSpans.splice(idx, 1);
					const startMs = new Date(pending.startTime).getTime();
					const endMs = new Date(event.createdAt).getTime();
					const durationMs = Number.isFinite(endMs - startMs) ? endMs - startMs : null;
					output.push(completeSpan(pending, event.createdAt, durationMs, baseAttrs));
					break;
				}

				case "spawn": {
					const attrs: Record<string, string | number | boolean> = { ...baseAttrs };
					output.push(instantSpan(event, `spawn:${event.agentName}`, "spawn", attrs, res));
					break;
				}

				case "mail_sent": {
					const attrs: Record<string, string | number | boolean> = { ...baseAttrs };
					output.push(instantSpan(event, `mail:${event.agentName}`, "mail", attrs, res));
					break;
				}

				case "mission": {
					const attrs: Record<string, string | number | boolean> = { ...baseAttrs };
					output.push(instantSpan(event, `mission:${event.agentName}`, "mission", attrs, res));
					break;
				}

				case "error": {
					// Find nearest open span for same agent (last in openSpans that matches)
					let targetPending: PendingSpan | undefined;
					for (let i = openSpans.length - 1; i >= 0; i--) {
						const s = openSpans[i];
						if (s && s.agentName === event.agentName) {
							targetPending = s;
							break;
						}
					}
					if (targetPending) {
						const spanEvent: SpanEvent = {
							name: "error",
							timestamp: event.createdAt,
							attributes: { ...baseAttrs },
						};
						targetPending.events.push(spanEvent);
					} else {
						// Standalone error span
						const errAttrs: Record<string, string | number | boolean> = { ...baseAttrs };
						const errTraceId = event.runId ? event.runId.replace(/-/g, "") : genTraceId();
						output.push({
							spanId: genSpanId(),
							parentSpanId: null,
							traceId: errTraceId,
							name: `error:${event.agentName}`,
							kind: "custom",
							startTime: event.createdAt,
							endTime: event.createdAt,
							durationMs: 0,
							status: "error",
							attributes: errAttrs,
							events: [],
							resource: res,
						});
					}
					break;
				}

				// Unhandled event types (progress, result, custom, mail_received) — skip
				default:
					break;
			}
		} catch (err) {
			console.warn(`[normalize] Skipping event id=${event.id} type=${event.eventType}:`, err);
		}
	}

	// Flush all remaining open/unmatched spans
	for (const pending of openSpans) {
		output.push(openSpan(pending));
	}

	return output;
}

/**
 * Convenience: fetch events for a run, then normalize.
 */
export function normalizeEventsForRun(
	eventStore: EventStore,
	runId: string,
	resource?: Partial<SpanResource>,
): ExportSpan[] {
	const events = eventStore.getByRun(runId);
	return normalizeSpans(events, resource ?? {});
}

/**
 * Convenience: fetch events for an agent, then normalize.
 */
export function normalizeEventsForAgent(
	eventStore: EventStore,
	agentName: string,
	opts?: EventQueryOptions,
	resource?: Partial<SpanResource>,
): ExportSpan[] {
	const events = eventStore.getByAgent(agentName, opts);
	return normalizeSpans(events, resource ?? {});
}
