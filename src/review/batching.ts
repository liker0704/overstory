/**
 * Scoped review context batching.
 *
 * Assembles curated evidence packets for plan and architecture reviews.
 * Packets are batched by concern, with narrow context windows and explicit
 * references to supporting evidence.
 *
 * Library only — does not modify any store or artifact.
 * All stores are opened read-only (no writes) and closed when done.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import { createReviewStore } from "./store.ts";

// === Types ===

/** The concern categories supported by the batching API. */
export type ConcernType = "staleness" | "coordination" | "completeness" | "error-patterns";

/** A single piece of evidence within a ReviewBatch. */
export interface EvidenceEntry {
	/** Path to the source artifact (file path, DB ID, or event reference). */
	path: string;
	/** Truncated excerpt from the artifact (max 500 chars). */
	excerpt: string;
	/** One-line explanation of why this evidence is relevant to the concern. */
	relevance: string;
}

/**
 * A batch of related evidence grouped by concern.
 * Self-contained — the reviewer does not need to look up external files.
 */
export interface ReviewBatch {
	/** Concern category label. */
	concern: ConcernType;
	/** Evidence items for this concern. */
	evidence: EvidenceEntry[];
	/** Brief narrative explaining why these items are grouped. */
	context: string;
	/** Source artifact references (file paths, review IDs, event timestamps). */
	references: string[];
}

// === Helpers ===

/** Truncate a string to at most maxLen characters. */
function truncate(text: string, maxLen = 500): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, maxLen - 3)}...`;
}

// === Concern assemblers ===

/**
 * Collect evidence for the "staleness" concern.
 * Gathers stale review records and their dependency chains.
 */
function assembleStaleness(overstoryDir: string): ReviewBatch {
	const evidence: EvidenceEntry[] = [];
	const references: string[] = [];

	try {
		const reviewStore = createReviewStore(join(overstoryDir, "reviews.db"));
		try {
			const staleRecords = reviewStore.getStale();
			for (const record of staleRecords) {
				const excerpt = truncate(
					`subject: ${record.subjectId} | score: ${record.overallScore} | stale since: ${record.staleSince ?? "unknown"} | reason: ${record.staleReason ?? "none"}`,
				);
				evidence.push({
					path: `reviews.db#${record.id}`,
					excerpt,
					relevance: `${record.subjectType} review is stale: ${record.staleReason ?? "subject changed"}`,
				});
				references.push(`reviews.db#${record.id}`);
			}
		} finally {
			reviewStore.close();
		}
	} catch {
		// Missing or empty store — return empty results
	}

	return {
		concern: "staleness",
		evidence,
		context:
			"Stale artifacts are reviews whose subjects have changed since review was completed. " +
			"These need re-review before relying on their scores.",
		references,
	};
}

/**
 * Collect evidence for the "coordination" concern.
 * Examines session handoff quality, escalation frequency, and error patterns in mail.
 */
