/**
 * Session analyzer — deterministic scoring of completed agent sessions.
 */

import type { AgentSession, SessionCheckpoint } from "../../types.ts";
import { computeOverallScore, scorePresence } from "../dimensions.ts";
import type { DimensionScore, InsertReviewRecord } from "../types.ts";

export interface SessionReviewInput {
	session: AgentSession;
	checkpoint: SessionCheckpoint | null;
	eventCount: number;
	errorCount: number;
	nudgeCount: number;
	mailSent: number;
	mailReceived: number;
	durationMs: number;
}

export function analyzeSession(input: SessionReviewInput): InsertReviewRecord {
	const { session, checkpoint, eventCount, errorCount, nudgeCount, mailSent } = input;

	// clarity: checkpoint quality (progressSummary + pendingWork present)
	let clarityScore: number;
	let clarityDetails: string;
	if (checkpoint === null) {
		clarityScore = 0;
		clarityDetails = "No checkpoint present";
	} else {
		const hasProgress = checkpoint.progressSummary.length > 0;
		const hasPending = checkpoint.pendingWork.length > 0;
		clarityScore = scorePresence((hasProgress ? 1 : 0) + (hasPending ? 1 : 0), 2);
		clarityDetails = `progressSummary: ${hasProgress ? "present" : "missing"}, pendingWork: ${hasPending ? "present" : "missing"}`;
	}

	// actionability: concrete pendingWork, lists filesModified
	let actionabilityScore: number;
	let actionabilityDetails: string;
	if (checkpoint === null) {
		actionabilityScore = 0;
		actionabilityDetails = "No checkpoint";
	} else {
		const hasPending = checkpoint.pendingWork.length > 10;
		const hasFiles = checkpoint.filesModified.length > 0;
		actionabilityScore = scorePresence((hasPending ? 1 : 0) + (hasFiles ? 1 : 0), 2);
		actionabilityDetails = `pendingWork: ${hasPending ? "concrete" : "empty/vague"}, filesModified: ${checkpoint.filesModified.length}`;
	}

	// completeness: completed state, has checkpoint, non-zero events
	const isCompleted = session.state === "completed";
	const hasCheckpoint = checkpoint !== null;
	const hasEvents = eventCount > 0;
	const completenessScore = scorePresence(
		(isCompleted ? 1 : 0) + (hasCheckpoint ? 1 : 0) + (hasEvents ? 1 : 0),
		3,
	);
	const completenessDetails = `state: ${session.state}, checkpoint: ${hasCheckpoint}, events: ${eventCount}`;

	// signal-to-noise: meaningful events vs nudges/errors; nudgeCount > 3 is a penalty
	let signalNoiseScore: number;
	let signalNoiseDetails: string;
	if (eventCount === 0) {
		signalNoiseScore = 70;
		signalNoiseDetails = "No events recorded";
	} else {
		const usefulEvents = Math.max(0, eventCount - errorCount - nudgeCount);
		signalNoiseScore = scorePresence(usefulEvents, eventCount);
		if (nudgeCount > 3) {
			signalNoiseScore = Math.max(0, signalNoiseScore - 20);
		}
		signalNoiseDetails = `useful: ${usefulEvents}/${eventCount} events, nudges: ${nudgeCount}`;
	}

	// correctness-confidence: error rate (errorCount / eventCount); low errors = high score
	let correctnessScore: number;
	let correctnessDetails: string;
	if (eventCount === 0) {
		correctnessScore = 100;
		correctnessDetails = "No events to evaluate";
	} else {
		const errorRate = errorCount / eventCount;
		correctnessScore = Math.round((1 - errorRate) * 100);
		correctnessDetails = `${errorCount} errors in ${eventCount} events (rate: ${(errorRate * 100).toFixed(1)}%)`;
	}

	// coordination-fit: sent worker_done mail (mailSent > 0)
	const coordinationScore = mailSent > 0 ? 100 : 30;
	const coordinationDetails = `mailSent: ${mailSent}`;

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
		subjectType: "session",
		subjectId: session.agentName,
		dimensions,
		overallScore: computeOverallScore(dimensions),
		notes: [],
		reviewerSource: "deterministic",
	};
}
