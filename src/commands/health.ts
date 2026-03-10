/**
 * CLI command: ov health [--json] [--run <id>] [--compare <path>]
 *
 * Shows the swarm's operational health score and factor breakdown.
 * Collects signals from SessionStore, MetricsStore, and DoctorChecks,
 * computes a weighted score, and renders the result.
 */

import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { renderComparison, renderHealthScore } from "../health/render.ts";
import { compareSnapshots, computeScore } from "../health/score.ts";
import { collectSignals } from "../health/signals.ts";
import type { HealthSnapshot } from "../health/types.ts";
import { jsonError, jsonOutput } from "../json.ts";

export interface HealthOptions {
	json?: boolean;
	/** Scope signals to a specific run ID. */
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
		signals = collectSignals({ overstoryDir, config, runId: opts.run });
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

	// Optional comparison against previous snapshot
	let comparison: ReturnType<typeof compareSnapshots> | undefined;
	if (opts.compare) {
		try {
			const file = Bun.file(opts.compare);
			const text = await file.text();
			const prev = JSON.parse(text) as HealthSnapshot;
			comparison = compareSnapshots(score.snapshot, prev);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (json) {
				jsonError("health", `Failed to load comparison snapshot: ${msg}`);
			} else {
				process.stderr.write(`Warning: could not load snapshot for comparison: ${msg}\n`);
			}
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
			snapshot: score.snapshot,
		};
		if (comparison !== undefined) {
			out.comparison = comparison;
		}
		jsonOutput("health", out);
		return;
	}

	renderHealthScore(score);
	if (comparison !== undefined) {
		renderComparison(comparison);
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
