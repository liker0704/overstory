/**
 * Mission health score module.
 *
 * Computes a compact health snapshot (MissionScore) from bundle data,
 * runtime signals, and review dimensions. Surfaced in ov mission status
 * and ov health --json.
 *
 * Score model
 * -----------
 * Five factors, each scored 0–100, combined via fixed weights that sum to 1.0.
 *
 * Factor                 Weight  Description
 * ──────────────────────  ──────  ──────────────────────────────────────────────────
 * execution_progress      0.30   Phase score: understand=10 → done=100
 * error_rate              0.25   Fraction of events that are errors (inverted)
 * session_completion      0.20   completedSessions / totalSessions * 100
 * review_quality          0.15   Latest mission review overallScore (default 50 if none)
 * artifact_completeness   0.10   bundleFileCount / 7 expected files * 100
 *
 * Grade thresholds: A ≥ 85, B ≥ 70, C ≥ 55, D ≥ 40, F < 40.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import { accent, color, muted } from "../logging/color.ts";
import { thickSeparator } from "../logging/theme.ts";
import { createReviewStore } from "../review/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { Mission, MissionPhase } from "../types.ts";
import type { BundleManifest } from "./bundle.ts";

// === Types ===

export interface MissionScoreFactor {
	/** Machine-readable key (e.g. "error_rate"). */
	name: string;
	/** Human-readable display label. */
	label: string;
	/** Factor score from 0 (worst) to 100 (best). */
	score: number;
	/** Weight (0.0–1.0). All factor weights sum to 1.0. */
	weight: number;
	/** Weighted contribution: score × weight. */
	contribution: number;
	/** One-line human-readable explanation of why this score was assigned. */
	details: string;
}

export type MissionGrade = "A" | "B" | "C" | "D" | "F";

export interface MissionScore {
	/** Overall score from 0 (worst) to 100 (best). */
	overall: number;
	/** Letter grade: A ≥ 85, B ≥ 70, C ≥ 55, D ≥ 40, F < 40. */
	grade: MissionGrade;
	/** Individual factor scores with weights and explanations. */
	factors: MissionScoreFactor[];
	/** ISO 8601 timestamp when the score was computed. */
	collectedAt: string;
}

export interface MissionScoreSignals {
	phase: MissionPhase;
	totalEvents: number;
	errorEvents: number;
	totalSessions: number;
	completedSessions: number;
	reviewScore: number | null;
	bundleFileCount: number;
	expectedBundleFiles: number;
}

// === Constants ===

const FACTOR_WEIGHTS = {
	execution_progress: 0.3,
	error_rate: 0.25,
	session_completion: 0.2,
	review_quality: 0.15,
	artifact_completeness: 0.1,
} as const satisfies Record<string, number>;

const GRADE_THRESHOLDS: Array<{ min: number; grade: MissionGrade }> = [
	{ min: 85, grade: "A" },
	{ min: 70, grade: "B" },
	{ min: 55, grade: "C" },
	{ min: 40, grade: "D" },
	{ min: 0, grade: "F" },
];

const PHASE_SCORES: Record<MissionPhase, number> = {
	understand: 10,
	align: 25,
	decide: 40,
	plan: 55,
	execute: 75,
	done: 100,
};

// === Helpers ===

