/**
 * CLI command: ov health [--json] [--run <id>] [--compare <path>]
 *
 * Shows the swarm's operational health score and factor breakdown.
 * Collects signals from SessionStore, MetricsStore, and DoctorChecks,
 * computes a weighted score, and renders the result.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { createEventStore } from "../events/store.ts";
import { createEvalSource } from "../health/eval-source.ts";
import { loadRecentActions } from "../health/policy/history.ts";
import { isPolicyDisabled } from "../health/policy/kill-switch.ts";
import { type PolicyStatusInfo, renderPolicyStatus } from "../health/policy/render.ts";
import { selectRecommendations } from "../health/recommendations.ts";
import { renderHealthScore } from "../health/render.ts";
import { createReviewSource } from "../health/review-source.ts";
import { computeScore } from "../health/score.ts";
import { collectSignals } from "../health/signals.ts";
import type { HealthSnapshot } from "../health/types.ts";
import { jsonError, jsonOutput } from "../json.ts";
import { computeArtifactStaleness } from "../missions/artifact-staleness.ts";
import type { MissionScore } from "../missions/score.ts";
import { computeMissionScore } from "../missions/score.ts";
import { createMissionStore } from "../missions/store.ts";
import { createReminderSource } from "../reminders/source.ts";

export interface HealthOptions {
	json?: boolean;
	/** Scope signals to a specific run ID (informational, not currently filtered). */
	run?: string;
	/** Path to a previous snapshot JSON file for comparison. */
	compare?: string;
}

/**
 * Core health command logic, extracted for testability.
 */
export async function executeHealth(opts: HealthOptions): Promise<void> {
	const json = opts.json ?? false;

	let config: Awaited<ReturnType<typeof loadConfig>>;
	try {
		config = await loadConfig(process.cwd());
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) {
			jsonError("health", msg);
		} else {
			process.stderr.write(`Error: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	const overstoryDir = join(config.project.root, ".overstory");

	let signals: ReturnType<typeof collectSignals>;
	try {
		signals = collectSignals({ overstoryDir });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) {
			jsonError("health", `Signal collection failed: ${msg}`);
		} else {
			process.stderr.write(`Error collecting signals: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	const score = computeScore(signals);
	const extraSources = [
		createReviewSource(overstoryDir),
		createEvalSource(overstoryDir),
		createReminderSource(overstoryDir),
	];
	const recommendation = selectRecommendations(score, undefined, extraSources)[0] ?? null;

	let missionScore: MissionScore | null = null;
	let artifactStaleness:
		| {
				totalArtifacts: number;
				freshCount: number;
				staleCount: number;
				unscoredCount: number;
				freshnessPercent: number;
		  }
		| undefined;
	const sessionsDb = join(overstoryDir, "sessions.db");
	if (existsSync(sessionsDb)) {
		const missionStore = createMissionStore(sessionsDb);
		try {
			const active = missionStore.getActive();
			if (active) {
				missionScore = computeMissionScore(overstoryDir, active);
				try {
					const missionDir = active.artifactRoot ?? join(overstoryDir, "missions", active.id);
					const report = await computeArtifactStaleness(missionDir);
					const totalArtifacts = report.results.length;
					const freshCount = report.results.filter((r) => r.status === "fresh").length;
					const staleCount = report.results.filter((r) => r.status === "stale").length;
					const unscoredCount = report.results.filter((r) => r.status === "unscored").length;
					const freshnessPercent =
						totalArtifacts > 0 ? Math.round((freshCount / totalArtifacts) * 100) : 100;
					artifactStaleness = {
						totalArtifacts,
						freshCount,
						staleCount,
						unscoredCount,
						freshnessPercent,
					};
				} catch {
					// artifact staleness unavailable
				}
			}
		} finally {
			missionStore.close();
		}
	}

	const snapshot: HealthSnapshot = {
		score,
		recommendation,
		savedAt: new Date().toISOString(),
	};

	// Optional comparison against previous snapshot
	let comparisonDelta: number | undefined;
	if (opts.compare) {
		try {
			const file = Bun.file(opts.compare);
			const text = await file.text();
			const prev = JSON.parse(text) as HealthSnapshot;
			comparisonDelta = score.overall - prev.score.overall;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			process.stderr.write(`Warning: could not load snapshot for comparison: ${msg}\n`);
			// Non-fatal — continue without comparison
		}
	}

	// Policy status (optional)
	let policyStatusInfo: PolicyStatusInfo | null = null;
	if (config.healthPolicy) {
		const disabled = isPolicyDisabled(overstoryDir, config);
		let recentTriggered = 0;
		let lastEvaluationAt: string | undefined;
		const eventsDb = join(overstoryDir, "events.db");
		if (existsSync(eventsDb)) {
			try {
				const eventStore = createEventStore(eventsDb);
				const MS_1H = 60 * 60 * 1000;
				const records = loadRecentActions(eventStore, MS_1H);
				recentTriggered = records.filter((r) => r.triggered).length;
				const latest = records[0];
				if (latest !== undefined) {
					lastEvaluationAt = latest.timestamp;
				}
			} catch {
				// Non-fatal — proceed without policy history
			}
		}
		policyStatusInfo = {
			enabled: config.healthPolicy.enabled && !disabled,
			disabled,
			dryRun: config.healthPolicy.dryRun,
			ruleCount: config.healthPolicy.rules.length,
			lastEvaluationAt,
			recentTriggered,
		};
	}

	if (json) {
		const reviewRecs = extraSources[0] ? extraSources[0].collect(score) : [];
		const evalRecs = extraSources[1] ? extraSources[1].collect(score) : [];
		const reminderRecs = extraSources[2] ? extraSources[2].collect(score) : [];
		const out: Record<string, unknown> = {
			score: {
				overall: score.overall,
				grade: score.grade,
				collectedAt: score.collectedAt,
			},
			signals: score.signals,
			snapshot,
		};
		if (comparisonDelta !== undefined) {
			out.comparison = { overallDelta: comparisonDelta };
		}
		if (missionScore) {
			out.missionScore = missionScore;
		}
		if (artifactStaleness !== undefined) {
			out.artifactStaleness = artifactStaleness;
		}
		out.qualitySignals = {
			reviewSourceActive: true,
			evalSourceActive: true,
			reminderSourceActive: true,
			reviewRecommendationCount: reviewRecs.length,
			evalRecommendationCount: evalRecs.length,
			reminderRecommendationCount: reminderRecs.length,
		};
		if (policyStatusInfo !== null) {
			out.policyStatus = policyStatusInfo;
		}
		jsonOutput("health", out);
		return;
	}

	renderHealthScore(score);
	if (comparisonDelta !== undefined) {
		const sign = comparisonDelta > 0 ? "+" : "";
		process.stdout.write(`\n  Score delta vs previous snapshot: ${sign}${comparisonDelta}\n`);
	}
	if (policyStatusInfo !== null) {
		process.stdout.write("\n");
		process.stdout.write(renderPolicyStatus(policyStatusInfo) + "\n");
	}
}

/**
 * Create the `ov health` command.
 */
export function createHealthCommand(): Command {
	return new Command("health")
		.description("Show swarm operational health score and factor breakdown")
		.option("--json", "Output as JSON")
		.option("--run <id>", "Scope to a specific run")
		.option("--compare <path>", "Compare against a previous snapshot file")
		.action(async (opts: HealthOptions) => {
			await executeHealth(opts);
		});
}
