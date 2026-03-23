/** Workflow import bridge types — parsed artifacts, manifests, and transform results. */

import type { Workstream } from "../missions/workstreams.ts";

// === Const arrays ===

export const WORKFLOW_COMPONENT_ACTIONS = ["CREATE", "MODIFY", "DELETE", "REUSE"] as const;
export const WORKFLOW_TDD_MODES = ["full", "skip"] as const;

// === Parsed Workflow Artifacts (intermediate representation) ===

/** Parsed task from plan/tasks.md */
export interface WorkflowTask {
	id: string;
	title: string;
	description: string;
	dependencies: string[];
	tddMode: "full" | "skip" | null;
}

/** Parsed metadata from task.md */
export interface WorkflowMetadata {
	slug: string;
	status: string;
	created: string;
	lastUpdated: string;
	description: string;
}

/** Parsed risk from plan/risks.md */
export interface WorkflowRisk {
	risk: string;
	likelihood: string;
	impact: string;
	mitigation: string;
}

/** Parsed component from architecture.md */
export interface WorkflowComponent {
	action: (typeof WORKFLOW_COMPONENT_ACTIONS)[number];
	path: string;
	purpose: string;
}

/** Parsed acceptance criterion from plan/acceptance.md */
export interface WorkflowAcceptanceCriterion {
	text: string;
	checked: boolean;
}

/** Complete parsed workflow */
export interface ParsedWorkflow {
	metadata: WorkflowMetadata;
	tasks: WorkflowTask[];
	risks: WorkflowRisk[];
	components: WorkflowComponent[];
	acceptanceCriteria: WorkflowAcceptanceCriterion[];
	planSummary: string | null;
	researchSummary: string | null;
	architectureContext: string | null;
}

// === Import Manifest (round-trip provenance with SHA256 hashes) ===

export interface ImportManifest {
	version: 1;
	sourcePath: string;
	sourceSlug: string;
	importedAt: string;
	artifactHashes: Record<string, string>; // filename -> SHA256
	briefHashes: Record<string, string>; // workstream ID -> SHA256 of generated brief
	taskMapping: Record<string, string>; // workstream ID -> source task ID
}

// === Transform Options ===

export interface TransformOptions {
	includeAllRisks?: boolean;
}

export interface ImportOptions {
	sourcePath: string;
	missionArtifactRoot: string;
	dryRun?: boolean;
	overwrite?: boolean;
	transformOptions?: TransformOptions;
}

export interface ImportResult {
	workstreams: Workstream[];
	briefs: Array<{ workstreamId: string; path: string; content: string }>;
	manifest: ImportManifest;
	warnings: string[];
}

export interface SyncResult {
	drifted: Array<{ workstreamId: string; field: string; old: string; new: string }>;
	added: string[];
	removed: string[];
	unchanged: string[];
}

export interface MergeWorkstreamUpdateOptions {
	existing: Workstream[];
	incoming: Workstream[];
	manifest: ImportManifest;
}

export interface MergeWorkstreamUpdateResult {
	merged: Workstream[];
	updatedBriefs: Array<{ workstreamId: string; path: string; content: string }>;
	skippedBriefs: string[];
	warnings: string[];
}
