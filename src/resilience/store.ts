import { Database } from "bun:sqlite";
import { ensureMigrations, type Migration } from "../db/migrate.ts";
import type { CircuitBreakerState, RetryRecord } from "./types.ts";

export interface ResilienceStore {
	getBreaker(capability: string): CircuitBreakerState | null;
	upsertBreaker(state: CircuitBreakerState, expectedState: CircuitBreakerState["state"]): boolean;
	listOpenBreakers(): CircuitBreakerState[];
	recordRetry(record: RetryRecord): void;
	getRetries(taskId: string): RetryRecord[];
	getRetryCount(taskId: string): number;
	getRecentFailures(capability: string, windowMs: number): number;
	getPendingRetries(maxAttempts: number): RetryRecord[];
	cleanup(olderThanMs: number): number;
	close(): void;
}

interface BreakerRow {
	capability: string;
	state: string;
	failure_count: number;
	last_failure_at: string | null;
	opened_at: string | null;
	half_open_at: string | null;
	updated_at: string;
}

interface RetryRow {
	id: number;
	task_id: string;
	attempt: number;
	outcome: string;
	agent_name: string;
	started_at: string;
	failed_at: string | null;
	error_class: string;
	is_probe: number;
	created_at: string;
}

function rowToBreaker(row: BreakerRow): CircuitBreakerState {
	return {
		capability: row.capability,
		state: row.state as CircuitBreakerState["state"],
		failureCount: row.failure_count,
		lastFailureAt: row.last_failure_at,
		openedAt: row.opened_at,
		halfOpenAt: row.half_open_at,
	};
}

function rowToRetry(row: RetryRow): RetryRecord {
	return {
		taskId: row.task_id,
		attempt: row.attempt,
		outcome: row.outcome as RetryRecord["outcome"],
		agentName: row.agent_name,
		startedAt: row.started_at,
		failedAt: row.failed_at,
		errorClass: row.error_class as RetryRecord["errorClass"],
	};
}

const CREATE_BREAKER_TABLE = `
CREATE TABLE IF NOT EXISTS breaker_state (
  capability TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'closed' CHECK(state IN ('closed','open','half_open')),
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_failure_at TEXT,
  opened_at TEXT,
  half_open_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const CREATE_RETRY_TABLE = `
