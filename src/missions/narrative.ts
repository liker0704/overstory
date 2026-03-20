/**
 * Mission narrative export.
 *
 * Converts raw StoredEvents into a human-readable mission timeline.
 * The narrative is the readable layer of the result bundle — it answers
 * "what happened during this mission?" in plain language.
 *
 * Entry points:
 *   buildNarrative(mission, events) → MissionNarrative
 *   renderNarrative(narrative)      → multi-line text string
 */

import type { Mission, StoredEvent } from "../types.ts";

// === Types ===

/**
 * A single entry in the mission narrative timeline.
 */
export interface NarrativeEvent {
	/** ISO 8601 timestamp from the source event. */
	timestamp: string;
	/** Short label for the event kind (e.g. "Phase: building"). */
	label: string;
	/** Human-readable description of what happened. */
	description: string;
	/** Name of the agent that produced this event. */
	agentName: string;
	/** The raw source event. */
	source: StoredEvent;
}

/**
 * A complete mission narrative — the full timeline plus mission metadata.
 */
export interface MissionNarrative {
	/** Mission metadata snapshot at generation time. */
	mission: {
		id: string;
		slug: string;
		objective: string;
		state: Mission["state"];
		phase: Mission["phase"];
	};
	/** Chronologically ordered narrative events. */
	events: NarrativeEvent[];
	/** ISO 8601 timestamp when this narrative was generated. */
	generatedAt: string;
}

// === Event-type label mapping ===

/** Data shape expected inside "mission" events. */
interface MissionEventData {
	kind?: string;
	from?: string;
	to?: string;
	detail?: string;
}

/**
 * Convert a StoredEvent into a NarrativeEvent, or return null to skip it.
 *
 * Skipped event types: tool_start, tool_end, turn_start, turn_end, custom.
 * These are low-level noise that add no narrative value at the mission level.
 */
function toNarrativeEvent(event: StoredEvent): NarrativeEvent | null {
	const agent = event.agentName;

	switch (event.eventType) {
		case "mission": {
			const data = parseMissionData(event.data);
			const label = missionLabel(data);
			const description = missionDescription(agent, data);
			return { timestamp: event.createdAt, label, description, agentName: agent, source: event };
		}

		case "session_start":
			return {
				timestamp: event.createdAt,
				label: "Agent started",
				description: `Agent ${agent} started a new session.`,
				agentName: agent,
				source: event,
			};

		case "session_end":
			return {
				timestamp: event.createdAt,
				label: "Agent completed",
				description: `Agent ${agent} session ended.`,
				agentName: agent,
				source: event,
			};

		case "spawn": {
			const spawnTarget = parseSpawnTarget(event.data);
			const spawnDesc = spawnTarget
				? `${agent} spawned agent ${spawnTarget}.`
				: `${agent} spawned a sub-agent.`;
			return {
				timestamp: event.createdAt,
				label: "Spawn",
				description: spawnDesc,
				agentName: agent,
				source: event,
			};
		}

		case "error": {
			const errorDetail = event.data ? `: ${event.data}` : ".";
			return {
				timestamp: event.createdAt,
				label: "Error",
				description: `Error in ${agent}${errorDetail}`,
				agentName: agent,
				source: event,
			};
		}

		case "result": {
			const resultDetail = event.data ? `: ${event.data}` : ".";
			return {
				timestamp: event.createdAt,
				label: "Result",
				description: `${agent} reported a result${resultDetail}`,
				agentName: agent,
				source: event,
			};
		}

		case "progress": {
			const progressDetail = event.data ? `: ${event.data}` : ".";
			return {
				timestamp: event.createdAt,
				label: "Progress",
				description: `${agent} progress update${progressDetail}`,
				agentName: agent,
				source: event,
			};
		}

		case "mail_sent":
			return {
				timestamp: event.createdAt,
				label: "Mail sent",
				description: `${agent} sent a mail message.`,
				agentName: agent,
				source: event,
			};

		case "mail_received":
			return {
				timestamp: event.createdAt,
				label: "Mail received",
				description: `${agent} received a mail message.`,
				agentName: agent,
				source: event,
			};

		// Low-level events — skip for narrative purposes.
		case "tool_start":
		case "tool_end":
		case "turn_start":
		case "turn_end":
		case "custom":
			return null;

		default:
			return null;
	}
}

