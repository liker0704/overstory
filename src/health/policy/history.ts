import type { EventStore } from "../../types.ts";
import type { PolicyAction, PolicyActionRecord } from "./types.ts";

export const MAX_RECORDS = 100;
export const POLICY_AGENT_NAME = "health-policy";

const POLICY_ACTIONS = new Set<string>([
	"pause_spawning",
	"resume_spawning",
	"prioritize_merger",
	"escalate_mission_refresh",
	"trigger_recovery",
]);

/**
 * Load recent policy action records from the event store within the given time window.
 *
 * Queries up to MAX_RECORDS events from the health-policy agent, filters to
 * custom events with type === 'health_action', validates shape, and returns
 * parsed PolicyActionRecord[].
 */
export function loadRecentActions(eventStore: EventStore, windowMs: number): PolicyActionRecord[] {
	const since = new Date(Date.now() - windowMs).toISOString();
	const events = eventStore.getByAgent(POLICY_AGENT_NAME, { since, limit: MAX_RECORDS });

	const records: PolicyActionRecord[] = [];

	for (const event of events) {
		if (event.eventType !== "custom") continue;
		if (!event.data) continue;

		const record = parseActionRecord(event.data);
		if (record) records.push(record);
	}

	return records;
}

function parseActionRecord(raw: string): PolicyActionRecord | null {
	try {
		const data: unknown = JSON.parse(raw);
		if (!data || typeof data !== "object") return null;

		const d = data as Record<string, unknown>;

		if (d.type !== "health_action") return null;

		if (
			typeof d.action !== "string" ||
			!POLICY_ACTIONS.has(d.action) ||
			typeof d.ruleId !== "string" ||
			typeof d.triggered !== "boolean" ||
			typeof d.suppressed !== "boolean" ||
			typeof d.dryRun !== "boolean" ||
			typeof d.details !== "string" ||
			typeof d.timestamp !== "string"
		) {
			return null;
		}

		return {
			action: d.action as PolicyAction,
			ruleId: d.ruleId,
			triggered: d.triggered,
			suppressed: d.suppressed,
			dryRun: d.dryRun,
			details: d.details,
			timestamp: d.timestamp,
		};
	} catch {
		return null;
	}
}
