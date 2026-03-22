import { type ConfigVersion, CURRENT_CONFIG_VERSION, SUPPORTED_VERSIONS } from "./config-schema.ts";
import { ValidationError } from "./errors.ts";

/**
 * Migrate deprecated watchdog tier key names in a parsed config object.
 *
 * Phase 4 renamed the watchdog tiers:
 *   - Old "tier1" (mechanical daemon) -> New "tier0"
 *   - Old "tier2" (AI triage)         -> New "tier1"
 *
 * Detection heuristic: if `tier0Enabled` is absent but `tier1Enabled` is present,
 * this is an old-style config. A new-style config would have `tier0Enabled`.
 *
 * If old key names are present and new key names are absent, this function
 * copies the values to the new keys, removes the old keys (to prevent collision
 * with the renamed tiers), and logs a deprecation warning.
 *
 * Mutates the parsed config object in place.
 */
export function migrateDeprecatedWatchdogKeys(parsed: Record<string, unknown>): void {
	const watchdog = parsed.watchdog;
	if (watchdog === null || watchdog === undefined || typeof watchdog !== "object") {
		return;
	}

	const wd = watchdog as Record<string, unknown>;

	// Detect old-style config: tier1Enabled present but tier0Enabled absent.
	// In old naming, tier1 = mechanical daemon. In new naming, tier0 = mechanical daemon.
	const isOldStyle = "tier1Enabled" in wd && !("tier0Enabled" in wd);

	if (!isOldStyle) {
		// New-style config or no tier keys at all -- nothing to migrate
		return;
	}

	// Old tier1Enabled -> new tier0Enabled (mechanical daemon)
	wd.tier0Enabled = wd.tier1Enabled;
	delete wd.tier1Enabled;
	process.stderr.write(
		"[overstory] DEPRECATED: watchdog.tier1Enabled → use watchdog.tier0Enabled\n",
	);

	// Old tier1IntervalMs -> new tier0IntervalMs (mechanical daemon)
	if ("tier1IntervalMs" in wd) {
		wd.tier0IntervalMs = wd.tier1IntervalMs;
		delete wd.tier1IntervalMs;
		process.stderr.write(
			"[overstory] DEPRECATED: watchdog.tier1IntervalMs → use watchdog.tier0IntervalMs\n",
		);
	}

	// Old tier2Enabled -> new tier1Enabled (AI triage)
	if ("tier2Enabled" in wd) {
		wd.tier1Enabled = wd.tier2Enabled;
		delete wd.tier2Enabled;
		process.stderr.write(
			"[overstory] DEPRECATED: watchdog.tier2Enabled → use watchdog.tier1Enabled\n",
		);
	}
}

/**
 * Migrate deprecated task tracker key names in a parsed config object.
 *
 * Handles legacy `beads:` and `seeds:` top-level keys, converting them to
 * the unified `taskTracker:` section. If `taskTracker:` already exists, no
 * migration is performed.
 *
 * Mutates the parsed config object in place.
 */
export function migrateDeprecatedTaskTrackerKeys(parsed: Record<string, unknown>): void {
	// Always remove legacy keys, even when taskTracker: is already present.
	// This ensures legacy keys don't fail unknown-field validation.
	if (parsed.taskTracker === undefined && parsed.beads !== undefined) {
		const beadsConfig = parsed.beads as Record<string, unknown>;
		parsed.taskTracker = {
			backend: "beads",
			enabled: beadsConfig.enabled ?? true,
		};
		process.stderr.write(
			"[overstory] DEPRECATED: beads: -> use taskTracker: { backend: beads, enabled: true }\n",
		);
	} else if (parsed.taskTracker === undefined && parsed.seeds !== undefined) {
		const seedsConfig = parsed.seeds as Record<string, unknown>;
		parsed.taskTracker = {
			backend: "seeds",
			enabled: seedsConfig.enabled ?? true,
		};
		process.stderr.write(
			"[overstory] DEPRECATED: seeds: -> use taskTracker: { backend: seeds, enabled: true }\n",
		);
	}

	// Remove legacy keys regardless of whether taskTracker was already set.
	if (parsed.beads !== undefined) {
		delete parsed.beads;
	}
	if (parsed.seeds !== undefined) {
		delete parsed.seeds;
	}
}

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
