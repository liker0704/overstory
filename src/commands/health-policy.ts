/**
 * CLI command: ov health policy [--execute] [--json]
 *              ov health policy history [--limit N] [--json]
 *              ov health policy disable
 *              ov health policy enable
 *
 * Evaluates health policy rules against the current swarm health score.
 * Dry-run is the default; pass --execute to apply actions.
 */

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { createEventStore } from "../events/store.ts";
import { evaluatePolicy } from "../health/policy/evaluator.ts";
import { loadRecentActions } from "../health/policy/history.ts";
import { recordPolicyEvaluationResult } from "../health/policy/recorder.ts";
import { renderPolicyEvaluation, renderPolicyHistory } from "../health/policy/render.ts";
import type { PolicyRule } from "../health/policy/types.ts";
import { computeScore } from "../health/score.ts";
import { collectSignals } from "../health/signals.ts";
import { jsonError, jsonOutput } from "../json.ts";

const MS_24H = 24 * 60 * 60 * 1000;

export function createHealthPolicyCommand(): Command {
	const cmd = new Command("health-policy")
		.description("Evaluate and manage health policy rules")
		.option("--execute", "Execute triggered actions (default: dry-run only)")
		.option("--json", "Output as JSON")
		.action(async (opts: { execute?: boolean; json?: boolean }) => {
			const json = opts.json ?? false;

			let config: Awaited<ReturnType<typeof loadConfig>>;
			try {
				config = await loadConfig(process.cwd());
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (json) jsonError("health-policy", msg);
				else process.stderr.write(`Error: ${msg}\n`);
				process.exitCode = 1;
				return;
			}

			if (!config.healthPolicy) {
				if (json) jsonOutput("health-policy", { configured: false });
				else process.stdout.write("Health policy is not configured.\n");
				return;
			}

			const overstoryDir = join(config.project.root, ".overstory");

			let signals: ReturnType<typeof collectSignals>;
			try {
				signals = collectSignals({ overstoryDir });
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (json) jsonError("health-policy", `Signal collection failed: ${msg}`);
				else process.stderr.write(`Error collecting signals: ${msg}\n`);
				process.exitCode = 1;
				return;
			}

			const score = computeScore(signals);

			const eventsDb = join(overstoryDir, "events.db");
			const eventStore = createEventStore(eventsDb);

			const rules = config.healthPolicy.rules as PolicyRule[];
			const history = loadRecentActions(eventStore, config.healthPolicy.defaultCooldownMs);
			const dryRun = !(opts.execute ?? false);
			const result = evaluatePolicy(score, rules, history, { dryRun });

			if (!dryRun) {
				recordPolicyEvaluationResult(eventStore, result.evaluations, null, history);
			}

			if (json) {
				jsonOutput("health-policy", result as unknown as Record<string, unknown>);
				return;
			}

			process.stdout.write(renderPolicyEvaluation(result) + "\n");
		});

	cmd
		.command("history")
		.description("Show recent policy action history")
		.option("--limit <n>", "Number of records to show", "20")
		.option("--json", "Output as JSON")
		.action(async (opts: { limit?: string; json?: boolean }) => {
			const json = opts.json ?? false;
			const limit = Number(opts.limit ?? 20);

			let config: Awaited<ReturnType<typeof loadConfig>>;
			try {
				config = await loadConfig(process.cwd());
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (json) jsonError("health-policy", msg);
				else process.stderr.write(`Error: ${msg}\n`);
				process.exitCode = 1;
				return;
			}

			const overstoryDir = join(config.project.root, ".overstory");
			const eventsDb = join(overstoryDir, "events.db");
			const eventStore = createEventStore(eventsDb);

			const records = loadRecentActions(eventStore, MS_24H).slice(0, limit);

			if (json) {
				jsonOutput("health-policy-history", { records });
				return;
			}

			process.stdout.write(renderPolicyHistory(records) + "\n");
		});

	cmd
		.command("disable")
		.description("Disable health policy via kill switch")
		.action(async () => {
			let config: Awaited<ReturnType<typeof loadConfig>>;
			try {
				config = await loadConfig(process.cwd());
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				process.stderr.write(`Error: ${msg}\n`);
				process.exitCode = 1;
				return;
			}

			const overstoryDir = join(config.project.root, ".overstory");
			const sentinelPath = join(overstoryDir, "health-policy-disabled");
			writeFileSync(sentinelPath, "");
			process.stdout.write("Health policy disabled (kill switch active).\n");
		});

	cmd
		.command("enable")
		.description("Re-enable health policy (removes kill switch)")
		.action(async () => {
			let config: Awaited<ReturnType<typeof loadConfig>>;
			try {
				config = await loadConfig(process.cwd());
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				process.stderr.write(`Error: ${msg}\n`);
				process.exitCode = 1;
				return;
			}

			const overstoryDir = join(config.project.root, ".overstory");
			const sentinelPath = join(overstoryDir, "health-policy-disabled");
			if (existsSync(sentinelPath)) {
				rmSync(sentinelPath);
			}
			process.stdout.write("Health policy enabled.\n");
		});

	return cmd;
}
