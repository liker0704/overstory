/**
 * CLI command: ov spec write <bead-id> --body <content>
 *
 * Writes a task specification to `.overstory/specs/<task-id>.md`.
 * Scouts use this to persist spec documents as files instead of
 * sending entire specs via mail messages.
 *
 * Supports reading body content from --body flag or stdin.
 */

import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { printSuccess } from "../logging/color.ts";
import { computeBriefRevision } from "../missions/brief-refresh.ts";
import { writeSpecMeta } from "../missions/spec-meta.ts";
import { normalizeTrackedPath } from "../missions/workstream-control.ts";

export interface SpecWriteOptions {
	body?: string;
	agent?: string;
	workstreamId?: string;
	briefPath?: string;
	json?: boolean;
}

function computeContentRevision(content: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(content);
	return hasher.digest("hex");
}

/**
 * Read all of stdin as a string. Returns empty string if stdin is a TTY
 * (no piped input).
 */
async function readStdin(): Promise<string> {
	// Bun.stdin is a ReadableStream when piped, a TTY otherwise
	if (process.stdin.isTTY) {
		return "";
	}
	return await new Response(Bun.stdin.stream()).text();
}

/**
 * Write a spec file to .overstory/specs/<task-id>.md.
 *
 * Exported for direct use in tests.
 */
export async function writeSpec(
	projectRoot: string,
	taskId: string,
	body: string,
	agent?: string,
): Promise<string> {
	const specsDir = join(projectRoot, ".overstory", "specs");
	await mkdir(specsDir, { recursive: true });

	// Build the spec content with optional attribution header
	let content = "";
	if (agent) {
		content += `<!-- written-by: ${agent} -->\n`;
	}
	content += body;

	// Ensure trailing newline
	if (!content.endsWith("\n")) {
		content += "\n";
	}

	const specPath = join(specsDir, `${taskId}.md`);
	await Bun.write(specPath, content);

	return specPath;
}

export async function writeSpecCompanionMeta(
	projectRoot: string,
	taskId: string,
	specPath: string,
	opts: {
		workstreamId: string;
		briefPath: string;
		generatedBy?: string;
	},
): Promise<string> {
	const specContent = await Bun.file(specPath).text();
	const normalizedBriefPath = normalizeTrackedPath(projectRoot, opts.briefPath);
	const absoluteBriefPath = resolve(projectRoot, normalizedBriefPath);
	const briefRevision = await computeBriefRevision(absoluteBriefPath);
	const specRevision = computeContentRevision(specContent);

	return writeSpecMeta(projectRoot, taskId, {
		taskId,
		workstreamId: opts.workstreamId,
		briefPath: normalizedBriefPath,
		briefRevision,
		specRevision,
		status: "current",
		generatedAt: new Date().toISOString(),
		generatedBy: opts.generatedBy ?? opts.workstreamId,
	});
}

/**
 * Entry point for `ov spec write <bead-id> [flags]`.
 *
 * @param taskId - The task ID for the spec file
 * @param opts - Command options
 */
export async function specWriteCommand(taskId: string, opts: SpecWriteOptions): Promise<void> {
	if (!taskId || taskId.trim().length === 0) {
		throw new ValidationError("Task ID is required: ov spec write <task-id> --body <content>", {
			field: "taskId",
		});
	}

	let body = opts.body;

	// If no --body flag, try reading from stdin
	if (body === undefined) {
		const stdinContent = await readStdin();
		if (stdinContent.trim().length > 0) {
			body = stdinContent;
		}
	}

	if (body === undefined || body.trim().length === 0) {
		throw new ValidationError("Spec body is required: use --body <content> or pipe via stdin", {
			field: "body",
		});
	}
	const metaRequested = opts.workstreamId !== undefined || opts.briefPath !== undefined;
	if (metaRequested && (!opts.workstreamId || !opts.briefPath)) {
		throw new ValidationError(
			"Mission spec metadata requires both --workstream-id and --brief-path",
			{
				field: !opts.workstreamId ? "workstreamId" : "briefPath",
			},
		);
	}

	const { resolveProjectRoot } = await import("../config.ts");
	const projectRoot = await resolveProjectRoot(process.cwd());

	const specPath = await writeSpec(projectRoot, taskId, body, opts.agent);
	let metaPath: string | null = null;
	if (opts.workstreamId && opts.briefPath) {
		metaPath = await writeSpecCompanionMeta(projectRoot, taskId, specPath, {
			workstreamId: opts.workstreamId,
			briefPath: opts.briefPath,
			generatedBy: opts.agent,
		});
	}
	if (opts.json) {
		jsonOutput("spec-write", { taskId, path: specPath, metaPath });
	} else {
		printSuccess("Spec written", taskId);
		if (metaPath) {
			process.stdout.write(`  Meta: ${metaPath}\n`);
		}
	}
}
