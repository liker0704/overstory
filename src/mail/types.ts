import type { Capability } from "../agents/types.ts";
import type { ResolutionTier } from "../merge/types.ts";

// === Mail (Custom SQLite) ===

/** Semantic message types (original, human-readable). */
export type MailSemanticType = "status" | "question" | "result" | "error";

/** Protocol message types for structured agent coordination. */
export type MailProtocolType =
	| "worker_done"
	| "merge_ready"
	| "merged"
	| "merge_failed"
	| "escalation"
	| "health_check"
	| "dispatch"
	| "assign"
	| "rate_limited"
	| "mission_finding"
	| "analyst_resolution"
	| "execution_guidance"
	| "analyst_recommendation"
	| "execution_handoff"
	| "mission_resolution"
	| "plan_review_request"
	| "plan_critic_verdict"
	| "plan_review_consolidated"
	| "plan_revision_complete"
	| "decision_gate"
	| "task_retried"
	| "breaker_tripped"
	| "breaker_reset"
	| "task_rerouted"
	| "reroute_recommendation"
	| "health_policy_action";

/** All valid mail message types. */
export type MailMessageType = MailSemanticType | MailProtocolType;

/** All protocol type strings as a runtime array for CHECK constraint generation. */
export const MAIL_MESSAGE_TYPES: readonly MailMessageType[] = [
	"status",
	"question",
	"result",
	"error",
	"worker_done",
	"merge_ready",
	"merged",
	"merge_failed",
	"escalation",
	"health_check",
	"dispatch",
	"assign",
	"rate_limited",
	"mission_finding",
	"analyst_resolution",
	"execution_guidance",
	"analyst_recommendation",
	"execution_handoff",
	"mission_resolution",
	"plan_review_request",
	"plan_critic_verdict",
	"plan_review_consolidated",
	"plan_revision_complete",
	"decision_gate",
	"task_retried",
	"breaker_tripped",
	"breaker_reset",
	"task_rerouted",
	"reroute_recommendation",
	"health_policy_action",
] as const;

/** Delivery state for mail reliability v2 (claim/ack semantics). */
export type MailDeliveryState = "queued" | "claimed" | "acked" | "failed" | "dead_letter";

/** All valid delivery states as a runtime array for CHECK constraint generation. */
export const MAIL_DELIVERY_STATES: readonly MailDeliveryState[] = [
	"queued",
	"claimed",
	"acked",
	"failed",
	"dead_letter",
] as const;

export interface MailMessage {
	id: string; // "msg-" + nanoid(12)
	from: string; // Agent name
	to: string; // Agent name or "orchestrator"
	subject: string;
	body: string;
	priority: "low" | "normal" | "high" | "urgent";
	type: MailMessageType;
	threadId: string | null; // Conversation threading
	payload: string | null; // JSON-encoded structured data for protocol messages
	read: boolean;
	createdAt: string; // ISO timestamp
	state: MailDeliveryState;
	claimedAt: string | null; // ISO timestamp when claimed
	attempt: number; // Retry attempt count
	nextRetryAt: string | null; // ISO timestamp for next retry
	failReason: string | null; // Why the message was nack'd or dead-lettered
	missionId: string | null; // Mission scope (null for legacy/non-mission messages)
}

// === Mail Protocol Payloads ===

/** Worker signals task completion to supervisor. */
export interface WorkerDonePayload {
	taskId: string;
	branch: string;
	exitCode: number;
	filesModified: string[];
}

/** Supervisor signals branch is verified and ready for merge. */
export interface MergeReadyPayload {
	branch: string;
	taskId: string;
	agentName: string;
	filesModified: string[];
}

/** Merger signals branch was merged successfully. */
export interface MergedPayload {
	branch: string;
	taskId: string;
	tier: ResolutionTier;
}

/** Merger signals merge failed, needs rework. */
export interface MergeFailedPayload {
	branch: string;
	taskId: string;
	conflictFiles: string[];
	errorMessage: string;
}

/** Any agent escalates an issue to a higher-level decision-maker. */
export interface EscalationPayload {
	severity: "warning" | "error" | "critical";
	taskId: string | null;
	context: string;
}

