import type { EventStore } from "../../types.ts";
import type { PolicyActionRecord, PolicyEvaluation } from "./types.ts";

const POLICY_AGENT_NAME = "health-policy";

/**
 * Record a single policy evaluation event into the event store.
 *
 * - Non-triggered evaluations are skipped silently.
 * - Suppressed evaluations that already appear in existingHistory (same ruleId + action + suppressed)
 *   are skipped to avoid dedup noise.
 * - Fire-and-forget: never throws.
 */
export function recordPolicyEvent(
	eventStore: EventStore,
	evaluation: PolicyEvaluation,
	runId: string | null,
	existingHistory: PolicyActionRecord[] = [],
): void {
	try {
		if (!evaluation.triggered) return;

		const { rule, suppressed, dryRun, executedAt } = evaluation;

		// Suppression dedup: skip if this exact suppressed record already exists in history
		if (suppressed) {
			const alreadyRecorded = existingHistory.some(
				(r) => r.ruleId === rule.id && r.action === rule.action && r.suppressed === true,
			);
			if (alreadyRecorded) return;
		}

		const details = buildDetails(evaluation);

		const record: PolicyActionRecord = {
			action: rule.action,
			ruleId: rule.id,
			triggered: true,
			suppressed,
			dryRun,
			details,
			timestamp: executedAt ?? new Date().toISOString(),
		};

		const level = dryRun || suppressed ? "warn" : "info";

		eventStore.insert({
			runId,
			agentName: POLICY_AGENT_NAME,
			sessionId: null,
			eventType: "custom",
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			level,
			data: JSON.stringify({ type: "health_action", ...record }),
		});
	} catch {
		// Fire-and-forget: event recording must never break the caller
	}
}

/**
 * Convenience wrapper: record all evaluations in a batch.
 */
export function recordPolicyEvaluationResult(
	eventStore: EventStore,
	evaluations: PolicyEvaluation[],
	runId: string | null,
	existingHistory: PolicyActionRecord[] = [],
): void {
	for (const evaluation of evaluations) {
		recordPolicyEvent(eventStore, evaluation, runId, existingHistory);
	}
}

function buildDetails(evaluation: PolicyEvaluation): string {
	const { rule, suppressed, dryRun, suppressReason } = evaluation;
	if (suppressed) {
		return `suppressed: ${suppressReason ?? "cooldown"}`;
	}
	if (dryRun) {
		return `dry-run: would ${rule.action}`;
	}
	return `executed: ${rule.action}`;
}
