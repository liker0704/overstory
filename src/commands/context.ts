/**
 * CLI command: ov context <generate|show|invalidate>
 *
 * Manages the project context cache at .overstory/project-context.json.
 *
 *   generate   Run all signal analyzers and write project-context.json
 *   show       Display cached context (rendered or raw JSON)
 *   invalidate Delete the cached context file
 */

import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { analyzeProject } from "../context/analyze.ts";
import { isCacheValid, readCachedContext, writeCachedContext } from "../context/cache.ts";
import { renderContext } from "../context/render.ts";
import { jsonError, jsonOutput } from "../json.ts";

const CACHE_FILENAME = "project-context.json";

// ─── generate ─────────────────────────────────────────────────────────────────

export interface ContextGenerateOptions {
	force?: boolean;
	json?: boolean;
}

export async function executeContextGenerate(opts: ContextGenerateOptions): Promise<void> {
	const json = opts.json ?? false;

	let config: Awaited<ReturnType<typeof loadConfig>>;
	try {
		config = await loadConfig(process.cwd());
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) {
			jsonError("context generate", msg);
		} else {
			process.stderr.write(`Error: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	const overstoryDir = join(config.project.root, ".overstory");
	const cachePath = join(overstoryDir, CACHE_FILENAME);
	const projectRoot = config.project.root;

	// Check if cache is valid and skip if not forced
	if (!opts.force) {
		const cached = readCachedContext(cachePath);
		if (cached !== null) {
			const { computeStructuralHash } = await import("../context/cache.ts");
			const currentHash = await computeStructuralHash(projectRoot);
			if (isCacheValid(cached, currentHash)) {
				if (json) {
					jsonOutput("context generate", {
						status: "cached",
						cachePath,
						generatedAt: cached.generatedAt,
					});
				} else {
					process.stdout.write(
						`Context is up to date (generated ${cached.generatedAt}). Use --force to regenerate.\n`,
					);
				}
				return;
			}
		}
	}

	const disabledSignals = config.context?.disabledSignals;
	const context = await analyzeProject(projectRoot, { disabledSignals });

	await writeCachedContext(cachePath, context);

	if (json) {
		const { signals } = context;
		jsonOutput("context generate", {
			status: "generated",
			cachePath,
			generatedAt: context.generatedAt,
			structuralHash: context.structuralHash,
			summary: {
				languages: signals.languages.length,
				importHotspots: signals.importHotspots.length,
				configZones: signals.configZones.length,
				sharedInvariants: signals.sharedInvariants.length,
			},
		});
		return;
	}

	// Human-readable summary
	const { signals } = context;
	process.stdout.write(`Project context generated → ${cachePath}\n\n`);
	if (signals.languages.length > 0) {
		const langs = signals.languages
			.map((l) => (l.framework ? `${l.language} (${l.framework})` : l.language))
			.join(", ");
		process.stdout.write(`  Languages:        ${langs}\n`);
	}
	if (signals.testConventions.framework) {
		process.stdout.write(`  Test framework:   ${signals.testConventions.framework}\n`);
	}
	if (signals.directoryProfile.sourceRoots.length > 0) {
		process.stdout.write(
			`  Source roots:     ${signals.directoryProfile.sourceRoots.join(", ")}\n`,
		);
	}
	if (signals.importHotspots.length > 0) {
		process.stdout.write(`  Import hotspots:  ${signals.importHotspots.length} detected\n`);
	}
	if (signals.sharedInvariants.length > 0) {
		process.stdout.write(`  Shared invariants: ${signals.sharedInvariants.length} detected\n`);
	}
	process.stdout.write(`\n  Hash: ${context.structuralHash.slice(0, 16)}\n`);
}

// ─── show ──────────────────────────────────────────────────────────────────────

export interface ContextShowOptions {
	compact?: boolean;
	json?: boolean;
	signal?: string;
}

export async function executeContextShow(opts: ContextShowOptions): Promise<void> {
	const json = opts.json ?? false;

	let config: Awaited<ReturnType<typeof loadConfig>>;
	try {
		config = await loadConfig(process.cwd());
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) {
			jsonError("context show", msg);
		} else {
			process.stderr.write(`Error: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	const cachePath = join(config.project.root, ".overstory", CACHE_FILENAME);
	const cached = readCachedContext(cachePath);

	if (cached === null) {
		if (json) {
			jsonError("context show", "No cached context found. Run `ov context generate` first.");
		} else {
			process.stderr.write("No cached context found. Run `ov context generate` to create one.\n");
		}
		process.exitCode = 1;
		return;
	}

	if (json) {
		if (opts.signal) {
			const signals = cached.signals as unknown as Record<string, unknown>;
			const value = signals[opts.signal];
			if (value === undefined) {
				jsonError("context show", `Unknown signal: ${opts.signal}`);
				process.exitCode = 1;
				return;
			}
			jsonOutput("context show", { signal: opts.signal, value });
		} else {
			jsonOutput("context show", cached as unknown as Record<string, unknown>);
		}
		return;
	}

	if (opts.signal) {
		const signals = cached.signals as unknown as Record<string, unknown>;
		const value = signals[opts.signal];
		if (value === undefined) {
			process.stderr.write(`Unknown signal: ${opts.signal}\n`);
			process.exitCode = 1;
			return;
		}
		process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
		return;
	}

	const compact = opts.compact !== false;
	const rendered = renderContext(cached, { compact });
	process.stdout.write(`${rendered}\n`);
}

// ─── invalidate ───────────────────────────────────────────────────────────────

export interface ContextInvalidateOptions {
	json?: boolean;
}

export async function executeContextInvalidate(opts: ContextInvalidateOptions): Promise<void> {
	const json = opts.json ?? false;

	let config: Awaited<ReturnType<typeof loadConfig>>;
	try {
		config = await loadConfig(process.cwd());
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (json) {
			jsonError("context invalidate", msg);
		} else {
			process.stderr.write(`Error: ${msg}\n`);
		}
		process.exitCode = 1;
		return;
	}

	const cachePath = join(config.project.root, ".overstory", CACHE_FILENAME);

	if (!existsSync(cachePath)) {
		if (json) {
			jsonOutput("context invalidate", { status: "not_found", cachePath });
		} else {
			process.stdout.write("No context cache to invalidate.\n");
		}
		return;
	}

	await unlink(cachePath);

	if (json) {
		jsonOutput("context invalidate", { status: "deleted", cachePath });
	} else {
		process.stdout.write(`Context cache deleted: ${cachePath}\n`);
	}
}

// ─── command factory ──────────────────────────────────────────────────────────

export function createContextCommand(): Command {
	const cmd = new Command("context").description("Manage project context cache (signal analysis)");

	cmd
		.command("generate")
		.description("Analyze project and generate context cache")
		.option("--force", "Regenerate even if cache is valid")
		.option("--json", "Output as JSON")
		.action(async (opts: ContextGenerateOptions) => {
			await executeContextGenerate(opts);
		});

	cmd
		.command("show")
		.description("Display cached project context")
		.option("--compact", "Compact summary (default)")
		.option("--json", "Output raw JSON")
		.option("--signal <name>", "Show a specific signal by name")
		.action(async (opts: ContextShowOptions) => {
			await executeContextShow(opts);
		});

	cmd
		.command("invalidate")
		.description("Delete the project context cache")
		.option("--json", "Output as JSON")
		.action(async (opts: ContextInvalidateOptions) => {
			await executeContextInvalidate(opts);
		});

	return cmd;
}
