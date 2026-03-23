// Barrel file — re-exports all domain types for backward compatibility.
// New code should import directly from domain type files.

// === Value re-exports (runtime constants — MUST NOT use `export type`) ===
export { SUPPORTED_CAPABILITIES } from "./agents/types.ts";
export { ARTIFACT_STATUSES } from "./artifact-status/types.ts";
export { EVENT_LEVELS } from "./events/types.ts";
export { getThrottlePriority, PERSISTENT_CAPABILITIES } from "./headroom/priority.ts";
export {
	MAIL_DELIVERY_STATES,
	MAIL_MESSAGE_TYPES,
	PLAN_CRITIC_TYPES,
	PLAN_REVIEW_TIER_CRITICS,
} from "./mail/types.ts";
export { MISSION_PHASES, MISSION_STATES, PENDING_INPUT_KINDS } from "./missions/types.ts";

// === Type re-exports ===

// Agent types
export type {
	AgentDefinition,
	AgentIdentity,
	AgentManifest,
	AgentSession,
	AgentState,
	Capability,
} from "./agents/types.ts";
// Artifact status types
export type {
	ArtifactStatus,
	ArtifactStatusRecord,
	MissionClassifyInput,
	ReviewClassifyInput,
	SpecMetaClassifyInput,
} from "./artifact-status/types.ts";
// Canopy types
export type {
	CanopyListResult,
	CanopyPromptSection,
	CanopyPromptSummary,
	CanopyRenderResult,
	CanopyShowResult,
	CanopyValidateResult,
} from "./canopy/types.ts";
export type {
	ChangeSeverity,
	CompatConfig,
	CompatGateAction,
	CompatGateDecision,
	CompatibilityResult,
	ExportedSymbol,
	SurfaceChange,
	SurfaceChangeKind,
	SymbolKind,
	TypeSurface,
} from "./compat/types.ts";
// Compat types
export {
	CHANGE_SEVERITIES,
	COMPAT_GATE_ACTIONS,
	SURFACE_CHANGE_KINDS,
	SYMBOL_KINDS,
} from "./compat/types.ts";
// Config types
export type {
	CoordinatorExitTriggers,
	GitHubPollerConfig,
	ModelAlias,
	ModelRef,
	OverstoryConfig,
	PiRuntimeConfig,
	ProviderConfig,
	QualityGate,
	ResolvedModel,
	TaskTrackerBackend,
} from "./config-types.ts";
// Event types
export type {
	EventLevel,
	EventQueryOptions,
	EventStore,
	EventType,
	InsertEvent,
	StoredEvent,
	ToolStats,
} from "./events/types.ts";
export type {
	ThrottleAction,
	ThrottleLevel,
	ThrottlePolicy,
	ThrottleState,
} from "./headroom/throttle-types.ts";
// Headroom types
export type {
	HeadroomConfig,
	HeadroomSnapshot,
	HeadroomState,
	HeadroomStore,
} from "./headroom/types.ts";
export type {
	KnownFactor,
	PolicyAction,
	PolicyActionRecord,
	PolicyCondition,
	PolicyConditionOperator,
	PolicyEvaluation,
	PolicyEvaluationResult,
	PolicyRule,
} from "./health/policy/types.ts";
// Health policy types
export { GRADE_ORDER, KNOWN_FACTORS } from "./health/policy/types.ts";
// Mail types
export type {
	AnalystRecommendationPayload,
	AnalystResolutionPayload,
	AssignPayload,
	DecisionGatePayload,
	DispatchPayload,
	EscalationPayload,
	ExecutionGuidancePayload,
	ExecutionHandoffItemPayload,
	ExecutionHandoffPayload,
	HealthCheckPayload,
	IngressCategory,
	MailDeliveryState,
	MailMessage,
	MailMessageType,
	MailPayloadMap,
	MailProtocolType,
	MailSemanticType,
	MergedPayload,
	MergeFailedPayload,
	MergeReadyPayload,
	MissionFindingPayload,
	MissionResolutionPayload,
	PlanCriticConcern,
	PlanCriticType,
	PlanCriticVerdictPayload,
	PlanReviewConsolidatedPayload,
	PlanReviewRequestPayload,
	PlanReviewTier,
	PlanReviewVerdict,
	PlanRevisionCompletePayload,
	RateLimitedPayload,
	WorkerDonePayload,
} from "./mail/types.ts";
// Merge types
export type {
	ConflictHistory,
	MergeEntry,
	MergeResult,
	ParsedConflictPattern,
	ResolutionTier,
} from "./merge/types.ts";
// Metrics types
export type { SessionMetrics, TokenSnapshot } from "./metrics/types.ts";
// Mission types
export type {
	GraphTransitionResult,
	InsertMission,
	Mission,
	MissionGraph,
	MissionGraphEdge,
	MissionGraphNode,
	MissionPhase,
	MissionState,
	MissionStore,
	MissionSummary,
	PendingInputKind,
} from "./missions/types.ts";
// Mulch types
export type {
	MulchCompactResult,
	MulchDiffResult,
	MulchDoctorResult,
	MulchLearnResult,
	MulchPruneResult,
	MulchReadyResult,
	MulchStatus,
} from "./mulch/types.ts";
// Reminder types
export type { ReminderConfig, ReminderPolicy, TemporalSignals } from "./reminders/types.ts";
// Resilience types
export type {
	CircuitBreakerConfig,
	CircuitBreakerState,
	RerouteConfig,
	RerouteDecision,
	ResilienceConfig,
	RetryConfig,
	RetryRecord,
} from "./resilience/types.ts";
// Session types
export type {
	AgentLayers,
	FileProfile,
	InsertRun,
	InsightAnalysis,
	Run,
	RunStatus,
	RunStore,
	SessionCheckpoint,
	SessionHandoff,
	SessionInsight,
	ToolProfile,
} from "./sessions/types.ts";