CREATE TABLE IF NOT EXISTS retry_records (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK(outcome IN ('pending','success','failure')),
  agent_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  failed_at TEXT,
  error_class TEXT NOT NULL,
  is_probe INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_retry_task_outcome ON retry_records(task_id, outcome);
CREATE INDEX IF NOT EXISTS idx_retry_capability ON retry_records(agent_name, started_at)`;

const RESILIENCE_MIGRATIONS: Migration[] = [
	{
		version: 1,
		description: "initial resilience schema (breaker_state + retry_records)",
		up: () => {
			// Tables created by CREATE TABLE IF NOT EXISTS below
		},
		detect: (db) => {
			const row = db
				.prepare<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='breaker_state'",
				)
				.get();
			const row2 = db
				.prepare<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='retry_records'",
				)
				.get();
			return !!row && !!row2;
		},
	},
];

export function createResilienceStore(dbPath: string): ResilienceStore {
	const db = new Database(dbPath);

	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA busy_timeout = 5000");

	ensureMigrations(db, RESILIENCE_MIGRATIONS);

	db.exec(CREATE_BREAKER_TABLE);
	db.exec(CREATE_RETRY_TABLE);
	db.exec(CREATE_INDEXES);

	const getBreakerStmt = db.prepare<BreakerRow, { $capability: string }>(
		"SELECT * FROM breaker_state WHERE capability = $capability",
	);

	const insertBreakerStmt = db.prepare<
		void,
		{
			$capability: string;
			$state: string;
			$failure_count: number;
			$last_failure_at: string | null;
			$opened_at: string | null;
			$half_open_at: string | null;
		}
	>(`
		INSERT INTO breaker_state (capability, state, failure_count, last_failure_at, opened_at, half_open_at, updated_at)
		VALUES ($capability, $state, $failure_count, $last_failure_at, $opened_at, $half_open_at, datetime('now'))
	`);

	const updateBreakerStmt = db.prepare<
		{ capability: string },
		{
			$capability: string;
			$state: string;
			$failure_count: number;
			$last_failure_at: string | null;
			$opened_at: string | null;
			$half_open_at: string | null;
			$expected_state: string;
		}
	>(`
		UPDATE breaker_state
		SET state = $state,
		    failure_count = $failure_count,
		    last_failure_at = $last_failure_at,
		    opened_at = $opened_at,
		    half_open_at = $half_open_at,
		    updated_at = datetime('now')
		WHERE capability = $capability AND state = $expected_state
		RETURNING capability
	`);

	const listOpenBreakersStmt = db.prepare<BreakerRow, []>(
		"SELECT * FROM breaker_state WHERE state IN ('open','half_open')",
	);

	const insertRetryStmt = db.prepare<
		void,
		{
			$task_id: string;
			$attempt: number;
			$outcome: string;
			$agent_name: string;
			$started_at: string;
			$failed_at: string | null;
			$error_class: string;
		}
	>(`
		INSERT INTO retry_records (task_id, attempt, outcome, agent_name, started_at, failed_at, error_class)
		VALUES ($task_id, $attempt, $outcome, $agent_name, $started_at, $failed_at, $error_class)
	`);

	const getRetriesStmt = db.prepare<RetryRow, { $task_id: string }>(
		"SELECT * FROM retry_records WHERE task_id = $task_id ORDER BY attempt ASC",
	);

	const getRetryCountStmt = db.prepare<{ cnt: number }, { $task_id: string }>(
		"SELECT COUNT(*) as cnt FROM retry_records WHERE task_id = $task_id",
	);

	const getRecentFailuresStmt = db.prepare<
		{ cnt: number },
		{ $agent_name: string; $cutoff: string }
	>(
		"SELECT COUNT(*) as cnt FROM retry_records WHERE agent_name = $agent_name AND outcome = 'failure' AND started_at >= $cutoff",
	);

	const getPendingRetriesStmt = db.prepare<RetryRow, { $max_attempts: number }>(
		"SELECT * FROM retry_records WHERE outcome = 'pending' AND attempt < $max_attempts ORDER BY created_at ASC",
	);

	const upsertBreakerTransaction = db.transaction(
		(state: CircuitBreakerState, expectedState: CircuitBreakerState["state"]): boolean => {
			const existing = getBreakerStmt.get({ $capability: state.capability });
			if (!existing) {
				insertBreakerStmt.run({
					$capability: state.capability,
					$state: state.state,
					$failure_count: state.failureCount,
					$last_failure_at: state.lastFailureAt,
					$opened_at: state.openedAt,
					$half_open_at: state.halfOpenAt,
				});
				return true;
			}
			const updated = updateBreakerStmt.all({
				$capability: state.capability,
				$state: state.state,
				$failure_count: state.failureCount,
				$last_failure_at: state.lastFailureAt,
				$opened_at: state.openedAt,
				$half_open_at: state.halfOpenAt,
				$expected_state: expectedState,
			});
			return updated.length > 0;
		},
	);

	return {
		getBreaker(capability: string): CircuitBreakerState | null {
			const row = getBreakerStmt.get({ $capability: capability });
			return row ? rowToBreaker(row) : null;
		},

		upsertBreaker(
			state: CircuitBreakerState,
			expectedState: CircuitBreakerState["state"],
		): boolean {
			return upsertBreakerTransaction(state, expectedState);
		},

		listOpenBreakers(): CircuitBreakerState[] {
			return listOpenBreakersStmt.all().map(rowToBreaker);
		},

		recordRetry(record: RetryRecord): void {
			insertRetryStmt.run({
				$task_id: record.taskId,
				$attempt: record.attempt,
				$outcome: record.outcome,
				$agent_name: record.agentName,
				$started_at: record.startedAt,
				$failed_at: record.failedAt,
				$error_class: record.errorClass,
			});
		},

		getRetries(taskId: string): RetryRecord[] {
			return getRetriesStmt.all({ $task_id: taskId }).map(rowToRetry);
		},

		getRetryCount(taskId: string): number {
			const row = getRetryCountStmt.get({ $task_id: taskId });
			return row?.cnt ?? 0;
		},

		getRecentFailures(capability: string, windowMs: number): number {
			const cutoff = new Date(Date.now() - windowMs).toISOString();
			const row = getRecentFailuresStmt.get({ $agent_name: capability, $cutoff: cutoff });
			return row?.cnt ?? 0;
		},

		getPendingRetries(maxAttempts: number): RetryRecord[] {
			return getPendingRetriesStmt.all({ $max_attempts: maxAttempts }).map(rowToRetry);
		},

		cleanup(olderThanMs: number): number {
			const cutoff = new Date(Date.now() - olderThanMs).toISOString();
			const deleted = db
				.prepare<{ id: number }, { $cutoff: string }>(
					"DELETE FROM retry_records WHERE created_at < $cutoff RETURNING id",
				)
				.all({ $cutoff: cutoff });
			return deleted.length;
		},

		close(): void {
			try {
				db.exec("PRAGMA wal_checkpoint(PASSIVE)");
			} catch {
				// Best effort
			}
			db.close();
		},
	};
}
