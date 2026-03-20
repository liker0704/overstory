/**
 * Tests for src/review/batching.ts
 *
 * Uses real SQLite stores in temp directories (no mock.module).
 * Per mx-56558b: avoid mock.module() — it leaks across test files.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import { assembleBatch, batchForReview, type ConcernType } from "./batching.ts";
import { createReviewStore } from "./store.ts";

// === Test Helpers ===

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "ov-batching-test-"));
}

async function cleanupTempDir(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
}

function makeReviewRecord(overstoryDir: string) {
	const store = createReviewStore(join(overstoryDir, "reviews.db"));
	return { store };
}

function makeEventRecord(overstoryDir: string) {
	const store = createEventStore(join(overstoryDir, "events.db"));
	return { store };
}

// === Tests ===

describe("assembleBatch", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await makeTempDir();
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	test("returns well-formed ReviewBatch for staleness with empty store", () => {
		const batch = assembleBatch(tempDir, null, "staleness");
		expect(batch.concern).toBe("staleness");
		expect(Array.isArray(batch.evidence)).toBe(true);
		expect(batch.evidence.length).toBe(0);
		expect(typeof batch.context).toBe("string");
		expect(batch.context.length).toBeGreaterThan(0);
		expect(Array.isArray(batch.references)).toBe(true);
	});

	test("returns well-formed ReviewBatch for coordination with empty store", () => {
		const batch = assembleBatch(tempDir, null, "coordination");
		expect(batch.concern).toBe("coordination");
		expect(Array.isArray(batch.evidence)).toBe(true);
		expect(typeof batch.context).toBe("string");
	});

	test("returns well-formed ReviewBatch for completeness with empty store", () => {
		const batch = assembleBatch(tempDir, null, "completeness");
		expect(batch.concern).toBe("completeness");
		expect(Array.isArray(batch.evidence)).toBe(true);
		expect(typeof batch.context).toBe("string");
	});

	test("returns well-formed ReviewBatch for error-patterns with empty store", () => {
		const batch = assembleBatch(tempDir, "test-mission", "error-patterns");
		expect(batch.concern).toBe("error-patterns");
		expect(Array.isArray(batch.evidence)).toBe(true);
		expect(typeof batch.context).toBe("string");
	});

	test("does not crash when stores do not exist", () => {
		const missingDir = join(tempDir, "missing");
		const concerns: ConcernType[] = ["staleness", "coordination", "completeness", "error-patterns"];
		for (const concern of concerns) {
			expect(() => assembleBatch(missingDir, null, concern)).not.toThrow();
		}
	});

	test("staleness: returns evidence for stale review records", () => {
		const { store } = makeReviewRecord(tempDir);
		const record = store.insert({
			subjectType: "session",
			subjectId: "test-agent",
			dimensions: [{ dimension: "clarity", score: 30, details: "poor clarity" }],
			overallScore: 30,
			notes: [],
			reviewerSource: "deterministic",
		});
		store.markStaleById(record.id, "subject changed");
		store.close();

		const batch = assembleBatch(tempDir, null, "staleness");
		expect(batch.concern).toBe("staleness");
		expect(batch.evidence.length).toBe(1);
		expect(batch.evidence[0]).toBeDefined();

		const entry = batch.evidence[0]!;
		expect(entry.path).toContain("reviews.db");
		expect(entry.excerpt).toContain("test-agent");
		expect(entry.relevance).toContain("stale");
		expect(batch.references.length).toBe(1);
	});

	test("staleness: evidence excerpts are truncated to 500 chars", () => {
		const { store } = makeReviewRecord(tempDir);
		const longId = "x".repeat(600);
		const record = store.insert({
			subjectType: "session",
			subjectId: longId,
			dimensions: [{ dimension: "clarity", score: 10, details: "detail" }],
			overallScore: 10,
			notes: [],
			reviewerSource: "deterministic",
		});
		store.markStaleById(record.id, "reason");
		store.close();

		const batch = assembleBatch(tempDir, null, "staleness");
		for (const entry of batch.evidence) {
			expect(entry.excerpt.length).toBeLessThanOrEqual(500);
		}
	});

	test("coordination: returns evidence for low-scoring handoffs", () => {
		const { store } = makeReviewRecord(tempDir);
		store.insert({
			subjectType: "handoff",
			subjectId: "agent-a-to-agent-b",
			dimensions: [
				{ dimension: "clarity", score: 20, details: "unclear handoff" },
				{ dimension: "actionability", score: 30, details: "no action items" },
			],
			overallScore: 25,
			notes: [],
			reviewerSource: "deterministic",
		});
		store.close();

		const batch = assembleBatch(tempDir, null, "coordination");
		expect(batch.concern).toBe("coordination");
		expect(batch.evidence.length).toBeGreaterThan(0);
		expect(batch.evidence[0]?.relevance).toContain("coordination gaps");
	});

	test("coordination: does not return evidence for high-scoring handoffs", () => {
		const { store } = makeReviewRecord(tempDir);
		store.insert({
			subjectType: "handoff",
			subjectId: "good-handoff",
			dimensions: [
				{ dimension: "clarity", score: 90, details: "clear" },
				{ dimension: "actionability", score: 85, details: "concrete" },
			],
			overallScore: 87,
			notes: [],
			reviewerSource: "deterministic",
		});
		store.close();

		const batch = assembleBatch(tempDir, null, "coordination");
		// No low-scoring dimensions so no coordination evidence from reviews
		const reviewEvidence = batch.evidence.filter((e) => e.path.includes("reviews.db"));
		expect(reviewEvidence.length).toBe(0);
	});

	test("coordination: returns escalation events from event store", () => {
		const { store } = makeEventRecord(tempDir);
		store.insert({
			runId: null,
			agentName: "worker-1",
			sessionId: null,
			eventType: "session_end",
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			level: "error",
			data: "agent stalled after 30s",
		});
		store.insert({
			runId: null,
			agentName: "worker-2",
			sessionId: null,
			eventType: "error",
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			level: "error",
			data: "escalation triggered",
		});
		store.close();

		const batch = assembleBatch(tempDir, null, "coordination");
		const eventEvidence = batch.evidence.filter((e) => e.path.includes("events.db"));
		expect(eventEvidence.length).toBeGreaterThan(0);
		expect(eventEvidence[0]?.relevance).toContain("escalation");
	});

	test("completeness: returns evidence for low-scoring session types", () => {
		const { store } = makeReviewRecord(tempDir);
		// Insert multiple low-scoring sessions to bring average below 60
		for (let i = 0; i < 3; i++) {
			store.insert({
				subjectType: "session",
				subjectId: `agent-${i}`,
				dimensions: [
					{ dimension: "completeness", score: 10, details: "incomplete" },
					{ dimension: "clarity", score: 20, details: "unclear" },
				],
				overallScore: 15,
				notes: [],
				reviewerSource: "deterministic",
			});
		}
		store.close();

		const batch = assembleBatch(tempDir, null, "completeness");
		expect(batch.concern).toBe("completeness");
		expect(batch.evidence.length).toBeGreaterThan(0);
	});

	test("completeness: evidence entries have path, excerpt, and relevance", () => {
		const { store } = makeReviewRecord(tempDir);
		for (let i = 0; i < 2; i++) {
			store.insert({
				subjectType: "session",
				subjectId: `agent-${i}`,
				dimensions: [{ dimension: "completeness", score: 5, details: "zero completeness" }],
				overallScore: 5,
				notes: [],
				reviewerSource: "deterministic",
			});
		}
		store.close();

		const batch = assembleBatch(tempDir, null, "completeness");
		for (const entry of batch.evidence) {
			expect(typeof entry.path).toBe("string");
			expect(entry.path.length).toBeGreaterThan(0);
			expect(typeof entry.excerpt).toBe("string");
			expect(entry.excerpt.length).toBeGreaterThan(0);
			expect(typeof entry.relevance).toBe("string");
			expect(entry.relevance.length).toBeGreaterThan(0);
		}
	});

	test("error-patterns: groups recurring errors by tool name", () => {
		const { store } = makeEventRecord(tempDir);
		for (let i = 0; i < 3; i++) {
			store.insert({
				runId: null,
				agentName: `agent-${i}`,
				sessionId: null,
				eventType: "error",
				toolName: "Bash",
				toolArgs: null,
				toolDurationMs: null,
				level: "error",
				data: `error message ${i}`,
			});
		}
		store.close();

		const batch = assembleBatch(tempDir, null, "error-patterns");
		expect(batch.concern).toBe("error-patterns");
		expect(batch.evidence.length).toBeGreaterThan(0);
		const grouped = batch.evidence.find((e) => e.path.includes("tool:Bash"));
		expect(grouped).toBeDefined();
		expect(grouped?.relevance).toContain("3 times");
	});

	test("error-patterns: ungrouped errors with data are surfaced", () => {
		const { store } = makeEventRecord(tempDir);
		store.insert({
			runId: null,
			agentName: "agent-x",
			sessionId: null,
			eventType: "error",
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			level: "error",
			data: "critical failure details",
		});
		store.close();

		const batch = assembleBatch(tempDir, null, "error-patterns");
		const single = batch.evidence.find((e) => e.excerpt.includes("agent-x"));
		expect(single).toBeDefined();
	});
});

describe("batchForReview", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await makeTempDir();
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	test("returns empty array when all stores are empty", () => {
		const batches = batchForReview(tempDir, "mission-1");
		expect(Array.isArray(batches)).toBe(true);
		expect(batches.length).toBe(0);
	});

	test("returns only batches with evidence", () => {
		// Insert one stale review
		const { store } = makeReviewRecord(tempDir);
		const record = store.insert({
			subjectType: "spec",
			subjectId: "overstory-d869",
			dimensions: [{ dimension: "clarity", score: 40, details: "vague" }],
			overallScore: 40,
			notes: [],
			reviewerSource: "deterministic",
		});
		store.markStaleById(record.id, "spec updated");
		store.close();

		const batches = batchForReview(tempDir, "mission-1");
		expect(batches.length).toBeGreaterThan(0);
		for (const batch of batches) {
			expect(batch.evidence.length).toBeGreaterThan(0);
		}
	});

	test("returns ReviewBatch with all required fields", () => {
		const { store: eStore } = makeEventRecord(tempDir);
		eStore.insert({
			runId: null,
			agentName: "agent-1",
			sessionId: null,
			eventType: "session_end",
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			level: "error",
			data: "stalled",
		});
		eStore.insert({
			runId: null,
			agentName: "agent-2",
			sessionId: null,
			eventType: "session_end",
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			level: "error",
			data: "stalled again",
		});
		eStore.close();

		const batches = batchForReview(tempDir, "mission-2");
		for (const batch of batches) {
			expect(typeof batch.concern).toBe("string");
			expect(Array.isArray(batch.evidence)).toBe(true);
			expect(typeof batch.context).toBe("string");
			expect(Array.isArray(batch.references)).toBe(true);
		}
	});

	test("does not crash when overstory dir does not exist", () => {
		const missingDir = join(tempDir, "nonexistent");
		expect(() => batchForReview(missingDir, "mission-x")).not.toThrow();
		const batches = batchForReview(missingDir, "mission-x");
		expect(batches.length).toBe(0);
	});
});
