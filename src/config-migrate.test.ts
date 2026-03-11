import { describe, expect, test } from "bun:test";
import { detectConfigVersion, migrateToLatest } from "./config-migrate.ts";
import { ValidationError } from "./errors.ts";

describe("detectConfigVersion", () => {
	test("returns 1 when version field is absent (legacy config)", () => {
		expect(detectConfigVersion({})).toBe(1);
		expect(detectConfigVersion({ project: { canonicalBranch: "main" } })).toBe(1);
	});

	test("returns 1 when version: 1 is explicit", () => {
		expect(detectConfigVersion({ version: 1 })).toBe(1);
	});

	test("returns 2 when version: 2", () => {
		expect(detectConfigVersion({ version: 2 })).toBe(2);
	});

	test("throws ValidationError for unsupported version number", () => {
		expect(() => detectConfigVersion({ version: 99 })).toThrow(ValidationError);
		expect(() => detectConfigVersion({ version: 0 })).toThrow(ValidationError);
		expect(() => detectConfigVersion({ version: 3 })).toThrow(ValidationError);
	});

	test("throws ValidationError when version is not an integer", () => {
		expect(() => detectConfigVersion({ version: 1.5 })).toThrow(ValidationError);
		expect(() => detectConfigVersion({ version: "2" })).toThrow(ValidationError);
		expect(() => detectConfigVersion({ version: true })).toThrow(ValidationError);
	});

	test("error message mentions the unsupported version number", () => {
		const err = (() => {
			try {
				detectConfigVersion({ version: 42 });
			} catch (e) {
				return e;
			}
		})();
		expect(err).toBeInstanceOf(ValidationError);
		expect((err as ValidationError).message).toContain("42");
	});

	test("treats null version as legacy (v1)", () => {
		expect(detectConfigVersion({ version: null })).toBe(1);
	});
});

describe("migrateToLatest", () => {
	test("returns original object unchanged when already at current version", () => {
		const raw = { version: 2, project: { canonicalBranch: "main" } };
		const result = migrateToLatest(raw, 2);
		expect(result.appliedMigration).toBe(false);
		expect(result.fromVersion).toBe(2);
		expect(result.migrated).toStrictEqual(raw);
	});

	test("upgrades v1 to v2 by adding version field", () => {
		const raw = { project: { canonicalBranch: "main" } };
		const result = migrateToLatest(raw, 1);
		expect(result.appliedMigration).toBe(true);
		expect(result.fromVersion).toBe(1);
		expect(result.migrated.version).toBe(2);
	});

	test("does not mutate the original raw object", () => {
		const raw = { project: { canonicalBranch: "main" } };
		const before = { ...raw };
		migrateToLatest(raw, 1);
		expect(raw).toStrictEqual(before);
	});

	test("migration preserves existing config fields", () => {
		const raw = {
			project: { canonicalBranch: "develop" },
			agents: { maxConcurrent: 10 },
		};
		const result = migrateToLatest(raw, 1);
		expect(result.migrated.project).toStrictEqual({ canonicalBranch: "develop" });
		expect(result.migrated.agents).toStrictEqual({ maxConcurrent: 10 });
	});
});
