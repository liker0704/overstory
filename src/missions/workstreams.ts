/**
 * Workstreams schema, validation, task bridge, and execution handoff.
 *
 * A workstream is a single unit of mission work that maps 1:1 to a tracker task.
 * Workstreams are defined in {artifactRoot}/plan/workstreams.json and consumed
 * by the Execution Director to dispatch leads via ov sling.
 */

import type { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TrackerClient } from "../tracker/types.ts";
import { TDD_MODES, type TddMode } from "./types.ts";

// === Status ===

export type WorkstreamStatus = "planned" | "active" | "paused" | "completed" | "merged" | "failed";
export const WORKSTREAM_STATUSES: readonly WorkstreamStatus[] = [
	"planned",
	"active",
	"paused",
	"completed",
	"merged",
	"failed",
] as const;

/** Workstream is considered done (terminal success) if status is completed or merged. */
export function isWorkstreamDone(status: WorkstreamStatus | undefined): boolean {
	return status === "completed" || status === "merged";
}

// === Core types ===

export interface Workstream {
	id: string;
	taskId: string;
	objective: string;
	fileScope: string[];
	dependsOn: string[];
	briefPath: string | null;
	status: WorkstreamStatus;
	tddMode?: TddMode;
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

	if (raw.version !== 1) {
		errors.push({ path: "version", message: "Expected version 1" });
	}

	if (!Array.isArray(raw.workstreams)) {
		errors.push({ path: "workstreams", message: "Expected an array" });
		return { valid: false, errors, workstreams: null };
	}

	const rawWorkstreams = raw.workstreams as unknown[];
	const parsed: Workstream[] = [];

