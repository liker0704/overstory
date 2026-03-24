/**
 * CLI command: ov workflow
 *   ov workflow import <source-path> [--mission <slug>] [--dry-run] [--overwrite] [--json]
 *   ov workflow sync <source-path> [--mission <slug>] [--update] [--force] [--json]
 *
 * Import: parse + transform + validate + write workstreams from a workflow source directory.
 * Sync: drift detection against stored manifest, with optional incremental update.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { jsonError, jsonOutput } from "../json.ts";
import { createMissionStore } from "../missions/store.ts";
import { loadWorkstreamsFile, persistWorkstreamsFile } from "../missions/workstreams.ts";
import { detectDrift, readManifest } from "../workflow/manifest.ts";
import { parseWorkflow } from "../workflow/parse.ts";
import {
	importWorkflow,
	mergeWorkstreamUpdate,
	transformToWorkstreams,
} from "../workflow/transform.ts";
import type { ImportResult, SyncResult } from "../workflow/types.ts";

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

function resolveMissionArtifactRoot(
	overstoryDir: string,
	missionSlug: string | undefined,
	sessionsDbPath: string,
): string | null {
	if (missionSlug !== undefined) {
		const store = createMissionStore(sessionsDbPath);
		try {
			const mission = store.getBySlug(missionSlug);
			if (mission === null) {
				return null;
			}
			return mission.artifactRoot ?? join(overstoryDir, "missions", mission.id);
		} finally {
			store.close();
		}
	}

	// Fall back to active mission
	const store = createMissionStore(sessionsDbPath);
	try {
		const active = store.getActive();
		if (active === null) {
			return null;
		}
		return active.artifactRoot ?? join(overstoryDir, "missions", active.id);
	} finally {
		store.close();
	}
}

function renderImportResult(result: ImportResult, dryRun: boolean): void {
	const prefix = dryRun ? chalk.dim("[dry-run] ") : "";
	process.stdout.write(`${prefix}${chalk.green("Import complete")}\n`);
	process.stdout.write(`  Workstreams: ${result.workstreams.length}\n`);
	process.stdout.write(`  Briefs: ${result.briefs.length}\n`);
	if (result.warnings.length > 0) {
		process.stdout.write("\nWarnings:\n");
		for (const w of result.warnings) {
			process.stdout.write(`  ${chalk.yellow("⚠")} ${w}\n`);
		}
	}
	if (!dryRun) {
		process.stdout.write("\nFiles written:\n");
		for (const brief of result.briefs) {
			process.stdout.write(`  ${chalk.dim(brief.path)}\n`);
		}
	}
}

function renderSyncResult(result: SyncResult, sourcePath: string): void {
	const total =
		result.drifted.length + result.added.length + result.removed.length + result.unchanged.length;

	if (result.drifted.length === 0 && result.added.length === 0 && result.removed.length === 0) {
		process.stdout.write(`${chalk.green("✓")} No drift detected (${total} artifacts checked)\n`);
		return;
	}

	process.stdout.write(`${chalk.yellow("Drift detected")} in ${sourcePath}\n\n`);

	if (result.drifted.length > 0) {
		process.stdout.write(`Modified (${result.drifted.length}):\n`);
		for (const d of result.drifted) {
			process.stdout.write(`  ${chalk.yellow("~")} ${d.workstreamId}\n`);
		}
	}

	if (result.added.length > 0) {
		process.stdout.write(`Added (${result.added.length}):\n`);
		for (const a of result.added) {
			process.stdout.write(`  ${chalk.green("+")} ${a}\n`);
		}
	}

	if (result.removed.length > 0) {
		process.stdout.write(`Removed (${result.removed.length}):\n`);
		for (const r of result.removed) {
			process.stdout.write(`  ${chalk.red("-")} ${r}\n`);
		}
	}

	if (result.unchanged.length > 0) {
		process.stdout.write(`Unchanged: ${result.unchanged.length} artifact(s)\n`);
	}

	process.stdout.write(`\nRun ${chalk.bold("ov workflow sync --update")} to apply changes.\n`);
}

// ── import command ───────────────────────────────────────────────────────────────────────────────

export interface WorkflowImportOptions {
	mission?: string;
	dryRun?: boolean;
	overwrite?: boolean;
	json?: boolean;
}

export async function executeWorkflowImport(
	sourcePath: string,
	opts: WorkflowImportOptions,
): Promise<void> {
	const json = opts.json ?? false;

	let config: Awaited<ReturnType<typeof loadConfig>>;
	try {
		config = await loadConfig(process.cwd());
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) {
			jsonError("workflow:import", msg);
		} else {
			process.stderr.write(`Error: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	const overstoryDir = join(config.project.root, ".overstory");
	const sessionsDbPath = join(overstoryDir, "sessions.db");

	if (!existsSync(sessionsDbPath)) {
		const msg = "No sessions.db found — run `ov init` first or ensure a mission is active.";
		if (json) {
			jsonError("workflow:import", msg);
		} else {
			process.stderr.write(`Error: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	const missionArtifactRoot = resolveMissionArtifactRoot(
		overstoryDir,
		opts.mission,
		sessionsDbPath,
	);
	if (missionArtifactRoot === null) {
		const msg =
			opts.mission !== undefined
				? `Mission not found: "${opts.mission}"`
				: "No active mission. Use --mission <slug> to specify one.";
		if (json) {
			jsonError("workflow:import", msg);
		} else {
			process.stderr.write(`Error: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	// Check for existing workstreams.json — guard against accidental overwrite
	const workstreamsPath = join(missionArtifactRoot, "plan", "workstreams.json");
	if (!opts.overwrite && !opts.dryRun && existsSync(workstreamsPath)) {
		const msg = `workstreams.json already exists at ${workstreamsPath}. Use --overwrite to replace it.`;
		if (json) {
			jsonError("workflow:import", msg);
		} else {
			process.stderr.write(`Error: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	let result: ImportResult;
	try {
		result = await importWorkflow({
			sourcePath,
			missionArtifactRoot,
			dryRun: opts.dryRun,
			overwrite: opts.overwrite,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) {
			jsonError("workflow:import", msg);
		} else {
			process.stderr.write(`Error: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	if (json) {
		jsonOutput("workflow:import", {
			workstreams: result.workstreams,
			briefs: result.briefs.map((b) => ({ workstreamId: b.workstreamId, path: b.path })),
			manifest: result.manifest,
			warnings: result.warnings,
			dryRun: opts.dryRun ?? false,
		});
		return;
	}

	renderImportResult(result, opts.dryRun ?? false);
}

// ── sync command ─────────────────────────────────────────────────────────────────────────────────

export interface WorkflowSyncOptions {
	mission?: string;
	update?: boolean;
	force?: boolean;
	json?: boolean;
}

export async function executeWorkflowSync(
	sourcePath: string,
	opts: WorkflowSyncOptions,
): Promise<void> {
	const json = opts.json ?? false;

	let config: Awaited<ReturnType<typeof loadConfig>>;
	try {
		config = await loadConfig(process.cwd());
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) {
			jsonError("workflow:sync", msg);
		} else {
			process.stderr.write(`Error: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	const overstoryDir = join(config.project.root, ".overstory");
	const sessionsDbPath = join(overstoryDir, "sessions.db");

	if (!existsSync(sessionsDbPath)) {
		const msg = "No sessions.db found — run `ov init` first or ensure a mission is active.";
		if (json) {
			jsonError("workflow:sync", msg);
		} else {
			process.stderr.write(`Error: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	const missionArtifactRoot = resolveMissionArtifactRoot(
		overstoryDir,
		opts.mission,
		sessionsDbPath,
	);
	if (missionArtifactRoot === null) {
		const msg =
			opts.mission !== undefined
				? `Mission not found: "${opts.mission}"`
				: "No active mission. Use --mission <slug> to specify one.";
		if (json) {
			jsonError("workflow:sync", msg);
		} else {
			process.stderr.write(`Error: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	const manifestPath = join(missionArtifactRoot, "plan", "import-manifest.json");
	const manifest = await readManifest(manifestPath);

	if (manifest === null) {
		const msg = `No import manifest found at ${manifestPath}. Run \`ov workflow import\` first.`;
		if (json) {
			jsonError("workflow:sync", msg);
		} else {
			process.stderr.write(`Error: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	// Detect drift
	let syncResult: SyncResult;
	try {
		syncResult = await detectDrift(manifest, sourcePath);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) {
			jsonError("workflow:sync", msg);
		} else {
			process.stderr.write(`Error: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	const hasDrift =
		syncResult.drifted.length > 0 || syncResult.added.length > 0 || syncResult.removed.length > 0;

	// If --update, apply incremental changes
	if (opts.update && hasDrift) {
		try {
			const parsed = await parseWorkflow(sourcePath);
			const { workstreamsFile: incomingFile } = transformToWorkstreams(parsed);

			// Load existing workstreams
			const workstreamsPath = join(missionArtifactRoot, "plan", "workstreams.json");
			const loadResult = await loadWorkstreamsFile(workstreamsPath);
			const existingWorkstreams = loadResult.workstreams?.workstreams ?? [];

			const mergeResult = await mergeWorkstreamUpdate(
				{
					existing: existingWorkstreams,
					incoming: incomingFile.workstreams,
					manifest,
				},
				parsed,
				opts.force ?? false,
				missionArtifactRoot,
			);

			if (!opts.force && mergeResult.skippedBriefs.length > 0) {
				process.stdout.write(
					`Skipped ${mergeResult.skippedBriefs.length} manually-edited brief(s): ${mergeResult.skippedBriefs.join(", ")}\n`,
				);
			}

			// Write updated workstreams.json
			await persistWorkstreamsFile(workstreamsPath, mergeResult.merged);

			// Write updated briefs
			for (const brief of mergeResult.updatedBriefs) {
				await Bun.write(brief.path, brief.content);
			}

			// Re-create manifest
			const { createManifest, writeManifest } = await import("../workflow/manifest.ts");
			const briefContents: Record<string, string> = {};
			for (const brief of mergeResult.updatedBriefs) {
				briefContents[brief.workstreamId] = brief.content;
			}
			const workstreamIds = mergeResult.merged.map((ws) => ws.id);
			const newManifest = await createManifest(sourcePath, parsed, workstreamIds, briefContents);
			await writeManifest(manifestPath, newManifest);

			if (json) {
				jsonOutput("workflow:sync", {
					syncResult,
					updated: true,
					mergedWorkstreams: mergeResult.merged.length,
					updatedBriefs: mergeResult.updatedBriefs.length,
					skippedBriefs: mergeResult.skippedBriefs,
					warnings: mergeResult.warnings,
				});
				return;
			}

			process.stdout.write(`${chalk.green("✓")} Sync applied\n`);
			process.stdout.write(`  Workstreams updated: ${mergeResult.merged.length}\n`);
			process.stdout.write(`  Briefs updated: ${mergeResult.updatedBriefs.length}\n`);
			if (mergeResult.skippedBriefs.length > 0) {
				process.stdout.write(`  Skipped (manual edits): ${mergeResult.skippedBriefs.join(", ")}\n`);
			}
			if (mergeResult.warnings.length > 0) {
				process.stdout.write("\nWarnings:\n");
				for (const w of mergeResult.warnings) {
					process.stdout.write(`  ${chalk.yellow("⚠")} ${w}\n`);
				}
			}
			return;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (json) {
				jsonError("workflow:sync", msg);
			} else {
				process.stderr.write(`Error applying sync: ${msg}\n`);
			}
			process.exitCode = 1;
			return;
		}
	}

	if (json) {
		jsonOutput("workflow:sync", { syncResult, updated: false });
		return;
	}

	renderSyncResult(syncResult, sourcePath);
}

// ── createWorkflowCommand ────────────────────────────────────────────────────────────────────────

export function createWorkflowCommand(): Command {
	const cmd = new Command("workflow").description(
		"Import and sync workflows from a claude-code-workflow task directory",
	);

	cmd
		.command("import")
		.description("Parse, transform, validate, and write workstreams from a workflow source")
		.argument("<source-path>", "Path to the workflow source directory (contains task.md)")
		.option("--mission <slug>", "Target mission slug (defaults to active mission)")
		.option("--dry-run", "Preview changes without writing any files")
		.option("--overwrite", "Overwrite existing workstreams.json")
		.option("--json", "Output as JSON")
		.action(async (sourcePath: string, opts: WorkflowImportOptions) => {
			await executeWorkflowImport(sourcePath, opts);
		});

	cmd
		.command("sync")
		.description(
			"Detect drift between source artifacts and stored manifest; optionally apply updates",
		)
		.argument("<source-path>", "Path to the workflow source directory")
		.option("--mission <slug>", "Target mission slug (defaults to active mission)")
		.option("--update", "Apply incremental update from drift (preserves execution state)")
		.option("--force", "Overwrite manually-edited briefs during update")
		.option("--json", "Output as JSON")
		.action(async (sourcePath: string, opts: WorkflowSyncOptions) => {
			await executeWorkflowSync(sourcePath, opts);
		});

	return cmd;
}
