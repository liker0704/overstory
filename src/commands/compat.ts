/**
 * CLI command: ov compat
 *
 * Compatibility analysis tools for agent branches.
 *
 * Usage:
 *   ov compat check <branch>   Check branch compatibility against canonical
 */

import { Command } from "commander";
import { analyzeCompatibility } from "../compat/analyzer.ts";
import { extractTypeSurface } from "../compat/extractor.ts";
import { formatCompatReport } from "../compat/report.ts";
import type { CompatConfig } from "../compat/types.ts";
import { loadConfig } from "../config.ts";
import { jsonOutput } from "../json.ts";

export function createCompatCommand(): Command {
	const cmd = new Command("compat");
	cmd.description("Compatibility analysis tools");

	cmd
		.command("check <branch>")
		.description("Check branch compatibility against canonical")
		.option("--against <branch>", "Branch to compare against", "main")
		.option("--json", "JSON output")
		.action(
			async (branch: string, opts: { against?: string; json?: boolean }) => {
				await compatCheckCommand(branch, opts);
			},
		);

	return cmd;
}

async function compatCheckCommand(
	branch: string,
	opts: { against?: string; json?: boolean },
): Promise<void> {
	const against = opts.against ?? "main";
	const json = opts.json ?? false;

	const cwd = process.cwd();
	const config = await loadConfig(cwd);

	const compatConfig: CompatConfig = {
		enabled: config.compat?.enabled ?? true,
		skipPatterns: config.compat?.skipPatterns ?? [],
		aiThreshold: config.compat?.aiThreshold ?? 3,
		strictMode: config.compat?.strictMode ?? false,
	};

	const repoRoot = config.project.root;
	const filePatterns = ["src/**/*.ts"];

	const [canonicalSurface, branchSurface] = await Promise.all([
		extractTypeSurface(repoRoot, against, filePatterns),
		extractTypeSurface(repoRoot, branch, filePatterns),
	]);

	const result = await analyzeCompatibility(
		canonicalSurface,
		branchSurface,
		compatConfig,
	);

	if (json) {
		jsonOutput("compat", { result });
	} else {
		process.stdout.write(formatCompatReport(result));
		process.stdout.write("\n");
	}

	if (!result.compatible) {
		process.exitCode = 1;
	}
}
