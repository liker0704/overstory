/**
 * SQL schema consistency tests.
 *
 * Verifies that SQL CREATE TABLE column names match the TypeScript row interfaces
 * and row-to-object conversion functions across all four SQLite stores.
 * Prevents regressions like the bead_id/task_id column rename that caused runtime failures.
 *
 * Strategy: create each store (which runs CREATE TABLE), then open a second
 * read-only connection to the same temp file and query PRAGMA table_info().
 * bun:sqlite with WAL mode allows concurrent readers.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventStore } from "./events/store.ts";
import { createMailStore } from "./mail/store.ts";
import { createMergeQueue } from "./merge/queue.ts";
import { createMetricsStore } from "./metrics/store.ts";
import { createMissionStore } from "./missions/store.ts";
import { createResilienceStore } from "./resilience/store.ts";
import { createSessionStore } from "./sessions/store.ts";

import { cleanupTempDir } from "./test-helpers.ts";

/** Extract sorted column names from a table via PRAGMA table_info(). */
function getTableColumns(db: Database, tableName: string): string[] {
	const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
		name: string;
	}>;
	return rows.map((r) => r.name).sort();
}

describe("SQL schema consistency", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "overstory-schema-test-"));
	});

	afterEach(async () => {
		await cleanupTempDir(tmpDir);
	});

	describe("SessionStore", () => {
		test("sessions table columns match SessionRow interface", () => {
			const dbPath = join(tmpDir, "sessions.db");
			const store = createSessionStore(dbPath);

			const db = new Database(dbPath, { readonly: true });
			const actual = getTableColumns(db, "sessions");
			db.close();
			store.close();

			// Columns from SessionRow interface in src/sessions/store.ts
			const expected = [
				"agent_name",
				"branch_name",
				"capability",
				"depth",
				"escalation_level",
				"id",
				"last_activity",
				"original_runtime",
				"parent_agent",
				"pid",
				"rate_limit_resumes_at",
				"rate_limited_since",
				"run_id",
				"prompt_version",
				"runtime",
				"runtime_session_id",
				"stalled_since",
				"started_at",
				"state",
				"status_line",
				"task_id",
				"tmux_session",
				"transcript_path",
				"worktree_path",
			].sort();

			expect(actual).toEqual(expected);
		});

		test("runs table columns match RunRow interface", () => {
			const dbPath = join(tmpDir, "sessions.db");
			const store = createSessionStore(dbPath);

			const db = new Database(dbPath, { readonly: true });
			const actual = getTableColumns(db, "runs");
			db.close();
			store.close();

			// Columns from RunRow interface in src/sessions/store.ts
			const expected = [
				"agent_count",
				"completed_at",
				"coordinator_name",
				"coordinator_session_id",
				"id",
				"started_at",
				"status",
			].sort();

			expect(actual).toEqual(expected);
		});
	});

	describe("EventStore", () => {
		test("events table columns match EventRow interface", () => {
			const dbPath = join(tmpDir, "events.db");
			const store = createEventStore(dbPath);

			const db = new Database(dbPath, { readonly: true });
			const actual = getTableColumns(db, "events");
			db.close();
			store.close();

			// Columns from EventRow interface in src/events/store.ts
			const expected = [
				"agent_name",
				"created_at",
				"data",
				"event_type",
				"id",
				"level",
				"run_id",
				"session_id",
				"tool_args",
				"tool_duration_ms",
				"tool_name",
			].sort();

			expect(actual).toEqual(expected);
		});
	});

	describe("MetricsStore", () => {
		test("sessions table columns match metrics SessionRow interface", () => {
			const dbPath = join(tmpDir, "metrics.db");
			const store = createMetricsStore(dbPath);

			const db = new Database(dbPath, { readonly: true });
			const actual = getTableColumns(db, "sessions");
			db.close();
			store.close();

			// Columns from SessionRow interface in src/metrics/store.ts
			const expected = [
				"agent_name",
				"cache_creation_tokens",
				"cache_read_tokens",
				"capability",
				"completed_at",
				"duration_ms",
				"estimated_cost_usd",
				"exit_code",
				"input_tokens",
				"merge_result",
				"model_used",
				"output_tokens",
				"parent_agent",
				"run_id",
				"started_at",
				"task_id",
			].sort();

			expect(actual).toEqual(expected);
		});

		test("token_snapshots table columns match SnapshotRow interface", () => {
			const dbPath = join(tmpDir, "metrics.db");
			const store = createMetricsStore(dbPath);

			const db = new Database(dbPath, { readonly: true });
			const actual = getTableColumns(db, "token_snapshots");
			db.close();
			store.close();

			// Columns from SnapshotRow interface in src/metrics/store.ts
			const expected = [
				"agent_name",
				"cache_creation_tokens",
				"cache_read_tokens",
				"created_at",
				"estimated_cost_usd",
				"id",
				"input_tokens",
				"model_used",
				"output_tokens",
				"run_id",
			].sort();

			expect(actual).toEqual(expected);
		});
	});

	describe("MailStore", () => {
		test("messages table columns match MessageRow interface", () => {
			const dbPath = join(tmpDir, "mail.db");
			const store = createMailStore(dbPath);

			const db = new Database(dbPath, { readonly: true });
			const actual = getTableColumns(db, "messages");
			db.close();
			store.close();

			// Columns from MessageRow interface in src/mail/store.ts
			const expected = [
				"attempt",
				"body",
				"claimed_at",
				"created_at",
				"fail_reason",
				"from_agent",
				"id",
				"mission_id",
				"next_retry_at",
				"payload",
				"priority",
				"read",
				"state",
				"subject",
				"thread_id",
				"to_agent",
				"type",
			].sort();

			expect(actual).toEqual(expected);
		});
	});

	describe("MergeQueue", () => {
		test("merge_queue table columns match MergeQueueRow interface", () => {
			const dbPath = join(tmpDir, "merge-queue.db");
			const queue = createMergeQueue(dbPath);

			const db = new Database(dbPath, { readonly: true });
			const actual = getTableColumns(db, "merge_queue");
			db.close();
			queue.close();

			// Columns from MergeQueueRow interface in src/merge/queue.ts
			const expected = [
				"agent_name",
				"branch_name",
				"compat_report_path",
				"enqueued_at",
				"files_modified",
				"id",
				"mission_id",
				"resolved_tier",
				"status",
				"task_id",
			].sort();

			expect(actual).toEqual(expected);
		});
	});

	describe("ResilienceStore", () => {
		test("breaker_state table columns match BreakerRow interface", () => {
			const dbPath = join(tmpDir, "resilience.db");
			const store = createResilienceStore(dbPath);

			const db = new Database(dbPath, { readonly: true });
			const actual = getTableColumns(db, "breaker_state");
			db.close();
			store.close();

			// Columns from BreakerRow interface in src/resilience/store.ts
			const expected = [
				"capability",
				"failure_count",
				"half_open_at",
				"last_failure_at",
				"opened_at",
				"state",
				"updated_at",
			].sort();

			expect(actual).toEqual(expected);
		});

		test("retry_records table columns match RetryRow interface", () => {
			const dbPath = join(tmpDir, "resilience.db");
			const store = createResilienceStore(dbPath);

			const db = new Database(dbPath, { readonly: true });
			const actual = getTableColumns(db, "retry_records");
			db.close();
			store.close();

			// Columns from RetryRow interface in src/resilience/store.ts
			const expected = [
				"attempt",
				"capability",
				"created_at",
				"error_class",
				"failed_at",
				"id",
				"is_probe",
				"outcome",
				"started_at",
				"task_id",
			].sort();

			expect(actual).toEqual(expected);
		});
	});

	describe("MissionStore", () => {
		test("missions table columns match MissionRow interface", () => {
			const dbPath = join(tmpDir, "sessions.db");
			const store = createMissionStore(dbPath);

			const db = new Database(dbPath, { readonly: true });
			const actual = getTableColumns(db, "missions");
			db.close();
			store.close();

			const expected = [
				"analyst_session_id",
				"architect_session_id",
				"artifact_root",
				"completed_at",
				"coordinator_session_id",
				"created_at",
				"current_node",
				"execution_director_session_id",
				"first_freeze_at",
				"frozen_at",
				"id",
				"learnings_extracted",
				"objective",
				"pause_reason",
				"paused_lead_names",
				"paused_workstream_ids",
				"pending_input_kind",
				"pending_input_thread_id",
				"pending_user_input",
				"phase",
				"reopen_count",
				"run_id",
				"slug",
				"started_at",
				"state",
				"tier",
				"updated_at",
			].sort();

			expect(actual).toEqual(expected);
		});
	});
});
