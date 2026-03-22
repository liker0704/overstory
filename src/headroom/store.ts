import { Database } from "bun:sqlite";
import { ensureMigrations, type Migration } from "../db/migrate.ts";
import type { HeadroomSnapshot, HeadroomState, HeadroomStore } from "./types.ts";

const VALID_STATES: readonly HeadroomState[] = ["exact", "estimated", "unavailable"];

/** Row shape as stored in SQLite (snake_case columns). */
interface SnapshotRow {
	runtime: string;
	state: string;
	captured_at: string;
	requests_remaining: number | null;
	requests_limit: number | null;
	tokens_remaining: number | null;
	tokens_limit: number | null;
	window_resets_at: string | null;
	message: string;
}

function rowToSnapshot(row: SnapshotRow): HeadroomSnapshot {
	return {
		runtime: row.runtime,
		state: row.state as HeadroomState,
		capturedAt: row.captured_at,
		requestsRemaining: row.requests_remaining,
		requestsLimit: row.requests_limit,
		tokensRemaining: row.tokens_remaining,
		tokensLimit: row.tokens_limit,
		windowResetsAt: row.window_resets_at,
		message: row.message,
	};
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS headroom_snapshots (
  runtime TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('exact', 'estimated', 'unavailable')),
  captured_at TEXT NOT NULL,
  requests_remaining INTEGER,
  requests_limit INTEGER,
  tokens_remaining INTEGER,
  tokens_limit INTEGER,
  window_resets_at TEXT,
  message TEXT NOT NULL DEFAULT ''
)`;

const MIGRATIONS: Migration[] = [
	{
		version: 1,
		description: "initial headroom snapshots schema",
		up: (db) => {
			db.exec(CREATE_TABLE);
		},
		detect: (_db, columns) => columns.has("runtime") && columns.has("state"),
	},
];

export function createHeadroomStore(dbPath: string): HeadroomStore {
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA busy_timeout=5000");

	ensureMigrations(db, MIGRATIONS);

	const upsertStmt = db.prepare<
		void,
		{
			$runtime: string;
			$state: string;
			$captured_at: string;
			$requests_remaining: number | null;
			$requests_limit: number | null;
			$tokens_remaining: number | null;
			$tokens_limit: number | null;
			$window_resets_at: string | null;
			$message: string;
		}
	>(`
		INSERT OR REPLACE INTO headroom_snapshots
			(runtime, state, captured_at, requests_remaining, requests_limit,
			 tokens_remaining, tokens_limit, window_resets_at, message)
		VALUES
			($runtime, $state, $captured_at, $requests_remaining, $requests_limit,
			 $tokens_remaining, $tokens_limit, $window_resets_at, $message)
	`);

	const getStmt = db.prepare<SnapshotRow, { $runtime: string }>(
		"SELECT * FROM headroom_snapshots WHERE runtime = $runtime",
	);

	const getAllStmt = db.prepare<SnapshotRow, []>(
		"SELECT * FROM headroom_snapshots ORDER BY captured_at DESC",
	);

	const pruneStmt = db.prepare<{ runtime: string }, [string]>(
		"DELETE FROM headroom_snapshots WHERE captured_at < ? RETURNING runtime",
	);

	return {
		upsert(snapshot: HeadroomSnapshot): void {
			if (!VALID_STATES.includes(snapshot.state)) {
				throw new Error(`Invalid HeadroomState: ${snapshot.state}`);
			}
			upsertStmt.run({
				$runtime: snapshot.runtime,
				$state: snapshot.state,
				$captured_at: snapshot.capturedAt,
				$requests_remaining: snapshot.requestsRemaining,
				$requests_limit: snapshot.requestsLimit,
				$tokens_remaining: snapshot.tokensRemaining,
				$tokens_limit: snapshot.tokensLimit,
				$window_resets_at: snapshot.windowResetsAt,
				$message: snapshot.message,
			});
		},

		get(runtime: string): HeadroomSnapshot | null {
			const row = getStmt.get({ $runtime: runtime });
			return row ? rowToSnapshot(row) : null;
		},

		getAll(): HeadroomSnapshot[] {
			return getAllStmt.all().map(rowToSnapshot);
		},

		pruneOlderThan(cutoff: string): number {
			return pruneStmt.all(cutoff).length;
		},

		close(): void {
			try {
				db.exec("PRAGMA wal_checkpoint(PASSIVE)");
			} catch {
				// Best effort — checkpoint failure is non-fatal
			}
			db.close();
		},
	};
}
