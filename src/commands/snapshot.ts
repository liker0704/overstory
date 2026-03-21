/**
 * CLI command: ov snapshot [--agent <name>] [--run <id>] [--mission <id>] [--output <dir>] [--json]
 *
 * Creates a SwarmSnapshot of all agent state and exports it as a recovery bundle.
 */

import { join } from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { jsonError, jsonOutput } from "../json.ts";
import { createSnapshot, exportSnapshotBundle } from "../recovery/snapshot.ts";

export interface SnapshotCommandOptions {
	agent?: string;
	run?: string;
	mission?: string;
	output?: string;
	json?: boolean;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Core snapshot command logic, extracted for testability.
 */
export async function executeSnapshot(opts: SnapshotCommandOptions): Promise<void> {
	const json = opts.json ?? false;

	let config: Awaited<ReturnType<typeof loadConfig>>;
	try {
		config = await loadConfig(process.cwd());
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) {
			jsonError("snapshot", msg);
		} else {
			process.stderr.write(`Error: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	const projectRoot = config.project.root;

	const agentFilter = opts.agent ? [opts.agent] : undefined;

	let snapshot: Awaited<ReturnType<typeof createSnapshot>>;
	try {
		snapshot = await createSnapshot(projectRoot, { agentFilter });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) {
			jsonError("snapshot", msg);
		} else {
			process.stderr.write(`Error creating snapshot: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	const outputDir =
		opts.output ?? join(projectRoot, ".overstory", "snapshots", snapshot.snapshotId);

	let manifest: Awaited<ReturnType<typeof exportSnapshotBundle>>;
	try {
		manifest = await exportSnapshotBundle(snapshot, outputDir);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) {
			jsonError("snapshot", msg);
		} else {
			process.stderr.write(`Error exporting bundle: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	const componentSummary = {
		sessions: snapshot.sessions.length,
		runs: snapshot.runs.length,
		missions: snapshot.missions.length,
		mail: snapshot.mail.length,
		mergeQueue: snapshot.mergeQueue.length,
		checkpoints: Object.keys(snapshot.checkpoints).length,
		identities: Object.keys(snapshot.identities).length,
		worktrees: snapshot.worktreeStatus.length,
	};

	if (json) {
		jsonOutput("snapshot", {
			bundlePath: outputDir,
			manifest,
			componentSummary,
		});
		return;
	}

	const totalBytes = manifest.files.reduce((sum, f) => sum + f.sizeBytes, 0);
	process.stdout.write(`${chalk.green("✓")} Snapshot created: ${chalk.cyan(outputDir)}\n`);
	process.stdout.write(`  Files: ${manifest.files.length}  Size: ${formatBytes(totalBytes)}\n`);
	process.stdout.write(
		`  Sessions: ${componentSummary.sessions}  Runs: ${componentSummary.runs}` +
			`  Missions: ${componentSummary.missions}  Mail: ${componentSummary.mail}\n`,
	);
	process.stdout.write(
		`  Checkpoints: ${componentSummary.checkpoints}  Identities: ${componentSummary.identities}` +
			`  Worktrees: ${componentSummary.worktrees}  MergeQueue: ${componentSummary.mergeQueue}\n`,
	);
}

/**
 * Create the `ov snapshot` command.
 */
export function createSnapshotCommand(): Command {
	return new Command("snapshot")
		.description("Create a recovery snapshot of all swarm state")
		.option("--agent <name>", "Filter snapshot to a specific agent")
		.option("--run <id>", "Scope to a specific run")
		.option("--mission <id>", "Scope to a specific mission")
		.option("--output <dir>", "Output directory for the snapshot bundle")
		.option("--json", "Output as JSON")
		.action(async (opts: SnapshotCommandOptions) => {
			await executeSnapshot(opts);
		});
}