function assembleCoordination(overstoryDir: string): ReviewBatch {
	const evidence: EvidenceEntry[] = [];
	const references: string[] = [];

	try {
		const reviewStore = createReviewStore(join(overstoryDir, "reviews.db"));
		try {
			const handoffs = reviewStore.getByType("handoff", { limit: 20 });
			for (const record of handoffs) {
				const lowScoreDimensions = record.dimensions.filter((d) => d.score < 50);
				if (lowScoreDimensions.length > 0) {
					const dimSummary = lowScoreDimensions.map((d) => `${d.dimension}:${d.score}`).join(", ");
					evidence.push({
						path: `reviews.db#${record.id}`,
						excerpt: truncate(
							`handoff: ${record.subjectId} | score: ${record.overallScore} | weak dims: ${dimSummary}`,
						),
						relevance: "Handoff has low-scoring dimensions indicating coordination gaps",
					});
					references.push(`reviews.db#${record.id}`);
				}
			}
		} finally {
			reviewStore.close();
		}
	} catch {
		// Missing or empty store — return empty results
	}

	try {
		const eventStore = createEventStore(join(overstoryDir, "events.db"));
		try {
			const errors = eventStore.getErrors({ limit: 50 });
			// Group escalation-related errors (session_end with error level, or data mentioning escalation/stall)
			const escalations = errors.filter(
				(e) =>
					(e.eventType === "session_end" && e.level === "error") ||
					(e.data !== null &&
						(e.data.toLowerCase().includes("escalat") || e.data.toLowerCase().includes("stall"))),
			);
			for (const evt of escalations.slice(0, 10)) {
				evidence.push({
					path: `events.db#${evt.id}`,
					excerpt: truncate(
						`agent: ${evt.agentName} | type: ${evt.eventType} | at: ${evt.createdAt} | data: ${evt.data ?? ""}`,
					),
					relevance: "Agent escalation or stall event indicates coordination stress",
				});
				references.push(`events.db#${evt.id} (${evt.createdAt})`);
			}
		} finally {
			eventStore.close();
		}
	} catch {
		// Missing or empty store — return empty results
	}

	return {
		concern: "coordination",
		evidence,
		context:
			"Coordination quality is measured through handoff review scores and escalation frequency. " +
			"Low handoff scores or frequent stalls indicate process gaps that affect mission throughput.",
		references,
	};
}

/**
 * Collect evidence for the "completeness" concern.
 * Identifies missing artifacts, incomplete bundles, and low-coverage reviews.
 */
function assembleCompleteness(overstoryDir: string, missionId: string | null): ReviewBatch {
	const evidence: EvidenceEntry[] = [];
	const references: string[] = [];

	try {
		const reviewStore = createReviewStore(join(overstoryDir, "reviews.db"));
		try {
			// Look for low overall scores across all types
			for (const subjectType of ["session", "handoff", "spec", "mission"] as const) {
				const summary = reviewStore.getSummary(subjectType, { limit: 5 });
				if (summary.totalReviewed > 0 && summary.averageScore < 60) {
					evidence.push({
						path: `reviews.db (${subjectType})`,
						excerpt: truncate(
							`type: ${subjectType} | reviewed: ${summary.totalReviewed} | avg score: ${Math.round(summary.averageScore)} | stale: ${summary.staleCount}`,
						),
						relevance: `Low average review score for ${subjectType} artifacts suggests quality gaps`,
					});
					references.push(`reviews.db#${subjectType}`);
				}
			}

			// Check for session reviews with zero completeness dimension scores
			const sessionReviews = reviewStore.getByType("session", { limit: 30 });
			const incompleteReviews = sessionReviews.filter((r) => {
				const completeness = r.dimensions.find((d) => d.dimension === "completeness");
				return completeness !== undefined && completeness.score < 30;
			});
			for (const record of incompleteReviews.slice(0, 5)) {
				const dim = record.dimensions.find((d) => d.dimension === "completeness");
				evidence.push({
					path: `reviews.db#${record.id}`,
					excerpt: truncate(
						`session: ${record.subjectId} | completeness: ${dim?.score ?? "n/a"} | detail: ${dim?.details ?? ""}`,
					),
					relevance: "Session has very low completeness score — likely incomplete or aborted",
				});
				references.push(`reviews.db#${record.id}`);
			}
		} finally {
			reviewStore.close();
		}
	} catch {
		// Missing or empty store — return empty results
	}

	// Check for mission bundle artifacts if missionId is provided
	if (missionId !== null) {
		const bundlePath = join(overstoryDir, "missions", missionId, "results", "manifest.json");
		// Only flag missing bundle when the missions directory exists (mission was started)
		const missionsDir = join(overstoryDir, "missions", missionId);
		if (existsSync(missionsDir) && !existsSync(bundlePath)) {
			evidence.push({
				path: bundlePath,
				excerpt: truncate(`Mission bundle not found at ${bundlePath}`),
				relevance: "No result bundle exported for this mission — completeness unknown",
			});
			references.push(bundlePath);
		}
	}

	return {
		concern: "completeness",
		evidence,
		context:
			"Completeness tracks whether artifacts have been fully produced and reviewed. " +
			"Low scores or missing bundles indicate work that was started but not finished.",
		references,
	};
}

