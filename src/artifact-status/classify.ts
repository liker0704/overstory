import type { ArtifactStalenessResult } from "../missions/artifact-staleness.ts";
import type { SpecMetaStatus } from "../missions/spec-meta.ts";
import type { ArtifactStatus } from "./types.ts";

const DEFAULT_SCORE_THRESHOLD = 70;

export function classifyMissionArtifact(result: ArtifactStalenessResult): ArtifactStatus {
	return result.isStale ? "stale" : "fresh";
}

export function classifyReviewRecord(
	record: { stale: boolean; overallScore: number } | null,
	scoreThreshold: number = DEFAULT_SCORE_THRESHOLD,
): ArtifactStatus {
	if (record === null) return "unscored";
	if (record.stale) return "stale";
	if (record.overallScore < scoreThreshold) return "under-target";
	return "fresh";
}

export function classifySpecMeta(meta: { status: SpecMetaStatus } | null): ArtifactStatus {
	if (meta === null) return "unscored";
	switch (meta.status) {
		case "current":
			return "fresh";
		case "stale":
			return "stale";
		case "superseded":
			return "superseded";
	}
}
