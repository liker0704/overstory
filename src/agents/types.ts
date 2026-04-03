import type { ModelRef } from "../config-types.ts";

// === Agent Manifest ===

export interface AgentManifest {
	version: string;
	agents: Record<string, AgentDefinition>;
	capabilityIndex: Record<string, string[]>;
}

export interface AgentDefinition {
	file: string; // Path to base agent definition (.md)
	model: ModelRef;
	tools: string[]; // Allowed tools
	capabilities: string[]; // What this agent can do
	canSpawn: boolean; // Can this agent spawn sub-workers?
	constraints: string[]; // Machine-readable restrictions
}

/** All valid agent capability types. Used for compile-time validation. */
export const SUPPORTED_CAPABILITIES = [
	"scout",
	"builder",
	"reviewer",
	"lead",
	"merger",
	"coordinator",
	"coordinator-mission",
	"coordinator-mission-assess",
	"coordinator-mission-direct",
	"coordinator-mission-planned",
	"supervisor",
	"monitor",
	"lead-mission",
	"mission-analyst",
	"mission-analyst-planned",
	"execution-director",
	"plan-review-lead",
	"plan-devil-advocate",
	"plan-security-critic",
	"plan-performance-critic",
	"plan-second-opinion",
	"plan-simulator",
	"research-lead",
	"researcher",
] as const;

/** Union type derived from the capabilities constant. */
export type Capability = (typeof SUPPORTED_CAPABILITIES)[number];

/** Check if a capability string represents any coordinator variant. */
export function isCoordinatorCapability(cap: string | null): boolean {
	return cap !== null && (cap === "coordinator" || cap.startsWith("coordinator-mission"));
}

// === Agent Session ===

export type AgentState = "booting" | "working" | "waiting" | "completed" | "stalled" | "zombie";

export interface AgentSession {
	id: string; // Unique session ID
	agentName: string; // Unique per-session name
	capability: string; // Which agent definition
	runtime: string; // Runtime adapter name (e.g. "claude", "pi")
	worktreePath: string;
	branchName: string;
	taskId: string; // Task being worked
	tmuxSession: string; // Tmux session name
	state: AgentState;
	pid: number | null; // Claude Code PID
	parentAgent: string | null; // Who spawned this agent (null = orchestrator)
	depth: number; // 0 = direct from orchestrator
	runId: string | null; // Groups sessions in the same orchestrator run
	startedAt: string;
	lastActivity: string;
	escalationLevel: number; // Progressive nudge stage: 0=warn, 1=nudge, 2=escalate, 3=terminate
	stalledSince: string | null; // ISO timestamp when agent first entered stalled state
	rateLimitedSince: string | null; // ISO timestamp when agent was first rate-limited
	rateLimitResumesAt?: string | null; // ISO timestamp when rate limit resets (parsed from provider message)
	runtimeSessionId: string | null; // Runtime-native session ID (e.g. Claude UUID, OpenCode ses_xxx)
	transcriptPath: string | null; // Runtime-provided transcript JSONL path (decoupled from ~/.claude/)
	originalRuntime: string | null; // Pre-swap runtime (set by watchdog on rate-limit swap, cleared on resume)
	statusLine: string | null; // Agent self-reported current activity (set via `ov status set`)
	promptVersion?: string | null; // Canopy prompt version used at sling time (e.g. "builder@17")
}

// === Agent Identity ===

export interface AgentIdentity {
	name: string;
	capability: string;
	created: string;
	sessionsCompleted: number;
	expertiseDomains: string[];
	recentTasks: Array<{
		taskId: string;
		summary: string;
		completedAt: string;
	}>;
}
