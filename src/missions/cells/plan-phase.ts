/**
 * Plan-phase subgraph cell.
 *
 * Subgraph: dispatch-planning → await-plan (async) → architect-design (async) → review
 *           review = plan-review cell subgraph (embedded)
 *           review --approved--> await-handoff (async)
 *           review --stuck--> review-stuck (async) → review | await-handoff
 *           await-handoff → terminal
 *
 * In Full tier, architect ALWAYS runs. The gate evaluator adapts artifact
 * requirements based on TDD mode (architecture.md only vs + test-plan.yaml).
 */

import type { MissionGraph } from "../../types.ts";
import type { HandlerRegistry } from "../types.ts";
import type { PhaseCellConfig, PhaseCellDefinition, PhaseCellDeps } from "./types.ts";

const CELL_TYPE = "plan-phase";

function buildSubgraph(_config: PhaseCellConfig): MissionGraph {
	return {
		version: 1,
		nodes: [
			{
				kind: "cell",
				id: `${CELL_TYPE}:dispatch-planning`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: 3600,
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:await-plan`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: 3600,
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:architect-design`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: 3600,
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:review`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: 3600,
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:review-stuck`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: 300,
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:await-handoff`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: 3600,
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
				from: `${CELL_TYPE}:dispatch-planning`,
				to: `${CELL_TYPE}:await-plan`,
				trigger: "planning_started",
			},
			{
				from: `${CELL_TYPE}:await-plan`,
				to: `${CELL_TYPE}:architect-design`,
				trigger: "plan_written",
			},
			{
				from: `${CELL_TYPE}:architect-design`,
				to: `${CELL_TYPE}:review`,
				trigger: "architect_ready",
			},
			{
				from: `${CELL_TYPE}:review`,
				to: `${CELL_TYPE}:await-handoff`,
				trigger: "approved",
			},
			{
				from: `${CELL_TYPE}:review`,
				to: `${CELL_TYPE}:review-stuck`,
				trigger: "stuck",
			},
			{
				from: `${CELL_TYPE}:review-stuck`,
				to: `${CELL_TYPE}:review`,
				trigger: "resolved",
			},
			{
				from: `${CELL_TYPE}:review-stuck`,
				to: `${CELL_TYPE}:await-handoff`,
				trigger: "override",
			},
			{
				from: `${CELL_TYPE}:await-handoff`,
				to: `${CELL_TYPE}:complete`,
				trigger: "handoff_complete",
			},
		],
	};
}

function buildHandlers(_deps: PhaseCellDeps): HandlerRegistry {
	return {};
}

export const planPhaseCell: PhaseCellDefinition = {
	cellType: CELL_TYPE,
	buildSubgraph,
	buildHandlers,
};
