import type { HealthScore } from "../types.ts";
import {
	GRADE_ORDER,
	type PolicyActionRecord,
	type PolicyConditionOperator,
	type PolicyEvaluation,
	type PolicyEvaluationResult,
	type PolicyRule,
} from "./types.ts";

function compareValues(actual: number, operator: PolicyConditionOperator, target: number): boolean {
	switch (operator) {
		case "lt":
			return actual < target;
		case "lte":
			return actual <= target;
		case "eq":
			return actual === target;
		case "gt":
			return actual > target;
		case "gte":
			return actual >= target;
	}
}

function evaluateRule(
	score: HealthScore,
	rule: PolicyRule,
	history: PolicyActionRecord[],
	dryRun: boolean,
): PolicyEvaluation {
	const { condition } = rule;
	let triggered = false;

	if (condition.factor !== undefined) {
		const factor = score.factors.find((f) => f.name === condition.factor);
		if (factor !== undefined && condition.threshold !== undefined) {
			triggered = compareValues(factor.score, condition.operator, condition.threshold);
		}
	} else if (condition.grade !== undefined) {
		triggered = compareValues(
			GRADE_ORDER[score.grade],
			condition.operator,
			GRADE_ORDER[condition.grade],
		);
	}

	let suppressed = false;
	let suppressReason: string | undefined;

	if (triggered) {
		// Find most recent non-suppressed, non-dryRun triggered record for this rule
		const recent = history
			.filter((r) => r.ruleId === rule.id && r.triggered && !r.suppressed && !r.dryRun)
			.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

		if (recent !== undefined) {
			const elapsed = Date.now() - new Date(recent.timestamp).getTime();
			const remaining = rule.cooldownMs - elapsed;
			if (remaining > 0) {
				suppressed = true;
				suppressReason = `cooldown: ${remaining}ms remaining`;
			}
		}
	}

	return { rule, triggered, suppressed, suppressReason, dryRun };
}

export function evaluatePolicy(
	score: HealthScore,
	rules: PolicyRule[],
	history: PolicyActionRecord[],
	options: { dryRun: boolean },
): PolicyEvaluationResult {
	const evaluations: PolicyEvaluation[] = rules.map((rule) =>
		evaluateRule(score, rule, history, options.dryRun),
	);

	return {
		evaluations,
		score,
		timestamp: new Date().toISOString(),
	};
}
