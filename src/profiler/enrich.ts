/**
 * Span hierarchy enrichment: stitches parentSpanId onto flat ExportSpan arrays
 * using AgentSession parent-child relationships.
 *
 * Pure function — no I/O, no mutations to input arrays.
 */

import type { AgentSession } from "../agents/types.ts";
import type { ExportSpan } from "../observability/types.ts";

/**
 * Enrich flat ExportSpans with parent-child hierarchy from session data.
 *
 * Rules:
 * 1. Session spans get parentSpanId from their agent's parentAgent lookup
 *    (i.e., the session span of the parent agent).
 * 2. Tool/turn/mail/spawn/mission spans get parentSpanId = their enclosing
 *    session span (matched by resource.sessionId, then resource.agentName).
 * 3. Spans with no matching session remain unparented (parentSpanId = null).
 *
 * Returns new array with cloned spans — originals are not mutated.
 */
export function enrichSpanHierarchy(spans: ExportSpan[], sessions: AgentSession[]): ExportSpan[] {
	// Map: agentName → AgentSession (for parentAgent lookup)
	const sessionByAgent = new Map<string, AgentSession>();
	for (const s of sessions) {
		sessionByAgent.set(s.agentName, s);
	}

	// Map: sessionId → spanId (for session spans — to link children to their session)
	// Map: agentName → spanId (fallback when sessionId is null/missing)
	const sessionSpanBySessionId = new Map<string, string>();
	const sessionSpanByAgent = new Map<string, string>();

	// Map: agentName → spanId of their session span (for agent-level parenting)
	// First pass: identify session spans
	for (const span of spans) {
		if (span.kind === "session") {
			const sid = span.resource.sessionId;
			if (sid) {
				sessionSpanBySessionId.set(sid, span.spanId);
			}
			// For agentName, use the last session span seen (handles restarts — latest wins)
			sessionSpanByAgent.set(span.resource.agentName, span.spanId);
		}
	}

	// Second pass: enrich parentSpanId
	return spans.map((span) => {
		let parentSpanId: string | null = null;

		if (span.kind === "session") {
			// Session span → parent is the session span of parentAgent
			const agent = sessionByAgent.get(span.resource.agentName);
			if (agent?.parentAgent) {
				parentSpanId = sessionSpanByAgent.get(agent.parentAgent) ?? null;
			}
		} else {
			// Non-session span → parent is the enclosing session span for this agent
			// Try sessionId first (handles agent restarts), then agentName
			const sid = span.resource.sessionId;
			if (sid) {
				parentSpanId = sessionSpanBySessionId.get(sid) ?? null;
			}
			if (parentSpanId === null) {
				parentSpanId = sessionSpanByAgent.get(span.resource.agentName) ?? null;
			}
		}

		if (parentSpanId === span.parentSpanId) {
			return span; // No change needed
		}

		return { ...span, parentSpanId };
	});
}
