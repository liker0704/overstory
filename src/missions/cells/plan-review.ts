/**
 * Plan-review executable subgraph cell.
 *
 * Implements ReviewCellDefinition with a full convergence loop:
 * dispatch-critics → collect-verdicts (async gate) → convergence
 *   → approved (terminal) | revise-plan → dispatch-critics | escalate (terminal)
 */

import type { MissionGraph, PlanCriticVerdictPayload } from "../../types.ts";
import { createHandlerRegistry } from "../handlers.ts";
import type { HandlerContext, HandlerRegistry } from "../types.ts";
import type { ReviewCellConfig, ReviewCellDefinition, ReviewCellDeps } from "./types.ts";

// Re-export security helpers
export { guardBriefPath } from "../plan-review.ts";

// === Security: sender validation ===

/**
 * [sec-trust-01] Validate that a verdict sender is in the dispatched agent set.
 *
 * Reads the dispatched agent set from checkpoint data saved by dispatch-critics.
 */
export function validateVerdictSender(sender: string, checkpoint: unknown): boolean {
	if (typeof checkpoint !== "object" || checkpoint === null) return false;
	const data = checkpoint as Record<string, unknown>;
	if (!Array.isArray(data.agents)) return false;
	const agents = data.agents as unknown[];
	return agents.some((a) => a === sender);
}

// === Subgraph builder ===

function buildSubgraph(_config: ReviewCellConfig): MissionGraph {
	return {
		version: 1,
		nodes: [
			{
				kind: "cell",
				id: "plan-review:dispatch-critics",
				cellType: "plan-review",
				handler: "dispatch-critics",
			},
			{
				kind: "cell",
				id: "plan-review:collect-verdicts",
				cellType: "plan-review",
				gate: "async",
				gateTimeout: 600,
				onTimeout: "timeout-escalate",
			},
			{
				kind: "cell",
				id: "plan-review:convergence",
				cellType: "plan-review",
				handler: "convergence",
			},
			{
				kind: "cell",
				id: "plan-review:revise-plan",
				cellType: "plan-review",
				handler: "revise-plan",
			},
			{
				kind: "cell",
				id: "plan-review:approved",
				cellType: "plan-review",
				terminal: true,
			},
			{
				kind: "cell",
				id: "plan-review:escalate",
				cellType: "plan-review",
				terminal: true,
			},
		],
		edges: [
			{
				from: "plan-review:dispatch-critics",
				to: "plan-review:collect-verdicts",
				trigger: "dispatched",
			},
			{
				from: "plan-review:collect-verdicts",
				to: "plan-review:convergence",
				trigger: "verdicts-collected",
			},
			{
				from: "plan-review:convergence",
				to: "plan-review:approved",
				trigger: "approved",
			},
			{
				from: "plan-review:convergence",
				to: "plan-review:revise-plan",
				trigger: "revision-needed",
			},
			{
				from: "plan-review:convergence",
				to: "plan-review:escalate",
				trigger: "stuck",
			},
			{
				from: "plan-review:revise-plan",
				to: "plan-review:dispatch-critics",
				trigger: "default",
			},
		],
	};
}

// === Checkpoint shapes ===

interface DispatchCheckpoint {
	dispatched: boolean;
	round: number;
	agents: string[];
}

interface ConvergenceCheckpoint {
	verdicts?: PlanCriticVerdictPayload[];
	previousBlockConcerns?: string[];
	round?: number;
	maxRounds?: number;
}

function isDispatchCheckpoint(data: unknown): data is DispatchCheckpoint {
	if (typeof data !== "object" || data === null) return false;
	const d = data as Record<string, unknown>;
	return d.dispatched === true && typeof d.round === "number" && Array.isArray(d.agents);
}

// === Handler builders ===

function buildHandlers(deps: ReviewCellDeps): HandlerRegistry {
	const dispatchCriticsHandler = async (ctx: HandlerContext) => {
		// [da-medium-r2-02] Idempotent dispatch: skip if already dispatched this round
		if (isDispatchCheckpoint(ctx.checkpoint) && ctx.checkpoint.dispatched === true) {
			return { trigger: "dispatched" };
		}

		const round = isDispatchCheckpoint(ctx.checkpoint) ? ctx.checkpoint.round + 1 : 1;
		await ctx.saveCheckpoint({ dispatched: true, round, agents: [] } satisfies DispatchCheckpoint);

		return { trigger: "dispatched" };
	};

	const convergenceHandler = async (ctx: HandlerContext) => {
		const data = ctx.checkpoint as ConvergenceCheckpoint | null;
		const verdicts = data?.verdicts ?? [];
		const previousBlockConcerns = data?.previousBlockConcerns ?? [];
		const round = data?.round ?? 1;
		const maxRounds = data?.maxRounds ?? 3;

		if (verdicts.length === 0) {
			return { trigger: "approved" };
		}

		const hasBlock = verdicts.some((v) => v.verdict === "BLOCK");
		const hasRecommend = verdicts.some((v) => v.verdict === "RECOMMEND_CHANGES");

		if (!hasBlock && !hasRecommend) {
			return { trigger: "approved" };
		}

		// Stuck detection: max rounds exceeded
		if (round >= maxRounds) {
			return { trigger: "stuck" };
		}

		// Stuck detection: same blocking concerns repeating
		if (previousBlockConcerns.length > 0) {
			const blockingIds = new Set<string>();
			for (const v of verdicts) {
				if (v.verdict === "BLOCK" || v.verdict === "RECOMMEND_CHANGES") {
					for (const concern of v.concerns) {
						if (concern.severity === "high" || concern.severity === "critical") {
							blockingIds.add(concern.id);
						}
					}
				}
			}
			const isStuck = previousBlockConcerns.some((id) => blockingIds.has(id));
			if (isStuck) {
				return { trigger: "stuck" };
			}
		}

		return { trigger: "revision-needed" };
	};

	const revisePlanHandler = async (ctx: HandlerContext) => {
		const mission = ctx.getMission();
		await deps.mailSend(
			"mission-analyst",
			"Plan review: revision needed",
			`Mission ${mission?.id ?? ctx.missionId}: please revise the plan and re-submit for review.`,
			"plan_review_request",
		);
		return { trigger: "default" };
	};

	return createHandlerRegistry({
		"dispatch-critics": dispatchCriticsHandler,
		convergence: convergenceHandler,
		"revise-plan": revisePlanHandler,
	});
}

// === Cell definition export ===

export const planReviewCell: ReviewCellDefinition = {
	cellType: "plan-review",
	buildSubgraph,
	buildHandlers,
};
