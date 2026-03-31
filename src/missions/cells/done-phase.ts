/**
 * Done-phase subgraph cell.
 *
 * Subgraph: summary (async) → holdout → cleanup → terminal
 */

import type { MissionGraph } from "../../types.ts";
import type { HandlerRegistry } from "../types.ts";
import type { PhaseCellConfig, PhaseCellDefinition, PhaseCellDeps } from "./types.ts";

const CELL_TYPE = "done-phase";

function buildSubgraph(_config: PhaseCellConfig): MissionGraph {
	return {
		version: 1,
		nodes: [
			{
				kind: "cell",
				id: `${CELL_TYPE}:summary`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: 600,
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:holdout`,
				cellType: CELL_TYPE,
				handler: "holdout",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:cleanup`,
				cellType: CELL_TYPE,
				handler: "cleanup",
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
				from: `${CELL_TYPE}:summary`,
				to: `${CELL_TYPE}:holdout`,
				trigger: "summary_ready",
			},
			{
				from: `${CELL_TYPE}:holdout`,
				to: `${CELL_TYPE}:cleanup`,
				trigger: "skip",
			},
			{
				from: `${CELL_TYPE}:holdout`,
				to: `${CELL_TYPE}:cleanup`,
				trigger: "holdout_pass",
			},
			{
				from: `${CELL_TYPE}:holdout`,
				to: `${CELL_TYPE}:cleanup`,
				trigger: "holdout_fail",
			},
			{
				from: `${CELL_TYPE}:cleanup`,
				to: `${CELL_TYPE}:complete`,
				trigger: "cleanup_done",
			},
		],
	};
}

function buildHandlers(_deps: PhaseCellDeps): HandlerRegistry {
	return {
		holdout: async (ctx) => {
			// Holdout validation is optional per config.
			// Gate evaluator in mission-tick checks config and populates checkpoint.
			const data = ctx.checkpoint as { holdoutEnabled?: boolean; holdoutPassed?: boolean } | null;
			if (!data?.holdoutEnabled) return { trigger: "skip" };
			if (data.holdoutPassed) return { trigger: "holdout_pass" };
			return { trigger: "holdout_fail" };
		},

		cleanup: async (_ctx) => {
			// Cleanup is handled by gate evaluator in mission-tick:
			// - Stop persistent agents
			// - Extract learnings
			// - Commit state
			return { trigger: "cleanup_done" };
		},
	};
}

export const donePhaseCell: PhaseCellDefinition = {
	cellType: CELL_TYPE,
	buildSubgraph,
	buildHandlers,
};
