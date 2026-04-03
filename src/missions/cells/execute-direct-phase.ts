/**
 * Execute-phase subgraph cell for direct tier.
 *
 * Simplified subgraph with no Execution Director:
 *   dispatch-leads → await-leads-done (async gate, 4hr timeout)
 *   await-leads-done --lead_done--> merge-all
 *   merge-all --more_leads--> await-leads-done (LOOP)
 *   merge-all --all_merged--> complete (terminal)
 *
 * Uses CELL_TYPE = "execute-phase" (same as standard cell) for
 * compatible node ID prefixes. The -phase: split in processMission()
 * extracts "execute" → parent node "execute:active".
 */

import type { MissionGraph } from "../../types.ts";
import type { HandlerRegistry } from "../types.ts";
import type { PhaseCellConfig, PhaseCellDefinition, PhaseCellDeps } from "./types.ts";

const CELL_TYPE = "execute-phase";

function buildSubgraph(_config: PhaseCellConfig): MissionGraph {
	return {
		version: 1,
		nodes: [
			{
				kind: "cell",
				id: `${CELL_TYPE}:dispatch-leads`,
				cellType: CELL_TYPE,
				handler: "dispatch-leads",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:await-leads-done`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: 14400,
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:merge-all`,
				cellType: CELL_TYPE,
				handler: "merge-all",
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
				from: `${CELL_TYPE}:dispatch-leads`,
				to: `${CELL_TYPE}:await-leads-done`,
				trigger: "dispatched",
			},
			{
				from: `${CELL_TYPE}:await-leads-done`,
				to: `${CELL_TYPE}:merge-all`,
				trigger: "lead_done",
			},
			{
				from: `${CELL_TYPE}:merge-all`,
				to: `${CELL_TYPE}:await-leads-done`,
				trigger: "more_leads",
			},
			{
				from: `${CELL_TYPE}:merge-all`,
				to: `${CELL_TYPE}:complete`,
				trigger: "all_merged",
			},
		],
	};
}

function buildHandlers(_deps: PhaseCellDeps): HandlerRegistry {
	return {
		"dispatch-leads": async (ctx) => {
			const data = ctx.checkpoint as { dispatched?: boolean } | null;
			if (data?.dispatched) {
				return { trigger: "dispatched" };
			}
			// In direct tier the coordinator dispatches leads directly.
			// Gate evaluator checks coordinator inbox for lead completion signals.
			return { trigger: "dispatched" };
		},

		"merge-all": async (ctx) => {
			const data = ctx.checkpoint as {
				allDone?: boolean;
				morePending?: boolean;
			} | null;

			if (data?.allDone) return { trigger: "all_merged" };
			if (data?.morePending) return { trigger: "more_leads" };
			return { trigger: "more_leads" };
		},
	};
}

export const executeDirectPhaseCell: PhaseCellDefinition = {
	cellType: CELL_TYPE,
	buildSubgraph,
	buildHandlers,
};
