/**
 * SQLite-backed session store for agent lifecycle tracking.
 *
 * Replaces the flat-file sessions.json with a proper database.
 * Uses bun:sqlite for zero-dependency, synchronous database access.
 * WAL mode enables concurrent reads from multiple agent processes.
 */

import { Database } from "bun:sqlite";
import { ensureMigrations, hasColumn, type Migration, rebuildTable } from "../db/migrate.ts";
import type { AgentSession, AgentState, InsertRun, Run, RunStatus, RunStore } from "../types.ts";

export interface SessionStore {
	/** Insert or update a session. Uses agent_name as the unique key. */
	upsert(session: AgentSession): void;
	/** Get a session by agent name, or null if not found. */
	getByName(agentName: string): AgentSession | null;
	/** Get all active sessions (state IN ('booting', 'working', 'stalled')). */
	getActive(): AgentSession[];
	/** Get all sessions regardless of state. */
	getAll(): AgentSession[];
	/** Get the total number of sessions. Lightweight alternative to getAll().length. */
	count(): number;
	/** Get sessions belonging to a specific run. */
	getByRun(runId: string): AgentSession[];
	/** Update only the state of a session. */
	updateState(agentName: string, state: AgentState): void;
	/** Update lastActivity to current ISO timestamp. */
	updateLastActivity(agentName: string): void;
	/** Update escalation level and stalled timestamp. */
	updateEscalation(agentName: string, level: number, stalledSince: string | null): void;
	/** Update the transcript path for a session. */
	updateTranscriptPath(agentName: string, path: string): void;
	/** Update the runtime-native session ID for a session. */
	updateRuntimeSessionId(agentName: string, runtimeSessionId: string | null): void;
	/** Update the rate_limited_since timestamp for a session. */
	updateRateLimitedSince(agentName: string, rateLimitedSince: string | null): void;
	/** Update the rate_limit_resumes_at timestamp for a session. */
	updateRateLimitResumesAt(agentName: string, resumesAt: string | null): void;
	/** Update original_runtime (set on swap, cleared on resume). */
	updateOriginalRuntime(agentName: string, originalRuntime: string | null): void;
	/** Update the agent's self-reported status line. */
	updateStatusLine(agentName: string, statusLine: string): void;
	/** Get sessions that can be resumed (not completed — includes zombie since dead tmux is expected). */
	getResumable(): AgentSession[];
	/** Remove a session by agent name. */
	remove(agentName: string): void;
	/** Purge sessions matching criteria. Returns count of deleted rows. */
	purge(opts: { all?: boolean; state?: AgentState; agent?: string }): number;
	/** Close the database connection. */
	close(): void;
}

/** Row shape as stored in SQLite (snake_case columns). */
interface SessionRow {
	id: string;
	agent_name: string;
	capability: string;
	runtime: string;
	worktree_path: string;
	branch_name: string;
	task_id: string;
	tmux_session: string;
	state: string;
	pid: number | null;
	parent_agent: string | null;
	depth: number;
	run_id: string | null;
	started_at: string;
	last_activity: string;
	escalation_level: number;
	stalled_since: string | null;
	rate_limited_since: string | null;
	rate_limit_resumes_at: string | null;
	runtime_session_id: string | null;
	transcript_path: string | null;
	original_runtime: string | null;
	status_line: string | null;
	prompt_version: string | null;
}

/** Row shape for runs table as stored in SQLite (snake_case columns). */
interface RunRow {
	id: string;
	started_at: string;
	completed_at: string | null;
	agent_count: number;
	coordinator_session_id: string | null;
	coordinator_name: string | null;
	status: string;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL UNIQUE,
  capability TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  task_id TEXT NOT NULL,
  tmux_session TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'booting'
    CHECK(state IN ('booting','working','completed','stalled','zombie')),
  pid INTEGER,
  parent_agent TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  run_id TEXT,
  started_at TEXT NOT NULL,
  last_activity TEXT NOT NULL,
  escalation_level INTEGER NOT NULL DEFAULT 0,
  stalled_since TEXT,
  transcript_path TEXT,
  prompt_version TEXT
)`;

const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions(state);
CREATE INDEX IF NOT EXISTS idx_sessions_run ON sessions(run_id)`;

