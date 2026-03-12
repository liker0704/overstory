/**
 * SQLite-backed mission store for long-running objective tracking.
 *
 * Stores missions in the sessions.db file alongside sessions and runs.
 * WAL mode enables concurrent reads from multiple agent processes.
 */

import { Database } from "bun:sqlite";
import type {
	InsertMission,
	Mission,
	MissionPhase,
	MissionState,
	MissionStore,
	PendingInputKind,
} from "../types.ts";

/** Row shape as stored in SQLite (snake_case columns). */
interface MissionRow {
	id: string;
	slug: string;
	objective: string;
	run_id: string | null;
	state: string;
	phase: string;
	first_freeze_at: string | null;
	pending_user_input: number;
	pending_input_kind: string | null;
	pending_input_thread_id: string | null;
	reopen_count: number;
	artifact_root: string | null;
	paused_workstream_ids: string;
	analyst_session_id: string | null;
	execution_director_session_id: string | null;
	coordinator_session_id: string | null;
	paused_lead_names: string;
	pause_reason: string | null;
	started_at: string | null;
	completed_at: string | null;
	created_at: string;
	updated_at: string;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  objective TEXT NOT NULL,
  run_id TEXT,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK(state IN ('active','frozen','completed','failed','cancelled')),
  phase TEXT NOT NULL DEFAULT 'understand'
    CHECK(phase IN ('understand','align','decide','plan','execute','done')),
  first_freeze_at TEXT,
  pending_user_input INTEGER NOT NULL DEFAULT 0,
  pending_input_kind TEXT CHECK(pending_input_kind IS NULL OR pending_input_kind IN ('question','approval','decision','clarification')),
  pending_input_thread_id TEXT,
  reopen_count INTEGER NOT NULL DEFAULT 0,
  artifact_root TEXT,
  paused_workstream_ids TEXT NOT NULL DEFAULT '[]',
  analyst_session_id TEXT,
  execution_director_session_id TEXT,
  coordinator_session_id TEXT,
  paused_lead_names TEXT NOT NULL DEFAULT '[]',
  pause_reason TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_missions_state ON missions(state);
CREATE INDEX IF NOT EXISTS idx_missions_slug ON missions(slug);
CREATE INDEX IF NOT EXISTS idx_missions_run ON missions(run_id)`;

/** Convert a database row (snake_case) to a Mission object (camelCase). */
function rowToMission(row: MissionRow): Mission {
	return {
		id: row.id,
		slug: row.slug,
		objective: row.objective,
		runId: row.run_id,
		state: row.state as MissionState,
		phase: row.phase as MissionPhase,
		firstFreezeAt: row.first_freeze_at,
		pendingUserInput: row.pending_user_input === 1,
		pendingInputKind: row.pending_input_kind as PendingInputKind | null,
		pendingInputThreadId: row.pending_input_thread_id,
		reopenCount: row.reopen_count,
		artifactRoot: row.artifact_root,
		pausedWorkstreamIds: JSON.parse(row.paused_workstream_ids) as string[],
		analystSessionId: row.analyst_session_id,
		executionDirectorSessionId: row.execution_director_session_id,
		coordinatorSessionId: row.coordinator_session_id,
		pausedLeadNames: JSON.parse(row.paused_lead_names) as string[],
		pauseReason: row.pause_reason,
		startedAt: row.started_at,
		completedAt: row.completed_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/**
 * Create a new MissionStore backed by a SQLite database at the given path.
 *
 * Initializes with WAL mode and a 5-second busy timeout.
 * Creates the missions table and indexes if they do not already exist.
 */
export function createMissionStore(dbPath: string): MissionStore {
	const db = new Database(dbPath);

	// Configure for concurrent access from multiple agent processes.
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA busy_timeout = 5000");

	db.exec(CREATE_TABLE);
	db.exec(CREATE_INDEXES);

	const insertStmt = db.prepare<
		void,
		{
			$id: string;
			$slug: string;
			$objective: string;
			$run_id: string | null;
			$artifact_root: string | null;
			$started_at: string | null;
			$created_at: string;
			$updated_at: string;
		}
	>(`
		INSERT INTO missions
			(id, slug, objective, run_id, artifact_root, started_at, created_at, updated_at)
		VALUES
			($id, $slug, $objective, $run_id, $artifact_root, $started_at, $created_at, $updated_at)
	`);

	const getByIdStmt = db.prepare<MissionRow, { $id: string }>(`
		SELECT * FROM missions WHERE id = $id
	`);

	const getBySlugStmt = db.prepare<MissionRow, { $slug: string }>(`
		SELECT * FROM missions WHERE slug = $slug
	`);

	const getActiveStmt = db.prepare<MissionRow, Record<string, never>>(`
		SELECT * FROM missions WHERE state = 'active' OR state = 'frozen'
		ORDER BY created_at DESC
		LIMIT 1
	`);

	const updateStateStmt = db.prepare<void, { $id: string; $state: string; $updated_at: string }>(`
		UPDATE missions SET state = $state, updated_at = $updated_at WHERE id = $id
	`);

	const updatePhaseStmt = db.prepare<void, { $id: string; $phase: string; $updated_at: string }>(`
		UPDATE missions SET phase = $phase, updated_at = $updated_at WHERE id = $id
	`);

	const freezeStmt = db.prepare<
		void,
		{
			$id: string;
			$kind: string;
			$thread_id: string | null;
			$updated_at: string;
		}
	>(`
		UPDATE missions
		SET state = 'frozen',
		    pending_user_input = 1,
		    pending_input_kind = $kind,
		    pending_input_thread_id = $thread_id,
		    first_freeze_at = COALESCE(first_freeze_at, $updated_at),
		    updated_at = $updated_at
		WHERE id = $id
	`);

	const unfreezeStmt = db.prepare<void, { $id: string; $updated_at: string }>(`
		UPDATE missions
		SET state = 'active',
		    pending_user_input = 0,
		    pending_input_kind = NULL,
		    pending_input_thread_id = NULL,
		    reopen_count = reopen_count + 1,
		    updated_at = $updated_at
		WHERE id = $id
	`);

	const updatePausedWorkstreamsStmt = db.prepare<
		void,
		{ $id: string; $paused_workstream_ids: string; $updated_at: string }
	>(`
		UPDATE missions
		SET paused_workstream_ids = $paused_workstream_ids, updated_at = $updated_at
		WHERE id = $id
	`);

	const updateArtifactRootStmt = db.prepare<
		void,
		{ $id: string; $artifact_root: string; $updated_at: string }
	>(`
		UPDATE missions SET artifact_root = $artifact_root, updated_at = $updated_at WHERE id = $id
	`);

	const bindSessionsStmt = db.prepare<
		void,
		{
			$id: string;
			$analyst_session_id: string | null;
			$execution_director_session_id: string | null;
			$coordinator_session_id: string | null;
			$updated_at: string;
		}
	>(`
		UPDATE missions
		SET analyst_session_id = COALESCE($analyst_session_id, analyst_session_id),
		    execution_director_session_id = COALESCE($execution_director_session_id, execution_director_session_id),
		    coordinator_session_id = COALESCE($coordinator_session_id, coordinator_session_id),
		    updated_at = $updated_at
		WHERE id = $id
	`);

	const bindCoordinatorSessionStmt = db.prepare<
		void,
		{ $id: string; $coordinator_session_id: string; $updated_at: string }
	>(`
		UPDATE missions
		SET coordinator_session_id = $coordinator_session_id, updated_at = $updated_at
		WHERE id = $id
	`);

	const updatePausedLeadsStmt = db.prepare<
		void,
		{ $id: string; $paused_lead_names: string; $updated_at: string }
	>(`
		UPDATE missions
		SET paused_lead_names = $paused_lead_names, updated_at = $updated_at
		WHERE id = $id
	`);

	const updatePauseReasonStmt = db.prepare<
		void,
		{ $id: string; $pause_reason: string | null; $updated_at: string }
	>(`
		UPDATE missions
		SET pause_reason = $pause_reason, updated_at = $updated_at
		WHERE id = $id
	`);

	const startStmt = db.prepare<void, { $id: string; $started_at: string; $updated_at: string }>(`
		UPDATE missions
		SET started_at = COALESCE(started_at, $started_at), updated_at = $updated_at
		WHERE id = $id
	`);

	const completeMissionStmt = db.prepare<
		void,
		{ $id: string; $completed_at: string; $updated_at: string }
	>(`
		UPDATE missions
		SET state = 'completed', completed_at = $completed_at, updated_at = $updated_at
		WHERE id = $id
	`);

	return {
		create(mission: InsertMission): Mission {
			const now = new Date().toISOString();
			insertStmt.run({
				$id: mission.id,
				$slug: mission.slug,
				$objective: mission.objective,
				$run_id: mission.runId ?? null,
				$artifact_root: mission.artifactRoot ?? null,
				$started_at: mission.startedAt ?? null,
				$created_at: now,
				$updated_at: now,
			});
			const row = getByIdStmt.get({ $id: mission.id });
			if (!row) {
				throw new Error(`Mission ${mission.id} not found after insert`);
			}
			return rowToMission(row);
		},

		getById(id: string): Mission | null {
			const row = getByIdStmt.get({ $id: id });
			return row ? rowToMission(row) : null;
		},

		getBySlug(slug: string): Mission | null {
			const row = getBySlugStmt.get({ $slug: slug });
			return row ? rowToMission(row) : null;
		},

		getActive(): Mission | null {
			const row = getActiveStmt.get({});
			return row ? rowToMission(row) : null;
		},

		list(opts?: { state?: MissionState; limit?: number }): Mission[] {
			const hasState = opts?.state !== undefined;
			const hasLimit = opts?.limit !== undefined;

			if (hasState && hasLimit) {
				const rows = db
					.prepare<MissionRow, { $state: string; $limit: number }>(
						`SELECT * FROM missions WHERE state = $state ORDER BY created_at DESC LIMIT $limit`,
					)
					.all({ $state: opts!.state as string, $limit: opts!.limit as number });
				return rows.map(rowToMission);
			}
			if (hasState) {
				const rows = db
					.prepare<MissionRow, { $state: string }>(
						`SELECT * FROM missions WHERE state = $state ORDER BY created_at DESC`,
					)
					.all({ $state: opts!.state as string });
				return rows.map(rowToMission);
			}
			if (hasLimit) {
				const rows = db
					.prepare<MissionRow, { $limit: number }>(
						`SELECT * FROM missions ORDER BY created_at DESC LIMIT $limit`,
					)
					.all({ $limit: opts!.limit as number });
				return rows.map(rowToMission);
			}
			const rows = db
				.prepare<MissionRow, Record<string, never>>(
					`SELECT * FROM missions ORDER BY created_at DESC`,
				)
				.all({});
			return rows.map(rowToMission);
		},

		updateState(id: string, state: MissionState): void {
			updateStateStmt.run({ $id: id, $state: state, $updated_at: new Date().toISOString() });
		},

		updatePhase(id: string, phase: MissionPhase): void {
			updatePhaseStmt.run({ $id: id, $phase: phase, $updated_at: new Date().toISOString() });
		},

		freeze(id: string, kind: PendingInputKind, threadId: string | null): void {
			const now = new Date().toISOString();
			freezeStmt.run({ $id: id, $kind: kind, $thread_id: threadId, $updated_at: now });
		},

		unfreeze(id: string): void {
			unfreezeStmt.run({ $id: id, $updated_at: new Date().toISOString() });
		},

		updatePausedWorkstreams(id: string, ids: string[]): void {
			updatePausedWorkstreamsStmt.run({
				$id: id,
				$paused_workstream_ids: JSON.stringify(ids),
				$updated_at: new Date().toISOString(),
			});
		},

		updateArtifactRoot(id: string, path: string): void {
			updateArtifactRootStmt.run({
				$id: id,
				$artifact_root: path,
				$updated_at: new Date().toISOString(),
			});
		},

		bindSessions(
			id: string,
			sessions: {
				analystSessionId?: string;
				executionDirectorSessionId?: string;
				coordinatorSessionId?: string;
			},
		): void {
			bindSessionsStmt.run({
				$id: id,
				$analyst_session_id: sessions.analystSessionId ?? null,
				$execution_director_session_id: sessions.executionDirectorSessionId ?? null,
				$coordinator_session_id: sessions.coordinatorSessionId ?? null,
				$updated_at: new Date().toISOString(),
			});
		},

		bindCoordinatorSession(id: string, sessionId: string): void {
			bindCoordinatorSessionStmt.run({
				$id: id,
				$coordinator_session_id: sessionId,
				$updated_at: new Date().toISOString(),
			});
		},

		updatePausedLeads(id: string, names: string[]): void {
			updatePausedLeadsStmt.run({
				$id: id,
				$paused_lead_names: JSON.stringify(names),
				$updated_at: new Date().toISOString(),
			});
		},

		updatePauseReason(id: string, reason: string | null): void {
			updatePauseReasonStmt.run({
				$id: id,
				$pause_reason: reason,
				$updated_at: new Date().toISOString(),
			});
		},

		start(id: string): void {
			const now = new Date().toISOString();
			startStmt.run({ $id: id, $started_at: now, $updated_at: now });
		},

		completeMission(id: string): void {
			const now = new Date().toISOString();
			completeMissionStmt.run({ $id: id, $completed_at: now, $updated_at: now });
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
