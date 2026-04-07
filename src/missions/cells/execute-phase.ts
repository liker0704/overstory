/**
 * Execute-phase subgraph cell.
 *
 * Subgraph with dispatch loop:
 *   ensure-ed → dispatch-ready → await-ws-completion (async)
 *   await-ws-completion --ws_merged--> update-status → check-remaining
 *   check-remaining --more_ws--> dispatch-ready (LOOP, reserved for future batch dispatch)
 *   check-remaining --waiting--> await-ws-completion (LOOP)
 *   check-remaining --all_done--> complete (terminal)
 *   check-remaining --all_done_tdd--> arch-review-dispatch → arch-review (async, reserved for TDD)
 *   arch-review --approved--> check-refactor → await-refactor? → await-arch-final → complete
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
				id: `${CELL_TYPE}:ensure-ed`,
				cellType: CELL_TYPE,
				handler: "ensure-ed",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:dispatch-ready`,
				cellType: CELL_TYPE,
				handler: "dispatch-ready",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:await-ws-completion`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: 14400,
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:update-status`,
				cellType: CELL_TYPE,
				handler: "update-status",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:check-remaining`,
				cellType: CELL_TYPE,
				handler: "check-remaining",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:arch-review-dispatch`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: 120,
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:arch-review`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: 3600,
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:check-refactor`,
				cellType: CELL_TYPE,
				handler: "check-refactor",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:await-refactor`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: 14400,
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:await-arch-final`,
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
			// Main flow
			{
				from: `${CELL_TYPE}:ensure-ed`,
				to: `${CELL_TYPE}:dispatch-ready`,
				trigger: "ed_ready",
			},
			{
				from: `${CELL_TYPE}:dispatch-ready`,
				to: `${CELL_TYPE}:await-ws-completion`,
				trigger: "dispatched",
			},
			{
				from: `${CELL_TYPE}:dispatch-ready`,
				to: `${CELL_TYPE}:await-ws-completion`,
				trigger: "waiting",
			},
			// Merge detected
			{
				from: `${CELL_TYPE}:await-ws-completion`,
				to: `${CELL_TYPE}:update-status`,
				trigger: "ws_merged",
			},
			{
				from: `${CELL_TYPE}:update-status`,
				to: `${CELL_TYPE}:check-remaining`,
				trigger: "status_updated",
			},
			// Dispatch loop
			{
				from: `${CELL_TYPE}:check-remaining`,
				to: `${CELL_TYPE}:dispatch-ready`,
				trigger: "more_ws",
			},
			{
				from: `${CELL_TYPE}:check-remaining`,
				to: `${CELL_TYPE}:await-ws-completion`,
				trigger: "waiting",
			},
			// All done (no TDD)
			{
				from: `${CELL_TYPE}:check-remaining`,
				to: `${CELL_TYPE}:complete`,
				trigger: "all_done",
			},
			// All done (TDD — need arch review)
			{
				from: `${CELL_TYPE}:check-remaining`,
				to: `${CELL_TYPE}:arch-review-dispatch`,
				trigger: "all_done_tdd",
			},
			{
				from: `${CELL_TYPE}:arch-review-dispatch`,
				to: `${CELL_TYPE}:arch-review`,
				trigger: "review_dispatched",
			},
			// Arch review outcomes
			{
				from: `${CELL_TYPE}:arch-review`,
				to: `${CELL_TYPE}:check-refactor`,
				trigger: "approved",
			},
			{
				from: `${CELL_TYPE}:arch-review`,
				to: `${CELL_TYPE}:await-arch-final`,
				trigger: "stuck",
			},
			{
				from: `${CELL_TYPE}:check-refactor`,
				to: `${CELL_TYPE}:await-refactor`,
				trigger: "refactor_needed",
			},
			{
				from: `${CELL_TYPE}:check-refactor`,
				to: `${CELL_TYPE}:await-arch-final`,
				trigger: "no_refactor",
			},
			{
				from: `${CELL_TYPE}:await-refactor`,
				to: `${CELL_TYPE}:await-arch-final`,
				trigger: "refactor_done",
			},
			{
				from: `${CELL_TYPE}:await-arch-final`,
				to: `${CELL_TYPE}:complete`,
				trigger: "architecture_final",
			},
		],
	};
}

function buildHandlers(deps: PhaseCellDeps): HandlerRegistry {
	return {
		"ensure-ed": async (ctx) => {
			const mission = ctx.getMission();
			if (mission?.executionDirectorSessionId) {
				return { trigger: "ed_ready" };
			}
			// Gate evaluator in mission-tick handles ED spawn/recovery
			return { trigger: "ed_ready" };
		},

		"dispatch-ready": async (ctx) => {
			// Gate evaluator in mission-tick calls packageHandoffs() and dispatches.
			// This handler checks checkpoint for dispatch state.
			const data = ctx.checkpoint as { dispatched?: boolean; wsIds?: string[] } | null;
			if (data?.dispatched) {
				return { trigger: "dispatched" };
			}
			// No dispatch yet — gate evaluator will handle
			return { trigger: "waiting" };
		},

		"update-status": async (_ctx) => {
			return { trigger: "status_updated" };
		},

		"check-remaining": async (ctx) => {
			const mission = ctx.getMission();
			if (!mission) return { trigger: "waiting" };

			// Determine completion by checking lead session states.
			// Each workstream has a lead agent parented to the ED.
			const sessionStore = deps.sessionStore;
			if (!sessionStore) return { trigger: "waiting" };

			const edName = `execution-director-${mission.slug}`;
			const allSessions = sessionStore.getAll();
			const leadSessions = allSessions.filter(
				(s) => s.capability === "lead" && s.parentAgent === edName && s.runId === mission.runId,
			);

			// No leads dispatched yet — wait for dispatch
			if (leadSessions.length === 0) return { trigger: "waiting" };

			const terminalStates = new Set(["completed", "zombie"]);
			const activeLeads = leadSessions.filter((s) => !terminalStates.has(s.state));

			if (activeLeads.length === 0) {
				// All dispatched leads are done.
				// TDD detection requires workstream file access — handled by arch-review
				// dispatch if needed. Default to all_done for now.
				return { trigger: "all_done" };
			}

			return { trigger: "waiting" };
		},

		"check-refactor": async (ctx) => {
			const data = ctx.checkpoint as { hasRefactorSpecs?: boolean } | null;
			if (data?.hasRefactorSpecs) return { trigger: "refactor_needed" };
			return { trigger: "no_refactor" };
		},
	};
}

export const executePhaseCell: PhaseCellDefinition = {
	cellType: CELL_TYPE,
	buildSubgraph,
	buildHandlers,
};
