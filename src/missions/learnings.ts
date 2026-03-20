/**
 * Deterministic mission learnings extraction.
 *
 * Parses completed mission bundle files and artifact data to produce
 * structured mulch expertise records. No AI calls — purely structural parsing.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// === Types ===

interface BundleSummary {
	id: string;
	slug: string;
	objective: string;
	state: string;
	phase: string;
	createdAt: string;
	updatedAt: string;
	reopenCount: number;
	runId: string | null;
}

interface BundleReviewDimension {
	dimension: string;
	score: number;
	details: string;
}

interface BundleReview {
	dimensions: BundleReviewDimension[];
	overallScore: number;
}

interface BundleSession {
	agentName: string;
	capability: string;
	state: string;
	startedAt: string;
	lastActivity: string;
}

interface BundleMetric {
	agentName: string;
	estimatedCostUsd: number | null;
	inputTokens: number;
	outputTokens: number;
}

interface Workstream {
	id: string;
	taskId: string;
	objective: string;
	fileScope: string[];
	dependsOn: string[];
	status: string;
}

interface WorkstreamsFile {
	version: number;
	workstreams: Workstream[];
}

interface MulchRecordInput {
	type: string;
	name?: string;
	description: string;
	title?: string;
	rationale?: string;
	tags: string[];
	classification: string;
	outcomeStatus?: "success" | "failure";
}

export interface LearningsExtractionResult {
	recordsAttempted: number;
	recordsSucceeded: number;
	errors: string[];
}

// === Safe file readers ===

export function readJsonSafe<T>(path: string): T | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return null;
	}
}

export function readTextSafe(path: string): string | null {
	if (!existsSync(path)) return null;
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

// === Record builders ===

export function buildMissionSummaryRecord(
	summary: BundleSummary,
	sessions: BundleSession[],
	metrics: BundleMetric[],
	slug: string,
): MulchRecordInput {
	const capabilities = [...new Set(sessions.map((s) => s.capability))].join(", ");
	const totalCost = metrics.reduce((sum, m) => sum + (m.estimatedCostUsd ?? 0), 0);
	const costStr = totalCost > 0 ? ` Cost: $${totalCost.toFixed(2)}.` : "";

	return {
		type: "reference",
		name: `Mission: ${slug}`,
		description:
			`Objective: ${summary.objective}. ` +
			`Agents: ${sessions.length} (${capabilities || "none"}).` +
			`${costStr} State: ${summary.state}. Phase: ${summary.phase}.`,
		tags: ["mission", slug, summary.state],
		classification: "foundational",
		outcomeStatus: summary.state === "completed" ? "success" : "failure",
	};
}

export function parseDecisions(content: string): Array<{ id: string; text: string }> {
	const results: Array<{ id: string; text: string }> = [];
	const regex = /^D(\d+):\s*(.+)$/gm;
	let match = regex.exec(content);
	while (match) {
		const id = match[1];
		const text = match[2];
		if (id && text) {
			results.push({ id: `D${id}`, text: text.trim() });
		}
		match = regex.exec(content);
	}
	return results;
}

export function buildLowScoringDimensionRecords(
	review: BundleReview,
	slug: string,
): MulchRecordInput[] {
	return review.dimensions
		.filter((d) => d.score < 80)
		.map((d) => ({
			type: "failure",
			description: `Mission ${slug} scored ${d.score}/100 on ${d.dimension}: ${d.details}`,
			tags: ["mission", slug, "review", d.dimension],
			classification: "tactical",
		}));
}

export function buildWorkstreamPatternRecord(
	workstreams: Workstream[],
	sessions: BundleSession[],
	slug: string,
): MulchRecordInput | null {
	if (workstreams.length === 0) return null;

	const capabilities = [...new Set(sessions.map((s) => s.capability))];
	const wsIds = workstreams.map((ws) => ws.id).join(", ");
	const deps = workstreams
		.filter((ws) => ws.dependsOn.length > 0)
		.map((ws) => `${ws.id} → ${ws.dependsOn.join(", ")}`)
		.join("; ");

	return {
		type: "pattern",
		name: `Workstream decomposition: ${slug}`,
		description:
			`${workstreams.length} workstreams: ${wsIds}. ` +
			`Capabilities: ${capabilities.join(", ") || "none"}. ` +
			`Dependencies: ${deps || "none"}.`,
		tags: ["mission", slug, "decomposition"],
		classification: "tactical",
	};
}

// === Main extraction ===

export async function extractMissionLearnings(opts: {
	bundlePath: string;
	artifactRoot: string;
	projectRoot: string;
	missionSlug: string;
}): Promise<LearningsExtractionResult> {
	const { bundlePath, artifactRoot, projectRoot, missionSlug } = opts;
	const { createMulchClient } = await import("../mulch/client.ts");
	const mulch = createMulchClient(projectRoot);

	const records: MulchRecordInput[] = [];
	const errors: string[] = [];

	// 1. Mission summary
	const summary = readJsonSafe<BundleSummary>(join(bundlePath, "summary.json"));
	const sessions = readJsonSafe<BundleSession[]>(join(bundlePath, "sessions.json")) ?? [];
	const metrics = readJsonSafe<BundleMetric[]>(join(bundlePath, "metrics.json")) ?? [];
	if (summary) {
		records.push(buildMissionSummaryRecord(summary, sessions, metrics, missionSlug));
	}

	// 2. Decisions
	const decisionsMd = readTextSafe(join(artifactRoot, "decisions.md"));
	if (decisionsMd) {
		const decisions = parseDecisions(decisionsMd);
		for (const d of decisions) {
			records.push({
				type: "decision",
				title: `${d.id}: ${d.text.slice(0, 80)}`,
				description: d.text,
				rationale: `Decision from mission ${missionSlug}`,
				tags: ["mission", missionSlug, "decision"],
				classification: "foundational",
			});
		}
	}

	// 3. Low-scoring review dimensions
	const review = readJsonSafe<BundleReview>(join(bundlePath, "review.json"));
	if (review?.dimensions) {
		records.push(...buildLowScoringDimensionRecords(review, missionSlug));
	}

	// 4. Workstream pattern
	const wsFile = readJsonSafe<WorkstreamsFile>(join(artifactRoot, "plan", "workstreams.json"));
	if (wsFile?.workstreams) {
		const wsRecord = buildWorkstreamPatternRecord(wsFile.workstreams, sessions, missionSlug);
		if (wsRecord) {
			records.push(wsRecord);
		}
	}

	// Record all into mulch
	let succeeded = 0;
	for (const record of records) {
		try {
			await mulch.record("missions", {
				type: record.type,
				name: record.name,
				description: record.description,
				title: record.title,
				rationale: record.rationale,
				tags: record.tags,
				classification: record.classification,
				outcomeStatus: record.outcomeStatus,
			});
			succeeded++;
		} catch (err) {
			errors.push(`Failed to record ${record.type}: ${err}`);
		}
	}

	return {
		recordsAttempted: records.length,
		recordsSucceeded: succeeded,
		errors,
	};
}
