/**
 * Shared cell types for mission subgraph cells.
 */

import type {
	CheckpointStore,
	MissionGraph,
	MissionStore,
	PlanReviewTier,
} from "../../types.ts";
import type { SessionStore } from "../../sessions/store.ts";
import type { HandlerRegistry } from "../types.ts";

// === Review cell types (plan-review, architecture-review) ===

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

// === Phase cell types (understand, plan, execute, done) ===

export interface PhaseCellConfig {
	missionId: string;
	artifactRoot: string;
	projectRoot: string;
}

export interface PhaseCellDeps {
	mailSend: (to: string, subject: string, body: string, type: string) => Promise<void>;
	checkpointStore: CheckpointStore;
	missionStore: MissionStore;
	sessionStore?: SessionStore;
}

export interface PhaseCellDefinition {
	cellType: string;
	buildSubgraph(config: PhaseCellConfig): MissionGraph;
	buildHandlers(deps: PhaseCellDeps): HandlerRegistry;
}