const CREATE_RUNS_TABLE = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  agent_count INTEGER NOT NULL DEFAULT 0,
  coordinator_session_id TEXT,
  coordinator_name TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','completed','failed','stopped'))
)`;

const CREATE_RUNS_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_coordinator ON runs(coordinator_name)`;

/** Convert a database row (snake_case) to an AgentSession object (camelCase). */
function rowToSession(row: SessionRow): AgentSession {
	return {
		id: row.id,
		agentName: row.agent_name,
		capability: row.capability,
		runtime: row.runtime ?? "claude",
		worktreePath: row.worktree_path,
		branchName: row.branch_name,
		taskId: row.task_id,
		tmuxSession: row.tmux_session,
		state: row.state as AgentState,
		pid: row.pid,
		parentAgent: row.parent_agent,
		depth: row.depth,
		runId: row.run_id,
		startedAt: row.started_at,
		lastActivity: row.last_activity,
		escalationLevel: row.escalation_level,
		stalledSince: row.stalled_since,
		rateLimitedSince: row.rate_limited_since,
		rateLimitResumesAt: row.rate_limit_resumes_at ?? null,
		runtimeSessionId: row.runtime_session_id ?? null,
		transcriptPath: row.transcript_path,
		originalRuntime: row.original_runtime ?? null,
		statusLine: row.status_line ?? null,
		...(row.prompt_version !== null ? { promptVersion: row.prompt_version } : {}),
	};
}

/** Convert a database row (snake_case) to a Run object (camelCase). */
function rowToRun(row: RunRow): Run {
	return {
		id: row.id,
		startedAt: row.started_at,
		completedAt: row.completed_at,
		agentCount: row.agent_count,
		coordinatorSessionId: row.coordinator_session_id,
		coordinatorName: row.coordinator_name,
		status: row.status as RunStatus,
	};
}

