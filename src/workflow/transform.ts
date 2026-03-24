/**
 * Workflow transform layer — converts ParsedWorkflow into Overstory workstreams,
 * generates execution briefs, and orchestrates the full import pipeline.
 */

import { join } from "node:path";
import type { Workstream, WorkstreamsFile } from "../missions/workstreams.ts";
import { validateWorkstreamsFile } from "../missions/workstreams.ts";
import { createManifest, readManifest, writeManifest } from "./manifest.ts";
import { parseWorkflow } from "./parse.ts";
import type {
	ImportOptions,
	ImportResult,
	MergeWorkstreamUpdateOptions,
	MergeWorkstreamUpdateResult,
	ParsedWorkflow,
	TransformOptions,
	WorkflowTask,
} from "./types.ts";

// ── transformToWorkstreams ─────────────────────────────────────────────────────────────────────

/**
 * Convert a ParsedWorkflow into a WorkstreamsFile.
 * Assigns fileScope to workstreams based on component-task matching.
 * Emits warnings for unassigned and reassigned files.
 */
export function transformToWorkstreams(
	parsed: ParsedWorkflow,
	_opts: TransformOptions = {},
): { workstreamsFile: WorkstreamsFile; warnings: string[] } {
	const warnings: string[] = [];

	// Track file assignment: componentPath -> task index
	const fileAssignment = new Map<string, number>();
	const taskFileSets: string[][] = parsed.tasks.map(() => []);

	// Match components to tasks
	for (const component of parsed.components) {
		let assignedTaskIdx: number | null = null;

		for (let i = 0; i < parsed.tasks.length; i++) {
			const task = parsed.tasks[i];
			if (task === undefined) continue;

			const purposeLower = component.purpose.toLowerCase();
			const pathLower = component.path.toLowerCase();
			const taskIdLower = task.id.toLowerCase();
			const taskTitleLower = task.title.toLowerCase();
			const taskDescLower = task.description.toLowerCase();

			const matches =
				purposeLower.includes(taskIdLower) ||
				purposeLower.includes(taskTitleLower) ||
				taskDescLower.includes(pathLower);

			if (matches) {
				assignedTaskIdx = i;
				break;
			}
		}

		if (assignedTaskIdx === null) {
			// Stays unassigned — warning emitted below
			continue;
		}

		if (fileAssignment.has(component.path)) {
			const prevIdx = fileAssignment.get(component.path) ?? -1;
			const prevTask = parsed.tasks[prevIdx];
			warnings.push(
				`Warning: file "${component.path}" matched multiple tasks (keeping assignment to ` +
					`"${prevTask?.id ?? prevIdx}"); dropping reassignment.`,
			);
		} else {
			fileAssignment.set(component.path, assignedTaskIdx);
			const files = taskFileSets[assignedTaskIdx];
			if (files !== undefined) {
				files.push(component.path);
			}
		}
	}

	// Warn for unassigned components
	const unassigned = parsed.components
		.filter((c) => !fileAssignment.has(c.path))
		.map((c) => c.path);
	if (unassigned.length > 0) {
		warnings.push(
			`Warning: ${unassigned.length} file(s) from architecture.md could not be assigned to ` +
				`workstreams: [${unassigned.join(", ")}]. Use --dry-run to review, then manually ` +
				`assign via workstreams.json.`,
		);
	}

	// Build workstream array
	const workstreams: Workstream[] = parsed.tasks.map((task, i) => {
		const firstSentence = firstSentenceOf(task.description);
		const objective = firstSentence ? `${task.title} — ${firstSentence}` : task.title;

		const depIds = task.dependencies.map((depId) => depId);
		const files = taskFileSets[i] ?? [];

		return {
			id: task.id,
			taskId: task.id,
			objective,
			fileScope: files,
			dependsOn: depIds,
			briefPath: `workstreams/${task.id}/brief.md`,
			status: "planned",
		};
	});

	const workstreamsFile: WorkstreamsFile = { version: 1, workstreams };
	return { workstreamsFile, warnings };
}

function firstSentenceOf(text: string): string {
	const match = text.match(/^[^.!?]*[.!?]/);
	return match ? match[0].trim() : (text.split("\n")[0]?.trim() ?? "");
}

