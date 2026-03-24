/**
 * CLI command: ov adaptive [--json]
 *
 * Shows the current adaptive parallelism state: effective max concurrent,
 * last scaling decision, direction, and whether spawn is paused.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { readEffectiveMaxConcurrent } from "../adaptive/index.ts";
import type { ScalingDecision } from "../adaptive/types.ts";
import { loadConfig } from "../config.ts";
import { jsonError, jsonOutput } from "../json.ts";
import { chalk, muted } from "../logging/color.ts";

export interface AdaptiveOptions {
	json?: boolean;
}

/**
 * Core adaptive command logic, extracted for testability.
 */
export async function executeAdaptive(opts: AdaptiveOptions): Promise<void> {
	const json = opts.json ?? false;

	let config: Awaited<ReturnType<typeof loadConfig>>;
	try {
		config = await loadConfig(process.cwd());
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) {
			jsonError("adaptive", msg);
		} else {
			process.stderr.write(`Error: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	const adaptiveConfig = config.agents.adaptive;

	if (!adaptiveConfig?.enabled) {
		if (json) {
			jsonOutput("adaptive", { enabled: false });
		} else {
			process.stdout.write(muted("  Adaptive parallelism is disabled.\n"));
		}
		return;
	}

	const overstoryDir = join(config.project.root, ".overstory");

	const effectiveMax = readEffectiveMaxConcurrent(overstoryDir, config);

	// Check spawn-paused sentinel
	const spawnPaused = existsSync(join(overstoryDir, "spawn-paused"));

	// Try to read the full decision for more detail
	let decision: ScalingDecision | null = null;
	const statePath = join(overstoryDir, "adaptive-state.json");
	if (existsSync(statePath)) {
		try {
			const file = Bun.file(statePath);
			const text = await file.text();
			decision = JSON.parse(text) as ScalingDecision;
		} catch {
			// Non-fatal
		}
	}

	if (json) {
		jsonOutput("adaptive", {
			enabled: true,
			effectiveMaxConcurrent: effectiveMax,
			configuredMax: adaptiveConfig.maxWorkers,
			configuredMin: adaptiveConfig.minWorkers,
			spawnPaused,
			decision,
		});
		return;
	}

	process.stdout.write(`\n  ${chalk.bold("Adaptive Parallelism")}\n\n`);
	process.stdout.write(`  Effective max concurrent: ${chalk.cyan(String(effectiveMax))}\n`);
	process.stdout.write(
		`  Configured range:         ${muted(`${adaptiveConfig.minWorkers}–${adaptiveConfig.maxWorkers}`)}\n`,
	);

	if (spawnPaused) {
		process.stdout.write(`  Spawn paused:             ${chalk.yellow("yes")}\n`);
	}

	if (decision) {
		const dirColor =
			decision.direction === "up"
				? chalk.green
				: decision.direction === "down"
					? chalk.red
					: chalk.dim;
		process.stdout.write(`  Last direction:           ${dirColor(decision.direction)}\n`);
		process.stdout.write(`  Decided at:               ${muted(decision.decidedAt)}\n`);
	} else if (!existsSync(statePath)) {
		process.stdout.write(`  ${muted("No scaling decision yet.")}\n`);
	}

	process.stdout.write("\n");
}

/**
 * Create the `ov adaptive` command.
 */
export function createAdaptiveCommand(): Command {
	return new Command("adaptive")
		.description("Show adaptive parallelism state and current scaling decision")
		.option("--json", "Output as JSON")
		.action(async (opts: AdaptiveOptions) => {
			await executeAdaptive(opts);
		});
}
