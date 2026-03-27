/**
 * Engine wiring bridge module.
 *
 * Bridges lifecycle.ts and engine.ts: defines the cell registry, bridge
 * functions for starting/advancing cell engines, and status queries.
 * All engine orchestration logic lives here; lifecycle.ts only calls guard
 * clauses that delegate here.
 */

import type { OverstoryConfig } from "../config-types.ts";
import type { CheckpointStore, Mission, MissionStore } from "../types.ts";
import { architectureReviewCell } from "./cells/architecture-review.ts";
import { planReviewCell } from "./cells/plan-review.ts";
import type { ReviewCellConfig, ReviewCellDefinition } from "./cells/types.ts";
import { createGraphEngine, type RunResult } from "./engine.ts";

// === Types ===

export type { ReviewCellConfig, ReviewCellDefinition } from "./cells/types.ts";

export interface EngineDeps {
	checkpointStore: CheckpointStore;
	missionStore: MissionStore;
	sendMail?: (to: string, subject: string, body: string, type: string) => Promise<void>;
}

export interface EngineStatus {
	cellType: string;
	currentNodeId: string;
	transitions: Array<{ fromNode: string; toNode: string; trigger: string; createdAt: string }>;
}

// === Cell registry ===

export const CELL_REGISTRY: Record<string, ReviewCellDefinition> = {
	"plan-review": planReviewCell,
	"architecture-review": architectureReviewCell,
};

// === Bridge functions ===

/**
 * Returns true if graph execution engine is enabled via config flag.
 */
export function shouldUseEngine(mission: Mission, config: OverstoryConfig): boolean {
	// mission param reserved for future per-mission overrides
	void mission;
	return config.mission?.graphExecution === true;
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
