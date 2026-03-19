# Versioned Config

This document is the contributor guide for Overstory's config versioning system.
It covers the schema version constant, the migration pipeline, strict
unknown-field validation, and step-by-step instructions for adding new fields
and migrations.

---

## 1. Problem: Config Drift

As Overstory evolves, new config fields are added and existing fields are
renamed or restructured. Without versioning:

- Users on older config files get silent failures when new fields are expected.
- Typos in field names go undetected, causing hard-to-debug behavior.
- Migrations between config shapes require ad-hoc detection heuristics.

The versioned config system solves this by:

1. Stamping each config file with an explicit `version` number.
2. Detecting and migrating old versions automatically on load.
3. Rejecting unknown fields to catch typos early.

---

## 2. Schema Version

**Source:** [`src/config-schema.ts`](../src/config-schema.ts)

```typescript
export const CURRENT_CONFIG_VERSION = 2;

export const SUPPORTED_VERSIONS = [1, 2] as const;

export type ConfigVersion = (typeof SUPPORTED_VERSIONS)[number];
```

- `CURRENT_CONFIG_VERSION` is the latest version that the current codebase
  expects.
- `SUPPORTED_VERSIONS` lists all versions that can be loaded and migrated.
  Unsupported version numbers cause a `ValidationError`.
- Config files without a `version` field are treated as v1 (legacy).

---

## 3. Known Fields

**Source:** [`src/config-schema.ts`](../src/config-schema.ts) (`KNOWN_FIELDS`)

Every config section has a set of allowed field names. Any key not in the set
is rejected by `validateUnknownFields()`.

```typescript
export const KNOWN_FIELDS = {
	root: new Set([
		"version", "project", "agents", "worktrees", "taskTracker",
		"mulch", "merge", "providers", "watchdog", "models",
		"logging", "coordinator", "rateLimit", "runtime",
	]),
	project: new Set(["name", "root", "canonicalBranch", "qualityGates"]),
	agents: new Set([
		"manifestPath", "baseDir", "maxConcurrent", "staggerDelayMs",
		"maxDepth", "maxSessionsPerRun", "maxAgentsPerLead",
	]),
	// ... (one set per config section)
} as const;
```

Dynamic-key sections (`providers`, `models`, `runtime.capabilities`,
`runtime.pi.modelMap`) allow arbitrary string keys. Their value shapes are
validated by `validateConfig()` instead.

---

## 4. Config Loading Pipeline

**Source:** [`src/config.ts`](../src/config.ts)

The `loadConfig()` function runs this pipeline on every config load:

```
Read .overstory/config.yaml
        |
        v
parseYaml(text)                          # Minimal YAML parser
        |
        v
migrateDeprecatedWatchdogKeys(parsed)    # Rename old tier1→tier0, tier2→tier1
migrateDeprecatedTaskTrackerKeys(parsed) # Convert beads:/seeds: → taskTracker:
        |
        v
detectConfigVersion(parsed)              # Returns ConfigVersion (1 or 2)
        |
        v
validateUnknownFields(parsed)            # Reject typos and unknown keys
        |
        v
migrateToLatest(parsed, version)         # Apply version-to-version migrations
        |
        v
deepMerge(DEFAULT_CONFIG, migrated)      # Fill in missing fields with defaults
        |
        v
mergeLocalConfig(root, merged)           # Layer config.local.yaml overrides
        |
        v
validateConfig(merged)                   # Validate types, ranges, and references
        |
        v
OverstoryConfig                          # Fully populated and validated
```

### Merge order

```
DEFAULT_CONFIG  <-  config.yaml  <-  config.local.yaml
```

`config.local.yaml` is gitignored and provides machine-specific overrides
(e.g., lower `maxConcurrent` for weaker hardware).

---

## 5. Version Detection

**Source:** [`src/config-migrate.ts`](../src/config-migrate.ts) (`detectConfigVersion`)

```typescript
export function detectConfigVersion(raw: Record<string, unknown>): ConfigVersion
```

| `version` field | Detected version | Notes |
|-----------------|------------------|-------|
| Missing / `null` | `1` | Legacy config without explicit version |
| `1` | `1` | Explicit v1 |
| `2` | `2` | Current version |
| Anything else | `ValidationError` | Unsupported |

---

## 6. Migration Pipeline

**Source:** [`src/config-migrate.ts`](../src/config-migrate.ts) (`migrateToLatest`)

```typescript
export function migrateToLatest(
	raw: Record<string, unknown>,
	fromVersion: ConfigVersion,
): MigrationResult
```

Returns:

```typescript
export interface MigrationResult {
	migrated: Record<string, unknown>;
	appliedMigration: boolean;
	fromVersion: ConfigVersion;
}
```

### Current migrations

