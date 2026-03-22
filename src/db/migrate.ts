/**
 * Unified schema migration framework for all SQLite stores.
 *
 * Uses PRAGMA user_version to track the current schema version.
 * Each store defines a Migration[] array; applyMigrations runs only
 * the migrations above the current version. bootstrapSchemaVersion
 * handles existing databases that were migrated before versioning.
 */

import type { Database } from "bun:sqlite";

export interface Migration {
	version: number;
	description: string;
	up: (db: Database) => void;
	/** Check if this migration's changes already exist (for bootstrapping unversioned DBs). */
	detect?: (db: Database, columns: Set<string>) => boolean;
}

export interface RebuildOpts {
	db: Database;
	table: string;
	createSql: string;
	columns: string[];
	/** Optional per-column SELECT expressions (for CASE mappings). Defaults to column name. */
	selectExprs?: Record<string, string>;
}

/** Get the current schema version from PRAGMA user_version. */
export function getSchemaVersion(db: Database): number {
	const row = db.prepare<{ user_version: number }, []>("PRAGMA user_version").get();
	return row?.user_version ?? 0;
}

/** Set the schema version via PRAGMA user_version. */
export function setSchemaVersion(db: Database, version: number): void {
	db.exec(`PRAGMA user_version = ${version}`);
}

/** Check if a column exists in a table. Replaces repeated PRAGMA table_info patterns. */
export function hasColumn(db: Database, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	return rows.some((r) => r.name === column);
}

/** Get all column names for a table as a Set. */
export function getColumns(db: Database, table: string): Set<string> {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	return new Set(rows.map((r) => r.name));
}

/**
 * Rebuild a table using the rename-create-insert-drop pattern.
 *
 * Encapsulates the ALTER-RENAME + CREATE + INSERT...SELECT + DROP pattern
 * required when SQLite CHECK constraints or column definitions must change.
 */
export function rebuildTable(opts: RebuildOpts): void {
	const { db, table, createSql, columns, selectExprs } = opts;
	const tmpTable = `${table}_migrate_tmp`;

	// Build column lists
	const insertCols = columns.join(", ");
	const selectCols = columns.map((col) => selectExprs?.[col] ?? col).join(", ");

	db.exec(`ALTER TABLE ${table} RENAME TO ${tmpTable}`);
	db.exec(createSql);
	db.exec(`INSERT INTO ${table} (${insertCols}) SELECT ${selectCols} FROM ${tmpTable}`);
	db.exec(`DROP TABLE ${tmpTable}`);
}

/**
 * Bootstrap schema version for existing databases that were migrated
 * before user_version tracking was introduced.
 *
 * Detects the actual schema state via each migration's detect callback
 * and sets user_version to the highest detected version without re-running
 * migrations.
 */
export function bootstrapSchemaVersion(db: Database, table: string, migrations: Migration[]): void {
	const currentVersion = getSchemaVersion(db);
	if (currentVersion > 0) return; // already versioned

	// Check if the table exists at all
	const tableExists = db
		.prepare<{ name: string }, []>(
			`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`,
		)
		.get();
	if (!tableExists) return; // no table, nothing to bootstrap

	const columns = getColumns(db, table);

	// Find highest migration whose schema is already present
	let detectedVersion = 0;
	for (const m of migrations) {
		if (m.detect?.(db, columns)) {
			detectedVersion = m.version;
		} else {
			break;
		}
	}

	if (detectedVersion > 0) {
		setSchemaVersion(db, detectedVersion);
	}
}

/**
 * Apply pending migrations above the current schema version.
 *
 * Wraps the entire run in BEGIN IMMEDIATE to hold an exclusive lock for
 * minimum duration. Sets user_version after each successful migration
 * so a crash mid-run leaves version at the last completed step.
 */
export function applyMigrations(db: Database, migrations: Migration[]): void {
	const currentVersion = getSchemaVersion(db);

	const pending = migrations.filter((m) => m.version > currentVersion);
	if (pending.length === 0) return;

	db.exec("BEGIN IMMEDIATE");
	try {
		for (const m of pending) {
			m.up(db);
			// Set version inside transaction so it's atomic with the DDL
			db.exec(`PRAGMA user_version = ${m.version}`);
		}
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

/**
 * Run all migration up() functions unconditionally and set version to latest.
 *
 * Use this instead of applyMigrations when all up() functions are idempotent
 * (guarded by hasColumn / constraint checks). This handles edge cases where
 * user_version is stale relative to actual schema state (e.g., table was
 * externally recreated with an older schema).
 */
export function ensureMigrations(db: Database, migrations: Migration[]): void {
	if (migrations.length === 0) return;

	const lastVersion = migrations[migrations.length - 1]?.version ?? 0;
	const currentVersion = getSchemaVersion(db);

	// Fast path: version matches and no work needed
	if (currentVersion >= lastVersion) {
		// Still run up() functions as safety net (they're idempotent)
		for (const m of migrations) {
			m.up(db);
		}
		return;
	}

	db.exec("BEGIN IMMEDIATE");
	try {
		for (const m of migrations) {
			m.up(db);
		}
		db.exec(`PRAGMA user_version = ${lastVersion}`);
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}
