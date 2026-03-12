/**
 * Workstreams schema, validation, task bridge, and execution handoff.
 *
 * A workstream is a single unit of mission work that maps 1:1 to a tracker task.
 * Workstreams are defined in {artifactRoot}/plan/workstreams.json and consumed
 * by the Execution Director to dispatch leads via ov sling.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TrackerClient } from "../tracker/types.ts";

// === Status ===

export type WorkstreamStatus = "planned" | "active" | "paused" | "completed";
export const WORKSTREAM_STATUSES: readonly WorkstreamStatus[] = [
	"planned",
	"active",
	"paused",
	"completed",
] as const;

// === Core types ===

export interface Workstream {
	id: string;
	taskId: string;
	objective: string;
	fileScope: string[];
	dependsOn: string[];
	briefPath: string | null;
	status: WorkstreamStatus;
}

export interface WorkstreamsFile {
	version: 1;
	workstreams: Workstream[];
}

// === Validation types ===

export interface ValidationError {
	path: string;
	message: string;
}

export interface ValidationResult {
	valid: boolean;
	errors: ValidationError[];
	workstreams: WorkstreamsFile | null;
}

// === Validation helpers ===

function isObject(val: unknown): val is Record<string, unknown> {
	return typeof val === "object" && val !== null && !Array.isArray(val);
}

function isStringArray(val: unknown): val is string[] {
	return Array.isArray(val) && val.every((v) => typeof v === "string");
}

// === Validation ===

export function validateWorkstreamsFile(raw: unknown): ValidationResult {
	const errors: ValidationError[] = [];

	if (!isObject(raw)) {
		return {
			valid: false,
			errors: [{ path: "", message: "Expected an object" }],
			workstreams: null,
		};
	}

	if (raw["version"] !== 1) {
		errors.push({ path: "version", message: "Expected version 1" });
	}

	if (!Array.isArray(raw["workstreams"])) {
		errors.push({ path: "workstreams", message: "Expected an array" });
		return { valid: false, errors, workstreams: null };
	}

	const rawWorkstreams = raw["workstreams"] as unknown[];
	const parsed: Workstream[] = [];

	for (let i = 0; i < rawWorkstreams.length; i++) {
		const ws = rawWorkstreams[i];
		const base = `workstreams[${i}]`;
		let entryValid = true;

		if (!isObject(ws)) {
			errors.push({ path: base, message: "Expected an object" });
			continue;
		}

		if (typeof ws["id"] !== "string" || ws["id"].trim() === "") {
			errors.push({ path: `${base}.id`, message: "Expected non-empty string" });
			entryValid = false;
		}

		if (typeof ws["taskId"] !== "string" || ws["taskId"].trim() === "") {
			errors.push({ path: `${base}.taskId`, message: "Expected non-empty string" });
			entryValid = false;
		}

		if (typeof ws["objective"] !== "string" || ws["objective"].trim() === "") {
			errors.push({ path: `${base}.objective`, message: "Expected non-empty string" });
			entryValid = false;
		}

		if (!isStringArray(ws["fileScope"])) {
			errors.push({ path: `${base}.fileScope`, message: "Expected string[]" });
			entryValid = false;
		}

		if (!isStringArray(ws["dependsOn"])) {
			errors.push({ path: `${base}.dependsOn`, message: "Expected string[]" });
			entryValid = false;
		}

		if (ws["briefPath"] !== null && typeof ws["briefPath"] !== "string") {
			errors.push({ path: `${base}.briefPath`, message: "Expected string or null" });
			entryValid = false;
		}

		if (!WORKSTREAM_STATUSES.includes(ws["status"] as WorkstreamStatus)) {
			errors.push({
				path: `${base}.status`,
				message: `Expected one of: ${WORKSTREAM_STATUSES.join(", ")}`,
			});
			entryValid = false;
		}

		if (entryValid) {
			parsed.push({
				id: ws["id"] as string,
				taskId: ws["taskId"] as string,
				objective: ws["objective"] as string,
				fileScope: ws["fileScope"] as string[],
				dependsOn: ws["dependsOn"] as string[],
				briefPath: ws["briefPath"] as string | null,
				status: ws["status"] as WorkstreamStatus,
			});
		}
	}

	// Cross-workstream checks (run on all valid parsed entries)
	const seenIds = new Set<string>();
	const seenTaskIds = new Set<string>();
	const allIds = new Set(parsed.map((ws) => ws.id));

	for (const ws of parsed) {
		if (seenIds.has(ws.id)) {
			errors.push({ path: "workstreams", message: `Duplicate workstream id: ${ws.id}` });
		}
		seenIds.add(ws.id);

		if (seenTaskIds.has(ws.taskId)) {
			errors.push({ path: "workstreams", message: `Duplicate taskId: ${ws.taskId}` });
		}
		seenTaskIds.add(ws.taskId);

		for (const depId of ws.dependsOn) {
			if (!allIds.has(depId)) {
				errors.push({
					path: `workstreams[id=${ws.id}].dependsOn`,
					message: `Unknown workstream reference: ${depId}`,
				});
			}
		}
	}

	// Non-overlapping fileScope check
	const fileToWorkstream = new Map<string, string>();
	for (const ws of parsed) {
		for (const file of ws.fileScope) {
			const existing = fileToWorkstream.get(file);
			if (existing !== undefined) {
				errors.push({
					path: "workstreams",
					message: `File scope overlap: '${file}' claimed by both '${existing}' and '${ws.id}'`,
				});
			} else {
				fileToWorkstream.set(file, ws.id);
			}
		}
	}

	if (errors.length > 0) {
		return { valid: false, errors, workstreams: null };
	}

	return { valid: true, errors: [], workstreams: { version: 1, workstreams: parsed } };
}

export async function loadWorkstreamsFile(filePath: string): Promise<ValidationResult> {
	let raw: unknown;
	try {
		const text = await readFile(filePath, "utf-8");
		raw = JSON.parse(text);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			valid: false,
			errors: [{ path: "", message: `Failed to load file: ${message}` }],
			workstreams: null,
		};
	}
	return validateWorkstreamsFile(raw);
}

// === Task Bridge ===

export interface TaskBridgeResult {
	workstreamId: string;
	taskId: string;
	created: boolean;
	error?: string;
}

export async function bridgeWorkstreamsToTasks(
	workstreams: Workstream[],
	tracker: TrackerClient,
): Promise<TaskBridgeResult[]> {
	const results: TaskBridgeResult[] = [];

	for (const ws of workstreams) {
		try {
			await tracker.show(ws.taskId);
			results.push({ workstreamId: ws.id, taskId: ws.taskId, created: false });
		} catch (showErr) {
			// Distinguish 'not found' from API/network errors
			const showMsg = showErr instanceof Error ? showErr.message : String(showErr);
			const isNotFound = /not found|does not exist|no such/i.test(showMsg);
			if (!isNotFound) {
				// Real API error — don't attempt create, report directly
				results.push({
					workstreamId: ws.id,
					taskId: ws.taskId,
					created: false,
					error: `Failed to check task: ${showMsg}`,
				});
				continue;
			}
			try {
				await tracker.create(ws.objective, {
					type: "task",
					priority: 2,
					description: `Workstream: ${ws.id}`,
				});
				results.push({ workstreamId: ws.id, taskId: ws.taskId, created: true });
			} catch (createErr) {
				const message = createErr instanceof Error ? createErr.message : String(createErr);
				results.push({
					workstreamId: ws.id,
					taskId: ws.taskId,
					created: false,
					error: message,
				});
			}
		}
	}

	return results;
}

export async function validateTaskIds(
	workstreams: Workstream[],
	tracker: TrackerClient,
): Promise<string[]> {
	const missing: string[] = [];

	for (const ws of workstreams) {
		try {
			await tracker.show(ws.taskId);
		} catch {
			missing.push(ws.id);
		}
	}

	return missing;
}

// === Execution Handoff ===

export interface ExecutionHandoff {
	workstreamId: string;
	taskId: string;
	objective: string;
	fileScope: string[];
	briefPath: string | null;
	dependsOn: string[];
	status: WorkstreamStatus;
}

export function packageHandoffs(workstreams: Workstream[]): ExecutionHandoff[] {
	const completedIds = new Set(
		workstreams.filter((ws) => ws.status === "completed").map((ws) => ws.id),
	);

	return workstreams
		.filter((ws) => {
			if (ws.status !== "planned" && ws.status !== "active") return false;
			return ws.dependsOn.every((depId) => completedIds.has(depId));
		})
		.map((ws) => ({
			workstreamId: ws.id,
			taskId: ws.taskId,
			objective: ws.objective,
			fileScope: ws.fileScope,
			briefPath: ws.briefPath,
			dependsOn: ws.dependsOn,
			status: ws.status,
		}));
}

export function slingArgsFromHandoff(
	handoff: ExecutionHandoff,
	opts: { parentAgent: string; depth: number; specBasePath?: string },
): string[] {
	const args = [
		"ov",
		"sling",
		handoff.taskId,
		"--capability",
		"lead",
		"--parent",
		opts.parentAgent,
		"--depth",
		String(opts.depth),
		"--skip-task-check",
	];

	if (handoff.fileScope.length > 0) {
		args.push("--files", handoff.fileScope.join(","));
	}

	if (handoff.briefPath !== null && opts.specBasePath !== undefined) {
		args.push("--spec", join(opts.specBasePath, handoff.briefPath));
	}

	return args;
}
