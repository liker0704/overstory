/**
 * CLI command: ov research
 *
 * Runs deep research on a topic via a coordinator-driven researcher swarm.
 * Provides 5 subcommands: start, stop, status, list, output.
 */

import { Command } from "commander";
import { jsonError, jsonOutput } from "../json.ts";
import { formatReportSummary as _formatReportSummary } from "../research/output.ts";
import {
	getResearchOutput,
	getResearchStatus,
	listResearch,
	startResearch,
	stopResearch,
} from "../research/runner.ts";
import type { ResearchSession } from "../research/types.ts";

// --- DI Interface ---

/** Result returned by startResearch. */
export interface ResearchStartResult {
	slug: string;
	agentName: string;
	runId: string;
}

/** Options passed to startResearch. */
export interface ResearchStartOptions {
	topic: string;
	name?: string;
	maxResearchers?: number;
	attach?: boolean;
	watchdog?: boolean;
	json?: boolean;
}

/**
 * Dependency injection interface for the research command.
 * All runner functions are injectable for testability.
 */
export interface ResearchDeps {
	startResearch: (opts: ResearchStartOptions) => Promise<ResearchStartResult>;
	stopResearch: (name?: string) => Promise<void>;
	getResearchStatus: (name?: string) => Promise<ResearchSession | null>;
	listResearch: () => Promise<ResearchSession[]>;
	/** Returns file content (or path when opts.path=true), or null if not found. */
	getResearchOutput: (name: string | undefined, opts: { path?: boolean }) => Promise<string | null>;
	formatReportSummary?: (session: ResearchSession) => string;
}

// --- Default deps (real implementations) ---

const defaultDeps: ResearchDeps = {
	startResearch,
	stopResearch,
	getResearchStatus,
	listResearch,
	getResearchOutput,
	formatReportSummary: _formatReportSummary as unknown as (session: ResearchSession) => string,
};

// --- Format helpers ---

function formatSessionRow(session: ResearchSession): string {
	const cols = [
		session.slug.padEnd(20),
		session.topic.slice(0, 30).padEnd(32),
		session.status.padEnd(12),
		session.startedAt.slice(0, 19),
	];
	return `  ${cols.join("  ")}`;
}

// --- Command factory ---

/**
 * Build Commander command for ov research.
 * Accepts optional deps for testing (real runner is loaded lazily when omitted).
 */
