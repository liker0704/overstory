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
import { selectRecommendations } from "../health/recommendations.ts";
import { renderHealthScore } from "../health/render.ts";
import { computeScore } from "../health/score.ts";
import { collectSignals } from "../health/signals.ts";
import type { HealthSnapshot } from "../health/types.ts";
import { jsonError, jsonOutput } from "../json.ts";
import type { MissionScore } from "../missions/score.ts";
import { computeMissionScore } from "../missions/score.ts";
import { createMissionStore } from "../missions/store.ts";

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
	const recommendation = selectRecommendations(score)[0] ?? null;

	let missionScore: MissionScore | null = null;
	const sessionsDb = join(overstoryDir, "sessions.db");
	if (existsSync(sessionsDb)) {
		const missionStore = createMissionStore(sessionsDb);
		try {
			const active = missionStore.getActive();
			if (active) {
				missionScore = computeMissionScore(overstoryDir, active);
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

	if (json) {
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
		jsonOutput("health", out);
		return;
	}

	renderHealthScore(score);
	if (comparisonDelta !== undefined) {
		const sign = comparisonDelta > 0 ? "+" : "";
		process.stdout.write(`\n  Score delta vs previous snapshot: ${sign}${comparisonDelta}\n`);
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
