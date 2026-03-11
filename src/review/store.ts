/**
 * SQLite-backed store for review records and staleness state.
 *
 * Mirrors the pattern from src/sessions/store.ts:
 * - WAL mode + busy_timeout for concurrent agent access
 * - Internal snake_case row types with camelCase converters
 * - JSON fields (dimensions, notes) stored as strings, parsed on read
 */

import { Database } from "bun:sqlite";
import type {
	DimensionScore,
	InsertReviewRecord,
	ReviewRecord,
	ReviewSubjectType,
	ReviewSummary,
	StalenessState,
} from "./types.ts";

export interface ReviewStore {
	insert(record: InsertReviewRecord): ReviewRecord;
	getById(id: string): ReviewRecord | null;
	getByType(subjectType: ReviewSubjectType, opts?: { limit?: number }): ReviewRecord[];
	getLatest(subjectType: ReviewSubjectType, subjectId: string): ReviewRecord | null;
	getStale(): ReviewRecord[];
	markStale(subjectType: ReviewSubjectType, reason: string): number;
	markStaleById(id: string, reason: string): void;
	getSummary(subjectType: ReviewSubjectType, opts?: { limit?: number }): ReviewSummary;
	saveStalenessState(state: StalenessState): void;
	loadStalenessState(): StalenessState | null;
	close(): void;
}
// === Internal row types (SQLite snake_case columns) ===

interface ReviewRow {
	id: string;
	subject_type: string;
	subject_id: string;
	timestamp: string;
	dimensions: string;
	overall_score: number;
	notes: string;
	reviewer_source: string;
	stale: number;
	stale_since: string | null;
	stale_reason: string | null;
}

interface StalenessStateRow {
	file_path: string;
	content_hash: string;
	captured_at: string;
}

// === Row converter ===

function rowToReview(row: ReviewRow): ReviewRecord {
	return {
		id: row.id,
		subjectType: row.subject_type as ReviewSubjectType,
		subjectId: row.subject_id,
		timestamp: row.timestamp,
		dimensions: JSON.parse(row.dimensions) as DimensionScore[],
		overallScore: row.overall_score,
		notes: JSON.parse(row.notes) as string[],
		reviewerSource: row.reviewer_source as "deterministic",
		stale: row.stale === 1,
		staleSince: row.stale_since,
		staleReason: row.stale_reason,
	};
}

// === Schema ===

const CREATE_REVIEWS_TABLE = `
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('session','handoff','spec')),
  subject_id TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
  dimensions TEXT NOT NULL,
  overall_score INTEGER NOT NULL,
  notes TEXT NOT NULL,
  reviewer_source TEXT NOT NULL DEFAULT 'deterministic',
  stale INTEGER NOT NULL DEFAULT 0,
  stale_since TEXT,
  stale_reason TEXT
)`;

const CREATE_STALENESS_TABLE = `
CREATE TABLE IF NOT EXISTS staleness_state (
  file_path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))
)`;

// === Factory ===

/**
 * Create a ReviewStore backed by a SQLite database at the given path.
 *
 * Uses WAL mode and a 5-second busy timeout for concurrent agent access.
 * Pass ":memory:" for ephemeral (test) databases.
 */
