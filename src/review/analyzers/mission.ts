/**
 * Mission analyzer — deterministic scoring of completed mission runs.
 */

import type { Mission } from "../../types.ts";
import { computeOverallScore, scorePresence } from "../dimensions.ts";
import type { DimensionScore, InsertReviewRecord } from "../types.ts";

export interface MissionReviewInput {
	mission: Mission;
	eventCount: number;
	errorCount: number;
	agentCount: number;
	completedSessionCount: number;
	totalSessionCount: number;
	hasBundleExport: boolean;
	durationMs: number;
}

export function analyzeMission(input: MissionReviewInput): InsertReviewRecord {
	const {
		mission,
		eventCount,
		errorCount,
		agentCount,
		completedSessionCount,
		totalSessionCount,
		hasBundleExport,
		durationMs,
	} = input;

	// clarity: objective has substance, slug follows naming convention
	const hasObjective = mission.objective.length > 10;
	const hasValidSlug = /^[a-z0-9-]+$/.test(mission.slug);
	const clarityScore = scorePresence((hasObjective ? 1 : 0) + (hasValidSlug ? 1 : 0), 2);
	const clarityDetails = `objective length: ${mission.objective.length}, slug valid: ${hasValidSlug}`;

	// actionability: terminal state reached, artifactRoot set
	const isTerminal =
		mission.state === "completed" ||
		mission.state === "failed" ||
		mission.state === "cancelled";
	const hasArtifactRoot = mission.artifactRoot !== null && mission.artifactRoot.length > 0;
	const actionabilityScore = scorePresence((isTerminal ? 1 : 0) + (hasArtifactRoot ? 1 : 0), 2);
	const actionabilityDetails = `state: ${mission.state}, artifactRoot: ${hasArtifactRoot ? "set" : "missing"}`;

	// completeness: has events, has sessions, has bundle export, phase is 'done'
	const hasEvents = eventCount > 0;
	const hasSessions = totalSessionCount > 0;
	const isDone = mission.phase === "done";
	const completenessScore = scorePresence(
		(hasEvents ? 1 : 0) + (hasSessions ? 1 : 0) + (hasBundleExport ? 1 : 0) + (isDone ? 1 : 0),
		4,
	);
	const completenessDetails = `events: ${eventCount}, sessions: ${totalSessionCount}, bundle: ${hasBundleExport}, phase: ${mission.phase}`;

	// signal-to-noise: error ratio with low reopenCount bonus
	let signalNoiseScore: number;
	let signalNoiseDetails: string;
	if (eventCount === 0) {
		signalNoiseScore = 50;
		signalNoiseDetails = "No events recorded";
	} else {
		const errorRatio = errorCount / eventCount;
		signalNoiseScore = Math.round((1 - errorRatio) * 100);
		signalNoiseScore = Math.max(0, Math.min(100, signalNoiseScore));
		if (mission.reopenCount <= 1) {
			signalNoiseScore = Math.min(100, signalNoiseScore + 10);
		}
		signalNoiseDetails = `${errorCount} errors in ${eventCount} events, reopenCount: ${mission.reopenCount}`;
	}

	// correctness-confidence: session completion ratio, penalize high error rate
	let correctnessScore: number;
	let correctnessDetails: string;
	if (totalSessionCount === 0) {
		correctnessScore = 50;
		correctnessDetails = "No sessions to evaluate";
	} else {
		correctnessScore = Math.round((completedSessionCount / totalSessionCount) * 100);
		if (eventCount > 0 && errorCount > eventCount * 0.2) {
			correctnessScore = Math.max(0, correctnessScore - 20);
		}
		correctnessDetails = `${completedSessionCount}/${totalSessionCount} sessions completed`;
	}

	// coordination-fit: has agents, not excessive agents, has duration
	const hasAgents = agentCount > 0;
	const notExcessiveAgents = agentCount <= 20;
	const hasDuration = durationMs > 0;
	const coordinationScore = scorePresence(
		(hasAgents ? 1 : 0) + (notExcessiveAgents ? 1 : 0) + (hasDuration ? 1 : 0),
		3,
	);
	const coordinationDetails = `agents: ${agentCount}, duration: ${durationMs}ms`;

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

	const notes: string[] = [];
	if (eventCount > 0 && errorCount > eventCount * 0.2) {
		notes.push(`High error rate: ${errorCount}/${eventCount} events were errors`);
	}
	if (!hasBundleExport) {
		notes.push("No bundle export found");
	}
	if (mission.reopenCount > 3) {
		notes.push(`Mission reopened ${mission.reopenCount} times`);
	}

	return {
		subjectType: "mission",
		subjectId: mission.id,
		dimensions,
		overallScore: computeOverallScore(dimensions),
		notes,
		reviewerSource: "deterministic",
	};
}
