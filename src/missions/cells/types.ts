/**
 * Shared cell types for mission subgraph cells.
 */

import type { CheckpointStore, MissionGraph, MissionStore, PlanReviewTier } from "../../types.ts";
import type { HandlerRegistry } from "../types.ts";

export interface ReviewCellConfig {
	tier: PlanReviewTier;
	maxRounds: number;
	artifactRoot: string;
}

export interface ReviewCellDeps {
	mailSend: (to: string, subject: string, body: string, type: string) => Promise<void>;
	checkpointStore: CheckpointStore;
	missionStore: MissionStore;
}

export interface ReviewCellDefinition {
	cellType: string;
	buildSubgraph(config: ReviewCellConfig): MissionGraph;
	buildHandlers(deps: ReviewCellDeps): HandlerRegistry;
}
