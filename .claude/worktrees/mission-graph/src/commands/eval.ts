/**
 * CLI command: ov eval run <scenario> / ov eval show <run-id> / ov eval list / ov eval compare
 *
 * Scenario-based orchestration evaluation. Runs a coordinator in a fixture repo
 * and evaluates assertions against the collected metrics.
 */

import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { renderReport, renderSummaryLine } from "../eval/report.ts";
import { runEval } from "../eval/runner.ts";
import { loadScenario } from "../eval/scenario.ts";
import { writeArtifacts } from "../eval/store.ts";
import type { EvalMetrics, EvalResult, EvalRunConfig } from "../eval/types.ts";
import { jsonError, jsonOutput } from "../json.ts";

interface EvalRunOpts {
	json?: boolean;
	timeout?: string;
}

interface EvalShowOpts {
	json?: boolean;
}

interface EvalListOpts {
	json?: boolean;
}

interface EvalCompareOpts {
	json?: boolean;
}

/** EvalMetrics extended with optional future fields for backwards-compatible compare. */
type ExtendedMetrics = EvalMetrics & {
	runtimeSwaps?: number;
	medianSessionDurationMs?: number;
};

interface CompareMetricRow {
	label: string;
	valA: string;
	valB: string;
	delta: string;
}

function formatInt(v: number): string {
	return String(Math.round(v));
}

function buildMetricRow(
	label: string,
	a: number,
	b: number,
	fmt: (v: number) => string,
): CompareMetricRow {
	const delta = b - a;
	const sign = delta > 0 ? "+" : "";
	return { label, valA: fmt(a), valB: fmt(b), delta: `${sign}${fmt(delta)}` };
}

