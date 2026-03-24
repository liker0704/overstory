/**
 * Plan review utility functions.
 *
 * Pure helpers for plan review orchestration. The convergence loop itself
 * is agent behavior (in plan-review-lead.md), not library code.
 */

import { join, resolve } from "node:path";
import type {
	Mission,
	PlanCriticType,
	PlanCriticVerdictPayload,
	PlanReviewRequestPayload,
	PlanReviewTier,
} from "../types.ts";
import { PLAN_REVIEW_TIER_CRITICS } from "../types.ts";

/** Default max review rounds before declaring stuck. */
export const DEFAULT_MAX_ROUNDS = 3;

/**
 * Build a PlanReviewRequestPayload from mission state and config.
 */
export async function buildPlanReviewRequest(opts: {
	mission: Pick<Mission, "id">;
	artifactRoot: string;
	tier: PlanReviewTier;
	round?: number;
	previousBlockConcerns?: string[];
}): Promise<PlanReviewRequestPayload> {
	const workstreamsJsonPath = join(opts.artifactRoot, "plan", "workstreams.json");
	const briefPaths: string[] = [];

	// If workstreams.json doesn't exist yet, return empty briefPaths.
	// This is intentional: the analyst may not have finished writing it.
	// The plan-review-lead will see an empty briefPaths and can decide
	// whether to proceed or wait.
	const file = Bun.file(workstreamsJsonPath);
	const exists = await file.exists();

	if (exists) {
		const text = await file.text();
		const parsed: unknown = JSON.parse(text);

		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"workstreams" in parsed &&
			Array.isArray((parsed as Record<string, unknown>).workstreams)
		) {
			const workstreams = (parsed as Record<string, unknown>).workstreams as unknown[];
			for (const ws of workstreams) {
				if (
					typeof ws === "object" &&
					ws !== null &&
					"briefPath" in ws &&
					typeof (ws as Record<string, unknown>).briefPath === "string"
				) {
					const briefPath = (ws as Record<string, unknown>).briefPath as string;
					briefPaths.push(join(opts.artifactRoot, briefPath));
				}
			}
		}
	}

	const criticTypes = [...PLAN_REVIEW_TIER_CRITICS[opts.tier]];

	return {
		missionId: opts.mission.id,
		artifactRoot: opts.artifactRoot,
		workstreamsJsonPath,
		briefPaths,
		criticTypes,
		tier: opts.tier,
		round: opts.round ?? 1,
		previousBlockConcerns: opts.previousBlockConcerns ?? [],
	};
}

/**
 * Detect if the convergence loop is stuck (same concerns repeating).
 * Returns true if any concern ID from current round appeared in previous rounds.
 */
export function detectStuck(currentConcernIds: string[], previousConcernIds: string[]): boolean {
	const previousSet = new Set(previousConcernIds);
	for (const id of currentConcernIds) {
		if (previousSet.has(id)) {
			return true;
		}
	}
	return false;
}

/**
 * Compute confidence score from critic verdicts.
 * Formula: 0.35*coverage + 0.25*agreement + 0.20*severity + 0.10*round + 0.10*count
 *
 * - coverage: fraction of critics that reported a verdict (vs total expected)
 * - agreement: fraction of critics sharing the majority verdict
 * - severity: inverse of max severity (no concerns=1.0, low=0.8, medium=0.6, high=0.3, critical=0.0)
 * - round: earlier rounds score higher (1/round), capped at 1.0
 * - count: inverse concern density (fewer concerns = higher score)
 */
export function computeConfidence(verdicts: PlanCriticVerdictPayload[], round: number): number {
	if (verdicts.length === 0) {
		return 0;
	}

	// Rounds are 1-indexed. Guard against invalid input.
	const safeRound = Math.max(1, round);

	// Coverage: all provided verdicts count as full coverage (caller decides expected count)
	const coverage = 1.0;

	// Agreement: fraction sharing the majority verdict
	const verdictCounts = new Map<string, number>();
	for (const v of verdicts) {
		const current = verdictCounts.get(v.verdict) ?? 0;
		verdictCounts.set(v.verdict, current + 1);
	}
	let maxCount = 0;
	for (const count of verdictCounts.values()) {
		if (count > maxCount) {
			maxCount = count;
		}
	}
	const agreement = maxCount / verdicts.length;

	// Severity: based on the worst concern across all verdicts
	const severityWeights: Record<string, number> = {
		low: 0.8,
		medium: 0.6,
		high: 0.3,
		critical: 0.0,
	};
	let worstSeverityScore = 1.0; // no concerns = perfect
	for (const v of verdicts) {
		for (const concern of v.concerns) {
			const score = severityWeights[concern.severity];
			if (score !== undefined && score < worstSeverityScore) {
				worstSeverityScore = score;
			}
		}
	}
	const severity = worstSeverityScore;

	// Round: earlier rounds are more confident (diminishing returns on re-reviews)
	const roundScore = Math.min(1.0, 1.0 / safeRound);

	// Count: fewer total concerns = higher confidence
	let totalConcerns = 0;
	for (const v of verdicts) {
		totalConcerns += v.concerns.length;
	}
	// Map concern count to a 0-1 score: 0 concerns = 1.0, 10+ concerns = ~0.1
	const countScore = 1.0 / (1.0 + totalConcerns * 0.3);

	const confidence =
		0.35 * coverage + 0.25 * agreement + 0.2 * severity + 0.1 * roundScore + 0.1 * countScore;

	// Clamp to [0, 1]
	return Math.max(0, Math.min(1, confidence));
}

/**
 * Extract concern IDs that should trigger re-review from a set of verdicts.
 *
 * Includes concerns from both BLOCK and RECOMMEND_CHANGES verdicts, but only
 * those with severity "critical" or "high". Lower-severity concerns in
 * RECOMMEND_CHANGES verdicts are treated as advisory and excluded from stuck
 * detection tracking.
 */
export function extractBlockingConcernIds(verdicts: PlanCriticVerdictPayload[]): string[] {
	const ids: string[] = [];
	for (const v of verdicts) {
		if (v.verdict === "BLOCK" || v.verdict === "RECOMMEND_CHANGES") {
			for (const concern of v.concerns) {
				if (concern.severity === "critical" || concern.severity === "high") {
					ids.push(concern.id);
				}
			}
		}
	}
	return ids;
}

/**
 * [sec-input-01] Guard a briefPath against path traversal attacks.
 *
 * Returns true only if the resolved path stays within artifactRoot.
 */
export function guardBriefPath(briefPath: string, artifactRoot: string): boolean {
	const resolved = resolve(artifactRoot, briefPath);
	const normalizedRoot = resolve(artifactRoot);
	return resolved.startsWith(normalizedRoot + "/") || resolved === normalizedRoot;
}

/**
 * Determine which critic types need to be re-run based on blocking verdicts.
 */
export function criticsToRerun(verdicts: PlanCriticVerdictPayload[]): PlanCriticType[] {
	const types = new Set<PlanCriticType>();
	for (const v of verdicts) {
		if (v.verdict === "BLOCK" || v.verdict === "RECOMMEND_CHANGES") {
			types.add(v.criticType);
		}
	}
	return [...types];
}
