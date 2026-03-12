/**
 * Mission ingress validation — selective escalation filter.
 *
 * Not every finding from a lead should reach the mission analyst. This module
 * classifies incoming MissionFinding payloads and determines whether they
 * qualify for mission-level escalation.
 *
 * Qualifying categories:
 *   cross-stream              — finding affects multiple workstreams
 *   brief-invalidating        — finding invalidates the workstream brief
 *   shared-assumption-changing — finding changes a shared assumption
 *   accepted-semantics-risk   — finding is an accepted semantics-level risk
 *
 * Non-qualifying findings should be resolved at the lead level.
 */

import type { IngressCategory, MissionFindingPayload } from "../types.ts";

// Re-export IngressCategory so callers can import it from this module.
export type { IngressCategory };

/** All valid ingress categories as a runtime array. */
export const INGRESS_CATEGORIES: readonly IngressCategory[] = [
	"cross-stream",
	"brief-invalidating",
	"shared-assumption-changing",
	"accepted-semantics-risk",
] as const;

/** Result of validating a MissionFinding for mission-level ingress. */
export interface IngressValidationResult {
	valid: boolean;
	category: IngressCategory | null;
	reason: string;
}

/**
 * Validate whether a MissionFindingPayload qualifies for mission-level ingress.
 *
 * Validation rules:
 * - cross-stream: affectedWorkstreams.length > 1
 * - brief-invalidating: trust the sender's classification
 * - shared-assumption-changing: trust the sender's classification
 * - accepted-semantics-risk: trust the sender's classification
 *
 * Non-qualifying findings produce valid=false and a reason directing the
 * sender to handle the finding at the lead level. A warning is also logged
 * to stderr.
 */
export function validateMissionIngress(payload: MissionFindingPayload): IngressValidationResult {
	const { category, affectedWorkstreams } = payload;

	switch (category) {
		case "cross-stream":
			if (affectedWorkstreams.length > 1) {
				return { valid: true, category, reason: "Finding affects multiple workstreams" };
			}
			// cross-stream category claimed but only one workstream affected
			{
				const reason =
					"cross-stream category requires affectedWorkstreams.length > 1; handle at lead level";
				return { valid: false, category: null, reason };
			}

		case "brief-invalidating":
		case "shared-assumption-changing":
		case "accepted-semantics-risk":
			return { valid: true, category, reason: `Finding classified as ${category}` };

		default: {
			const reason = `Category '${category}' does not qualify for mission-level ingress; handle at lead level`;
			return { valid: false, category: null, reason };
		}
	}
}