/**
 * Collect evidence for the "error-patterns" concern.
 * Groups recurring errors across sessions by type.
 */
function assembleErrorPatterns(overstoryDir: string): ReviewBatch {
	const evidence: EvidenceEntry[] = [];
	const references: string[] = [];

	try {
		const eventStore = createEventStore(join(overstoryDir, "events.db"));
		try {
			const errors = eventStore.getErrors({ limit: 200 });

			// Group errors by toolName (most errors are tool failures)
			const byTool = new Map<string, typeof errors>();
			const ungrouped: typeof errors = [];
			for (const err of errors) {
				if (err.toolName !== null) {
					const existing = byTool.get(err.toolName);
					if (existing !== undefined) {
						existing.push(err);
					} else {
						byTool.set(err.toolName, [err]);
					}
				} else {
					ungrouped.push(err);
				}
			}

			// Report tool groups with more than 1 occurrence
			for (const [toolName, group] of byTool) {
				if (group.length < 2) continue;
				const agents = [...new Set(group.map((e) => e.agentName))];
				const sample = group[0];
				evidence.push({
					path: `events.db (tool:${toolName})`,
					excerpt: truncate(
						`tool: ${toolName} | count: ${group.length} | agents: ${agents.join(", ")} | sample data: ${sample?.data ?? "none"} | first seen: ${sample?.createdAt ?? "unknown"}`,
					),
					relevance: `Tool '${toolName}' produced errors ${group.length} times across ${agents.length} agent(s)`,
				});
				if (sample !== undefined) {
					references.push(`events.db#${sample.id} (tool:${toolName} x${group.length})`);
				}
			}

			// Surface ungrouped errors with diagnostic data (no toolName, but has data)
			for (const err of ungrouped.slice(0, 10)) {
				if (err.data === null) continue;
				evidence.push({
					path: `events.db#${err.id}`,
					excerpt: truncate(
						`agent: ${err.agentName} | type: ${err.eventType} | at: ${err.createdAt} | data: ${err.data}`,
					),
					relevance: "Error event with diagnostic data (no tool context)",
				});
				references.push(`events.db#${err.id}`);
			}
		} finally {
			eventStore.close();
		}
	} catch {
		// Missing or empty store — return empty results
	}

	return {
		concern: "error-patterns",
		evidence,
		context:
			"Recurring error patterns across sessions may indicate systemic issues (config gaps, " +
			"dependency problems, or capability mismatches). Grouped by event type for easier triage.",
		references,
	};
}

// === Public API ===

/**
 * Assemble a ReviewBatch for a specific concern type.
 *
 * Reads from reviews.db, events.db, and sessions.db as needed.
 * Returns an empty evidence array if the relevant stores are missing or empty.
 * Never throws — callers can safely ignore missing infrastructure.
 */
export function assembleBatch(
	overstoryDir: string,
	missionId: string | null,
	concern: ConcernType,
): ReviewBatch {
	switch (concern) {
		case "staleness":
			return assembleStaleness(overstoryDir);
		case "coordination":
			return assembleCoordination(overstoryDir);
		case "completeness":
			return assembleCompleteness(overstoryDir, missionId);
		case "error-patterns":
			return assembleErrorPatterns(overstoryDir);
	}
}

/**
 * Assemble all relevant ReviewBatches for a mission.
 *
 * Returns only batches that have at least one evidence entry.
 * This is the primary API consumed by coordinator/analyst prompts.
 */
export function batchForReview(overstoryDir: string, missionId: string): ReviewBatch[] {
	const concerns: ConcernType[] = ["staleness", "coordination", "completeness", "error-patterns"];
	const batches: ReviewBatch[] = [];
	for (const concern of concerns) {
		const batch = assembleBatch(overstoryDir, missionId, concern);
		if (batch.evidence.length > 0) {
			batches.push(batch);
		}
	}
	return batches;
}
