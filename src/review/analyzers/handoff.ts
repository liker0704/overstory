/**
 * Handoff analyzer — deterministic scoring of session handoff records.
 */

import type { SessionCheckpoint, SessionHandoff } from "../../types.ts";
import { computeOverallScore, scorePresence, scoreTextQuality } from "../dimensions.ts";
import type { DimensionScore, InsertReviewRecord } from "../types.ts";

export interface HandoffReviewInput {
	handoff: SessionHandoff;
	checkpoint: SessionCheckpoint;
}

export function analyzeHandoff(input: HandoffReviewInput): InsertReviewRecord {
	const { handoff, checkpoint } = input;

	// clarity: progressSummary quality via scoreTextQuality
	const clarityScore = scoreTextQuality(checkpoint.progressSummary);
	const clarityDetails = `progressSummary quality for ${checkpoint.progressSummary.length} chars`;

	// actionability: pendingWork non-empty and specific (contains file paths)
	const hasPending = checkpoint.pendingWork.length > 10;
	const hasPaths = /\.[a-z]+\b|\/[a-z]/.test(checkpoint.pendingWork);
	const actionabilityScore = scorePresence((hasPending ? 1 : 0) + (hasPaths ? 1 : 0), 2);
	const actionabilityDetails = `pendingWork: ${hasPending ? "non-empty" : "empty"}, file paths: ${hasPaths ? "present" : "absent"}`;

	// completeness: all checkpoint fields populated (filesModified, mulchDomains, currentBranch)
	const hasFilesModified = checkpoint.filesModified.length > 0;
	const hasMulchDomains = checkpoint.mulchDomains.length > 0;
	const hasBranch = checkpoint.currentBranch.length > 0;
	const completenessScore = scorePresence(
		(hasFilesModified ? 1 : 0) + (hasMulchDomains ? 1 : 0) + (hasBranch ? 1 : 0),
		3,
	);
	const completenessDetails = `filesModified: ${checkpoint.filesModified.length}, mulchDomains: ${checkpoint.mulchDomains.length}, branch: ${hasBranch ? "set" : "missing"}`;

	// signal-to-noise: concise progressSummary (not too long, not trivial)
	const len = checkpoint.progressSummary.length;
	let signalNoiseScore: number;
	let signalNoiseDetails: string;
	if (len === 0) {
		signalNoiseScore = 0;
		signalNoiseDetails = "Empty progressSummary";
	} else if (len < 20) {
		signalNoiseScore = 30;
		signalNoiseDetails = `Too brief: ${len} chars`;
	} else if (len > 2000) {
		signalNoiseScore = 50;
		signalNoiseDetails = `Too long: ${len} chars`;
	} else {
		signalNoiseScore = 80;
		signalNoiseDetails = `Appropriate length: ${len} chars`;
	}

	// correctness-confidence: reason not crash, valid data present
	const notCrash = handoff.reason !== "crash";
	const hasValidData = checkpoint.agentName.length > 0 && checkpoint.taskId.length > 0;
	const correctnessScore = scorePresence((notCrash ? 1 : 0) + (hasValidData ? 1 : 0), 2);
	const correctnessDetails = `reason: ${handoff.reason}, validData: ${hasValidData}`;

	// coordination-fit: correct branch set, reasonable filesModified list
	const hasBranchSet = checkpoint.currentBranch.length > 0;
	const hasReasonableFiles = checkpoint.filesModified.length <= 50;
	const coordinationScore = scorePresence((hasBranchSet ? 1 : 0) + (hasReasonableFiles ? 1 : 0), 2);
	const coordinationDetails = `branch: ${checkpoint.currentBranch || "not set"}, filesModified: ${checkpoint.filesModified.length}`;

	const dimensions: DimensionScore[] = [
		{ dimension: "clarity", score: clarityScore, details: clarityDetails },
		{ dimension: "actionability", score: actionabilityScore, details: actionabilityDetails },
		{ dimension: "completeness", score: completenessScore, details: completenessDetails },
		{ dimension: "signal-to-noise", score: signalNoiseScore, details: signalNoiseDetails },
		{
			dimension: "correctness-confidence",
			score: correctnessScore,
			details: correctnessDetails,
		},
		{ dimension: "coordination-fit", score: coordinationScore, details: coordinationDetails },
	];

	return {
		subjectType: "handoff",
		subjectId: checkpoint.agentName,
		dimensions,
		overallScore: computeOverallScore(dimensions),
		notes: [],
		reviewerSource: "deterministic",
	};
}