export function createResearchCommand(deps?: ResearchDeps): Command {
	const cmd = new Command("research").description("Run deep research on a topic");

	// 1. start <topic>
	cmd
		.command("start")
		.description("Start a research session on a topic")
		.argument("<topic>", "Research topic or question")
		.option("--name <name>", "Agent name for the research session")
		.option("--attach", "Attach to the agent tmux session after start")
		.option("--no-attach", "Do not attach to the agent tmux session")
		.option("--max-researchers <n>", "Maximum number of researcher agents (default: 5)", "5")
		.option("--watchdog", "Auto-start watchdog daemon with the research session")
		.option("--json", "Output result as JSON")
		.action(
			async (
				topic: string,
				opts: {
					name?: string;
					attach?: boolean;
					maxResearchers?: string;
					watchdog?: boolean;
					json?: boolean;
				},
			) => {
				const json = opts.json ?? false;
				const maxResearchers = parseInt(opts.maxResearchers ?? "5", 10);
				const resolvedDeps = deps ?? defaultDeps;
				const startResearch = resolvedDeps.startResearch;
				try {
					const result = await startResearch({
						topic,
						name: opts.name,
						maxResearchers,
						attach: opts.attach,
						watchdog: opts.watchdog,
						json,
					});
					if (json) {
						jsonOutput("research start", {
							slug: result.slug,
							agentName: result.agentName,
							runId: result.runId,
						});
					} else {
						process.stdout.write(`Research started: ${result.slug} (agent: ${result.agentName})\n`);
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					if (json) {
						jsonError("research start", message);
					} else {
						process.stderr.write(`Error: ${message}\n`);
						process.exitCode = 1;
					}
				}
			},
		);

	// 2. stop [name]
	cmd
		.command("stop")
		.description("Stop a running research session")
		.argument("[name]", "Research session name or slug")
		.option("--json", "Output result as JSON")
		.action(async (name: string | undefined, opts: { json?: boolean }) => {
			const json = opts.json ?? false;
			const resolvedDeps = deps ?? defaultDeps;
			const stopResearch = resolvedDeps.stopResearch;
			try {
				await stopResearch(name);
				if (json) {
					jsonOutput("research stop", { stopped: true });
				} else {
					process.stdout.write("Research stopped.\n");
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (json) {
					jsonError("research stop", message);
				} else {
					process.stderr.write(`Error: ${message}\n`);
					process.exitCode = 1;
				}
			}
		});

	// 3. status [name]
	cmd
		.command("status")
		.description("Show status of a research session")
		.argument("[name]", "Research session name or slug")
		.option("--json", "Output result as JSON")
		.action(async (name: string | undefined, opts: { json?: boolean }) => {
			const json = opts.json ?? false;
			const resolvedDeps = deps ?? defaultDeps;
			const getResearchStatus = resolvedDeps.getResearchStatus;
			try {
				const session = await getResearchStatus(name);
				if (session === null) {
					if (json) {
						jsonOutput("research status", { found: false });
					} else {
						process.stdout.write("No active research session found.\n");
					}
				} else if (json) {
					jsonOutput("research status", { found: true, session });
				} else {
					const fmt = resolvedDeps.formatReportSummary;
					if (fmt) {
						process.stdout.write(`${fmt(session)}\n`);
					} else {
						process.stdout.write(
							`slug: ${session.slug}\ntopic: ${session.topic}\nstatus: ${session.status}\nstarted: ${session.startedAt}\n`,
						);
					}
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (json) {
					jsonError("research status", message);
				} else {
					process.stderr.write(`Error: ${message}\n`);
					process.exitCode = 1;
				}
			}
		});

	// 4. list
	cmd
		.command("list")
		.description("List all research sessions")
		.option("--json", "Output result as JSON")
		.action(async (opts: { json?: boolean }) => {
			const json = opts.json ?? false;
			const resolvedDeps = deps ?? defaultDeps;
			const listResearch = resolvedDeps.listResearch;
			try {
				const sessions = await listResearch();
				if (json) {
					jsonOutput("research list", { sessions });
				} else if (sessions.length === 0) {
					process.stdout.write("No research sessions found.\n");
				} else {
					const header = `  ${"SLUG".padEnd(20)}  ${"TOPIC".padEnd(32)}  ${"STATUS".padEnd(12)}  STARTED`;
					process.stdout.write(`${header}\n`);
					for (const s of sessions) {
						process.stdout.write(`${formatSessionRow(s)}\n`);
					}
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (json) {
					jsonError("research list", message);
				} else {
					process.stderr.write(`Error: ${message}\n`);
					process.exitCode = 1;
				}
			}
		});

	// 5. output [name]
	cmd
		.command("output")
		.description("Show or locate research output")
		.argument("[name]", "Research session name or slug")
		.option("--path", "Print the output file path instead of content")
		.option("--json", "Output result as JSON")
		.action(async (name: string | undefined, opts: { path?: boolean; json?: boolean }) => {
			const json = opts.json ?? false;
			const pathOnly = opts.path ?? false;
			const resolvedDeps = deps ?? defaultDeps;
			const getResearchOutput = resolvedDeps.getResearchOutput;
			try {
				const result = await getResearchOutput(name, { path: pathOnly });
				if (result === null) {
					if (json) {
						jsonOutput("research output", { found: false });
					} else {
						process.stdout.write("No research output found.\n");
					}
				} else if (json) {
					const data: Record<string, unknown> = { found: true };
					if (pathOnly) {
						data.path = result;
					} else {
						data.content = result;
					}
					jsonOutput("research output", data);
				} else {
					process.stdout.write(`${result}\n`);
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (json) {
					jsonError("research output", message);
				} else {
					process.stderr.write(`Error: ${message}\n`);
					process.exitCode = 1;
				}
			}
		});

	return cmd;
}