/** Migrations for the sessions table (v1-v7). */
const SESSION_MIGRATIONS: Migration[] = [
	{
		version: 1,
		description: "rename bead_id to task_id",
		up: (db) => {
			if (hasColumn(db, "sessions", "bead_id") && !hasColumn(db, "sessions", "task_id")) {
				db.exec("ALTER TABLE sessions RENAME COLUMN bead_id TO task_id");
			}
		},
		detect: (_db, cols) => cols.has("task_id"),
	},
	{
		version: 2,
		description: "add transcript_path column",
		up: (db) => {
			if (!hasColumn(db, "sessions", "transcript_path")) {
				db.exec("ALTER TABLE sessions ADD COLUMN transcript_path TEXT");
			}
		},
		detect: (_db, cols) => cols.has("transcript_path"),
	},
	{
		version: 3,
		description: "add rate_limited_since and runtime columns",
		up: (db) => {
			if (!hasColumn(db, "sessions", "rate_limited_since")) {
				db.exec("ALTER TABLE sessions ADD COLUMN rate_limited_since TEXT");
			}
			if (!hasColumn(db, "sessions", "runtime")) {
				db.exec("ALTER TABLE sessions ADD COLUMN runtime TEXT DEFAULT 'claude'");
			}
		},
		detect: (_db, cols) => cols.has("rate_limited_since") && cols.has("runtime"),
	},
	{
		version: 4,
		description: "add runtime_session_id column",
		up: (db) => {
			if (!hasColumn(db, "sessions", "runtime_session_id")) {
				db.exec("ALTER TABLE sessions ADD COLUMN runtime_session_id TEXT");
			}
		},
		detect: (_db, cols) => cols.has("runtime_session_id"),
	},
	{
		version: 5,
		description: "add original_runtime column",
		up: (db) => {
			if (!hasColumn(db, "sessions", "original_runtime")) {
				db.exec("ALTER TABLE sessions ADD COLUMN original_runtime TEXT");
			}
		},
		detect: (_db, cols) => cols.has("original_runtime"),
	},
	{
		version: 6,
		description: "add status_line column",
		up: (db) => {
			if (!hasColumn(db, "sessions", "status_line")) {
				db.exec("ALTER TABLE sessions ADD COLUMN status_line TEXT");
			}
		},
		detect: (_db, cols) => cols.has("status_line"),
	},
	{
		version: 7,
		description: "add prompt_version column",
		up: (db) => {
			if (!hasColumn(db, "sessions", "prompt_version")) {
				db.exec("ALTER TABLE sessions ADD COLUMN prompt_version TEXT");
			}
		},
		detect: (_db, cols) => cols.has("prompt_version"),
	},
	{
		version: 10,
		description: "add rate_limit_resumes_at column",
		up: (db) => {
			if (!hasColumn(db, "sessions", "rate_limit_resumes_at")) {
				db.exec("ALTER TABLE sessions ADD COLUMN rate_limit_resumes_at TEXT");
			}
		},
		detect: (_db, cols) => cols.has("rate_limit_resumes_at"),
	},
	{
		version: 11,
		description: "add waiting to sessions state CHECK constraint",
		up: (db) => {
			const result = db
				.prepare<{ sql: string }, []>(
					"SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'",
				)
				.get();
			if (!result || result.sql.includes("'waiting'")) return;
			rebuildTable({
				db,
				table: "sessions",
				createSql: `CREATE TABLE sessions (
					id TEXT PRIMARY KEY,
					agent_name TEXT NOT NULL UNIQUE,
					capability TEXT NOT NULL,
					worktree_path TEXT NOT NULL,
					branch_name TEXT NOT NULL,
					task_id TEXT NOT NULL,
					tmux_session TEXT NOT NULL,
					state TEXT NOT NULL DEFAULT 'booting'
						CHECK(state IN ('booting','working','waiting','completed','stalled','zombie')),
					pid INTEGER,
					parent_agent TEXT,
					depth INTEGER NOT NULL DEFAULT 0,
					run_id TEXT,
					started_at TEXT NOT NULL,
					last_activity TEXT NOT NULL,
					escalation_level INTEGER NOT NULL DEFAULT 0,
					stalled_since TEXT,
					transcript_path TEXT,
					prompt_version TEXT,
					rate_limited_since TEXT,
					runtime TEXT DEFAULT 'claude',
					runtime_session_id TEXT,
					original_runtime TEXT,
					status_line TEXT,
					rate_limit_resumes_at TEXT
				)`,
				columns: [
					"id",
					"agent_name",
					"capability",
					"worktree_path",
					"branch_name",
					"task_id",
					"tmux_session",
					"state",
					"pid",
					"parent_agent",
					"depth",
					"run_id",
					"started_at",
					"last_activity",
					"escalation_level",
					"stalled_since",
					"transcript_path",
					"prompt_version",
					"rate_limited_since",
					"runtime",
					"runtime_session_id",
					"original_runtime",
					"status_line",
					"rate_limit_resumes_at",
				],
			});
		},
		detect: (db) => {
			const result = db
				.prepare<{ sql: string }, []>(
					"SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'",
				)
				.get();
			return result !== null && result.sql.includes("'waiting'");
		},
	},
];

/** Migrations for the runs table (v8-v9). Separate for independent use by RunStore. */
const RUNS_MIGRATIONS: Migration[] = [
	{
		version: 8,
		description: "add coordinator_name to runs",
		up: (db) => {
			if (!hasColumn(db, "runs", "coordinator_name")) {
				db.exec("ALTER TABLE runs ADD COLUMN coordinator_name TEXT");
			}
		},
		detect: (db) => hasColumn(db, "runs", "coordinator_name"),
	},
	{
		version: 9,
		description: "extend runs.status CHECK to include stopped",
		up: (db) => {
			const result = db
				.prepare<{ sql: string }, []>(
					"SELECT sql FROM sqlite_master WHERE type='table' AND name='runs'",
				)
				.get();
			if (!result || result.sql.includes("'stopped'")) return;
			rebuildTable({
				db,
				table: "runs",
				createSql: `CREATE TABLE runs (
					id TEXT PRIMARY KEY,
					started_at TEXT NOT NULL,
					completed_at TEXT,
					agent_count INTEGER NOT NULL DEFAULT 0,
					coordinator_session_id TEXT,
					coordinator_name TEXT,
					status TEXT NOT NULL DEFAULT 'active'
						CHECK(status IN ('active','completed','failed','stopped'))
				)`,
				columns: [
					"id",
					"started_at",
					"completed_at",
					"agent_count",
					"coordinator_session_id",
					"coordinator_name",
					"status",
				],
			});
		},
		detect: (db) => {
			const result = db
				.prepare<{ sql: string }, []>(
					"SELECT sql FROM sqlite_master WHERE type='table' AND name='runs'",
				)
				.get();
			return !!result && result.sql.includes("'stopped'");
		},
	},
];

