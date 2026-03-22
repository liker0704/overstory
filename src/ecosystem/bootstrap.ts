/**
 * Ecosystem bootstrap: sibling tool initialization and onboarding.
 *
 * Extracted from src/commands/init.ts to isolate os-eco tool bootstrap
 * logic (mulch, seeds, canopy) from the core init scaffolding.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { printSuccess, printWarning } from "../logging/color.ts";

// ---- Spawner abstraction ----

/**
 * Spawner abstraction for testability.
 * Wraps Bun.spawn for running sibling CLI tools.
 */
export type Spawner = (
	args: string[],
	opts?: { cwd?: string },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export const defaultSpawner: Spawner = async (args, opts) => {
	try {
		const proc = Bun.spawn(args, {
			cwd: opts?.cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		return { exitCode, stdout, stderr };
	} catch (err) {
		// Binary not found (ENOENT) or other spawn failure -- treat as non-zero exit
		const message = err instanceof Error ? err.message : String(err);
		return { exitCode: 1, stdout: "", stderr: message };
	}
};

// ---- Sibling tool definitions ----

export interface SiblingTool {
	name: string;
	cli: string;
	dotDir: string;
	initCmd: string[];
	onboardCmd: string[];
}

export const SIBLING_TOOLS: SiblingTool[] = [
	{ name: "mulch", cli: "ml", dotDir: ".mulch", initCmd: ["init"], onboardCmd: ["onboard"] },
	{ name: "seeds", cli: "sd", dotDir: ".seeds", initCmd: ["init"], onboardCmd: ["onboard"] },
	{ name: "canopy", cli: "cn", dotDir: ".canopy", initCmd: ["init"], onboardCmd: ["onboard"] },
];

export type ToolStatus = "initialized" | "already_initialized" | "skipped";
export type OnboardStatus = "appended" | "current";

// ---- Tool resolution ----

/** Options relevant to tool set resolution. */
export interface ToolSetOptions {
	tools?: string;
	skipMulch?: boolean;
	skipSeeds?: boolean;
	skipCanopy?: boolean;
}

/**
 * Resolve the set of sibling tools to bootstrap.
 *
 * If opts.tools is set (comma-separated list of names), filter to those.
 * Otherwise start with all three and remove any skipped via skip flags.
 */
export function resolveToolSet(opts: ToolSetOptions): SiblingTool[] {
	if (opts.tools) {
		const requested = opts.tools.split(",").map((t) => t.trim());
		return SIBLING_TOOLS.filter((t) => requested.includes(t.name));
	}
	return SIBLING_TOOLS.filter((t) => {
		if (t.name === "mulch" && opts.skipMulch) return false;
		if (t.name === "seeds" && opts.skipSeeds) return false;
		if (t.name === "canopy" && opts.skipCanopy) return false;
		return true;
	});
}

// ---- Tool probing ----

async function isToolInstalled(cli: string, spawner: Spawner): Promise<boolean> {
	try {
		const result = await spawner([cli, "--version"]);
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

// ---- Init + Onboard ----

export async function initSiblingTool(
	tool: SiblingTool,
	projectRoot: string,
	spawner: Spawner,
): Promise<ToolStatus> {
	const installed = await isToolInstalled(tool.cli, spawner);
	if (!installed) {
		printWarning(
			`${tool.name} not installed -- skipping`,
			`install: npm i -g @os-eco/${tool.name}-cli`,
		);
		return "skipped";
	}

	let result: { exitCode: number; stdout: string; stderr: string };
	try {
		result = await spawner([tool.cli, ...tool.initCmd], { cwd: projectRoot });
	} catch (err) {
		// Spawn failure (e.g. ENOENT) -- treat as not installed
		const message = err instanceof Error ? err.message : String(err);
		printWarning(`${tool.name} init failed`, message);
		return "skipped";
	}
	if (result.exitCode !== 0) {
		// Check if dot directory already exists (already initialized)
		try {
			await stat(join(projectRoot, tool.dotDir));
			return "already_initialized";
		} catch {
			// Directory doesn't exist -- real failure
			printWarning(`${tool.name} init failed`, result.stderr.trim() || result.stdout.trim());
			return "skipped";
		}
	}

	printSuccess(`Bootstrapped ${tool.name}`);
	return "initialized";
}

export async function onboardTool(
	tool: SiblingTool,
	projectRoot: string,
	spawner: Spawner,
): Promise<OnboardStatus> {
	const installed = await isToolInstalled(tool.cli, spawner);
	if (!installed) return "current";

	try {
		const result = await spawner([tool.cli, ...tool.onboardCmd], { cwd: projectRoot });
		return result.exitCode === 0 ? "appended" : "current";
	} catch {
		return "current";
	}
}

// ---- Gitattributes ----

/**
 * Set up .gitattributes with merge=union entries for JSONL files.
 *
 * Only adds entries not already present. Returns true if file was modified.
 */
export async function setupGitattributes(projectRoot: string): Promise<boolean> {
	const entries = [".mulch/expertise/*.jsonl merge=union", ".seeds/issues.jsonl merge=union"];

	const gitattrsPath = join(projectRoot, ".gitattributes");
	let existing = "";

	try {
		existing = await Bun.file(gitattrsPath).text();
	} catch {
		// File doesn't exist yet -- will be created
	}

	const missing = entries.filter((e) => !existing.includes(e));
	if (missing.length === 0) return false;

	const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
	await Bun.write(gitattrsPath, `${existing}${separator}${missing.join("\n")}\n`);
	return true;
}
