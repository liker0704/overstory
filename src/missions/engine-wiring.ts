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
import type {
	CheckpointStore,
	Mission,
	MissionGraph,
	MissionStore,
	MissionTier,
} from "../types.ts";
import { architectureReviewCell } from "./cells/architecture-review.ts";
import { donePhaseCell } from "./cells/done-phase.ts";
import { executeDirectPhaseCell } from "./cells/execute-direct-phase.ts";
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
import { createGraphEngine, type GraphEngine, type RunResult, type StepResult } from "./engine.ts";
import { DEFAULT_MISSION_GRAPH } from "./graph.ts";
import { autoAdvanceHandlers } from "./handlers/auto-advance.ts";
import { createHandlerRegistry } from "./handlers.ts";
import type { HandlerRegistry } from "./types.ts";

// === Types ===

export type { PhaseCellDefinition, ReviewCellConfig, ReviewCellDefinition } from "./cells/types.ts";
export type { StepResult } from "./engine.ts";

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

// === Tier-phase mapping ===

/** Which lifecycle phases are active for each mission tier. */
export const TIER_PHASES: Record<MissionTier, readonly string[]> = {
	direct: ["execute", "done"],
	planned: ["understand", "plan", "execute", "done"],
	full: ["understand", "align", "decide", "plan", "execute", "done"],
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
 * Accepts tier to conditionally swap the execute-phase cell for direct tier.
 */
export function buildLifecycleHandlers(
	deps: EngineDeps,
	tier: MissionTier = "full",
): HandlerRegistry {
	const cellDeps = {
		mailSend: deps.sendMail ?? (async () => {}),
		checkpointStore: deps.checkpointStore,
		missionStore: deps.missionStore,
		sessionStore: deps.sessionStore,
	};
	const phaseHandlers: HandlerRegistry = {};
	for (const [key, cell] of Object.entries(PHASE_CELL_REGISTRY)) {
		// Skip standard execute cell if direct tier (use direct cell instead)
		if (tier === "direct" && key === "execute-phase") continue;
		Object.assign(phaseHandlers, cell.buildHandlers(cellDeps));
	}
	// Add direct execute handlers if direct tier
	if (tier === "direct") {
		Object.assign(phaseHandlers, executeDirectPhaseCell.buildHandlers(cellDeps));
	}
	return createHandlerRegistry({ ...autoAdvanceHandlers, ...phaseHandlers });
}

/**
 * Build a tier-aware lifecycle graph by filtering phases and attaching subgraphs.
 *
 * For each tier, only the phases in TIER_PHASES[tier] are included.
 * Direct tier gets executeDirectPhaseCell instead of standard executePhaseCell.
 * tier=null missions should never reach this — callers must guard.
 */
export function buildLifecycleGraph(mission: Mission): MissionGraph {
	const tier: MissionTier = mission.tier ?? "full";
	const allowedPhases = new Set(TIER_PHASES[tier]);

	const config: PhaseCellConfig = {
		missionId: mission.id,
		artifactRoot: mission.artifactRoot ?? "",
		projectRoot: "",
	};

	// Filter nodes to only include phases in this tier
	const nodes = DEFAULT_MISSION_GRAPH.nodes
		.filter((node) => {
			if (node.kind !== "lifecycle") return false;
			return allowedPhases.has(node.phase);
		})
		.map((node) => {
			if (node.kind !== "lifecycle" || node.state !== "active") return node;

			// Tier-aware cell selection: direct tier gets direct execute cell
			const cell =
				tier === "direct" && node.phase === "execute"
					? executeDirectPhaseCell
					: PHASE_CELL_REGISTRY[`${node.phase}-phase`];
			if (!cell) return node;

			return { ...node, subgraph: cell.buildSubgraph(config) };
		});

	// Collect valid node IDs for edge filtering
	const nodeIds = new Set(nodes.map((n) => n.id));

	// Filter edges to only include edges between remaining nodes
	const edges = DEFAULT_MISSION_GRAPH.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));

	// Add direct phase_advance edges between consecutive tier phases.
	// DEFAULT_MISSION_GRAPH has edges like understand→align→decide→plan→execute.
	// When tiers skip phases (e.g., planned skips align/decide), the edges are lost.
	// We need direct edges: understand:active → plan:active for planned tier.
	const tierPhaseList = TIER_PHASES[tier];
	for (let i = 0; i < tierPhaseList.length - 1; i++) {
		const fromPhase = tierPhaseList[i];
		const toPhase = tierPhaseList[i + 1];
		if (!fromPhase || !toPhase) continue;
		const fromId = `${fromPhase}:active`;
		const toId = `${toPhase}:active`;
		// Check if a phase_advance/handoff edge already exists between these phases
		const trigger = fromPhase === "plan" && toPhase === "execute" ? "handoff" : "phase_advance";
		const exists = edges.some((e) => e.from === fromId && e.to === toId && e.trigger === trigger);
		if (!exists && nodeIds.has(fromId) && nodeIds.has(toId)) {
			edges.push({ from: fromId, to: toId, trigger, weight: 10 });
		}
	}

	return { version: 1, nodes, edges };
}

/**
 * Transition a mission's graph state via the engine using a named trigger.
 *
 * Loads the mission, creates a lifecycle engine starting from its currentNode,
 * and calls forceAdvance(trigger). Returns a StepResult — no continuation run.
 */
export async function transitionMissionViaEngine(
	missionId: string,
	trigger: string,
	deps: EngineDeps,
): Promise<StepResult> {
	const mission = deps.missionStore.getById(missionId);
	if (!mission) {
		return {
			status: "error",
			fromNodeId: "",
			toNodeId: "",
			trigger,
			error: `Mission ${missionId} not found`,
		};
	}
	if (!mission.currentNode) {
		return {
			status: "error",
			fromNodeId: "",
			toNodeId: "",
			trigger,
			error: `Mission ${missionId} has no currentNode`,
		};
	}
	// Resolve subgraph nodes to parent lifecycle node for lifecycle triggers.
	// Subgraph nodes use "{phase}-phase:{name}" convention (e.g., "execute-phase:await-leads-done").
	// Lifecycle triggers (stop, complete, suspend, resume, handoff) only have edges from
	// parent lifecycle nodes (e.g., "execute:active"), not from subgraph nodes.
	let startNodeId = mission.currentNode;
	if (startNodeId.includes("-phase:")) {
		const phasePart = startNodeId.split("-phase:")[0];
		if (phasePart) {
			startNodeId = `${phasePart}:active`;
		}
	}

	const tier: MissionTier = mission.tier ?? "full";
	const graph = buildLifecycleGraph(mission);
	const handlers = buildLifecycleHandlers(deps, tier);
	const engine = startLifecycleEngine(mission, deps, {
		startNodeId,
		graph,
		handlers,
	});
	return engine.forceAdvance(trigger);
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
	opts?: { startNodeId?: string; graph?: MissionGraph; handlers?: HandlerRegistry },
): GraphEngine {
	const tier: MissionTier = mission.tier ?? "full";
	const graph = opts?.graph ?? buildLifecycleGraph(mission);
	const handlers = opts?.handlers ?? buildLifecycleHandlers(deps, tier);

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