/** Combined sessions + runs migrations for createSessionStore (both tables present). */
const ALL_SESSION_DB_MIGRATIONS: Migration[] = [...SESSION_MIGRATIONS, ...RUNS_MIGRATIONS];

/**
 * Create a new SessionStore backed by a SQLite database at the given path.
 *
 * Initializes the database with WAL mode and a 5-second busy timeout.
 * Creates the sessions table and indexes if they do not already exist.
 */
export function createSessionStore(dbPath: string): SessionStore {
	const db = new Database(dbPath);

	// Configure for concurrent access from multiple agent processes.
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA busy_timeout = 5000");

	// Create schema (tables first, then migrations, then indexes)
	db.exec(CREATE_TABLE);
	db.exec(CREATE_RUNS_TABLE);

	// Run all migrations (idempotent — each up() is guarded by hasColumn/constraint checks)
	ensureMigrations(db, ALL_SESSION_DB_MIGRATIONS);

	// Now safe to create indexes (all columns exist).
	db.exec(CREATE_INDEXES);
	db.exec(CREATE_RUNS_INDEXES);

	// Prepare statements for frequent operations
	const upsertStmt = db.prepare<
		void,
		{
			$id: string;
			$agent_name: string;
			$capability: string;
			$runtime: string;
			$worktree_path: string;
			$branch_name: string;
			$task_id: string;
			$tmux_session: string;
			$state: string;
			$pid: number | null;
			$parent_agent: string | null;
			$depth: number;
			$run_id: string | null;
			$started_at: string;
			$last_activity: string;
			$escalation_level: number;
			$stalled_since: string | null;
			$rate_limited_since: string | null;
			$runtime_session_id: string | null;
			$transcript_path: string | null;
			$original_runtime: string | null;
			$status_line: string | null;
			$prompt_version: string | null;
		}
	>(`
		INSERT INTO sessions
			(id, agent_name, capability, runtime, worktree_path, branch_name, task_id,
			 tmux_session, state, pid, parent_agent, depth, run_id,
			 started_at, last_activity, escalation_level, stalled_since,
			 rate_limited_since, runtime_session_id, transcript_path, original_runtime,
			 status_line, prompt_version)
		VALUES
			($id, $agent_name, $capability, $runtime, $worktree_path, $branch_name, $task_id,
			 $tmux_session, $state, $pid, $parent_agent, $depth, $run_id,
			 $started_at, $last_activity, $escalation_level, $stalled_since,
			 $rate_limited_since, $runtime_session_id, $transcript_path, $original_runtime,
			 $status_line, $prompt_version)
		ON CONFLICT(agent_name) DO UPDATE SET
			id = excluded.id,
			capability = excluded.capability,
			runtime = excluded.runtime,
			worktree_path = excluded.worktree_path,
			branch_name = excluded.branch_name,
			task_id = excluded.task_id,
			tmux_session = excluded.tmux_session,
			state = excluded.state,
			pid = excluded.pid,
			parent_agent = excluded.parent_agent,
			depth = excluded.depth,
			run_id = excluded.run_id,
			started_at = excluded.started_at,
			last_activity = excluded.last_activity,
			escalation_level = excluded.escalation_level,
			stalled_since = excluded.stalled_since,
			rate_limited_since = excluded.rate_limited_since,
			runtime_session_id = excluded.runtime_session_id,
			transcript_path = excluded.transcript_path,
			original_runtime = excluded.original_runtime,
			status_line = excluded.status_line,
			prompt_version = excluded.prompt_version
	`);

	const getByNameStmt = db.prepare<SessionRow, { $agent_name: string }>(`
		SELECT * FROM sessions WHERE agent_name = $agent_name
	`);

	const getActiveStmt = db.prepare<SessionRow, Record<string, never>>(`
		SELECT * FROM sessions WHERE state IN ('booting', 'working', 'waiting', 'stalled')
		ORDER BY started_at ASC
	`);

	const getAllStmt = db.prepare<SessionRow, Record<string, never>>(`
		SELECT * FROM sessions ORDER BY started_at ASC
	`);

	const countStmt = db.prepare<{ cnt: number }, Record<string, never>>(
		"SELECT COUNT(*) as cnt FROM sessions",
	);

	const getByRunStmt = db.prepare<SessionRow, { $run_id: string }>(`
		SELECT * FROM sessions WHERE run_id = $run_id ORDER BY started_at ASC
	`);

	const updateStateStmt = db.prepare<void, { $agent_name: string; $state: string }>(`
		UPDATE sessions SET state = $state WHERE agent_name = $agent_name
	`);

	const updateLastActivityStmt = db.prepare<void, { $agent_name: string; $last_activity: string }>(`
		UPDATE sessions SET last_activity = $last_activity WHERE agent_name = $agent_name
	`);

	const updateEscalationStmt = db.prepare<
		void,
		{
			$agent_name: string;
			$escalation_level: number;
			$stalled_since: string | null;
		}
	>(`
		UPDATE sessions
		SET escalation_level = $escalation_level, stalled_since = $stalled_since
		WHERE agent_name = $agent_name
	`);

	const removeStmt = db.prepare<void, { $agent_name: string }>(`
		DELETE FROM sessions WHERE agent_name = $agent_name
	`);

	const updateTranscriptPathStmt = db.prepare<
		void,
		{ $agent_name: string; $transcript_path: string }
	>(`
		UPDATE sessions SET transcript_path = $transcript_path WHERE agent_name = $agent_name
	`);

	const getResumableStmt = db.prepare<SessionRow, Record<string, never>>(`
		SELECT * FROM sessions WHERE state != 'completed'
		ORDER BY started_at ASC
	`);

	const updateRuntimeSessionIdStmt = db.prepare<
		void,
		{ $agent_name: string; $runtime_session_id: string | null }
	>(`
		UPDATE sessions SET runtime_session_id = $runtime_session_id WHERE agent_name = $agent_name
	`);

	const updateRateLimitedSinceStmt = db.prepare<
		void,
		{ $agent_name: string; $rate_limited_since: string | null }
	>(`
		UPDATE sessions SET rate_limited_since = $rate_limited_since WHERE agent_name = $agent_name
	`);

	const updateRateLimitResumesAtStmt = db.prepare<
		void,
		{ $agent_name: string; $rate_limit_resumes_at: string | null }
	>(`
		UPDATE sessions SET rate_limit_resumes_at = $rate_limit_resumes_at WHERE agent_name = $agent_name
	`);

	const updateOriginalRuntimeStmt = db.prepare<
		void,
		{ $agent_name: string; $original_runtime: string | null }
	>(`
		UPDATE sessions SET original_runtime = $original_runtime WHERE agent_name = $agent_name
	`);

	const updateStatusLineStmt = db.prepare<
		void,
		{ $agent_name: string; $status_line: string; $last_activity: string }
	>(`
		UPDATE sessions SET status_line = $status_line, last_activity = $last_activity WHERE agent_name = $agent_name
	`);

	return {
		upsert(session: AgentSession): void {
			upsertStmt.run({
				$id: session.id,
				$agent_name: session.agentName,
				$capability: session.capability,
				$runtime: session.runtime ?? "claude",
				$worktree_path: session.worktreePath,
				$branch_name: session.branchName,
				$task_id: session.taskId,
				$tmux_session: session.tmuxSession,
				$state: session.state,
				$pid: session.pid,
				$parent_agent: session.parentAgent,
				$depth: session.depth,
				$run_id: session.runId,
				$started_at: session.startedAt,
				$last_activity: session.lastActivity,
				$escalation_level: session.escalationLevel,
				$stalled_since: session.stalledSince,
				$rate_limited_since: session.rateLimitedSince,
				$runtime_session_id: session.runtimeSessionId ?? null,
				$transcript_path: session.transcriptPath,
				$original_runtime: session.originalRuntime ?? null,
				$status_line: session.statusLine ?? null,
				$prompt_version: session.promptVersion ?? null,
			});
		},

		getByName(agentName: string): AgentSession | null {
			const row = getByNameStmt.get({ $agent_name: agentName });
			return row ? rowToSession(row) : null;
		},

		getActive(): AgentSession[] {
			const rows = getActiveStmt.all({});
			return rows.map(rowToSession);
		},

		getAll(): AgentSession[] {
			const rows = getAllStmt.all({});
			return rows.map(rowToSession);
		},

		count(): number {
			const row = countStmt.get({});
			return row?.cnt ?? 0;
		},

		getByRun(runId: string): AgentSession[] {
			const rows = getByRunStmt.all({ $run_id: runId });
			return rows.map(rowToSession);
		},

		updateState(agentName: string, state: AgentState): void {
			updateStateStmt.run({ $agent_name: agentName, $state: state });
		},

		updateLastActivity(agentName: string): void {
			updateLastActivityStmt.run({
				$agent_name: agentName,
				$last_activity: new Date().toISOString(),
			});
		},

		updateEscalation(agentName: string, level: number, stalledSince: string | null): void {
			updateEscalationStmt.run({
				$agent_name: agentName,
				$escalation_level: level,
				$stalled_since: stalledSince,
			});
		},

		updateTranscriptPath(agentName: string, path: string): void {
			updateTranscriptPathStmt.run({ $agent_name: agentName, $transcript_path: path });
		},

		getResumable(): AgentSession[] {
			const rows = getResumableStmt.all({});
			return rows.map(rowToSession);
		},

		updateRuntimeSessionId(agentName: string, runtimeSessionId: string | null): void {
			updateRuntimeSessionIdStmt.run({
				$agent_name: agentName,
				$runtime_session_id: runtimeSessionId,
			});
		},

		updateRateLimitedSince(agentName: string, rateLimitedSince: string | null): void {
			updateRateLimitedSinceStmt.run({
				$agent_name: agentName,
				$rate_limited_since: rateLimitedSince,
			});
		},

		updateRateLimitResumesAt(agentName: string, resumesAt: string | null): void {
			updateRateLimitResumesAtStmt.run({
				$agent_name: agentName,
				$rate_limit_resumes_at: resumesAt,
			});
		},

		updateOriginalRuntime(agentName: string, originalRuntime: string | null): void {
			updateOriginalRuntimeStmt.run({
				$agent_name: agentName,
				$original_runtime: originalRuntime,
			});
		},

		updateStatusLine(agentName: string, statusLine: string): void {
			updateStatusLineStmt.run({
				$agent_name: agentName,
				$status_line: statusLine,
				$last_activity: new Date().toISOString(),
			});
		},

		remove(agentName: string): void {
			removeStmt.run({ $agent_name: agentName });
		},

		purge(opts: { all?: boolean; state?: AgentState; agent?: string }): number {
			if (opts.all) {
				const countRow = db
					.prepare<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM sessions")
					.get();
				const count = countRow?.cnt ?? 0;
				db.prepare("DELETE FROM sessions").run();
				return count;
			}

			const conditions: string[] = [];
			const params: Record<string, string> = {};

			if (opts.state !== undefined) {
				conditions.push("state = $state");
				params.$state = opts.state;
			}

			if (opts.agent !== undefined) {
				conditions.push("agent_name = $agent");
				params.$agent = opts.agent;
			}

			if (conditions.length === 0) {
				return 0;
			}

			const whereClause = conditions.join(" AND ");
			const countQuery = `SELECT COUNT(*) as cnt FROM sessions WHERE ${whereClause}`;
			const countRow = db.prepare<{ cnt: number }, Record<string, string>>(countQuery).get(params);
			const count = countRow?.cnt ?? 0;

			const deleteQuery = `DELETE FROM sessions WHERE ${whereClause}`;
			db.prepare<void, Record<string, string>>(deleteQuery).run(params);

			return count;
		},

		close(): void {
			try {
				db.exec("PRAGMA wal_checkpoint(PASSIVE)");
			} catch {
				// Best effort -- checkpoint failure is non-fatal
			}
			db.close();
		},
	};
}

