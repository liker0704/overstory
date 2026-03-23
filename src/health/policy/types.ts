import type { HealthGrade, HealthScore } from "../types.ts";

// Re-export for consumers that import from this module
export type { HealthGrade, HealthScore };

// === Policy Action ===

/** Actions the policy engine can take in response to health conditions. */
export type PolicyAction =
	| "pause_spawning"
	| "resume_spawning"
	| "prioritize_merger"
	| "escalate_mission_refresh"
	| "trigger_recovery";

// === Policy Condition ===

/** Comparison operator for policy conditions. */
export type PolicyConditionOperator = "lt" | "lte" | "eq" | "gt" | "gte";

/**
 * A condition that triggers a policy rule.
 *
 * When `factor` is set, compares the named factor's score against `threshold`
 * using `operator`. When `grade` is set, compares the overall health grade
 * using the GRADE_ORDER mapping.
 */
export interface PolicyCondition {
	/** Factor name from KNOWN_FACTORS. When set, compares factor score against threshold. */
	factor?: string;
	/** Numeric threshold for factor comparison (0–100). */
	threshold?: number;
	/** Overall health grade for grade-based comparison. */
	grade?: HealthGrade;
	/** Comparison operator. */
	operator: PolicyConditionOperator;
}

// === Grade Order ===

/**
 * Numeric mapping for HealthGrade values, enabling ordered comparison.
 * Lower number = worse grade.
 */
export const GRADE_ORDER: Record<HealthGrade, number> = {
	F: 0,
	D: 1,
	C: 2,
	B: 3,
	A: 4,
} as const;

// === Known Factors ===

/**
 * Valid factor names from the health scoring system.
 * Used for validating PolicyCondition.factor values.
 */
export const KNOWN_FACTORS = [
	"completion_rate",
	"stalled_rate",
	"zombie_count",
	"doctor_failures",
	"merge_quality",
	"runtime_stability",
	"resilience",
] as const satisfies readonly string[];

export type KnownFactor = (typeof KNOWN_FACTORS)[number];

// === Policy Rule ===

/** A single policy rule that maps a condition to an action. */
export interface PolicyRule {
	/** Unique identifier for this rule. */
	id: string;
	/** Action to take when the condition is met. */
	action: PolicyAction;
	/** Condition that triggers this rule. */
	condition: PolicyCondition;
	/** Minimum time in milliseconds between repeated triggers of this rule. */
	cooldownMs: number;
	/** Rule priority for ordering when multiple rules trigger simultaneously. */
	priority: "low" | "medium" | "high" | "critical";
}

// === Evaluation Results ===

/** Result of evaluating a single policy rule. */
export interface PolicyEvaluation {
	/** The rule that was evaluated. */
	rule: PolicyRule;
	/** Whether the rule's condition was met. */
	triggered: boolean;
	/** Whether the rule was suppressed (e.g., cooldown, dry-run). */
	suppressed: boolean;
	/** Human-readable reason for suppression, if applicable. */
	suppressReason?: string;
	/** Whether this evaluation ran in dry-run mode. */
	dryRun: boolean;
	/** ISO 8601 timestamp when the action was executed, if it was. */
	executedAt?: string;
}

/** Result of evaluating all policy rules against a health score. */
export interface PolicyEvaluationResult {
	/** Individual rule evaluations. */
	evaluations: PolicyEvaluation[];
	/** The health score used for evaluation. */
	score: HealthScore;
	/** ISO 8601 timestamp of this evaluation run. */
	timestamp: string;
}

// === Action Record ===

/** A record of a policy action that was (or would have been) taken. */
export interface PolicyActionRecord {
	/** The action that was taken or evaluated. */
	action: PolicyAction;
	/** ID of the rule that triggered this action. */
	ruleId: string;
	/** Whether the rule's condition was met. */
	triggered: boolean;
	/** Whether the action was suppressed. */
	suppressed: boolean;
	/** Whether this was a dry-run evaluation. */
	dryRun: boolean;
	/** Human-readable description of the action and outcome. */
	details: string;
	/** ISO 8601 timestamp when this record was created. */
	timestamp: string;
}