/** Watchdog probes agent liveness. */
export interface HealthCheckPayload {
	agentName: string;
	checkType: "liveness" | "readiness";
}

/** Coordinator dispatches work to a supervisor. */
export interface DispatchPayload {
	taskId: string;
	specPath: string;
	capability: Capability;
	fileScope: string[];
	/** Optional: skip scout phase for lead agents */
	skipScouts?: boolean;
	/** Optional: skip review phase for lead agents */
	skipReview?: boolean;
	/** Optional: per-lead max agent ceiling override */
	maxAgents?: number;
}

/** Supervisor assigns work to a specific worker. */
export interface AssignPayload {
	taskId: string;
	specPath: string;
	workerName: string;
	branch: string;
}

/** Agent signals it has been rate-limited by the provider. */
export interface RateLimitedPayload {
	agentName: string;
	runtime: string;
	resumesAt: string | null;
	message: string;
}

/** Category for qualifying mission-level escalations. All shared types live in types.ts. */
export type IngressCategory =
	| "cross-stream"
	| "brief-invalidating"
	| "shared-assumption-changing"
	| "accepted-semantics-risk";

/** Lead escalates a cross-stream or brief-invalidating finding to analyst. */
export interface MissionFindingPayload {
	workstreamId: string;
	category: IngressCategory;
	summary: string;
	affectedWorkstreams: string[];
}

/** Analyst resolves a finding (stays within mission contract). */
export interface AnalystResolutionPayload {
	findingThreadId: string;
	resolution: string;
	briefsToRefresh: string[];
}

/** Execution director sends operational guidance to leads. */
export interface ExecutionGuidancePayload {
	targetWorkstream: string;
	guidance: string;
	action: "pause" | "resume" | "adjust" | "proceed";
}

/** Analyst recommends action to coordinator (mission-contract impact). */
export interface AnalystRecommendationPayload {
	category: "scope_change" | "constraint_change" | "risk_escalation" | "decision_needed";
	summary: string;
	evidence: string;
}

/** Coordinator hands off execution to execution director. */
export interface ExecutionHandoffItemPayload {
	workstreamId: string;
	taskId: string;
	objective: string;
	fileScope: string[];
	briefPath: string | null;
	dependsOn: string[];
	status: "planned" | "active" | "paused" | "completed";
}

export interface ExecutionHandoffPayload {
	missionId: string;
	taskIds: string[];
	workstreamIds: string[];
	briefPaths: string[];
	dispatchCommands?: Array<{
		workstreamId: string;
		args: string[];
		command: string;
	}>;
	handoffs?: ExecutionHandoffItemPayload[];
}

/** Coordinator resolves a mission-level decision. */
export interface MissionResolutionPayload {
	decisionId: string;
	resolution: string;
	affectedWorkstreams: string[];
}

// === Plan Review Payloads ===

/** Verdict from a plan critic agent. */
export type PlanReviewVerdict = "APPROVE" | "APPROVE_WITH_NOTES" | "RECOMMEND_CHANGES" | "BLOCK";

/** Verification tier for plan review depth. */
export type PlanReviewTier = "simple" | "full" | "max";

/** Critic types available for plan review. */
export type PlanCriticType =
	| "devil-advocate"
	| "security"
	| "performance"
	| "second-opinion"
	| "simulator";

/** All critic types as a runtime array. */
export const PLAN_CRITIC_TYPES: readonly PlanCriticType[] = [
	"devil-advocate",
	"security",
	"performance",
	"second-opinion",
	"simulator",
] as const;

/** Maps verification tier to which critic types are spawned. */
export const PLAN_REVIEW_TIER_CRITICS: Record<PlanReviewTier, readonly PlanCriticType[]> = {
	simple: ["devil-advocate", "second-opinion"],
	full: ["devil-advocate", "security", "performance", "second-opinion"],
	max: ["devil-advocate", "security", "performance", "second-opinion", "simulator"],
} as const;

/** Mission Analyst requests plan review from plan-review-lead. */
export interface PlanReviewRequestPayload {
	missionId: string;
	artifactRoot: string;
	workstreamsJsonPath: string;
	briefPaths: string[];
	architectureMdPath?: string;
	testPlanYamlPath?: string;
	criticTypes: PlanCriticType[];
	tier: PlanReviewTier;
	round: number;
	previousBlockConcerns: string[];
}