	for (let i = 0; i < rawWorkstreams.length; i++) {
		const ws = rawWorkstreams[i];
		const base = `workstreams[${i}]`;
		let entryValid = true;

		if (!isObject(ws)) {
			errors.push({ path: base, message: "Expected an object" });
			continue;
		}

		if (typeof ws.id !== "string" || ws.id.trim() === "") {
			errors.push({ path: `${base}.id`, message: "Expected non-empty string" });
			entryValid = false;
		}

		if (typeof ws.taskId !== "string" || ws.taskId.trim() === "") {
			errors.push({ path: `${base}.taskId`, message: "Expected non-empty string" });
			entryValid = false;
		}

		if (typeof ws.objective !== "string" || ws.objective.trim() === "") {
			errors.push({ path: `${base}.objective`, message: "Expected non-empty string" });
			entryValid = false;
		}

		if (!isStringArray(ws.fileScope)) {
			errors.push({ path: `${base}.fileScope`, message: "Expected string[]" });
			entryValid = false;
		}

		if (!isStringArray(ws.dependsOn)) {
			errors.push({ path: `${base}.dependsOn`, message: "Expected string[]" });
			entryValid = false;
		}

		if (ws.briefPath !== null && typeof ws.briefPath !== "string") {
			errors.push({ path: `${base}.briefPath`, message: "Expected string or null" });
			entryValid = false;
		}

		if (!WORKSTREAM_STATUSES.includes(ws.status as WorkstreamStatus)) {
			errors.push({
				path: `${base}.status`,
				message: `Expected one of: ${WORKSTREAM_STATUSES.join(", ")}`,
			});
			entryValid = false;
		}

		if (ws.tddMode !== undefined && !TDD_MODES.includes(ws.tddMode as TddMode)) {
			errors.push({
				path: `${base}.tddMode`,
				message: `Expected one of: ${TDD_MODES.join(", ")}`,
			});
			entryValid = false;
		}

		if (entryValid) {
			parsed.push({
				id: ws.id as string,
				taskId: ws.taskId as string,
				objective: ws.objective as string,
				fileScope: ws.fileScope as string[],
				dependsOn: ws.dependsOn as string[],
				briefPath: ws.briefPath as string | null,
				status: ws.status as WorkstreamStatus,
				tddMode: (ws.tddMode as TddMode | undefined) ?? "skip",
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

	// Circular dependency detection
	const visited = new Set<string>();
	const inStack = new Set<string>();
	const allWorkstreams = new Map(parsed.map((ws) => [ws.id, ws]));

	function detectCycle(wsId: string, path: string[]): string[] | null {
		if (inStack.has(wsId)) {
			const cycleStart = path.indexOf(wsId);
			return path.slice(cycleStart).concat(wsId);
		}
		if (visited.has(wsId)) return null;
		visited.add(wsId);
		inStack.add(wsId);
		path.push(wsId);
		const ws = allWorkstreams.get(wsId);
		if (ws) {
			for (const depId of ws.dependsOn) {
				const cycle = detectCycle(depId, [...path]);
				if (cycle) return cycle;
			}
		}
		inStack.delete(wsId);
		return null;
	}

	for (const ws of parsed) {
		if (!visited.has(ws.id)) {
			const cycle = detectCycle(ws.id, []);
			if (cycle) {
				errors.push({
					path: "workstreams.dependsOn",
					message: `Circular dependency detected: ${cycle.join(" → ")}`,
				});
				break; // One cycle error is enough
			}
		}
	}

	// Non-overlapping fileScope check (exact string match only).
	// Glob patterns (e.g. "src/auth/**") are compared literally — overlap with
	// exact paths (e.g. "src/auth/login.ts") is NOT detected. Workstream authors
	// must ensure non-overlapping scopes when using globs.
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
	canonicalTaskId: string;
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
			results.push({
				workstreamId: ws.id,
				taskId: ws.taskId,
				canonicalTaskId: ws.taskId,
				created: false,
			});
		} catch (showErr) {
			// Distinguish 'not found' from API/network errors
			const showMsg = showErr instanceof Error ? showErr.message : String(showErr);
			const isNotFound = /not found|does not exist|no such/i.test(showMsg);
			if (!isNotFound) {
				// Real API error — don't attempt create, report directly
				results.push({
					workstreamId: ws.id,
					taskId: ws.taskId,
					canonicalTaskId: ws.taskId,
					created: false,
					error: `Failed to check task: ${showMsg}`,
				});
				continue;
			}
			try {
				const canonicalTaskId = await tracker.create(ws.objective, {
					type: "task",
					priority: 2,
					description: `Workstream: ${ws.id}`,
				});
				if (canonicalTaskId.trim().length === 0) {
					throw new Error("tracker returned empty task ID");
				}
				results.push({
					workstreamId: ws.id,
					taskId: ws.taskId,
					canonicalTaskId,
					created: true,
				});
			} catch (createErr) {
				const message = createErr instanceof Error ? createErr.message : String(createErr);
				results.push({
					workstreamId: ws.id,
					taskId: ws.taskId,
					canonicalTaskId: ws.taskId,
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

export function applyCanonicalTaskIds(
	workstreams: Workstream[],
	results: TaskBridgeResult[],
): Workstream[] {
	const canonicalByWorkstreamId = new Map(
		results.map((result) => [result.workstreamId, result.canonicalTaskId] as const),
	);
	return workstreams.map((workstream) => ({
		...workstream,
		taskId: canonicalByWorkstreamId.get(workstream.id) ?? workstream.taskId,
	}));
}

export async function persistWorkstreamsFile(
	filePath: string,
	workstreams: Workstream[],
): Promise<void> {
	await Bun.write(
		filePath,
		`${JSON.stringify({ version: 1, workstreams } satisfies WorkstreamsFile, null, 2)}\n`,
	);
}

// === Workstream Status (SQLite-backed) ===

/**
 * Update a workstream's status in the workstream_status table.
 * Uses INSERT OR REPLACE for idempotent upsert.
 */
export function updateWorkstreamStatus(
	db: Database,
	missionId: string,
	workstreamId: string,
	status: WorkstreamStatus,
	updatedBy: "engine" | "agent" | "operator",
): void {
	db.prepare(
		`INSERT INTO workstream_status (mission_id, workstream_id, status, updated_at, updated_by)
		 VALUES ($missionId, $wsId, $status, $now, $by)
		 ON CONFLICT(mission_id, workstream_id) DO UPDATE SET
		   status = $status, updated_at = $now, updated_by = $by`,
	).run({
		$missionId: missionId,
		$wsId: workstreamId,
		$status: status,
		$now: new Date().toISOString(),
		$by: updatedBy,
	});
}

/**
 * Single predicate for "all workstreams complete" used by both the gate evaluator
 * and the check-remaining handler. Prevents the two decision sites from drifting.
 *
 * Returns true when every planned workstream id has a status-table entry of
 * `merged` or `completed`. Returns false if any planned id is missing or has
 * a non-terminal status.
 */
export function areAllWorkstreamsDone(
	db: Database,
	missionId: string,
	plannedIds: readonly string[],
): boolean {
	if (plannedIds.length === 0) return false;
	const statuses = getWorkstreamStatuses(db, missionId);
	return plannedIds.every((id) => isWorkstreamDone(statuses.get(id)));
}

/**
 * Get all workstream statuses for a mission from the workstream_status table.
 * Returns a Map of workstreamId → status.
 */
export function getWorkstreamStatuses(
	db: Database,
	missionId: string,
): Map<string, WorkstreamStatus> {
	const rows = db
		.prepare<{ workstream_id: string; status: string }, { $missionId: string }>(
			"SELECT workstream_id, status FROM workstream_status WHERE mission_id = $missionId",
		)
		.all({ $missionId: missionId });
	const map = new Map<string, WorkstreamStatus>();
	for (const row of rows) {
		map.set(row.workstream_id, row.status as WorkstreamStatus);
	}
	return map;
}

/**
 * Load workstreams from JSON file and overlay statuses from the SQLite table.
 * DB statuses take precedence over JSON statuses (backward compat: if no DB rows,
 * falls back to JSON status field).
 */
export async function loadWorkstreamsWithStatuses(
	filePath: string,
	db: Database,
	missionId: string,
): Promise<Workstream[]> {
	const validation = await loadWorkstreamsFile(filePath);
	if (!validation.valid || !validation.workstreams) {
		return [];
	}
	const statuses = getWorkstreamStatuses(db, missionId);
	return validation.workstreams.workstreams.map((ws) => ({
		...ws,
		status: statuses.get(ws.id) ?? ws.status,
	}));
}

// === Cross-Mission Scope Detection ===

export interface ScopeConflict {
	file: string;
	proposedWorkstream: string;
	conflictMission: string;
	conflictWorkstream: string;
}

/**
 * Detect file scope conflicts between proposed workstreams and active missions.
 *
 * Uses exact string match only — glob patterns (e.g. "src/auth/**") are compared
 * literally and will NOT be detected as overlapping with exact paths like
 * "src/auth/login.ts". Workstream authors must ensure non-overlapping scopes
 * when using globs.
 *
 * Pure function — no store access.
 */
export function detectCrossMissionScopeConflicts(
	proposedWorkstreams: Workstream[],
	activeMissions: Array<{ id: string; slug: string; workstreams: Workstream[] }>,
): ScopeConflict[] {
	// Build map of file → { missionId, missionSlug, workstreamId } from all active missions
	const activeFileMap = new Map<
		string,
		{ missionId: string; missionSlug: string; workstreamId: string }
	>();
	for (const mission of activeMissions) {
		for (const ws of mission.workstreams) {
			for (const file of ws.fileScope) {
				activeFileMap.set(file, {
					missionId: mission.id,
					missionSlug: mission.slug,
					workstreamId: ws.id,
				});
			}
		}
	}

	const conflicts: ScopeConflict[] = [];
	for (const ws of proposedWorkstreams) {
		for (const file of ws.fileScope) {
			const existing = activeFileMap.get(file);
			if (existing !== undefined) {
				conflicts.push({
					file,
					proposedWorkstream: ws.id,
					conflictMission: existing.missionSlug,
					conflictWorkstream: existing.workstreamId,
				});
			}
		}
	}

	return conflicts;
}

export async function ensureCanonicalWorkstreamTasks(
	filePath: string,
	tracker: TrackerClient,
): Promise<{ workstreams: Workstream[]; results: TaskBridgeResult[] }> {
	const validation = await loadWorkstreamsFile(filePath);
	if (!validation.valid || !validation.workstreams) {
		const message = validation.errors[0]?.message ?? "workstreams.json is missing or invalid";
		throw new Error(message);
	}

	const results = await bridgeWorkstreamsToTasks(validation.workstreams.workstreams, tracker);
	const failed = results.find((result) => result.error);
	if (failed) {
		throw new Error(
			`Task bridge failed for ${failed.workstreamId} (${failed.taskId}): ${failed.error}`,
		);
	}

	const canonicalized = applyCanonicalTaskIds(validation.workstreams.workstreams, results);
	const changed = canonicalized.some(
		(workstream, index) => workstream.taskId !== validation.workstreams?.workstreams[index]?.taskId,
	);
	if (changed) {
		await persistWorkstreamsFile(filePath, canonicalized);
	}

	return { workstreams: canonicalized, results };
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
	tddMode?: TddMode;
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
			tddMode: ws.tddMode,
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
	];

	if (handoff.fileScope.length > 0) {
		args.push("--files", handoff.fileScope.join(","));
	}

	if (handoff.briefPath !== null && opts.specBasePath !== undefined) {
		args.push("--spec", join(opts.specBasePath, handoff.briefPath));
	}

	if (handoff.tddMode !== undefined && handoff.tddMode !== "skip") {
		args.push("--tdd-mode", handoff.tddMode);
	}

	return args;
}