/**
 * Create a new RunStore backed by a SQLite database at the given path.
 *
 * Shares the same sessions.db file as SessionStore. Initializes the runs
 * table alongside sessions. Uses WAL mode for concurrent access.
 */
export function createRunStore(dbPath: string): RunStore {
	const db = new Database(dbPath);

	// Configure for concurrent access from multiple agent processes.
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA busy_timeout = 5000");

	// Create schema (idempotent — safe if SessionStore already created these)
	db.exec(CREATE_RUNS_TABLE);

	// Run runs-specific migrations (idempotent — each up() is guarded)
	ensureMigrations(db, RUNS_MIGRATIONS);

	db.exec(CREATE_RUNS_INDEXES);

	// Prepare statements for frequent operations
	const insertRunStmt = db.prepare<
		void,
		{
			$id: string;
			$started_at: string;
			$completed_at: string | null;
			$agent_count: number;
			$coordinator_session_id: string | null;
			$coordinator_name: string | null;
			$status: string;
		}
	>(`
		INSERT INTO runs (id, started_at, completed_at, agent_count, coordinator_session_id, coordinator_name, status)
		VALUES ($id, $started_at, $completed_at, $agent_count, $coordinator_session_id, $coordinator_name, $status)
	`);

	const getRunStmt = db.prepare<RunRow, { $id: string }>(`
		SELECT * FROM runs WHERE id = $id
	`);

	const getActiveRunStmt = db.prepare<RunRow, Record<string, never>>(`
		SELECT * FROM runs WHERE status = 'active'
		ORDER BY started_at DESC
		LIMIT 1
	`);

	const getActiveRunForCoordinatorStmt = db.prepare<RunRow, { $coordinator_name: string }>(`
		SELECT * FROM runs WHERE status = 'active' AND coordinator_name = $coordinator_name
		ORDER BY started_at DESC
		LIMIT 1
	`);

	const incrementAgentCountStmt = db.prepare<void, { $id: string }>(`
		UPDATE runs SET agent_count = agent_count + 1 WHERE id = $id
	`);

	const completeRunStmt = db.prepare<
		void,
		{ $id: string; $status: string; $completed_at: string }
	>(`
		UPDATE runs SET status = $status, completed_at = $completed_at WHERE id = $id
	`);

	const reactivateRunStmt = db.prepare<void, { $id: string }>(`
		UPDATE runs SET status = 'active', completed_at = NULL WHERE id = $id
	`);

	return {
		createRun(run: InsertRun): void {
			insertRunStmt.run({
				$id: run.id,
				$started_at: run.startedAt,
				$completed_at: null,
				$agent_count: run.agentCount ?? 0,
				$coordinator_session_id: run.coordinatorSessionId,
				$coordinator_name: run.coordinatorName ?? null,
				$status: run.status,
			});
		},

		getRun(id: string): Run | null {
			const row = getRunStmt.get({ $id: id });
			return row ? rowToRun(row) : null;
		},

		getActiveRun(): Run | null {
			const row = getActiveRunStmt.get({});
			return row ? rowToRun(row) : null;
		},

		getActiveRunForCoordinator(coordinatorName: string): Run | null {
			const row = getActiveRunForCoordinatorStmt.get({ $coordinator_name: coordinatorName });
			return row ? rowToRun(row) : null;
		},

		listRuns(opts?: { limit?: number; status?: RunStatus }): Run[] {
			const conditions: string[] = [];
			const params: Record<string, string | number> = {};

			if (opts?.status !== undefined) {
				conditions.push("status = $status");
				params.$status = opts.status;
			}

			const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
			const limitClause = opts?.limit !== undefined ? `LIMIT ${opts.limit}` : "";
			const query = `SELECT * FROM runs ${whereClause} ORDER BY started_at DESC ${limitClause}`;

			const rows = db.prepare<RunRow, Record<string, string | number>>(query).all(params);
			return rows.map(rowToRun);
		},

		incrementAgentCount(runId: string): void {
			incrementAgentCountStmt.run({ $id: runId });
		},

		completeRun(runId: string, status: "completed" | "failed" | "stopped"): void {
			completeRunStmt.run({
				$id: runId,
				$status: status,
				$completed_at: new Date().toISOString(),
			});
		},

		reactivateRun(runId: string): void {
			reactivateRunStmt.run({ $id: runId });
		},

		close(): void {
			try {
				db.exec("PRAGMA wal_checkpoint(PASSIVE)");
			} catch {
				// Best effort -- checkpoint failure is non-fatal
			}
			db.close();
		},
	};
}
