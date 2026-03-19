import { type ConfigVersion, CURRENT_CONFIG_VERSION, SUPPORTED_VERSIONS } from "./config-schema.ts";
import { ValidationError } from "./errors.ts";

/**
 * Detect the config version from a raw parsed YAML object.
 *
 * - No `version` field → treat as v1 (legacy, no explicit version).
 * - `version: 1` → v1.
 * - `version: 2` → v2.
 * - Any other value → ValidationError.
 */
export function detectConfigVersion(raw: Record<string, unknown>): ConfigVersion {
	const version = raw.version;

	if (version === undefined || version === null) {
		return 1; // Legacy config without version field
	}

	if (typeof version !== "number" || !Number.isInteger(version)) {
		throw new ValidationError(
			`config.version must be an integer. Got: ${JSON.stringify(version)}`,
			{ field: "version", value: version },
		);
	}

	if (!(SUPPORTED_VERSIONS as readonly number[]).includes(version)) {
		throw new ValidationError(
			`Unsupported config version ${version}. Supported versions: ${SUPPORTED_VERSIONS.join(", ")}`,
			{ field: "version", value: version },
		);
	}

	return version as ConfigVersion;
}

/**
 * Result of migrateToLatest.
 */
export interface MigrationResult {
	/** The migrated raw config object, ready to be merged with defaults. */
	migrated: Record<string, unknown>;
	/** True when the config was upgraded from an older version. */
	appliedMigration: boolean;
	/** Original version before migration. */
	fromVersion: ConfigVersion;
}

/**
 * Migrate a raw parsed config object from its detected version to the latest format.
 *
 * Migration is deterministic: given the same input at version N, the output is always the same
 * v-latest shape. Each version step applies its own transformation.
 *
 * Currently supported migrations:
 *   v1 → v2: sets `version: 2` (structural shape is identical; version field is the only change).
 */
export function migrateToLatest(
	raw: Record<string, unknown>,
	fromVersion: ConfigVersion,
): MigrationResult {
	if (fromVersion === CURRENT_CONFIG_VERSION) {
		return { migrated: raw, appliedMigration: false, fromVersion };
	}

	let current: Record<string, unknown> = { ...raw };

	// v1 → v2: add explicit version field. No structural changes needed.
	if (fromVersion < 2) {
		current = { ...current, version: 2 };
	}

	return { migrated: current, appliedMigration: true, fromVersion };
}
