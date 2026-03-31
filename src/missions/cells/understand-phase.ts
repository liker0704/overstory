/**
 * Understand-phase subgraph cell.
 *
 * Subgraph: ensure-coordinator → await-research (async gate) → evaluate (async gate)
 *           evaluate --frozen--> frozen (human gate) --answer--> evaluate
 *           evaluate --ready--> terminal
 */

import type { MissionGraph } from "../../types.ts";
import type { HandlerRegistry } from "../types.ts";
import type { PhaseCellConfig, PhaseCellDefinition, PhaseCellDeps } from "./types.ts";

const CELL_TYPE = "understand-phase";

function buildSubgraph(_config: PhaseCellConfig): MissionGraph {
	return {
		version: 1,
		nodes: [
			{
				kind: "cell",
				id: `${CELL_TYPE}:ensure-coordinator`,
				cellType: CELL_TYPE,
				handler: "ensure-coordinator",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:await-research`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: 3600,
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:evaluate`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: 3600,
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:frozen`,
				cellType: CELL_TYPE,
				gate: "human",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:complete`,
				cellType: CELL_TYPE,
				terminal: true,
			},
		],
		edges: [
			{
				from: `${CELL_TYPE}:ensure-coordinator`,
				to: `${CELL_TYPE}:await-research`,
				trigger: "coordinator_ready",
			},
			{
				from: `${CELL_TYPE}:await-research`,
				to: `${CELL_TYPE}:evaluate`,
				trigger: "research_complete",
			},
			{
				from: `${CELL_TYPE}:evaluate`,
				to: `${CELL_TYPE}:frozen`,
				trigger: "frozen",
			},
			{
				from: `${CELL_TYPE}:evaluate`,
				to: `${CELL_TYPE}:complete`,
				trigger: "ready",
			},
			{
				from: `${CELL_TYPE}:frozen`,
				to: `${CELL_TYPE}:evaluate`,
				trigger: "answer",
			},
		],
	};
}

function buildHandlers(_deps: PhaseCellDeps): HandlerRegistry {
	return {
		"ensure-coordinator": async (ctx) => {
			// Gate evaluator in mission-tick.ts handles liveness checks.
			// This handler just signals readiness to proceed.
			const mission = ctx.getMission();
			if (!mission) {
				return { trigger: "coordinator_ready" };
			}
			// If coordinator session exists, proceed
			if (mission.coordinatorSessionId) {
				return { trigger: "coordinator_ready" };
			}
			// No coordinator yet — gate evaluator in mission-tick will handle spawning
			return { trigger: "coordinator_ready" };
		},
	};
}

export const understandPhaseCell: PhaseCellDefinition = {
	cellType: CELL_TYPE,
	buildSubgraph,
	buildHandlers,
};