/** Parse the JSON data field of a "mission" event. Returns empty object on failure. */
function parseMissionData(raw: string | null): MissionEventData {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as MissionEventData;
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[narrative] Failed to parse mission event data: ${msg}`);
	}
	return {};
}

/** Build a short label for a mission event. */
function missionLabel(data: MissionEventData): string {
	if (!data.kind) return "Mission event";
	switch (data.kind) {
		case "state_change":
			return `State: ${data.to ?? "?"}`;
		case "phase_change":
			return `Phase: ${data.to ?? "?"}`;
		default:
			return `Mission: ${data.kind}`;
	}
}

/** Build a human-readable description for a mission event. */
function missionDescription(agent: string, data: MissionEventData): string {
	if (!data.kind) {
		return data.detail
			? `Mission event from ${agent}: ${data.detail}`
			: `Mission event from ${agent}.`;
	}
	switch (data.kind) {
		case "state_change":
			if (data.from && data.to) {
				return `Mission state changed from ${data.from} to ${data.to}.`;
			}
			return data.to ? `Mission state changed to ${data.to}.` : "Mission state changed.";
		case "phase_change":
			if (data.from && data.to) {
				return `Mission phase advanced from ${data.from} to ${data.to}.`;
			}
			return data.to ? `Mission phase advanced to ${data.to}.` : "Mission phase changed.";
		default:
			return data.detail
				? `Mission ${data.kind} (${agent}): ${data.detail}`
				: `Mission ${data.kind} event from ${agent}.`;
	}
}

/** Extract a spawned agent name from spawn event data, if present. */
function parseSpawnTarget(raw: string | null): string | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null) {
			const obj = parsed as Record<string, unknown>;
			if (typeof obj["agentName"] === "string") return obj["agentName"];
			if (typeof obj["name"] === "string") return obj["name"];
		}
	} catch {
		// Ignore
	}
	return null;
}

// === Builder ===

/**
 * Build a MissionNarrative from a mission and its associated events.
 *
 * Events are converted to NarrativeEvents in chronological order.
 * Low-level tool events are filtered out.
 */
export function buildNarrative(mission: Mission, events: StoredEvent[]): MissionNarrative {
	const sorted = [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

	const narrativeEvents: NarrativeEvent[] = [];
	for (const event of sorted) {
		const entry = toNarrativeEvent(event);
		if (entry !== null) {
			narrativeEvents.push(entry);
		}
	}

	return {
		mission: {
			id: mission.id,
			slug: mission.slug,
			objective: mission.objective,
			state: mission.state,
			phase: mission.phase,
		},
		events: narrativeEvents,
		generatedAt: new Date().toISOString(),
	};
}

// === Renderer ===

/**
 * Render a MissionNarrative as a human-readable multi-line string.
 *
 * Format:
 *   Mission: <slug> (<state>)
 *   Objective: <objective>
 *   Phase: <phase>
 *   ─────────────────────────
 *   [timestamp] Label         Agent: description
 *   ...
 *   ─────────────────────────
 *   Generated: <generatedAt>
 */
export function renderNarrative(narrative: MissionNarrative): string {
	const { mission, events, generatedAt } = narrative;
	const sep = "─".repeat(50);

	const lines: string[] = [
		`Mission: ${mission.slug} (${mission.state})`,
		`Objective: ${mission.objective}`,
		`Phase: ${mission.phase}`,
		sep,
	];

	if (events.length === 0) {
		lines.push("  (no events recorded)");
	} else {
		for (const entry of events) {
			const ts = formatTimestamp(entry.timestamp);
			const label = entry.label.padEnd(20);
			lines.push(`[${ts}] ${label}  ${entry.agentName}: ${entry.description}`);
		}
	}

	lines.push(sep);
	lines.push(`Generated: ${generatedAt}`);

	return lines.join("\n");
}

/** Format an ISO 8601 timestamp to a compact HH:MM:SS representation. */
function formatTimestamp(iso: string): string {
	// Extract HH:MM:SS from ISO 8601 (e.g. 2026-03-12T18:48:41.946Z → 18:48:41)
	const match = /T(\d{2}:\d{2}:\d{2})/.exec(iso);
	return match?.[1] ?? iso;
}
