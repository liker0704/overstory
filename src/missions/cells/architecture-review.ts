/**
 * Architecture-review executable subgraph cell.
 *
 * Implements ReviewCellDefinition with a full convergence loop:
 * dispatch-critics → collect-verdicts (async gate) → convergence
 *   → approved (terminal) | revise → dispatch-critics | escalate (terminal)
 */

import type { MissionGraph } from "../../types.ts";
import { createHandlerRegistry } from "../handlers.ts";
import type { HandlerContext, HandlerRegistry } from "../types.ts";
import type { ReviewCellConfig, ReviewCellDefinition, ReviewCellDeps } from "./types.ts";

// === Architecture-specific types ===

export type ArchitectureCriticRole = "structure" | "integration" | "extensibility";

export type ArchitectureConcernDimension =
	| "cohesion"
	| "coupling"
	| "abstraction"
	| "interface-stability";

export type ArchitectureReviewVerdict =
	| "APPROVE"
	| "APPROVE_WITH_NOTES"
	| "RECOMMEND_CHANGES"
	| "BLOCK";

export interface ArchitectureConcern {
	id: string;
	description: string;
	severity: "low" | "medium" | "high" | "critical";
	dimension: ArchitectureConcernDimension;
}

export interface ArchitectureCriticVerdictPayload {
	criticRole: ArchitectureCriticRole;
	verdict: ArchitectureReviewVerdict;
	concerns: ArchitectureConcern[];
	notes: string[];
	round: number;
	confidence: number;
}

// === Dimension severity weighting ===

const DIMENSION_WEIGHTS: Record<ArchitectureConcernDimension, number> = {
	coupling: 1.0,
	cohesion: 0.9,
	"interface-stability": 0.8,
	abstraction: 0.7,
};

export function weightedSeverity(
	severity: "low" | "medium" | "high" | "critical",
	dimension: ArchitectureConcernDimension,
): "low" | "medium" | "high" | "critical" {
	const weight = DIMENSION_WEIGHTS[dimension];
	if (severity === "critical") return "critical";
	if (severity === "low") return "low";
	if (severity === "high") {
		return weight >= 0.8 ? "critical" : "high";
	}
	// medium
	return weight >= 0.9 ? "high" : "medium";
}

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
				id: "arch-review:dispatch-critics",
				cellType: "arch-review",
				handler: "dispatch-critics",
			},
			{
				kind: "cell",
				id: "arch-review:collect-verdicts",
				cellType: "arch-review",
				gate: "async",
				gateTimeout: 600,
				onTimeout: "timeout-escalate",
			},
			{
				kind: "cell",
				id: "arch-review:convergence",
				cellType: "arch-review",
				handler: "convergence",
			},
			{
				kind: "cell",
				id: "arch-review:revise",
				cellType: "arch-review",
				handler: "revise",
			},
			{
				kind: "cell",
				id: "arch-review:approved",
				cellType: "arch-review",
				terminal: true,
			},
			{
				kind: "cell",
				id: "arch-review:escalate",
				cellType: "arch-review",
				terminal: true,
			},
		],
		edges: [
			{
				from: "arch-review:dispatch-critics",
				to: "arch-review:collect-verdicts",
				trigger: "dispatched",
			},
			{
				from: "arch-review:collect-verdicts",
				to: "arch-review:convergence",
				trigger: "verdicts-collected",
			},
			{
				from: "arch-review:convergence",
				to: "arch-review:approved",
				trigger: "approved",
			},
			{
				from: "arch-review:convergence",
				to: "arch-review:revise",
				trigger: "revision-needed",
			},
			{
				from: "arch-review:convergence",
				to: "arch-review:escalate",
				trigger: "stuck",
			},
			{
				from: "arch-review:revise",
				to: "arch-review:dispatch-critics",
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
	verdicts?: ArchitectureCriticVerdictPayload[];
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
						// Apply dimension-weighted severity for stuck detection
						const effective = weightedSeverity(concern.severity, concern.dimension);
						if (effective === "high" || effective === "critical") {
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

	const reviseHandler = async (ctx: HandlerContext) => {
		const mission = ctx.getMission();
		await deps.mailSend(
			"mission-analyst",
			"Architecture review: revision needed",
			`Mission ${mission?.id ?? ctx.missionId}: please revise the architecture and re-submit for review.`,
			"architecture_review_request",
		);
		return { trigger: "default" };
	};

	return createHandlerRegistry({
		"dispatch-critics": dispatchCriticsHandler,
		convergence: convergenceHandler,
		revise: reviseHandler,
	});
}

// === Cell definition export ===

export const architectureReviewCell: ReviewCellDefinition = {
	cellType: "arch-review",
	buildSubgraph,
	buildHandlers,
};
