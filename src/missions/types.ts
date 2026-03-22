// === Mission Workflow Graph ===

/** A node in the mission workflow graph. */
export interface MissionGraphNode {
	/** Unique node ID, conventionally "phase:state" (e.g., "understand:active"). */
	id: string;
	/** The mission phase this node represents. */
	phase: MissionPhase;
	/** The mission state this node represents. */
	state: MissionState;
	/** Human-readable label for display. */
	label?: string;
	/** Whether this node blocks on input (human gate). */
	gate?: "human" | "auto";
	/** Whether this is a terminal (sink) node. */
	terminal?: boolean;
}

/** An edge in the mission workflow graph. */
export interface MissionGraphEdge {
	/** Source node ID. */
	from: string;
	/** Target node ID. */
	to: string;
	/** What triggers this transition (e.g. "freeze", "answer", "handoff"). */
	trigger: string;
	/** Human-readable condition description. */
	condition?: string;
	/** Weight for preferred-path rendering (higher = preferred). */
	weight?: number;
}

/** The complete mission workflow graph. */
export interface MissionGraph {
	/** Graph format version. */
	version: 1;
	/** All nodes. */
	nodes: MissionGraphNode[];
	/** All edges. */
	edges: MissionGraphEdge[];
}

/** Result of validating a transition against the graph. */
export interface GraphTransitionResult {
	/** Whether the transition is legal per the graph. */
	valid: boolean;
	/** The edge that permits this transition, if any. */
	edge: MissionGraphEdge | null;
	/** Human-readable explanation. */
	reason: string;
}

// === Mission (Long-Running Objective Tracking) ===

export type MissionState = "active" | "frozen" | "completed" | "failed" | "stopped" | "suspended";
export const MISSION_STATES: readonly MissionState[] = [
	"active",
	"frozen",
	"completed",
	"failed",
	"stopped",
	"suspended",
] as const;

export type MissionPhase = "understand" | "align" | "decide" | "plan" | "execute" | "done";
export const MISSION_PHASES: readonly MissionPhase[] = [
	"understand",
	"align",
	"decide",
	"plan",
	"execute",
	"done",
] as const;

export type PendingInputKind = "question" | "approval" | "decision" | "clarification";
export const PENDING_INPUT_KINDS: readonly PendingInputKind[] = [
	"question",
	"approval",
	"decision",
	"clarification",
] as const;

export interface Mission {
	id: string;
	slug: string;
	objective: string;
	runId: string | null;
	state: MissionState;
	phase: MissionPhase;
	firstFreezeAt: string | null;
	pendingUserInput: boolean;
	pendingInputKind: PendingInputKind | null;
	pendingInputThreadId: string | null;
	reopenCount: number;
	artifactRoot: string | null;
	pausedWorkstreamIds: string[];
	analystSessionId: string | null;
	executionDirectorSessionId: string | null;
	coordinatorSessionId: string | null;
	pausedLeadNames: string[];
	pauseReason: string | null;
	currentNode: string | null;
	startedAt: string | null;
	completedAt: string | null;
	createdAt: string;
	updatedAt: string;
	learningsExtracted: boolean;
}

export type InsertMission = Pick<Mission, "id" | "slug" | "objective"> & {
	runId?: string | null;
	artifactRoot?: string | null;
	startedAt?: string | null;
};

export interface MissionSummary {
	id: string;
	slug: string;
	objective: string;
	state: MissionState;
	phase: MissionPhase;
	pendingUserInput: boolean;
	pendingInputKind: PendingInputKind | null;
	firstFreezeAt: string | null;
	reopenCount: number;
	pausedWorkstreamCount: number;
	pauseReason: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface MissionStore {
	create(mission: InsertMission): Mission;
	getById(id: string): Mission | null;
	getBySlug(slug: string): Mission | null;
	getActive(): Mission | null;
	list(opts?: { state?: MissionState; limit?: number }): Mission[];
	delete(id: string): void;
	updateState(id: string, state: MissionState): void;
	updatePhase(id: string, phase: MissionPhase): void;
	freeze(id: string, kind: PendingInputKind, threadId: string | null): void;
	unfreeze(id: string): void;
	updatePausedWorkstreams(id: string, ids: string[]): void;
	updateArtifactRoot(id: string, path: string): void;
	bindSessions(
		id: string,
		sessions: {
			analystSessionId?: string;
			executionDirectorSessionId?: string;
			coordinatorSessionId?: string;
		},
	): void;
	bindCoordinatorSession(id: string, sessionId: string): void;
	updatePausedLeads(id: string, names: string[]): void;
	updatePauseReason(id: string, reason: string | null): void;
	start(id: string): void;
	completeMission(id: string): void;
	updateSlug(id: string, slug: string): void;
	updateObjective(id: string, objective: string): void;
	updateCurrentNode(id: string, nodeId: string): void;
	markLearningsExtracted(id: string): void;
	close(): void;
}