// ── generateBrief ──────────────────────────────────────────────────────────────────────────────

/**
 * Generate a markdown execution brief for a workstream.
 */
export function generateBrief(
	task: WorkflowTask,
	parsed: ParsedWorkflow,
	fileScope: string[],
	opts: TransformOptions = {},
): string {
	const sections: string[] = [];

	sections.push(`# Workstream: ${task.id}`);
	sections.push("");
	sections.push("## Objective");
	const firstSentence = firstSentenceOf(task.description);
	sections.push(firstSentence ? `${task.title} — ${firstSentence}` : task.title);
	sections.push("");

	// Context from plan summary
	sections.push("## Context");
	sections.push(parsed.planSummary ?? "_No plan summary available._");
	sections.push("");

	// What to build from task description
	sections.push("## What to Build");
	sections.push(task.description || "_No description provided._");
	sections.push("");

	// File scope
	sections.push("## File Scope");
	if (fileScope.length > 0) {
		sections.push(fileScope.map((f) => `- ${f}`).join("\n"));
	} else {
		sections.push("_No files assigned._");
	}
	sections.push("");

	// Risks — include all by default
	sections.push("## Risks");
	const includeAllRisks = opts.includeAllRisks !== false;
	const risks = includeAllRisks
		? parsed.risks
		: parsed.risks.filter((r) => {
				const text = `${r.risk} ${r.mitigation}`.toLowerCase();
				return (
					fileScope.some((f) => text.includes(f.toLowerCase())) ||
					text.includes(task.id.toLowerCase())
				);
			});

	if (risks.length > 0) {
		sections.push(
			risks
				.map(
					(r) =>
						`- **${r.risk}** (likelihood: ${r.likelihood}, impact: ${r.impact})\n  Mitigation: ${r.mitigation}`,
				)
				.join("\n"),
		);
	} else {
		sections.push("_No relevant risks identified._");
	}
	sections.push("");

	// Acceptance criteria — include all
	sections.push("## Acceptance Criteria");
	if (parsed.acceptanceCriteria.length > 0) {
		sections.push(
			parsed.acceptanceCriteria.map((ac) => `- [${ac.checked ? "x" : " "}] ${ac.text}`).join("\n"),
		);
	} else {
		sections.push("_No acceptance criteria defined._");
	}
	sections.push("");

	// Architecture context
	sections.push("## Architecture Context");
	sections.push(parsed.architectureContext ?? "_No architecture context available._");

	return sections.join("\n");
}

// ── importWorkflow ─────────────────────────────────────────────────────────────────────────────

/**
 * Full import pipeline: parse source → transform → validate → write workstreams + briefs + manifest.
 */