function clamp100(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function deriveGrade(overall: number): MissionGrade {
	for (const { min, grade } of GRADE_THRESHOLDS) {
		if (overall >= min) {
			return grade;
		}
	}
	return "F";
}

// === Signal collection ===

/**
 * Collect runtime signals for a mission.
 *
 * All store accesses are guarded with existsSync checks and wrapped in
 * try/catch so this always returns a valid signal set, even for new missions.
 */
export function collectMissionSignals(overstoryDir: string, mission: Mission): MissionScoreSignals {
	// Events
	let totalEvents = 0;
	let errorEvents = 0;
	if (mission.runId) {
		const eventsDb = join(overstoryDir, "events.db");
		if (existsSync(eventsDb)) {
			try {
				const eventStore = createEventStore(eventsDb);
				try {
					const events = eventStore.getByRun(mission.runId);
					totalEvents = events.length;
					errorEvents = events.filter((e) => e.level === "error").length;
				} finally {
					eventStore.close();
				}
			} catch {
				// Safe default — no events
			}
		}
	}

	// Sessions
	let totalSessions = 0;
	let completedSessions = 0;
	if (mission.runId) {
		const sessionsDb = join(overstoryDir, "sessions.db");
		if (existsSync(sessionsDb)) {
			try {
				const { store: sessionStore } = openSessionStore(overstoryDir);
				try {
					const sessions = sessionStore.getByRun(mission.runId);
					totalSessions = sessions.length;
					completedSessions = sessions.filter((s) => s.state === "completed").length;
				} finally {
					sessionStore.close();
				}
			} catch {
				// Safe default — no sessions
			}
		}
	}

	// Review
	let reviewScore: number | null = null;
	const reviewsDb = join(overstoryDir, "reviews.db");
	if (existsSync(reviewsDb)) {
		try {
			const reviewStore = createReviewStore(reviewsDb);
			try {
				const latest = reviewStore.getLatest("mission", mission.id);
				if (latest) {
					reviewScore = latest.overallScore;
				}
			} finally {
				reviewStore.close();
			}
		} catch {
			// Safe default — no review
		}
	}

	// Bundle manifest
	let bundleFileCount = 0;
	const expectedBundleFiles = 7;
	if (mission.artifactRoot) {
		const manifestPath = join(mission.artifactRoot, "results", "manifest.json");
		if (existsSync(manifestPath)) {
			try {
				const raw = readFileSync(manifestPath, "utf-8");
				const manifest = JSON.parse(raw) as BundleManifest;
				bundleFileCount = manifest.files.length;
			} catch {
				// Safe default — empty bundle
			}
		}
	}

	return {
		phase: mission.phase,
		totalEvents,
		errorEvents,
		totalSessions,
		completedSessions,
		reviewScore,
		bundleFileCount,
		expectedBundleFiles,
	};
}

// === Factor scoring ===

function scoreExecutionProgress(signals: MissionScoreSignals): MissionScoreFactor {
	const score = PHASE_SCORES[signals.phase];
	return {
		name: "execution_progress",
		label: "Execution Progress",
		score,
		weight: FACTOR_WEIGHTS.execution_progress,
		contribution: score * FACTOR_WEIGHTS.execution_progress,
		details: `Mission is in '${signals.phase}' phase`,
	};
}

function scoreErrorRate(signals: MissionScoreSignals): MissionScoreFactor {
	const { totalEvents, errorEvents } = signals;
	let score: number;
	let details: string;

	if (totalEvents === 0) {
		score = 100;
		details = "No events recorded — defaulting to 100";
	} else {
		const rate = errorEvents / totalEvents;
		// 0% errors = 100, 10%+ errors = 0, linear scale
		score = clamp100(Math.round((1 - rate / 0.1) * 100));
		details = `${errorEvents}/${totalEvents} events are errors (${Math.round(rate * 100)}%)`;
	}

	return {
		name: "error_rate",
		label: "Error Rate",
		score,
		weight: FACTOR_WEIGHTS.error_rate,
		contribution: score * FACTOR_WEIGHTS.error_rate,
		details,
	};
}

function scoreSessionCompletion(signals: MissionScoreSignals): MissionScoreFactor {
	const { totalSessions, completedSessions } = signals;
	let score: number;
	let details: string;

	if (totalSessions === 0) {
		score = 100;
		details = "No sessions recorded — defaulting to 100";
	} else {
		score = clamp100(Math.round((completedSessions / totalSessions) * 100));
		details = `${completedSessions}/${totalSessions} sessions completed`;
	}

	return {
		name: "session_completion",
		label: "Session Completion",
		score,
		weight: FACTOR_WEIGHTS.session_completion,
		contribution: score * FACTOR_WEIGHTS.session_completion,
		details,
	};
}

function scoreReviewQuality(signals: MissionScoreSignals): MissionScoreFactor {
	const { reviewScore } = signals;
	const score = reviewScore !== null ? clamp100(reviewScore) : 50;
	const details =
		reviewScore !== null
			? `Latest mission review: ${reviewScore}/100`
			: "No review recorded — defaulting to 50";

	return {
		name: "review_quality",
		label: "Review Quality",
		score,
		weight: FACTOR_WEIGHTS.review_quality,
		contribution: score * FACTOR_WEIGHTS.review_quality,
		details,
	};
}

function scoreArtifactCompleteness(signals: MissionScoreSignals): MissionScoreFactor {
	const { bundleFileCount, expectedBundleFiles } = signals;
	const score =
		expectedBundleFiles > 0
			? clamp100(Math.round((bundleFileCount / expectedBundleFiles) * 100))
			: 100;
	const details =
		bundleFileCount === 0
			? "No bundle files found"
			: `${bundleFileCount}/${expectedBundleFiles} expected bundle files present`;

	return {
		name: "artifact_completeness",
		label: "Artifact Completeness",
		score,
		weight: FACTOR_WEIGHTS.artifact_completeness,
		contribution: score * FACTOR_WEIGHTS.artifact_completeness,
		details,
	};
}

// === Score computation ===

/**
 * Pure score computation from pre-collected signals.
 *
 * Use this for testing to avoid filesystem dependencies.
 */
export function computeMissionScoreFromSignals(signals: MissionScoreSignals): MissionScore {
	const factors: MissionScoreFactor[] = [
		scoreExecutionProgress(signals),
		scoreErrorRate(signals),
		scoreSessionCompletion(signals),
		scoreReviewQuality(signals),
		scoreArtifactCompleteness(signals),
	];

	const overall = clamp100(Math.round(factors.reduce((sum, f) => sum + f.contribution, 0)));
	const grade = deriveGrade(overall);

	return {
		overall,
		grade,
		factors,
		collectedAt: new Date().toISOString(),
	};
}

/**
 * Collect signals and compute a MissionScore for the given mission.
 */
export function computeMissionScore(overstoryDir: string, mission: Mission): MissionScore {
	const signals = collectMissionSignals(overstoryDir, mission);
	return computeMissionScoreFromSignals(signals);
}

// === Rendering ===

function gradeColor(grade: MissionGrade): string {
	switch (grade) {
		case "A":
		case "B":
			return color.green(grade);
		case "C":
			return color.yellow(grade);
		case "D":
		case "F":
			return color.red(grade);
	}
}

function scoreColor(score: number): (s: string) => string {
	if (score >= 80) return color.green;
	if (score >= 60) return color.yellow;
	return color.red;
}

const BAR_WIDTH = 16;

function scoreBar(score: number): string {
	const filled = Math.round((score / 100) * BAR_WIDTH);
	const empty = BAR_WIDTH - filled;
	return scoreColor(score)("\u2588".repeat(filled) + "\u2591".repeat(empty));
}

function renderFactorRow(factor: MissionScoreFactor): void {
	const bar = scoreBar(factor.score);
	const scorePart = scoreColor(factor.score)(`${String(Math.round(factor.score)).padStart(3)}/100`);
	const namePart = color.bold(factor.label);
	const descPart = muted(factor.details);
	process.stdout.write(`  ${bar} ${scorePart}  ${namePart}\n`);
	process.stdout.write(`                        ${descPart}\n`);
}

/**
 * Render a MissionScore to stdout following health/render.ts conventions.
 */
export function renderMissionScore(score: MissionScore): void {
	const w = process.stdout.write.bind(process.stdout);

	w(`\n${accent("Mission Health")}\n`);
	w(`${thickSeparator()}\n`);
	w("\n");

	const overall = scoreColor(score.overall)(`${score.overall}/100`);
	const grade = gradeColor(score.grade);
	w(`  Overall: ${overall}  Grade: ${grade}\n`);
	w("\n");

	if (score.factors.length === 0) {
		w(`  ${muted("No factor data available.")}\n`);
		w("\n");
		return;
	}

	w(`  ${color.bold("Factor Breakdown")}  ${muted(`(${score.factors.length} factors)`)}\n`);
	w("\n");

	const sorted = [...score.factors].sort((a, b) => a.score - b.score);
	for (const factor of sorted) {
		renderFactorRow(factor);
		w("\n");
	}

	const ts = new Date(score.collectedAt).toLocaleTimeString();
	w(`  ${muted(`Collected at ${ts}`)}\n`);
}
