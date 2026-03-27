// === Mission Workflow Graph ===

/** A lifecycle node — represents a mission phase + state. */
export interface LifecycleGraphNode {
	kind: "lifecycle";
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
	/** Optional subgraph for composite nodes (review cells). */
	subgraph?: MissionGraph;
	/** Handler key that the execution engine resolves to a function. */
	handler?: string;
	/** Static configuration passed to handler. */
	handlerConfig?: Record<string, unknown>;
}

/** A cell node — represents a discrete workstream cell. */
export interface CellGraphNode {
	kind: "cell";
	/** Unique node ID, must start with cellType + ":" (e.g., "plan-review:dispatch"). */
	id: string;
	/** Cell type identifier (e.g., "plan-review"). */
	cellType: string;
	/** Human-readable label for display. */
	label?: string;
	/** Whether this node blocks on input. */
	gate?: "human" | "auto" | "async";
	/** Whether this is a terminal (sink) node. */
	terminal?: boolean;
	/** Handler key that the execution engine resolves to a function. */
	handler?: string;
	/** Static configuration passed to handler. */
	handlerConfig?: Record<string, unknown>;
	/** Timeout in ms for async gate resolution. */
	gateTimeout?: number;
	/** Handler key to invoke on timeout. */
	onTimeout?: string;
}

/** A node in the mission workflow graph. */
export type MissionGraphNode = LifecycleGraphNode | CellGraphNode;

/** Type guard: narrows MissionGraphNode to LifecycleGraphNode. */
export function isLifecycleNode(node: MissionGraphNode): node is LifecycleGraphNode {
	return node.kind === "lifecycle";
}

/** Type guard: narrows MissionGraphNode to CellGraphNode. */
export function isCellNode(node: MissionGraphNode): node is CellGraphNode {
	return node.kind === "cell";
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

/** Context passed to a node handler during graph execution. */
export interface HandlerContext {
	/** Mission being executed. */
	missionId: string;
	/** Current node ID. */
	nodeId: string;
	/** Current checkpoint data from prior execution, or null if none. */
	checkpoint: unknown | null;
	/** Persist checkpoint data for resumability. */
	saveCheckpoint: (data: unknown) => Promise<void>;
	/** Send a mail message from within the handler. */
	sendMail: (to: string, subject: string, body: string, type: string) => Promise<void>;
	/** Read current mission state. */
	getMission: () => Mission | null;
}

/** Result returned by a node handler after execution. */
export interface HandlerResult {
	/** Which trigger to fire after handler completes. */
	trigger: string;
	/** Optional transition data. */
	data?: Record<string, unknown>;
}

/** Registry mapping handler keys to handler functions. */
export type HandlerRegistry = Record<string, (ctx: HandlerContext) => Promise<HandlerResult>>;

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

// === Checkpoint Persistence ===

/** A persisted execution checkpoint for a graph node. */
export interface NodeCheckpoint {
	nodeId: string;
	data: unknown;
	version: number;
	schemaVersion: number;
	createdAt: string;
}

/** A recorded state transition between graph nodes. */
export interface TransitionRecord {
	fromNode: string;
	toNode: string;
	trigger: string;
	data?: unknown;
	error?: string;
	createdAt: string;
}

/** Store for per-node checkpoints and transition history. */
export interface CheckpointStore {
	/** Save checkpoint data for a node (increments version). */
	saveCheckpoint(missionId: string, nodeId: string, data: unknown): void;
	/** Get the latest checkpoint for a node. */
	getCheckpoint(
		missionId: string,
		nodeId: string,
	): { data: unknown; version: number; schemaVersion: number } | null;
	/** Get the most recently saved checkpoint across all nodes for a mission. */
	getLatestCheckpoint(missionId: string): { nodeId: string; data: unknown; version: number } | null;
	/** List all checkpoint summaries for a mission (nodeId, version, createdAt). */
	listCheckpoints(missionId: string): Array<{ nodeId: string; version: number; createdAt: string }>;
	/** Record a state transition. */
	recordTransition(
		missionId: string,
		fromNode: string,
		toNode: string,
		trigger: string,
		data?: unknown,
		error?: string,
	): void;
	/** Get paginated transition history for a mission. */
	getTransitionHistory(
		missionId: string,
		opts?: { limit?: number; offset?: number },
	): Array<{
		fromNode: string;
		toNode: string;
		trigger: string;
		createdAt: string;
		error?: string;
	}>;
	/** Atomically save checkpoint and record transition in a single transaction. */
	saveStepResult(
		missionId: string,
		fromNode: string,
		toNode: string,
		trigger: string,
		checkpointData: unknown,
	): void;
	/** Delete all checkpoints for a mission. */
	deleteCheckpoints(missionId: string): void;
}

// === Flash Quality Types ===

export type TddMode = "full" | "light" | "skip" | "refactor";
export const TDD_MODES: readonly TddMode[] = ["full", "light", "skip", "refactor"] as const;

// Architecture.md parsed representation

export interface ArchitectureComponent {
	action: string;
	file: string;
	purpose: string;
	workstream: string;
}

export interface ArchitectureInterface {
	name: string;
	workstream: string;
	confidence?: "High" | "Medium" | "Low";
	signatures: string;
	behavior: string;
	invariants: string[];
	errorCases: string[];
}

export interface ArchitectureTddAssignment {
	workstreamId: string;
	tddMode: TddMode;
	rationale: string;
}

export interface ArchitectureDecision {
	id: string;
	chosen: string;
	confidence: "High" | "Medium" | "Low";
	rejected: Array<{ option: string; reason: string }>;
}

export interface Architecture {
	context: string;
	components: ArchitectureComponent[];
	interfaces: ArchitectureInterface[];
	tddAssignments: ArchitectureTddAssignment[];
	decisions: ArchitectureDecision[];
	constraints: {
		boundaries: string[];
		patterns: string[];
		prohibitions: string[];
	};
}

// test-plan.yaml parsed representation

export interface TestPlanCase {
	id: string;
	description: string;
	type: "unit" | "integration" | "e2e" | "regression";
	expectedBehavior: string;
}

export interface TestPlanFile {
	path: string;
	description: string;
	interfaceRef: string;
	cases: TestPlanCase[];
}

export interface TestPlanSuite {
	workstreamId: string;
	tddMode: TddMode;
	files: TestPlanFile[];
}

export interface TestPlan {
	version: 1;
	missionId: string;
	architectureRef: string;
	suites: TestPlanSuite[];
}

export interface MissionStore {
	create(mission: InsertMission): Mission;
	getById(id: string): Mission | null;
	getBySlug(slug: string): Mission | null;
	getActive(): Mission | null;
	getActiveList(): Mission[];
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
	/** Access the checkpoint store backed by the same db connection. */
	checkpoints: CheckpointStore;
	close(): void;
}