/** A single concern raised by a plan critic. */
export interface PlanCriticConcern {
	id: string;
	severity: "low" | "medium" | "high" | "critical";
	summary: string;
	detail: string;
	affectedWorkstreams: string[];
}

/** Individual critic verdict sent to plan-review-lead. */
export interface PlanCriticVerdictPayload {
	criticType: PlanCriticType;
	verdict: PlanReviewVerdict;
	concerns: PlanCriticConcern[];
	notes: string[];
	round: number;
	confidence: number;
}

/** Consolidated review from plan-review-lead to mission analyst. */
export interface PlanReviewConsolidatedPayload {
	missionId: string;
	overallVerdict: PlanReviewVerdict;
	round: number;
	criticVerdicts: Array<{
		criticType: PlanCriticType;
		verdict: PlanReviewVerdict;
		concernCount: number;
	}>;
	blockingConcerns: Array<{
		criticType: PlanCriticType;
		concernId: string;
		summary: string;
	}>;
	notes: string[];
	isStuck: boolean;
	repeatedConcerns: string[];
	confidence: number | null;
}

/** Analyst signals plan revision is complete. */
export interface PlanRevisionCompletePayload {
	missionId: string;
	round: number;
	revisedArtifacts: string[];
	addressedConcerns: string[];
}

/** Agent pauses for a human-in-the-loop decision before proceeding. */
export interface DecisionGatePayload {
	/** Options for the human decision-maker to choose from. */
	options: string[];
	/** Context explaining why the decision is needed. */
	context: string;
	/** Optional deadline for the decision (ISO timestamp). */
	deadline?: string;
}

/** Agent reports a task retry attempt. */
export interface TaskRetriedPayload {
	taskId: string;
	attempt: number;
	delay: number;
	agentName: string;
	capability: string;
}

/** Circuit breaker tripped to open state. */
export interface BreakerTrippedPayload {
	capability: string;
	failureCount: number;
	threshold: number;
	cooldownMs: number;
}

/** Circuit breaker reset (closed after cooldown). */
export interface BreakerResetPayload {
	capability: string;
	previousState: string;
}

/** Task rerouted to different capability/runtime. */
export interface TaskReroutedPayload {
	taskId: string;
	fromCapability: string;
	toCapability: string;
	fromRuntime: string;
	toRuntime: string;
	reason: string;
}

/** Reroute engine recommendation for a task. */
export interface RerouteRecommendationPayload {
	taskId: string;
	capability: string;
	decision: import("../resilience/types.ts").RerouteDecision;
}

/** Health policy engine action recommendation to coordinator. */
export interface HealthPolicyActionPayload {
	ruleId: string;
	action: string;
	details: string;
}

/** Maps protocol message types to their payload interfaces. */
export interface MailPayloadMap {
	worker_done: WorkerDonePayload;
	merge_ready: MergeReadyPayload;
	merged: MergedPayload;
	merge_failed: MergeFailedPayload;
	escalation: EscalationPayload;
	health_check: HealthCheckPayload;
	dispatch: DispatchPayload;
	assign: AssignPayload;
	rate_limited: RateLimitedPayload;
	mission_finding: MissionFindingPayload;
	analyst_resolution: AnalystResolutionPayload;
	execution_guidance: ExecutionGuidancePayload;
	analyst_recommendation: AnalystRecommendationPayload;
	execution_handoff: ExecutionHandoffPayload;
	mission_resolution: MissionResolutionPayload;
	plan_review_request: PlanReviewRequestPayload;
	plan_critic_verdict: PlanCriticVerdictPayload;
	plan_review_consolidated: PlanReviewConsolidatedPayload;
	plan_revision_complete: PlanRevisionCompletePayload;
	decision_gate: DecisionGatePayload;
	task_retried: TaskRetriedPayload;
	breaker_tripped: BreakerTrippedPayload;
	breaker_reset: BreakerResetPayload;
	task_rerouted: TaskReroutedPayload;
	reroute_recommendation: RerouteRecommendationPayload;
	health_policy_action: HealthPolicyActionPayload;
}
