/**
 * CLI command: ov next-improvement [--json] [--run <id>] [--all]
 *
 * Synthesizes the single highest-value improvement recommendation from
 * existing Overstory signals. Drives a status → next → resolve → verify loop.
 */

import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { generateRecommendations } from "../health/recommendations.ts";
import { renderRecommendation } from "../health/render.ts";
import { computeScore } from "../health/score.ts";
import { collectSignals } from "../health/signals.ts";
import { jsonError, jsonOutput } from "../json.ts";
import { color, muted } from "../logging/color.ts";
import { thickSeparator } from "../logging/theme.ts";

export interface NextImprovementOptions {
	json?: boolean;
	/** Scope to a specific run ID. */
	run?: string;
	/** Show all recommendations instead of just the top one. */
	all?: boolean;
}

/**
 * Core next-improvement command logic, extracted for testability.
 */
export async function executeNextImprovement(opts: NextImprovementOptions): Promise<void> {
	const json = opts.json ?? false;
	const showAll = opts.all ?? false;

	let config: Awaited<ReturnType<typeof loadConfig>>;
	try {
		config = await loadConfig(process.cwd());
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) {
			jsonError("next-improvement", msg);
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
			jsonError("next-improvement", `Signal collection failed: ${msg}`);
		} else {
			process.stderr.write(`Error collecting signals: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	const score = computeScore(signals);
	const recommendations = generateRecommendations(score, config);

	if (json) {
		const selected = showAll ? recommendations : recommendations.slice(0, 1);
		jsonOutput("next-improvement", {
			recommendations: selected,
			score: { overall: score.overall, grade: score.grade },
			count: recommendations.length,
		});
		return;
	}

	// Human output
	process.stdout.write(`${color.bold("Next Improvement")}\n`);
	process.stdout.write(`${thickSeparator()}\n`);
	process.stdout.write("\n");

	if (recommendations.length === 0) {
		process.stdout.write(`  ${color.green("\u2713")} All clear — no improvements needed.\n`);
		process.stdout.write(`  ${muted(`Overall health: ${score.overall}/100 (${score.grade})`)}\n`);
		process.stdout.write("\n");
		return;
	}

	const toRender = showAll ? recommendations : recommendations.slice(0, 1);
	const headerLabel = showAll
		? `All Recommendations (${recommendations.length})`
		: "Top Recommendation";
	process.stdout.write(`  ${color.bold(headerLabel)}\n`);
	process.stdout.write("\n");

	for (let i = 0; i < toRender.length; i++) {
		const rec = toRender[i];
		if (rec !== undefined) {
			renderRecommendation(rec, i + 1);
			if (i < toRender.length - 1) {
				process.stdout.write("\n");
			}
		}
	}

	process.stdout.write("\n");
}

/**
 * Create the `ov next-improvement` command.
 */
export function createNextImprovementCommand(): Command {
	return new Command("next-improvement")
		.description("Show the single highest-value improvement recommendation")
		.option("--json", "Output as JSON")
		.option("--run <id>", "Scope to a specific run")
		.option("--all", "Show all recommendations, not just the top one")
		.action(async (opts: NextImprovementOptions) => {
			await executeNextImprovement(opts);
		});
}