| From | To | Changes |
|------|----|---------|
| v1 | v2 | Sets `version: 2`. No structural changes. |

If `fromVersion === CURRENT_CONFIG_VERSION`, the config is returned unchanged
with `appliedMigration: false`.

### Deprecation migrations (pre-version)

Before the version-based pipeline runs, two legacy migration functions handle
renamed keys:

- `migrateDeprecatedWatchdogKeys()` -- renames old `tier1*` keys to `tier0*`
  and `tier2*` to `tier1*` (Phase 4 tier renumbering).
- `migrateDeprecatedTaskTrackerKeys()` -- converts top-level `beads:` or
  `seeds:` sections to the unified `taskTracker:` format.

These run on both `config.yaml` and `config.local.yaml`.

---

## 7. Strict Unknown-Field Validation

**Source:** [`src/config-validate.ts`](../src/config-validate.ts)

```typescript
export function validateUnknownFields(raw: Record<string, unknown>): void
```

Called **before** merging with defaults, so only user-provided keys are checked.
Throws `ValidationError` with a precise path on the first unknown field:

```
Unknown field 'config.agentss'. Check for typos or see the config reference.
```

Validation walks the config tree recursively, checking each section against
its `KNOWN_FIELDS` set. Sections with dynamic keys (`providers`, `models`,
`runtime.capabilities`) are skipped at the key level but their value shapes
are validated by `validateConfig()`.

---

## 8. Doctor Integration

The `ov doctor` command's config category checks:

- Whether `version` is present and equals `CURRENT_CONFIG_VERSION`.
- Whether any deprecated keys remain (watchdog tier names, beads/seeds).
- Whether unknown fields would fail validation.

Running `ov doctor --fix` can auto-set `version: 2` in configs that lack it.

---

## 9. Adding New Config Fields (Contributor Guide)

### Step 1: Add to `KNOWN_FIELDS`

In `src/config-schema.ts`, add the new field name to the appropriate set:

```typescript
// Example: adding a new 'retryCount' field to the agents section
agents: new Set([
	"manifestPath", "baseDir", "maxConcurrent", "staggerDelayMs",
	"maxDepth", "maxSessionsPerRun", "maxAgentsPerLead",
	"retryCount",  // <-- add here
]),
```

### Step 2: Add to `OverstoryConfig` type

In `src/types.ts`, add the field to the appropriate interface:

```typescript
agents: {
	// ...existing fields...
	retryCount: number;
};
```

### Step 3: Set a default

In `src/config.ts`, add the default value to `DEFAULT_CONFIG`:

```typescript
agents: {
	// ...existing defaults...
	retryCount: 3,
},
```

### Step 4: Add validation

In `src/config.ts`, add a check in `validateConfig()`:

```typescript
if (!Number.isInteger(config.agents.retryCount) || config.agents.retryCount < 0) {
	throw new ValidationError("agents.retryCount must be a non-negative integer", {
		field: "agents.retryCount",
		value: config.agents.retryCount,
	});
}
```

### Step 5: Write tests

Add test cases to `src/config.test.ts`, `src/config-validate.test.ts`, and
`src/config-schema.test.ts` as appropriate.

---

## 10. Adding New Migrations

### Step 1: Bump `CURRENT_CONFIG_VERSION`

In `src/config-schema.ts`:

```typescript
export const CURRENT_CONFIG_VERSION = 3;
export const SUPPORTED_VERSIONS = [1, 2, 3] as const;
```

### Step 2: Add migration step

In `src/config-migrate.ts`, add a new block in `migrateToLatest()`:

```typescript
export function migrateToLatest(
	raw: Record<string, unknown>,
	fromVersion: ConfigVersion,
): MigrationResult {
	if (fromVersion === CURRENT_CONFIG_VERSION) {
		return { migrated: raw, appliedMigration: false, fromVersion };
	}

	let current: Record<string, unknown> = { ...raw };

	// v1 -> v2: add explicit version field
	if (fromVersion < 2) {
		current = { ...current, version: 2 };
	}

	// v2 -> v3: rename agents.staggerDelayMs to agents.spawnDelayMs
	if (fromVersion < 3) {
		const agents = current.agents as Record<string, unknown> | undefined;
		if (agents && "staggerDelayMs" in agents) {
			agents.spawnDelayMs = agents.staggerDelayMs;
			delete agents.staggerDelayMs;
		}
		current = { ...current, version: 3 };
	}

	return { migrated: current, appliedMigration: true, fromVersion };
}
```

### Step 3: Update `KNOWN_FIELDS`

If the migration renames a field, update the allowed set to include the new
name and remove the old name.

### Step 4: Write migration tests

Add test cases to `src/config-migrate.test.ts` covering:

- v2 config passes through unchanged.
- v1 config is migrated through v2 to v3.
- Direct v2-to-v3 migration works.
