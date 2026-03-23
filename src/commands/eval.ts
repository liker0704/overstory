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
import { runProbabilisticEval } from "../eval/probabilistic.ts";
import {
	renderProbabilisticReport,
	renderProbabilisticSummaryLine,
	renderReport,
	renderSummaryLine,
} from "../eval/report.ts";
import { runEval } from "../eval/runner.ts";
import { loadScenario } from "../eval/scenario.ts";
import { evaluateStochasticAssertions } from "../eval/stochastic.ts";
import { writeArtifacts, writeProbabilisticArtifacts } from "../eval/store.ts";
import type {
	EvalMetrics,
	EvalResult,
	EvalRunConfig,
	ProbabilisticEvalResult,
} from "../eval/types.ts";
import { jsonError, jsonOutput } from "../json.ts";

interface EvalRunOpts {
	json?: boolean;
	timeout?: string;
	trials?: string;
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

	// Determine trial count: CLI --trials > scenario.trials?.count > undefined
	const trialCount = opts.trials
		? Number.parseInt(opts.trials, 10)
		: (scenario.trials?.count ?? undefined);

	// Write artifacts to the project root
	const cwd = process.cwd();
	const projectConfig = await loadConfig(cwd);
	const projectRoot = projectConfig.project.root;

	if (trialCount !== undefined && trialCount > 1) {
		// Probabilistic path
		let probResult: ProbabilisticEvalResult;
		try {
			probResult = await runProbabilisticEval(config, { count: trialCount });
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

		const stochasticAssertions = evaluateStochasticAssertions(
			scenario.assertions,
			probResult.aggregateStats,
			probResult.trials,
		);
		probResult.stochasticAssertions = stochasticAssertions;
		probResult.passed = stochasticAssertions.every((a) => a.passed);

		try {
			await writeProbabilisticArtifacts(probResult, projectRoot);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			process.stderr.write(`Warning: Failed to write artifacts: ${msg}\n`);
		}

		if (json) {
			jsonOutput("eval run", probResult as unknown as Record<string, unknown>);
		} else {
			process.stdout.write(`${renderProbabilisticReport(probResult)}\n`);
		}

		if (!probResult.passed) {
			process.exitCode = 1;
		}
		return;
	}

	// Deterministic path (existing flow)
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

	const runDir = join(projectRoot, ".overstory", "eval-runs", runId);
	const probSummaryPath = join(runDir, "probabilistic-summary.json");
	const probSummaryFile = Bun.file(probSummaryPath);

	if (await probSummaryFile.exists()) {
		let probResult: ProbabilisticEvalResult;
		try {
			probResult = JSON.parse(await probSummaryFile.text()) as ProbabilisticEvalResult;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (json) {
				jsonError("eval show", `Failed to parse probabilistic summary: ${msg}`);
			} else {
				process.stderr.write(`Error: Failed to parse probabilistic summary: ${msg}\n`);
			}
			process.exitCode = 1;
			return;
		}
		if (json) {
			jsonOutput("eval show", probResult as unknown as Record<string, unknown>);
		} else {
			process.stdout.write(`${renderProbabilisticReport(probResult)}\n`);
		}
		return;
	}

	const summaryPath = join(runDir, "summary.json");
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
	const deterministicRuns: EvalResult[] = [];
	const probabilisticRuns: ProbabilisticEvalResult[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const runEntryDir = join(evalRunsDir, entry.name);

		const probSummaryFile = Bun.file(join(runEntryDir, "probabilistic-summary.json"));
		if (await probSummaryFile.exists()) {
			try {
				const parsed = JSON.parse(await probSummaryFile.text()) as ProbabilisticEvalResult;
				probabilisticRuns.push(parsed);
				continue;
			} catch {
				// skip unreadable runs
			}
		}

		const summaryFile = Bun.file(join(runEntryDir, "summary.json"));
		if (!(await summaryFile.exists())) continue;
		try {
			const parsed = JSON.parse(await summaryFile.text()) as EvalResult;
			deterministicRuns.push(parsed);
		} catch {
			// skip unreadable runs
		}
	}

	deterministicRuns.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	probabilisticRuns.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

	if (json) {
		jsonOutput("eval list", { runs: deterministicRuns, probabilisticRuns } as unknown as Record<
			string,
			unknown
		>);
	} else {
		if (deterministicRuns.length === 0 && probabilisticRuns.length === 0) {
			process.stdout.write("No eval runs found.\n");
		} else {
			for (const run of probabilisticRuns) {
				process.stdout.write(`${renderProbabilisticSummaryLine(run)}\n`);
			}
			for (const run of deterministicRuns) {
				process.stdout.write(`${renderSummaryLine(run)}\n`);
			}
		}
	}
}

async function loadEvalRun(
	evalRunsDir: string,
	runId: string,
): Promise<
	| { kind: "deterministic"; result: EvalResult }
	| { kind: "probabilistic"; result: ProbabilisticEvalResult }
	| null
> {
	const probFile = Bun.file(join(evalRunsDir, runId, "probabilistic-summary.json"));
	if (await probFile.exists()) {
		try {
			return {
				kind: "probabilistic",
				result: JSON.parse(await probFile.text()) as ProbabilisticEvalResult,
			};
		} catch {
			return null;
		}
	}
	const detFile = Bun.file(join(evalRunsDir, runId, "summary.json"));
	if (await detFile.exists()) {
		try {
			return { kind: "deterministic", result: JSON.parse(await detFile.text()) as EvalResult };
		} catch {
			return null;
		}
	}
	return null;
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

	const loadedA = await loadEvalRun(evalRunsDir, runIdA);
	const loadedB = await loadEvalRun(evalRunsDir, runIdB);

	if (loadedA === null) {
		if (json) {
			jsonError("eval compare", `Eval run not found: ${runIdA}`);
		} else {
			process.stderr.write(`Error: Eval run not found: ${runIdA}\n`);
		}
		process.exitCode = 1;
		return;
	}

	if (loadedB === null) {
		if (json) {
			jsonError("eval compare", `Eval run not found: ${runIdB}`);
		} else {
			process.stderr.write(`Error: Eval run not found: ${runIdB}\n`);
		}
		process.exitCode = 1;
		return;
	}

	// Both probabilistic: compare aggregate stats
	if (loadedA.kind === "probabilistic" && loadedB.kind === "probabilistic") {
		const pA = loadedA.result;
		const pB = loadedB.result;
		const lines: string[] = [];
		lines.push("Comparing probabilistic eval runs:");
		lines.push(
			`  A: ${runIdA} (${pA.scenarioName}) - ${pA.passed ? "PASS" : "FAIL"} (${pA.config.count} trials)`,
		);
		lines.push(
			`  B: ${runIdB} (${pB.scenarioName}) - ${pB.passed ? "PASS" : "FAIL"} (${pB.config.count} trials)`,
		);
		lines.push("");
		lines.push("Aggregate Stats (B - A):");
		const metricKeys = ["durationMs", "estimatedCostUsd", "totalAgents", "stallRate"] as const;
		for (const key of metricKeys) {
			const aAgg = pA.aggregateStats.metrics[key];
			const bAgg = pB.aggregateStats.metrics[key];
			if (aAgg !== undefined && bAgg !== undefined) {
				const delta = bAgg.mean - aAgg.mean;
				const sign = delta > 0 ? "+" : "";
				lines.push(
					`  ${key}: A mean=${aAgg.mean.toFixed(2)} B mean=${bAgg.mean.toFixed(2)} delta=${sign}${delta.toFixed(2)}`,
				);
			}
		}
		if (json) {
			jsonOutput("eval compare", {
				runA: runIdA,
				runB: runIdB,
				kind: "probabilistic",
				passedA: pA.passed,
				passedB: pB.passed,
			} as unknown as Record<string, unknown>);
		} else {
			process.stdout.write(`${lines.join("\n")}\n`);
		}
		return;
	}

	// Mixed: warn and compare what's possible
	if (loadedA.kind !== loadedB.kind) {
		const warning =
			"Warning: comparing a probabilistic run against a deterministic run — results may not be directly comparable.";
		if (!json) {
			process.stderr.write(`${warning}\n`);
		}
	}

	// Extract deterministic results for comparison (use trial 0 for probabilistic)
	let resultA: EvalResult;
	let resultB: EvalResult;

	if (loadedA.kind === "deterministic") {
		resultA = loadedA.result;
	} else {
		const firstTrial = loadedA.result.trials[0];
		if (firstTrial === undefined) {
			if (json) {
				jsonError("eval compare", `Run A has no trials: ${runIdA}`);
			} else {
				process.stderr.write(`Error: Run A has no trials: ${runIdA}\n`);
			}
			process.exitCode = 1;
			return;
		}
		resultA = firstTrial.evalResult;
	}

	if (loadedB.kind === "deterministic") {
		resultB = loadedB.result;
	} else {
		const firstTrial = loadedB.result.trials[0];
		if (firstTrial === undefined) {
			if (json) {
				jsonError("eval compare", `Run B has no trials: ${runIdB}`);
			} else {
				process.stderr.write(`Error: Run B has no trials: ${runIdB}\n`);
			}
			process.exitCode = 1;
			return;
		}
		resultB = firstTrial.evalResult;
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
		.option("--trials <count>", "Number of probabilistic trials")
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
