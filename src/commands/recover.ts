/**
 * CLI command: ov recover <bundle-path> [--force] [--dry-run] [--json]
 *
 * Restores swarm state from a recovery bundle produced by `ov snapshot`.
 * Calls restoreBundle(), then renders a ReconciliationReport with colored
 * component statuses and operator actions.
 */

import chalk from "chalk";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { jsonError, jsonOutput } from "../json.ts";
import { restoreBundle } from "../recovery/restore.ts";
import type { ReconciliationReport } from "../recovery/types.ts";

export interface RecoverCommandOptions {
	force?: boolean;
	dryRun?: boolean;
	json?: boolean;
}

const STATUS_COLORS: Record<string, (s: string) => string> = {
	restored: chalk.green,
	degraded: chalk.yellow,
	missing: chalk.red,
	skipped: chalk.dim,
};

const OVERALL_COLORS: Record<string, (s: string) => string> = {
	restored: chalk.green,
	partial: chalk.yellow,
	failed: chalk.red,
};

function renderReport(report: ReconciliationReport, dryRun: boolean): void {
	const prefix = dryRun ? "[dry-run] " : "";
	const colorize = OVERALL_COLORS[report.overallStatus] ?? ((s: string) => s);
	process.stdout.write(`${prefix}${colorize(`Recovery ${report.overallStatus}`)}\n`);
	process.stdout.write(`Bundle: ${report.bundleId}  Restored at: ${report.restoredAt}\n\n`);

	if (report.components.length > 0) {
		process.stdout.write("Components:\n");
		for (const component of report.components) {
			const colorize2 = STATUS_COLORS[component.status] ?? ((s: string) => s);
			const badge = colorize2(`[${component.status}]`);
			process.stdout.write(`  ${badge} ${component.name} — ${component.details}\n`);
		}
	}

	if (report.operatorActions.length > 0) {
		process.stdout.write("\nOperator actions required:\n");
		for (const action of report.operatorActions) {
			process.stdout.write(`  ${chalk.yellow("→")} ${action}\n`);
		}
	}
}

/**
 * Core recover command logic, extracted for testability.
 */
export async function executeRecover(
	bundlePath: string,
	opts: RecoverCommandOptions,
): Promise<void> {
	const json = opts.json ?? false;

	let config: Awaited<ReturnType<typeof loadConfig>>;
	try {
		config = await loadConfig(process.cwd());
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) {
			jsonError("recover", msg);
		} else {
			process.stderr.write(`Error: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	const projectRoot = config.project.root;

	let report: ReconciliationReport;
	try {
		report = await restoreBundle(projectRoot, {
			bundlePath,
			dryRun: opts.dryRun,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) {
			jsonError("recover", msg);
		} else {
			process.stderr.write(`Error: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	if (json) {
		jsonOutput("recover", { report });
		return;
	}

	renderReport(report, opts.dryRun ?? false);
}

/**
 * Create the `ov recover` command.
 */
export function createRecoverCommand(): Command {
	return new Command("recover")
		.description("Restore swarm state from a recovery bundle")
		.argument("<bundle-path>", "Path to the recovery bundle directory or archive")
		.option("--force", "Overwrite existing state without confirmation")
		.option("--dry-run", "Preview what would be restored without making changes")
		.option("--json", "Output as JSON")
		.action(async (bundlePath: string, opts: RecoverCommandOptions) => {
			await executeRecover(bundlePath, opts);
		});
}
