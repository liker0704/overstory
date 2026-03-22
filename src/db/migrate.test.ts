import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyMigrations,
	bootstrapSchemaVersion,
	getColumns,
	getSchemaVersion,
	hasColumn,
	type Migration,
	rebuildTable,
	setSchemaVersion,
} from "./migrate.ts";

describe("getSchemaVersion / setSchemaVersion", () => {
	test("returns 0 for a fresh database", () => {
		const db = new Database(":memory:");
		expect(getSchemaVersion(db)).toBe(0);
		db.close();
	});

	test("round-trips a version number", () => {
		const db = new Database(":memory:");
		setSchemaVersion(db, 5);
		expect(getSchemaVersion(db)).toBe(5);
		db.close();
	});
});

describe("hasColumn", () => {
	test("returns true for existing column", () => {
		const db = new Database(":memory:");
		db.exec("CREATE TABLE t (id INTEGER, name TEXT)");
		expect(hasColumn(db, "t", "id")).toBe(true);
		expect(hasColumn(db, "t", "name")).toBe(true);
		db.close();
	});

	test("returns false for missing column", () => {
		const db = new Database(":memory:");
		db.exec("CREATE TABLE t (id INTEGER)");
		expect(hasColumn(db, "t", "missing")).toBe(false);
		db.close();
	});
});

describe("getColumns", () => {
	test("returns all column names as a Set", () => {
		const db = new Database(":memory:");
		db.exec("CREATE TABLE t (id INTEGER, name TEXT, value REAL)");
		const cols = getColumns(db, "t");
		expect(cols).toEqual(new Set(["id", "name", "value"]));
		db.close();
	});
});

describe("rebuildTable", () => {
	test("rebuilds table with new CHECK constraint", () => {
		const db = new Database(":memory:");
		db.exec("CREATE TABLE items (id TEXT PRIMARY KEY, status TEXT CHECK(status IN ('a','b')))");
		db.exec("INSERT INTO items VALUES ('1', 'a')");

		rebuildTable({
			db,
			table: "items",
			createSql:
				"CREATE TABLE items (id TEXT PRIMARY KEY, status TEXT CHECK(status IN ('a','b','c')))",
			columns: ["id", "status"],
		});

		// Can now insert 'c'
		db.exec("INSERT INTO items VALUES ('2', 'c')");
		const rows = db.prepare("SELECT * FROM items ORDER BY id").all() as Array<{
			id: string;
			status: string;
		}>;
		expect(rows).toHaveLength(2);
		expect(rows[0]?.status).toBe("a");
		expect(rows[1]?.status).toBe("c");
		db.close();
	});

	test("applies selectExprs for CASE mappings", () => {
		const db = new Database(":memory:");
		db.exec("CREATE TABLE t (id TEXT, val TEXT)");
		db.exec("INSERT INTO t VALUES ('1', 'old')");

		rebuildTable({
			db,
			table: "t",
			createSql: "CREATE TABLE t (id TEXT, val TEXT)",
			columns: ["id", "val"],
			selectExprs: {
				val: "CASE WHEN val = 'old' THEN 'new' ELSE val END",
			},
		});

		const row = db.prepare("SELECT val FROM t WHERE id = '1'").get() as { val: string };
		expect(row.val).toBe("new");
		db.close();
	});
});

describe("applyMigrations", () => {
	const migrations: Migration[] = [
		{
			version: 1,
			description: "add name column",
			up: (db) => db.exec("ALTER TABLE t ADD COLUMN name TEXT"),
		},
		{
			version: 2,
			description: "add email column",
			up: (db) => db.exec("ALTER TABLE t ADD COLUMN email TEXT"),
		},
		{
			version: 3,
			description: "add phone column",
			up: (db) => db.exec("ALTER TABLE t ADD COLUMN phone TEXT"),
		},
	];

	test("runs only migrations above current version", () => {
		const db = new Database(":memory:");
		db.exec("CREATE TABLE t (id INTEGER)");
		// Simulate already at version 1
		setSchemaVersion(db, 1);
		db.exec("ALTER TABLE t ADD COLUMN name TEXT");

		applyMigrations(db, migrations);

		expect(getSchemaVersion(db)).toBe(3);
		expect(hasColumn(db, "t", "email")).toBe(true);
		expect(hasColumn(db, "t", "phone")).toBe(true);
		db.close();
	});

	test("runs all migrations from version 0", () => {
		const db = new Database(":memory:");
		db.exec("CREATE TABLE t (id INTEGER)");

		applyMigrations(db, migrations);

		expect(getSchemaVersion(db)).toBe(3);
		expect(hasColumn(db, "t", "name")).toBe(true);
		expect(hasColumn(db, "t", "email")).toBe(true);
		expect(hasColumn(db, "t", "phone")).toBe(true);
		db.close();
	});

	test("idempotent: running twice is a no-op", () => {
		const db = new Database(":memory:");
		db.exec("CREATE TABLE t (id INTEGER)");

		applyMigrations(db, migrations);
		// Second call should do nothing
		applyMigrations(db, migrations);

		expect(getSchemaVersion(db)).toBe(3);
		db.close();
	});

	test("no-op when no pending migrations", () => {
		const db = new Database(":memory:");
		db.exec("CREATE TABLE t (id INTEGER)");
		setSchemaVersion(db, 3);

		applyMigrations(db, migrations);
		expect(getSchemaVersion(db)).toBe(3);
		db.close();
	});

	test("rolls back on migration failure", () => {
		const db = new Database(":memory:");
		db.exec("CREATE TABLE t (id INTEGER)");

		const badMigrations: Migration[] = [
			{
				version: 1,
				description: "add column",
				up: (db) => db.exec("ALTER TABLE t ADD COLUMN name TEXT"),
			},
			{
				version: 2,
				description: "fail",
				up: () => {
					throw new Error("migration failed");
				},
			},
		];

		expect(() => applyMigrations(db, badMigrations)).toThrow("migration failed");
		// Version should be 0 since the transaction was rolled back
		expect(getSchemaVersion(db)).toBe(0);
		db.close();
	});
});