export async function importWorkflow(opts: ImportOptions): Promise<ImportResult> {
	const parsed = await parseWorkflow(opts.sourcePath);
	const { workstreamsFile, warnings } = transformToWorkstreams(parsed, opts.transformOptions ?? {});

	const validation = validateWorkstreamsFile(workstreamsFile);
	if (!validation.valid) {
		throw new Error(
			`Invalid workstreams file: ${validation.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
		);
	}

	const { workstreams } = workstreamsFile;

	// Generate briefs
	const briefs: ImportResult["briefs"] = [];
	const briefContents: Record<string, string> = {};
	for (let i = 0; i < workstreams.length; i++) {
		const ws = workstreams[i];
		const task = parsed.tasks[i];
		if (ws === undefined || task === undefined) continue;

		const content = generateBrief(task, parsed, ws.fileScope, opts.transformOptions ?? {});
		const briefPath = join(
			opts.missionArtifactRoot,
			ws.briefPath ?? `workstreams/${ws.id}/brief.md`,
		);
		briefs.push({ workstreamId: ws.id, path: briefPath, content });
		briefContents[ws.id] = content;
	}

	// Create manifest
	const workstreamIds = workstreams.map((ws) => ws.id);
	const manifest = await createManifest(opts.sourcePath, parsed, workstreamIds, briefContents);

	if (!opts.dryRun) {
		// Write workstreams.json
		const workstreamsPath = join(opts.missionArtifactRoot, "plan", "workstreams.json");
		await Bun.write(workstreamsPath, `${JSON.stringify(workstreamsFile, null, 2)}\n`);

		// Write briefs
		for (const brief of briefs) {
			await Bun.write(brief.path, brief.content);
		}

		// Write manifest
		const manifestPath = join(opts.missionArtifactRoot, "plan", "import-manifest.json");
		await writeManifest(manifestPath, manifest);
	}

	return { workstreams, briefs, manifest, warnings };
}

// ── mergeWorkstreamUpdate ──────────────────────────────────────────────────────────────────────

/**
 * Merge source changes into existing workstreams while preserving execution state.
 * Used by `sync --update`.
 */
export async function mergeWorkstreamUpdate(
	opts: MergeWorkstreamUpdateOptions,
	parsed: ParsedWorkflow,
	force: boolean,
	missionArtifactRoot: string,
	transformOptions: TransformOptions = {},
): Promise<MergeWorkstreamUpdateResult> {
	const warnings: string[] = [];
	const updatedBriefs: MergeWorkstreamUpdateResult["updatedBriefs"] = [];
	const skippedBriefs: string[] = [];

	// Build lookup: workstream ID -> existing workstream
	const existingById = new Map(opts.existing.map((ws) => [ws.id, ws]));
	// Reverse mapping: source task ID -> workstream ID
	const taskIdToWsId = new Map(
		Object.entries(opts.manifest.taskMapping).map(([wsId, taskId]) => [taskId, wsId]),
	);

	const merged: Workstream[] = [];

	// Process incoming workstreams
	for (const incoming of opts.incoming) {
		const existing =
			existingById.get(incoming.id) ?? existingById.get(taskIdToWsId.get(incoming.taskId) ?? "");

		if (existing !== undefined) {
			// Preserve execution state, update content fields
			merged.push({
				...incoming,
				status: existing.status,
				taskId: existing.taskId,
				briefPath: existing.briefPath ?? incoming.briefPath,
			});
		} else {
			// New workstream
			merged.push({ ...incoming, status: "planned" });
		}
	}

	// Warn about removed workstreams (existing not in incoming)
	const incomingIds = new Set(opts.incoming.map((ws) => ws.id));
	for (const existing of opts.existing) {
		if (!incomingIds.has(existing.id)) {
			warnings.push(
				`Warning: workstream "${existing.id}" was removed from source tasks but kept in workstreams (status: ${existing.status}).`,
			);
			merged.push(existing);
		}
	}

	// Regenerate briefs for all incoming workstreams
	const manifestPath = join(missionArtifactRoot, "plan", "import-manifest.json");
	const storedManifest = await readManifest(manifestPath);

	for (let i = 0; i < opts.incoming.length; i++) {
		const ws = opts.incoming[i];
		if (ws === undefined) continue;
		const taskId = opts.manifest.taskMapping[ws.id] ?? ws.id;
		const task = parsed.tasks.find((t) => t.id === taskId);
		if (task === undefined) continue;

		const content = generateBrief(task, parsed, ws.fileScope, transformOptions);
		const briefPath = join(missionArtifactRoot, ws.briefPath ?? `workstreams/${ws.id}/brief.md`);

		// Check if brief exists on disk
		let briefExistsOnDisk = false;
		try {
			await Bun.file(briefPath).text();
			briefExistsOnDisk = true;
		} catch {
			briefExistsOnDisk = false;
		}

		if (briefExistsOnDisk && !force && storedManifest !== null) {
			// Check hash against stored manifest
			const storedHash = storedManifest.briefHashes[ws.id];
			if (storedHash !== undefined) {
				// Compare current on-disk content hash with stored hash
				const diskContent = await Bun.file(briefPath).text();
				const hasher = new Bun.CryptoHasher("sha256");
				hasher.update(diskContent);
				const diskHash = hasher.digest("hex");

				if (diskHash !== storedHash) {
					// Manually edited — skip
					skippedBriefs.push(ws.id);
					continue;
				}
			}
		}

		updatedBriefs.push({ workstreamId: ws.id, path: briefPath, content });
	}

	return { merged, updatedBriefs, skippedBriefs, warnings };
}
