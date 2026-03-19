# Scenario-Based Eval Framework

This document is the contributor guide for Overstory's eval framework. It covers
scenario definition, assertion kinds, the runner pipeline, artifact storage, and
a step-by-step walkthrough for writing custom scenarios.

---

## 1. What `ov eval` Does

The eval framework runs end-to-end orchestration tests against disposable
fixture repos. Each **scenario** defines a repo template, config overrides,
startup actions, and assertions. The runner:

1. Creates a temporary fixture repo from the scenario's template.
2. Initializes overstory (`ov init`) in the fixture.
3. Applies config overrides and runs startup actions.
4. Starts a coordinator and polls for completion.
5. Collects metrics from the fixture's SQLite databases.
6. Evaluates assertions against the collected metrics.
7. Writes artifacts and cleans up the fixture.

This provides a deterministic, repeatable way to verify that the swarm system
handles dispatch, merging, watchdog behavior, and cost budgets correctly.

---

## 2. Scenario Directory Structure

Each scenario lives in its own directory under `evals/`:

```
evals/
  dispatch-smoke/
    scenario.yaml         # Required: scenario metadata
    assertions.yaml       # Required: assertions to evaluate
    repo-template/        # Optional: files copied into the fixture repo
      hello.txt
      goodbye.txt
      CLAUDE.md
```

---

## 3. `scenario.yaml` Format

**Source:** [`src/eval/scenario.ts`](../src/eval/scenario.ts)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `description` | `string` | Yes | -- | Human description of what this scenario tests |
| `timeout_ms` | `number` | No | `300000` (5 min) | Max time to wait for coordinator completion |
| `config_overrides` | `object` | No | `{}` | Deep-merged into `.overstory/config.yaml` |
| `startup_actions` | `list` | No | `[]` | Shell commands to run before coordinator start |

### `startup_actions` entries

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | `string` | Yes | Shell command to run in the fixture repo |
| `description` | `string` | No | Human description of the action |

### Example `scenario.yaml`

```yaml
description: "Smoke test: coordinator dispatches 2 tasks, workers spawn and complete"
timeout_ms: 600000

config_overrides:
  agents:
    maxConcurrent: 4

startup_actions:
  - command: sd create --title "Write hello.txt" --type task --priority 2
    description: "Create first task for dispatch"
  - command: sd create --title "Write goodbye.txt" --type task --priority 2
    description: "Create second task for dispatch"
```

---

## 4. `assertions.yaml` Format

**Source:** [`src/eval/assertions.ts`](../src/eval/assertions.ts)

The file must contain a top-level `assertions` key with a non-empty list.

Each assertion has:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `kind` | `AssertionKind` | Yes | One of the 8 supported kinds |
| `expected` | `number \| boolean \| string` | Yes | Threshold or expected value |
| `label` | `string` | No | Human label (auto-generated from kind if omitted) |

### Example `assertions.yaml`

```yaml
assertions:
  - kind: min_workers_spawned
    label: "At least 2 workers spawned"
    expected: 2
  - kind: tasks_completed
    label: "Both tasks completed"
    expected: 2
  - kind: no_zombies
    label: "No zombie agents"
    expected: true
  - kind: max_stall_rate
    label: "No stalled agents"
    expected: 0.0
```

---

## 5. Assertion Kinds

**Source:** [`src/eval/types.ts`](../src/eval/types.ts), [`src/eval/assertions.ts`](../src/eval/assertions.ts)

```typescript
export type AssertionKind =
	| "min_workers_spawned"
	| "no_zombies"
	| "merge_queue_empty"
	| "tasks_completed"
	| "max_stall_rate"
	| "max_cost"
	| "max_duration_ms"
	| "custom";
```

| Kind | Expected type | Metric compared | Pass condition |
|------|---------------|-----------------|----------------|
| `min_workers_spawned` | `number` | `metrics.totalAgents` | `actual >= expected` |
| `no_zombies` | `boolean` | `metrics.zombieCount` | `actual === 0` |
| `merge_queue_empty` | `boolean` | `metrics.mergeQueuePending` | `actual === 0` |
| `tasks_completed` | `number` | `metrics.tasksCompleted` | `actual >= expected` |
| `max_stall_rate` | `number` (0.0--1.0) | `metrics.stallRate` | `actual <= expected` |
| `max_cost` | `number` (USD) | `metrics.estimatedCostUsd` | `actual <= expected` |
| `max_duration_ms` | `number` (ms) | `metrics.durationMs` | `actual <= expected` |
| `custom` | `string` | -- | Always passes (LLM judge not yet implemented) |

---

## 6. Collected Metrics

**Source:** [`src/eval/types.ts`](../src/eval/types.ts) (`EvalMetrics`)

The runner reads metrics from the fixture's SQLite databases after the
coordinator finishes (or times out). These metrics feed assertion evaluation.

