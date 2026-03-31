/**
 * Engine wiring bridge module.
 *
 * Bridges lifecycle.ts and engine.ts: defines the cell registry, bridge
 * functions for starting/advancing cell engines, and status queries.
 * All engine orchestration logic lives here; lifecycle.ts only calls guard
 * clauses that delegate here.
 */

import type { OverstoryConfig } from "../config-types.ts";
import type { SessionStore } from "../sessions/store.ts";
import type { CheckpointStore, Mission, MissionGraph, MissionStore } from "../types.ts";
import { architectureReviewCell } from "./cells/architecture-review.ts";
import { donePhaseCell } from "./cells/done-phase.ts";
import { executePhaseCell } from "./cells/execute-phase.ts";
import { planPhaseCell } from "./cells/plan-phase.ts";
import { planReviewCell } from "./cells/plan-review.ts";
import type {
	PhaseCellConfig,
	PhaseCellDefinition,
	ReviewCellConfig,
	ReviewCellDefinition,
} from "./cells/types.ts";
import { understandPhaseCell } from "./cells/understand-phase.ts";
import { createGraphEngine, type GraphEngine, type RunResult } from "./engine.ts";
import { DEFAULT_MISSION_GRAPH } from "./graph.ts";
import { autoAdvanceHandlers } from "./handlers/auto-advance.ts";
import { createHandlerRegistry } from "./handlers.ts";
import type { HandlerRegistry } from "./types.ts";

// === Types ===

export type { ReviewCellConfig, ReviewCellDefinition } from "./cells/types.ts";
export type { PhaseCellDefinition } from "./cells/types.ts";

export interface EngineDeps {
	checkpointStore: CheckpointStore;
	missionStore: MissionStore;
	sendMail?: (to: string, subject: string, body: string, type: string) => Promise<void>;
	sessionStore?: SessionStore;
}

export interface EngineStatus {
	cellType: string;
	currentNodeId: string;
	transitions: Array<{ fromNode: string; toNode: string; trigger: string; createdAt: string }>;
}

// === Cell registries ===

/** Review cell registry (plan-review, architecture-review). Used by startCellEngine(). */
export const CELL_REGISTRY: Record<string, ReviewCellDefinition> = {
	"plan-review": planReviewCell,
	"architecture-review": architectureReviewCell,
};

/** Phase cell registry (understand, plan, execute, done). Used by startLifecycleEngine(). */
export const PHASE_CELL_REGISTRY: Record<string, PhaseCellDefinition> = {
	"understand-phase": understandPhaseCell,
	"plan-phase": planPhaseCell,
	"execute-phase": executePhaseCell,
	"done-phase": donePhaseCell,
};

// === Bridge functions ===

/**
 * Returns true if graph execution engine is enabled via config flag.
 */
export function shouldUseEngine(mission: Mission, config: OverstoryConfig): boolean {
	// mission param reserved for future per-mission overrides
	void mission;
	return config.mission?.graphExecution !== false;
}

/**
 * Start engine for a cell type from the registry.
 *
 * Idempotent: if a checkpoint already shows critics were dispatched, resumes
 * from checkpoint rather than re-dispatching from the start.
 */
export async function startCellEngine(
	mission: Mission,
	cellType: string,
	deps: EngineDeps,
	config?: ReviewCellConfig,
): Promise<RunResult> {
	const cell = CELL_REGISTRY[cellType];
	if (!cell) {
		throw new Error(
			`Unknown cell type: '${cellType}'. Known types: ${Object.keys(CELL_REGISTRY).join(", ")}`,
		);
	}

	const defaultConfig: ReviewCellConfig = config ?? {
		tier: "full",
		maxRounds: 3,
		artifactRoot: mission.artifactRoot ?? "",
	};

	const graph = cell.buildSubgraph(defaultConfig);
	const handlers = cell.buildHandlers({
		mailSend: deps.sendMail ?? (async () => {}),
		checkpointStore: deps.checkpointStore,
		missionStore: deps.missionStore,
	});

	// Idempotent dispatch: if checkpoint exists, engine resumes from it automatically
	// (createGraphEngine resolves startNodeId from checkpoint when not specified)
	const engine = createGraphEngine({
		graph,
		handlers,
		checkpointStore: deps.checkpointStore,
		missionId: mission.id,
		missionStore: deps.missionStore,
		sendMail: deps.sendMail,
	});

	return engine.run();
}

/**
 * Advance a gate node in the active cell engine for a mission.
 *
 * Determines the active cell from the latest checkpoint node ID prefix,
 * rebuilds the engine (resuming from checkpoint), then calls advanceNode.
 */