function diffAssertions(
	a: EvalResult,
	b: EvalResult,
): Array<{ kind: string; label: string; passedA: boolean; passedB: boolean }> {
	const aMap = new Map(a.assertions.map((ar) => [ar.assertion.kind, ar]));
	const result: Array<{ kind: string; label: string; passedA: boolean; passedB: boolean }> = [];
	for (const bResult of b.assertions) {
		const kind = bResult.assertion.kind;
		const aResult = aMap.get(kind);
		if (aResult !== undefined && aResult.passed !== bResult.passed) {
			result.push({
				kind,
				label: bResult.assertion.label ?? kind,
				passedA: aResult.passed,
				passedB: bResult.passed,
			});
		}
	}
	return result;
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

async function executeEvalList(opts: EvalListOpts): Promise<void> {
	const json = opts.json ?? false;

	const config = await loadConfig(process.cwd());
	const projectRoot = config.project.root;
	const evalRunsDir = join(projectRoot, ".overstory", "eval-runs");

	if (!existsSync(evalRunsDir)) {
		if (json) {
			jsonOutput("eval list", { runs: [] } as unknown as Record<string, unknown>);
		} else {
			process.stdout.write("No eval runs found.\n");
		}
		return;
	}

	const entries = readdirSync(evalRunsDir, { withFileTypes: true });
	const runs: EvalResult[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const summaryPath = join(evalRunsDir, entry.name, "summary.json");
		const summaryFile = Bun.file(summaryPath);
		if (!(await summaryFile.exists())) continue;
		try {
			const text = await summaryFile.text();
			const parsed = JSON.parse(text) as EvalResult;
			runs.push(parsed);
		} catch {
			// skip unreadable runs
		}
	}

	runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

	if (json) {
		jsonOutput("eval list", { runs } as unknown as Record<string, unknown>);
	} else {
		if (runs.length === 0) {
			process.stdout.write("No eval runs found.\n");
		} else {
			for (const run of runs) {
				process.stdout.write(`${renderSummaryLine(run)}\n`);
			}
		}
	}
}

async function executeEvalCompare(
	runIdA: string,
	runIdB: string,
	opts: EvalCompareOpts,
): Promise<void> {
	const json = opts.json ?? false;

	const config = await loadConfig(process.cwd());
	const projectRoot = config.project.root;
	const evalRunsDir = join(projectRoot, ".overstory", "eval-runs");

	const fileA = Bun.file(join(evalRunsDir, runIdA, "summary.json"));
	const fileB = Bun.file(join(evalRunsDir, runIdB, "summary.json"));

	if (!(await fileA.exists())) {
		if (json) {
			jsonError("eval compare", `Eval run not found: ${runIdA}`);
		} else {
			process.stderr.write(`Error: Eval run not found: ${runIdA}\n`);
		}
		process.exitCode = 1;
		return;
	}

	if (!(await fileB.exists())) {
		if (json) {
			jsonError("eval compare", `Eval run not found: ${runIdB}`);
		} else {
			process.stderr.write(`Error: Eval run not found: ${runIdB}\n`);
		}
		process.exitCode = 1;
		return;
	}

	let resultA: EvalResult;
	let resultB: EvalResult;

	try {
		resultA = JSON.parse(await fileA.text()) as EvalResult;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) {
			jsonError("eval compare", `Failed to parse run A: ${msg}`);
		} else {
			process.stderr.write(`Error: Failed to parse run A: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	try {
		resultB = JSON.parse(await fileB.text()) as EvalResult;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) {
			jsonError("eval compare", `Failed to parse run B: ${msg}`);
		} else {
			process.stderr.write(`Error: Failed to parse run B: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	const mA = resultA.metrics as ExtendedMetrics;
	const mB = resultB.metrics as ExtendedMetrics;

	const metricRows: CompareMetricRow[] = [
		buildMetricRow("Agents spawned", mA.totalAgents, mB.totalAgents, formatInt),
		buildMetricRow("Completed", mA.completedAgents, mB.completedAgents, formatInt),
		buildMetricRow("Zombies", mA.zombieCount, mB.zombieCount, formatInt),
		buildMetricRow("Stall rate", mA.stallRate * 100, mB.stallRate * 100, (v) => `${v.toFixed(1)}%`),
		buildMetricRow("Merge success", mA.mergeSuccessCount, mB.mergeSuccessCount, formatInt),
		buildMetricRow("Merge conflicts", mA.mergeConflictCount, mB.mergeConflictCount, formatInt),
		buildMetricRow("Queue pending", mA.mergeQueuePending, mB.mergeQueuePending, formatInt),
		buildMetricRow("Tasks completed", mA.tasksCompleted, mB.tasksCompleted, formatInt),
		buildMetricRow("Duration (ms)", mA.durationMs, mB.durationMs, formatInt),
		buildMetricRow("Cost (USD)", mA.estimatedCostUsd, mB.estimatedCostUsd, (v) => v.toFixed(4)),
		buildMetricRow("Nudges sent", mA.nudgesSent, mB.nudgesSent, formatInt),
		buildMetricRow("Runtime swaps", mA.runtimeSwaps ?? 0, mB.runtimeSwaps ?? 0, formatInt),
		buildMetricRow(
			"Median duration (ms)",
			mA.medianSessionDurationMs ?? 0,
			mB.medianSessionDurationMs ?? 0,
			formatInt,
		),
	];

	const assertionsDiff = diffAssertions(resultA, resultB);

	if (json) {
		const payload = {
			runA: runIdA,
			runB: runIdB,
			scenarioA: resultA.scenarioName,
			scenarioB: resultB.scenarioName,
			passedA: resultA.passed,
			passedB: resultB.passed,
			metricsDelta: metricRows,
			assertionsDiff,
		};
		jsonOutput("eval compare", payload as unknown as Record<string, unknown>);
		return;
	}

	const lines: string[] = [];
	lines.push("Comparing eval runs:");
	lines.push(`  A: ${runIdA} (${resultA.scenarioName}) - ${resultA.passed ? "PASS" : "FAIL"}`);
	lines.push(`  B: ${runIdB} (${resultB.scenarioName}) - ${resultB.passed ? "PASS" : "FAIL"}`);
	lines.push("");
	lines.push("Metrics Delta (B - A):");

	const labelWidth = Math.max(...metricRows.map((r) => r.label.length));
	for (const row of metricRows) {
		lines.push(
			`  ${row.label.padEnd(labelWidth)}  ${row.valA.padStart(12)}  ${row.valB.padStart(12)}  ${row.delta}`,
		);
	}

	if (assertionsDiff.length > 0) {
		lines.push("");
		lines.push("Assertion Diff:");
		for (const diff of assertionsDiff) {
			const from = diff.passedA ? "PASS" : "FAIL";
			const to = diff.passedB ? "PASS" : "FAIL";
			lines.push(`  ${diff.kind}: ${from} -> ${to} ${diff.label}`);
		}
	}

	process.stdout.write(`${lines.join("\n")}\n`);
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

	cmd
		.command("list")
		.description("List all past eval runs")
		.option("--json", "JSON output")
		.action(async (opts: EvalListOpts) => {
			await executeEvalList(opts);
		});

	cmd
		.command("compare")
		.argument("<run-a>", "First eval run ID")
		.argument("<run-b>", "Second eval run ID")
		.description("Compare two eval runs side-by-side")
		.option("--json", "JSON output")
		.action(async (runIdA: string, runIdB: string, opts: EvalCompareOpts) => {
			await executeEvalCompare(runIdA, runIdB, opts);
		});

	return cmd;
}