export function createReviewStore(dbPath: string): ReviewStore {
	const db = new Database(dbPath);

	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA busy_timeout=5000");

	db.exec(CREATE_REVIEWS_TABLE);
	db.exec(CREATE_STALENESS_TABLE);

	// Indexes — created after tables
	db.exec("CREATE INDEX IF NOT EXISTS idx_reviews_subject ON reviews(subject_type, subject_id)");
	db.exec("CREATE INDEX IF NOT EXISTS idx_reviews_type_time ON reviews(subject_type, timestamp)");
	db.exec("CREATE INDEX IF NOT EXISTS idx_reviews_stale ON reviews(stale) WHERE stale=1");

	// Prepared statements for frequent operations
	const insertStmt = db.prepare<
		void,
		{
			$id: string;
			$subject_type: string;
			$subject_id: string;
			$timestamp: string;
			$dimensions: string;
			$overall_score: number;
			$notes: string;
			$reviewer_source: string;
		}
	>(`
		INSERT INTO reviews
			(id, subject_type, subject_id, timestamp, dimensions, overall_score, notes, reviewer_source)
		VALUES
			($id, $subject_type, $subject_id, $timestamp, $dimensions, $overall_score, $notes, $reviewer_source)
	`);

	const getByIdStmt = db.prepare<ReviewRow, { $id: string }>(`
		SELECT * FROM reviews WHERE id = $id
	`);

	const getStaleStmt = db.prepare<ReviewRow, Record<string, never>>(`
		SELECT * FROM reviews WHERE stale = 1 ORDER BY timestamp DESC
	`);

	const markStaleByIdStmt = db.prepare<
		void,
		{ $id: string; $stale_since: string; $stale_reason: string }
	>(`
		UPDATE reviews
		SET stale = 1, stale_since = $stale_since, stale_reason = $stale_reason
		WHERE id = $id
	`);

	const insertStalenessRowStmt = db.prepare<
		void,
		{ $file_path: string; $content_hash: string; $captured_at: string }
	>(`
		INSERT INTO staleness_state (file_path, content_hash, captured_at)
		VALUES ($file_path, $content_hash, $captured_at)
	`);

	const loadStalenessStmt = db.prepare<StalenessStateRow, Record<string, never>>(
		"SELECT * FROM staleness_state",
	);

	return {
		insert(record: InsertReviewRecord): ReviewRecord {
			const id = crypto.randomUUID();
			const timestamp = new Date().toISOString();
			insertStmt.run({
				$id: id,
				$subject_type: record.subjectType,
				$subject_id: record.subjectId,
				$timestamp: timestamp,
				$dimensions: JSON.stringify(record.dimensions),
				$overall_score: record.overallScore,
				$notes: JSON.stringify(record.notes),
				$reviewer_source: record.reviewerSource,
			});
			return {
				id,
				subjectType: record.subjectType,
				subjectId: record.subjectId,
				timestamp,
				dimensions: record.dimensions,
				overallScore: record.overallScore,
				notes: record.notes,
				reviewerSource: record.reviewerSource,
				stale: false,
				staleSince: null,
				staleReason: null,
			};
		},

		getById(id: string): ReviewRecord | null {
			const row = getByIdStmt.get({ $id: id });
			return row ? rowToReview(row) : null;
		},

		getByType(subjectType: ReviewSubjectType, opts?: { limit?: number }): ReviewRecord[] {
			const limitClause = opts?.limit !== undefined ? `LIMIT ${opts.limit}` : "";
			const rows = db
				.prepare<ReviewRow, { $subject_type: string }>(
					`SELECT * FROM reviews WHERE subject_type = $subject_type ORDER BY timestamp DESC ${limitClause}`,
				)
				.all({ $subject_type: subjectType });
			return rows.map(rowToReview);
		},

		getLatest(subjectType: ReviewSubjectType, subjectId: string): ReviewRecord | null {
			const row = db
				.prepare<ReviewRow, { $subject_type: string; $subject_id: string }>(`
					SELECT * FROM reviews
					WHERE subject_type = $subject_type AND subject_id = $subject_id
					ORDER BY timestamp DESC LIMIT 1
				`)
				.get({ $subject_type: subjectType, $subject_id: subjectId });
			return row ? rowToReview(row) : null;
		},

		getStale(): ReviewRecord[] {
			return getStaleStmt.all({}).map(rowToReview);
		},

		markStale(subjectType: ReviewSubjectType, reason: string): number {
			const staleSince = new Date().toISOString();
			const result = db
				.prepare<void, { $subject_type: string; $stale_since: string; $stale_reason: string }>(`
					UPDATE reviews
					SET stale = 1, stale_since = $stale_since, stale_reason = $stale_reason
					WHERE subject_type = $subject_type AND stale = 0
				`)
				.run({ $subject_type: subjectType, $stale_since: staleSince, $stale_reason: reason });
			return result.changes;
		},

		markStaleById(id: string, reason: string): void {
			markStaleByIdStmt.run({
				$id: id,
				$stale_since: new Date().toISOString(),
				$stale_reason: reason,
			});
		},

		getSummary(subjectType: ReviewSubjectType, opts?: { limit?: number }): ReviewSummary {
			const agg = db
				.prepare<
					{ total: number; avg_score: number | null; stale_count: number },
					{ $subject_type: string }
				>(`
					SELECT
						COUNT(*) as total,
						AVG(overall_score) as avg_score,
						SUM(stale) as stale_count
					FROM reviews
					WHERE subject_type = $subject_type
				`)
				.get({ $subject_type: subjectType });

			const limit = opts?.limit ?? 10;
			const recentReviews = db
				.prepare<ReviewRow, { $subject_type: string }>(
					`SELECT * FROM reviews WHERE subject_type = $subject_type ORDER BY timestamp DESC LIMIT ${limit}`,
				)
				.all({ $subject_type: subjectType })
				.map(rowToReview);

			return {
				subjectType,
				totalReviewed: agg?.total ?? 0,
				averageScore: agg?.avg_score ?? 0,
				staleCount: agg?.stale_count ?? 0,
				recentReviews,
			};
		},

		saveStalenessState(state: StalenessState): void {
			db.exec("DELETE FROM staleness_state");
			for (const [filePath, hash] of Object.entries(state.fileHashes)) {
				insertStalenessRowStmt.run({
					$file_path: filePath,
					$content_hash: hash,
					$captured_at: state.capturedAt,
				});
			}
		},

		loadStalenessState(): StalenessState | null {
			const rows = loadStalenessStmt.all({});
			if (rows.length === 0) return null;

			const fileHashes: Record<string, string> = {};
			let capturedAt = "";
			for (const row of rows) {
				fileHashes[row.file_path] = row.content_hash;
				capturedAt = row.captured_at;
			}
			return { fileHashes, capturedAt };
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
