import type { ArtifactStalenessResult } from "../missions/artifact-staleness.ts";
import type { SpecMetaStatus } from "../missions/spec-meta.ts";

export type ArtifactStatus = "fresh" | "unscored" | "stale" | "under-target" | "superseded";

export const ARTIFACT_STATUSES: readonly ArtifactStatus[] = [
	"fresh",
	"unscored",
	"stale",
	"under-target",
	"superseded",
] as const;

// ClassifyInput interfaces for each domain:
export interface MissionClassifyInput {
	result: ArtifactStalenessResult;
}

export interface ReviewClassifyInput {
	record: { stale: boolean; overallScore: number } | null;
	scoreThreshold?: number;
}

export interface SpecMetaClassifyInput {
	meta: { status: SpecMetaStatus } | null;
}

// Status record:
export interface ArtifactStatusRecord {
	artifactId: string;
	status: ArtifactStatus;
	sourceDomain: "mission" | "review" | "spec-meta";
	classifiedAt: string;
}
