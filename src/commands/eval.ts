/**
 * CLI command: ov eval run <scenario> / ov eval show <run-id>
 *
 * Scenario-based orchestration evaluation. Runs a coordinator in a fixture repo
 * and evaluates assertions against the collected metrics.
 */

import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { renderReport } from "../eval/report.ts";
import { runEval } from "../eval/runner.ts";
import { loadScenario } from "../eval/scenario.ts";
import { writeArtifacts } from "../eval/store.ts";
import type { EvalResult, EvalRunConfig } from "../eval/types.ts";
import { jsonError, jsonOutput } from "../json.ts";

interface EvalRunOpts {
	json?: boolean;
	timeout?: string;
}

interface EvalShowOpts {
	json?: boolean;
}

async function executeEvalRun(scenarioPath: string, opts: EvalRunOpts): Promise<void> {
	const json = opts.json ?? false;

	const resolvedScenarioPath = resolve(process.cwd(), scenarioPath);

	let scenario: Awaited<ReturnType<typeof loadScenario>>;
	try {
		scenario = await loadScenario(resolvedScenarioPath);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) {
			jsonError("eval run", `Failed to load scenario: ${msg}`);
		} else {
			process.stderr.write(`Error: Failed to load scenario: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	const runId = crypto.randomUUID();
	const fixtureRepoPath = join(tmpdir(), `ov-eval-${runId}`);

	const timeoutMs = opts.timeout
		? Number.parseInt(opts.timeout, 10)
		: (scenario.timeoutMs ?? 300000);

	const config: EvalRunConfig = {
		runId,
		scenario,
		scenarioPath: resolvedScenarioPath,
		fixtureRepoPath,
		timeoutMs,
	};

	let result: EvalResult;
	try {
		result = await runEval(config);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) {
			jsonError("eval run", msg);
		} else {
			process.stderr.write(`Error: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	// Write artifacts to the project root
	const cwd = process.cwd();
	const projectConfig = await loadConfig(cwd);
	const projectRoot = projectConfig.project.root;

	try {
		await writeArtifacts(result, projectRoot);
	} catch (err: unknown) {
		// Non-fatal: report ran but artifacts failed to write
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`Warning: Failed to write artifacts: ${msg}\n`);
	}

	if (json) {
		jsonOutput("eval run", result as unknown as Record<string, unknown>);
	} else {
		process.stdout.write(`${renderReport(result)}\n`);
	}

	if (!result.passed) {
		process.exitCode = 1;
	}
}

async function executeEvalShow(runId: string, opts: EvalShowOpts): Promise<void> {
	const json = opts.json ?? false;

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;

	const summaryPath = join(projectRoot, ".overstory", "eval-runs", runId, "summary.json");
	const summaryFile = Bun.file(summaryPath);

	if (!(await summaryFile.exists())) {
		if (json) {
			jsonError("eval show", `Eval run not found: ${runId}`);
		} else {
			process.stderr.write(`Error: Eval run not found: ${runId}\n`);
			process.stderr.write(`Expected at: ${summaryPath}\n`);
		}
		process.exitCode = 1;
		return;
	}

	let result: EvalResult;
	try {
		const text = await summaryFile.text();
		result = JSON.parse(text) as EvalResult;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) {
			jsonError("eval show", `Failed to parse summary: ${msg}`);
		} else {
			process.stderr.write(`Error: Failed to parse summary: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	if (json) {
		jsonOutput("eval show", result as unknown as Record<string, unknown>);
	} else {
		process.stdout.write(`${renderReport(result)}\n`);
	}
}

export function createEvalCommand(): Command {
	const cmd = new Command("eval").description("Scenario-based orchestration evaluation");

	cmd
		.command("run")
		.argument("<scenario>", "Path to scenario directory")
		.description("Run an eval scenario against a fixture repo")
		.option("--json", "JSON output")
		.option("--timeout <ms>", "Override scenario timeout (ms)")
		.action(async (scenarioPath: string, opts: EvalRunOpts) => {
			await executeEvalRun(scenarioPath, opts);
		});

	cmd
		.command("show")
		.argument("<run-id>", "Eval run ID to display")
		.description("Show results of a previous eval run")
		.option("--json", "JSON output")
		.action(async (runId: string, opts: EvalShowOpts) => {
			await executeEvalShow(runId, opts);
		});

	return cmd;
}