// === Types that remain directly in this file ===

import type { AgentState } from "./agents/types.ts";
import type { QualityGate } from "./config-types.ts";

// === Overlay ===

export interface OverlayConfig {
	agentName: string;
	taskId: string;
	specPath: string | null;
	branchName: string;
	worktreePath: string;
	fileScope: string[];
	mulchDomains: string[];
	parentAgent: string | null;
	depth: number;
	canSpawn: boolean;
	capability: string;
	/** Full content of the base agent definition file (Layer 1: role-specific HOW). */
	baseDefinition: string;
	/** Rendered profile content from canopy (Layer 2: deployment-specific WHAT KIND). Inserted between base definition and assignment. */
	profileContent?: string;
	/** Pre-fetched mulch expertise output to embed directly in the overlay. */
	mulchExpertise?: string;
	/** When true, lead agents should skip Phase 1 (scout) and go straight to Phase 2 (build). */
	skipScout?: boolean;
	/** When true, lead agents should skip Phase 3 review and self-verify instead. */
	skipReview?: boolean;
	/** Per-lead max agents ceiling override from dispatch. Injected into overlay for lead visibility. */
	maxAgentsOverride?: number;
	trackerCli?: string; // "sd" or "bd"
	trackerName?: string; // "seeds" or "beads"
	/** Quality gate commands for the agent overlay. Falls back to defaults if undefined. */
	qualityGates?: QualityGate[];
	/** Relative path to the instruction file within the worktree (runtime-specific). Defaults to .claude/CLAUDE.md. */
	instructionPath?: string;
}

// === Watchdog ===

export interface HealthCheck {
	agentName: string;
	timestamp: string;
	processAlive: boolean;
	tmuxAlive: boolean;
	pidAlive: boolean | null; // null when pid is unavailable
	lastActivity: string;
	state: AgentState;
	action: "none" | "escalate" | "terminate" | "investigate";
	/** Describes any conflict between observable state and recorded state. */
	reconciliationNote: string | null;
}

// === Logging ===

export interface LogEvent {
	timestamp: string;
	level: "debug" | "info" | "warn" | "error";
	event: string;
	agentName: string | null;
	data: Record<string, unknown>;
}

// === Task Groups (Batch Coordination) ===

export interface TaskGroup {
	id: string; // "group-" + nanoid(8)
	name: string;
	memberIssueIds: string[]; // beads issue IDs tracked by this group
	status: "active" | "completed";
	createdAt: string; // ISO timestamp
	completedAt: string | null; // ISO timestamp when all members closed
}

export interface TaskGroupProgress {
	group: TaskGroup;
	total: number;
	completed: number;
	inProgress: number;
	blocked: number;
	open: number;
}