```typescript
export interface EvalMetrics {
	totalAgents: number;
	completedAgents: number;
	zombieCount: number;
	stallCount: number;
	stallRate: number;
	mergeSuccessCount: number;
	mergeConflictCount: number;
	mergeQueuePending: number;
	tasksCompleted: number;
	durationMs: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	estimatedCostUsd: number;
	nudgesSent: number;
	runtimeSwaps: number;
	medianSessionDurationMs: number;
}
```

Data sources:

| Database | Metrics extracted |
|----------|-------------------|
| `sessions.db` | `totalAgents`, `completedAgents`, `zombieCount`, `stallCount`, `runtimeSwaps` |
| `metrics.db` | `totalInputTokens`, `totalOutputTokens`, `estimatedCostUsd`, `medianSessionDurationMs` |
| `merge-queue.db` | `mergeSuccessCount`, `mergeConflictCount`, `mergeQueuePending` |
| `events.db` | `nudgesSent` |

---

## 7. CLI Usage

### `ov eval run <scenario>`

Run a scenario against a temporary fixture repo.

```bash
ov eval run evals/dispatch-smoke
ov eval run evals/dispatch-smoke --json
ov eval run evals/dispatch-smoke --timeout 120000
```

Exits with code 1 if any assertion fails.

### `ov eval show <run-id>`

Display results of a previous eval run.

```bash
ov eval show a1b2c3d4-...
ov eval show a1b2c3d4-... --json
```

### `ov eval list`

List all past eval runs, sorted by start time (newest first).

```bash
ov eval list
ov eval list --json
```

### `ov eval compare <run-a> <run-b>`

Compare two eval runs side-by-side. Shows metric deltas (B - A) and assertion
regressions/improvements.

```bash
ov eval compare a1b2c3d4-... e5f6g7h8-...
ov eval compare a1b2c3d4-... e5f6g7h8-... --json
```

---

## 8. Artifact Storage

**Source:** [`src/eval/store.ts`](../src/eval/store.ts)

After each run, artifacts are written to:

```
.overstory/eval-runs/<run-id>/
  manifest.json       # Run ID, scenario name, pass/fail, timestamps
  summary.json        # Full EvalResult (metrics + assertions + metadata)
  assertions.json     # Per-assertion results
  metrics.json        # Collected EvalMetrics
  sessions.json       # Raw sessions from the fixture's sessions.db
  events.jsonl        # Raw events from the fixture's events.db (NDJSON)
```

The `summary.json` file is the canonical artifact -- `ov eval show` and
`ov eval compare` both read from it.

---

## 9. Runner Pipeline

**Source:** [`src/eval/runner.ts`](../src/eval/runner.ts)

```
loadScenario(scenarioPath)
        |
        v
runEval(config)
        |
        +-- 1. Copy repo-template (if exists) or init empty git repo
        +-- 2. ov init --yes --skip-mulch --skip-seeds --skip-canopy
        +-- 3. Apply config_overrides to .overstory/config.yaml
        +-- 4. Run startup_actions (sequentially)
        +-- 5. ov coordinator start --no-attach
        +-- 6. Poll ov coordinator check-complete (every 5s, up to timeout)
        +-- 7. collectMetrics() from fixture SQLite databases
        +-- 8. evaluateAssertions(scenario.assertions, metrics)
        +-- 9. Build EvalResult { passed, timedOut, metrics, assertions }
        +-- 10. Cleanup: ov coordinator stop, rm fixture dir
```

The runner always cleans up -- even on timeout or error, the coordinator is
stopped and the fixture directory is removed.

---

## 10. Writing a Custom Scenario

### Step 1: Create the scenario directory

```bash
mkdir -p evals/my-scenario
```

### Step 2: Write `scenario.yaml`

```yaml
description: "Verify that rate-limited agents swap runtimes gracefully"
timeout_ms: 900000

config_overrides:
  rateLimit:
    enabled: true
    behavior: swap
    swapRuntime: codex
  agents:
    maxConcurrent: 2

startup_actions:
  - command: sd create --title "Implement feature A" --type task --priority 1
```

### Step 3: Write `assertions.yaml`

```yaml
assertions:
  - kind: min_workers_spawned
    expected: 1
  - kind: tasks_completed
    expected: 1
  - kind: no_zombies
    expected: true
  - kind: max_cost
    label: "Under $5 budget"
    expected: 5.0
  - kind: max_duration_ms
    label: "Completes within 15 minutes"
    expected: 900000
```

### Step 4: Add a repo template (optional)

Create `evals/my-scenario/repo-template/` with files that should exist in the
fixture repo before `ov init` runs. This directory is copied verbatim into the
fixture. If omitted, an empty git repo with a single `README.md` commit is
created.

### Step 5: Run it

```bash
ov eval run evals/my-scenario
```