export async function advanceCellGate(
	mission: Mission,
	trigger: string,
	data: unknown,
	deps: EngineDeps,
): Promise<RunResult> {
	// data param reserved for future use
	void data;

	const latest = deps.checkpointStore.getLatestCheckpoint(mission.id);
	if (!latest) {
		return {
			status: "error",
			steps: [],
			currentNodeId: "",
			error: `No checkpoint found for mission '${mission.id}'`,
		};
	}

	// Determine cellType from the node ID prefix (e.g., "plan-review:await-critics" → "plan-review")
	const colonIdx = latest.nodeId.indexOf(":");
	if (colonIdx === -1) {
		return {
			status: "error",
			steps: [],
			currentNodeId: latest.nodeId,
			error: `Cannot determine cellType from node ID '${latest.nodeId}'`,
		};
	}
	const cellType = latest.nodeId.slice(0, colonIdx);

	const cell = CELL_REGISTRY[cellType];
	if (!cell) {
		return {
			status: "error",
			steps: [],
			currentNodeId: latest.nodeId,
			error: `Unknown cell type '${cellType}' derived from checkpoint node '${latest.nodeId}'`,
		};
	}

	const defaultConfig: ReviewCellConfig = {
		tier: "full",
		maxRounds: 3,
		artifactRoot: mission.artifactRoot ?? "",
	};

	const graph = cell.buildSubgraph(defaultConfig);
	const handlers = cell.buildHandlers({
		mailSend: deps.sendMail ?? (async () => {}),
		checkpointStore: deps.checkpointStore,
		missionStore: deps.missionStore,
	});

	// Engine resumes from checkpoint automatically
	const engine = createGraphEngine({
		graph,
		handlers,
		checkpointStore: deps.checkpointStore,
		missionId: mission.id,
		missionStore: deps.missionStore,
		sendMail: deps.sendMail,
	});

	return engine.advanceNode(trigger);
}

/**
 * Get the current engine status for a mission, or null if no checkpoint exists.
 */
export function getCellEngineStatus(mission: Mission, deps: EngineDeps): EngineStatus | null {
	const latest = deps.checkpointStore.getLatestCheckpoint(mission.id);
	if (!latest) return null;

	const colonIdx = latest.nodeId.indexOf(":");
	if (colonIdx === -1) return null;
	const cellType = latest.nodeId.slice(0, colonIdx);

	const transitions = deps.checkpointStore.getTransitionHistory(mission.id);

	return {
		cellType,
		currentNodeId: latest.nodeId,
		transitions: transitions.map((t) => ({
			fromNode: t.fromNode,
			toNode: t.toNode,
			trigger: t.trigger,
			createdAt: t.createdAt,
		})),
	};
}

// === Lifecycle engine ===

/**
 * Build a merged handler registry from all phase cells + auto-advance handlers.
 * Combines handlers from all registered phase cells into a single registry.
 */
function buildLifecycleHandlers(deps: EngineDeps): HandlerRegistry {
	const phaseHandlers: HandlerRegistry = {};
	for (const cell of Object.values(PHASE_CELL_REGISTRY)) {
		const handlers = cell.buildHandlers({
			mailSend: deps.sendMail ?? (async () => {}),
			checkpointStore: deps.checkpointStore,
			missionStore: deps.missionStore,
			sessionStore: deps.sessionStore,
		});
		Object.assign(phaseHandlers, handlers);
	}
	return createHandlerRegistry({ ...autoAdvanceHandlers, ...phaseHandlers });
}

/**
 * Build an enhanced graph by attaching phase cell subgraphs to :active nodes.
 * Clones the default graph and sets the `subgraph` property on each phase's
 * active node to the corresponding cell's subgraph.
 */
function buildLifecycleGraph(mission: Mission): MissionGraph {
	const config: PhaseCellConfig = {
		missionId: mission.id,
		artifactRoot: mission.artifactRoot ?? "",
		projectRoot: "",
	};

	// Clone nodes (shallow — subgraph is the only mutation)
	const nodes = DEFAULT_MISSION_GRAPH.nodes.map((node) => {
		if (node.kind !== "lifecycle" || node.state !== "active") return node;

		const cellType = `${node.phase}-phase`;
		const cell = PHASE_CELL_REGISTRY[cellType];
		if (!cell) return node;

		return { ...node, subgraph: cell.buildSubgraph(config) };
	});

	return { version: 1, nodes, edges: DEFAULT_MISSION_GRAPH.edges };
}

/**
 * Create a lifecycle graph engine for a mission.
 *
 * Builds an enhanced graph with phase subgraphs attached to :active nodes,
 * merges all handler registries (built-in + auto-advance + phase cell handlers).
 * Engine is capped at maxSteps=5 for tick-based execution safety.
 */
export function startLifecycleEngine(
	mission: Mission,
	deps: EngineDeps,
	opts?: { startNodeId?: string },
): GraphEngine {
	const handlers = buildLifecycleHandlers(deps);
	const graph = buildLifecycleGraph(mission);

	return createGraphEngine({
		graph,
		handlers,
		checkpointStore: deps.checkpointStore,
		missionId: mission.id,
		missionStore: deps.missionStore,
		sendMail: deps.sendMail,
		maxSteps: 5,
		startNodeId: opts?.startNodeId,
	});
}