describe("bootstrapSchemaVersion", () => {
	const migrations: Migration[] = [
		{
			version: 1,
			description: "initial schema",
			up: () => {},
			detect: (_db, cols) => cols.has("id") && cols.has("name"),
		},
		{
			version: 2,
			description: "add email",
			up: (db) => db.exec("ALTER TABLE t ADD COLUMN email TEXT"),
			detect: (_db, cols) => cols.has("email"),
		},
		{
			version: 3,
			description: "add phone",
			up: (db) => db.exec("ALTER TABLE t ADD COLUMN phone TEXT"),
			detect: (_db, cols) => cols.has("phone"),
		},
	];

	test("sets version for fully-migrated DB at version 0", () => {
		const db = new Database(":memory:");
		db.exec("CREATE TABLE t (id INTEGER, name TEXT, email TEXT, phone TEXT)");

		bootstrapSchemaVersion(db, "t", migrations);
		expect(getSchemaVersion(db)).toBe(3);
		db.close();
	});

	test("sets version for partially-migrated DB at version 0", () => {
		const db = new Database(":memory:");
		db.exec("CREATE TABLE t (id INTEGER, name TEXT, email TEXT)");

		bootstrapSchemaVersion(db, "t", migrations);
		expect(getSchemaVersion(db)).toBe(2);
		db.close();
	});

	test("skips when version is already set", () => {
		const db = new Database(":memory:");
		db.exec("CREATE TABLE t (id INTEGER, name TEXT)");
		setSchemaVersion(db, 1);

		bootstrapSchemaVersion(db, "t", migrations);
		// Should not change
		expect(getSchemaVersion(db)).toBe(1);
		db.close();
	});

	test("no-op when table does not exist", () => {
		const db = new Database(":memory:");
		bootstrapSchemaVersion(db, "nonexistent", migrations);
		expect(getSchemaVersion(db)).toBe(0);
		db.close();
	});

	test("stops at first non-detected migration", () => {
		const db = new Database(":memory:");
		// Has id and name (v1) but not email (v2) or phone (v3)
		db.exec("CREATE TABLE t (id INTEGER, name TEXT, phone TEXT)");

		bootstrapSchemaVersion(db, "t", migrations);
		// Should stop at v1 because v2 (email) is not detected
		expect(getSchemaVersion(db)).toBe(1);
		db.close();
	});

	test("constraint-based detection", () => {
		const db = new Database(":memory:");
		db.exec(
			"CREATE TABLE t (id TEXT, state TEXT CHECK(state IN ('active','stopped','suspended')))",
		);

		const constraintMigrations: Migration[] = [
			{
				version: 1,
				description: "initial",
				up: () => {},
				detect: (_db, cols) => cols.has("id"),
			},
			{
				version: 2,
				description: "add stopped+suspended states",
				up: () => {},
				detect: (db) => {
					const result = db
						.prepare<{ sql: string }, []>(
							"SELECT sql FROM sqlite_master WHERE type='table' AND name='t'",
						)
						.get();
					return !!result && result.sql.includes("'stopped'") && result.sql.includes("'suspended'");
				},
			},
		];

		bootstrapSchemaVersion(db, "t", constraintMigrations);
		expect(getSchemaVersion(db)).toBe(2);
		db.close();
	});
});

describe("concurrent access", () => {
	let tmpDir: string;

	afterEach(async () => {
		if (tmpDir) {
			await rm(tmpDir, { recursive: true, force: true });
		}
	});

	test("busy_timeout handles migration lock", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "migrate-test-"));
		const dbPath = join(tmpDir, "test.db");

		// Create database with initial table
		const setup = new Database(dbPath);
		setup.exec("PRAGMA journal_mode = WAL");
		setup.exec("PRAGMA busy_timeout = 5000");
		setup.exec("CREATE TABLE t (id INTEGER)");
		setup.close();

		const migrationsA: Migration[] = [
			{
				version: 1,
				description: "add col_a",
				up: (db) => db.exec("ALTER TABLE t ADD COLUMN col_a TEXT"),
			},
		];

		// Open two connections, both with busy_timeout
		const dbA = new Database(dbPath);
		dbA.exec("PRAGMA journal_mode = WAL");
		dbA.exec("PRAGMA busy_timeout = 5000");

		const dbB = new Database(dbPath);
		dbB.exec("PRAGMA journal_mode = WAL");
		dbB.exec("PRAGMA busy_timeout = 5000");

		// Run migration on connection A
		applyMigrations(dbA, migrationsA);

		// Connection B should see the migration result
		expect(getSchemaVersion(dbB)).toBe(1);
		expect(hasColumn(dbB, "t", "col_a")).toBe(true);

		dbA.close();
		dbB.close();
	});
});
