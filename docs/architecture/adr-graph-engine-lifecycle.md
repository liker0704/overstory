# ADR: Graph Execution Engine as Mission Lifecycle Controller

**Status**: Accepted

**Date**: 2026-04-04

**Deciders**: Overstory core team

**References**: Issue #98 (design proposal), Bug #96 (mission stuck in understand), Bug #97 (WS2 never dispatched after WS1 merge)

---

## Context

### The Problem

Mission lifecycle currently depends entirely on LLM agents staying alive and executing prompt-defined behavior. When agents die (rate limits, context overflow, crashes), no system-level mechanism detects this, restarts them, or advances the mission. The mission stalls forever.

Two production bugs in `asrp.science-llm` exposed the root cause:

**Bug #96 -- Mission stuck in `understand` phase:**
Mission `auth-mock` coordinator dispatched analyst for research. Analyst spawned 3 scouts, all completed by 20:16. Both coordinator and analyst sessions ended (rate limit / context overflow). `ov status` showed both as "working" 40+ minutes later. `workstreams.json` remained empty. Mission stuck in `understand:active` forever.

**Bug #97 -- WS2 never dispatched after WS1 merge:**
Mission `auth-mock-v2` had 2 sequential workstreams: `shared-auth` (no deps) then `user-model` (depends on `shared-auth`). WS1 completed, built, reviewed, merged. Coordinator replied to exec-director: "Proceed with WS2 dispatch." Exec-director was already dead. Both workstreams still showed `"planned"` in `workstreams.json` -- status was never updated to `"completed"`. WS2 was never dispatched.

### Three Specific Gaps in Current Architecture

1. **No automatic phase transitions.** `understand -> plan -> execute` requires the coordinator agent to manually call `ov mission handoff` (`src/missions/lifecycle.ts`). If coordinator dies before this, the mission is permanently stuck.

2. **No workstream status updates after merge.** `persistWorkstreamsFile()` exists (`src/missions/workstreams.ts:368`) but is never called with status updates after a merge completes. `packageHandoffs()` (`src/missions/workstreams.ts:546`) checks `status === "completed"` to determine which workstreams are dispatchable, but nothing ever writes `"completed"`. The function that could enable sequential dispatch exists but is never fed the data it needs.

3. **No dead agent recovery.** When a persistent agent (coordinator, analyst, exec-director) dies, `evaluateHealth()` (`src/watchdog/health.ts`) marks it as `zombie` but this triggers no mission-level action. The watchdog daemon (`src/watchdog/daemon.ts`) has progressive escalation (levels 0-3) for individual agents, but no concept of mission-level impact when a critical role agent dies.

### Existing Infrastructure

The graph execution engine already exists but is controlled by `config.mission.graphExecution`:

| Component | Location | Status |
|---|---|---|
| Graph engine core | `src/missions/engine.ts` | Done -- `createGraphEngine()`, `step()`, `run()`, `advanceNode()`, subgraph support |
| Checkpoint store | `src/missions/checkpoint.ts` | Done -- `createCheckpointStore()` backed by `mission_node_checkpoints` table |
| Transition history | `mission_state_transitions` table | Done -- `saveStepResult()` records every transition |
| Plan-review cell | `src/missions/cells/plan-review.ts` | Done -- convergence loop with dispatch-critics, collect-verdicts, consolidate |
| Arch-review cell | `src/missions/cells/architecture-review.ts` | Done -- same convergence loop pattern |
| Engine wiring | `src/missions/engine-wiring.ts` | Done -- `shouldUseEngine()`, `startCellEngine()`, `CELL_REGISTRY` |
| Lifecycle graph | `src/missions/graph.ts` | Done -- phase nodes, freeze/unfreeze/suspend/stop/fail edges |
| Watchdog daemon | `src/watchdog/daemon.ts` | Done -- `runDaemonTick()` with progressive escalation |
| Role spawners | `src/missions/roles.ts` | Done -- `startMissionCoordinator()`, `startMissionAnalyst()`, etc. |
| Health evaluation | `src/watchdog/health.ts` | Done -- `evaluateHealth()` with ZFC principle, `PERSISTENT_CAPABILITIES` set |
| Circuit breaker | `src/resilience/circuit-breaker.ts` | Done -- `recordFailure()`, `getState()`, `recordSuccess()` |
| Resilience engine | `src/resilience/engine.ts` | Done -- `handleTaskFailure()`, `calculateBackoff()`, `shouldRetry()` |
| Workstream packaging | `src/missions/workstreams.ts` | Done -- `packageHandoffs()`, `slingArgsFromHandoff()` |

The `shouldUseEngine()` function (`src/missions/engine-wiring.ts:86`) returns `config.mission?.graphExecution !== false`, defaulting to enabled.

---

## Decision

Extend the graph execution engine to serve as an always-on mission lifecycle controller, integrated into the watchdog daemon tick. The engine operates as a **safety net**, not a replacement for agent decision-making.

Key elements:

1. **Make the engine always-on** (default `true`, configurable to `false`)
2. **Add subgraphs to each mission phase** that model the real workflow
3. **Add `runMissionTick()` to the watchdog daemon** -- each daemon tick evaluates active mission gates
4. **Implement dead agent detection + smart recovery** with cause-based response and circuit breaker
5. **Code-driven workstream status updates** via `updateWorkstreamStatus()`
6. **Grace period system** with activity-based extension for execution gates

### Engine Role: Controller, Not Replacement

The engine does NOT replace agents. Agents still make decisions, dispatch sub-agents, write plans, perform reviews. The engine is a controller with two modes:

**Nudge mode** (agent alive but stuck):
- Phase transition conditions met, coordinator has not advanced -- nudge coordinator
- WS1 completed, deps satisfied, exec-director silent -- nudge exec-director
- Research done, `workstreams.json` still empty -- nudge analyst

**Recovery mode** (agent dead):
- Rate limited -- wait for `rate_limit_resumes_at` (do NOT respawn)
- Context overflow -- respawn (new session = clean context)
- Crash (< max retries) -- respawn with backoff
- Crash (>= max retries) -- circuit breaker -- suspend mission + notify operator
- Completed but unreported -- `worker_done` mail exists, mark completed
- Unknown cause -- Tier 1 triage via `triageAgent()` (`src/watchdog/triage.ts`)

---

## Architecture Overview

### Component Interaction

```
                              +-----------------+
                              |  Watchdog Daemon |
                              | (daemon.ts)      |
                              +--------+---------+
                                       |
                     runDaemonTick() calls runMissionTick()
                                       |
                              +--------v---------+
                              | Mission Tick      |
                              | (mission-tick.ts) |
                              +--------+---------+
                                       |
                    +------------------+------------------+
                    |                                     |
           +--------v---------+              +------------v-----------+
           | Graph Engine      |              | Dead Agent Recovery    |
           | (engine.ts)       |              | (smart respawn +       |
           | - step()          |              |  circuit breaker)      |
           | - advanceNode()   |              +------------+-----------+
           +--------+---------+                           |
                    |                          uses evaluateHealth()
          +---------+---------+               from health.ts
          |                   |               + resilience/circuit-breaker.ts
  +-------v-------+  +-------v-------+
  | Gate Evaluators|  | Node Handlers  |
  | (async gates   |  | (sync actions: |
  |  check mail,   |  |  dispatch,     |
  |  session state, |  |  update status)|
  |  workstreams)  |  +-------+-------+
  +-------+-------+          |
          |            +------v-------+
          |            | Role Spawners |
    +-----v-----+     | (roles.ts)    |
    | Mail Store |     +--------------+
    | Session DB |
    | workstreams|
    |   .json    |
    +-----------+
```

### Data Flow: How a Tick Evaluates Gates

```
1. runDaemonTick() fires (every N seconds, per config)
2.   | -- existing agent health checks (levels 0-3)
3.   | -- NEW: runMissionTick(activeMissions)
4.         |
5.         for each active mission:
6.           |
7.           +-- reconstruct engine from checkpoint
8.           |     (checkpointStore.getLatestCheckpoint)
9.           |
10.          +-- determine current node
11.          |     (engine.currentNodeId())
12.          |
13.          +-- if node is async gate:
14.          |     |
15.          |     +-- read mission_gate_state row
16.          |     |     (entered_at, nudge_count, grace_ms)
17.          |     |
18.          |     +-- check child activity
19.          |     |     "any child of gated agent has state 'working'?"
20.          |     |     YES --> extend grace timer, return
21.          |     |
22.          |     +-- elapsed < grace_ms?
23.          |     |     YES --> return (agent is working)
24.          |     |
25.          |     +-- evaluate gate condition
26.          |     |     (check mail store, session state, workstreams.json)
27.          |     |
28.          |     +-- condition met?
29.          |     |     YES --> engine.advanceNode(trigger)
30.          |     |     NO  --> nudge (if nudgeInterval since last nudge)
31.          |     |             nudge_count >= max? --> escalate / check if dead
32.          |     |
33.          +-- if node is sync handler:
34.          |     engine.step() --> handler executes --> auto-advance
35.          |
36.          +-- dead agent check (background, every tick):
37.                check liveness of critical role agents
38.                (coordinator, analyst, exec-director, architect)
39.                dead? --> smart recovery decision tree
```

### Subgraph Structure Per Phase

The top-level lifecycle graph (`src/missions/graph.ts`) remains unchanged -- phases with freeze/unfreeze/suspend/stop/fail edges. Each `<phase>:active` node gains a **subgraph** property that models the real workflow within that phase.

```
Top-level graph (existing, unchanged):
  understand:active  --phase_advance-->  align:active  --phase_advance-->
  decide:active  --phase_advance-->  plan:active  --handoff-->
  execute:active  --phase_advance-->  done:active  --complete-->  done:completed

Each :active node gains a subgraph:

understand:active.subgraph:
  [ensure-coordinator] --> [await-research] --> [evaluate]
                                                   |--frozen--> [frozen] --answer--> [evaluate]

plan:active.subgraph:
  [dispatch-planning] --> [await-plan] --> [check-tdd]
                                              |--tdd_required--> [architect-design] --> [review]
                                              |--no_tdd--> [review]
  [review] = plan-review cell subgraph (existing)
  [review] --approved--> [await-handoff]
  [review] --stuck--> [review-stuck] --resolved--> [review]
  [await-handoff] --> terminal

execute:active.subgraph:
  [ensure-ed] --> [dispatch-ready] --> [await-ws-completion]
  [await-ws-completion] --ws_merged--> [update-status] --> [check-remaining]
  [check-remaining] --more_ws--> [dispatch-ready]       (LOOP)
  [check-remaining] --waiting--> [await-ws-completion]  (LOOP)
  [check-remaining] --all_done--> terminal
  [check-remaining] --all_done_tdd--> [arch-review-dispatch] --> [arch-review]
  [arch-review] --approved--> [check-refactor]
  [check-refactor] --refactor_needed--> [await-refactor] --> [await-arch-final]
  [check-refactor] --no_refactor--> [await-arch-final]
  [await-arch-final] --> terminal

done:active.subgraph:
  [summary] --> [holdout] --> [cleanup] --> terminal
```

The engine already supports subgraphs (`src/missions/engine.ts:152-175`): when `node.kind === "lifecycle" && node.subgraph` is truthy, it creates a child engine with `checkpointKeyPrefix` for isolation and runs it to completion before advancing the parent.

### Gate Evaluation Model

The engine's `step()` function runs synchronously. When a subgraph node hits an async gate, `step()` returns `{ status: "gate" }` to the parent, which propagates up. On the next watchdog tick, the engine is reconstructed from checkpoint — the parent checkpoint still points to the `phase:active` node, so the subgraph is re-entered from its own checkpoint.

**Gate evaluators are external to the engine.** They live in `mission-tick.ts`, not in the handler registry. The tick code:
1. Reconstructs engine from checkpoint
2. Calls `engine.step()` (NOT `engine.run()`)
3. If step returns `{ status: "gate" }` — the tick code evaluates the gate condition externally
4. If condition met — tick calls `engine.advanceNode(trigger)` to unblock the gate
5. If not met — tick checks grace period, nudges if needed, returns

This means the engine is NOT self-driving. The tick code drives it.

**Important**: `advanceNode()` (`engine.ts:262`) internally calls `run()` which is an unbounded `while(true)` loop. A single `advanceNode()` call can execute an unlimited chain of instant handlers and subgraphs. To make this safe for tick-based execution, we **modify `createGraphEngine()`** to accept a `maxSteps` option:

```typescript
// engine.ts modifications

export interface GraphEngineOpts {
  // ... existing fields ...
  maxSteps?: number; // Cap iterations in run(). Default: unlimited. Mission ticks set to 5.
}

// Inside run() — add step counter:
let stepCount = 0;
while (true) {
  if (opts.maxSteps && stepCount >= opts.maxSteps) {
    return { status: "gate", steps, currentNodeId: state.currentNodeId };
    // Treat as gate — next tick will continue from checkpoint
  }
  // ... existing step() call ...
  stepCount++;
}

// Inside step() — propagate maxSteps to subgraph engines (line 153):
if (node.kind === "lifecycle" && node.subgraph) {
  const subEngine = createGraphEngine({
    graph: node.subgraph,
    handlers: opts.handlers,
    checkpointStore: opts.checkpointStore,
    missionId: opts.missionId,
    checkpointKeyPrefix: nodeId,
    missionStore: opts.missionStore,
    sendMail: opts.sendMail,
    maxSteps: opts.maxSteps,  // <-- PROPAGATE to subgraph
  });
  const subResult = await subEngine.run(); // now capped
  // ...
}
```

Mission tick pseudocode:

```typescript
// mission-tick.ts
const engine = createGraphEngine({ ...opts, maxSteps: 5 });
const result = await engine.step();
if (result.status === "gate") {
  const condition = evaluateGateCondition(result.fromNodeId, stores);
  if (condition.met) {
    // advanceNode() calls run() which is capped at maxSteps
    // subgraph run() inside step() is also capped (maxSteps propagated)
    await engine.advanceNode(condition.trigger);
  } else if (condition.shouldNudge) {
    await nudgeAgent(condition.target, condition.message);
  }
}
```

`maxSteps: 5` means: across all engine operations (including nested subgraph execution), at most 5 instant handler steps execute before yielding to the next tick. `step()` propagates `opts.maxSteps` to `createGraphEngine()` when creating subgraph engines, so nested subgraphs (e.g., execute → arch-review cell) inherit the limit transitively.

**Gate state row creation**: When `step()` returns `{ status: "gate" }`, `runMissionTick()` checks if a `mission_gate_state` row exists for `(mission_id, node_id)`. If not, it inserts one with `entered_at = now` and the gate's configured grace/nudge/ceiling values. This is the only place gate state rows are created.

### `align` and `decide` Phases

The graph defines 5 working phases: understand, align, decide, plan, execute. Currently `align` and `decide` are **not used in any production mission** — missions jump directly from understand to plan (the coordinator calls `ov mission handoff` which sets phase to "execute", skipping align/decide entirely).

For the engine, `align:active` and `decide:active` nodes get **auto-advance handlers**:

```typescript
// align-phase and decide-phase handlers
async (ctx) => {
  // These phases are currently unused in mission workflow.
  // Auto-advance to next phase.
  return { trigger: "phase_advance" };
}
```

If these phases gain real workflow in the future, the auto-advance handlers are replaced with subgraphs — no structural change needed.

### Grace Period System with Activity-Based Extension

Every async gate has timing parameters stored in `mission_gate_state` (SQLite):

```
interface AsyncGateConfig {
  graceMs: number;           // wait before first nudge (default: 120_000 = 2 min)
  nudgeIntervalMs: number;   // interval between repeated nudges (default: 60_000 = 1 min)
  maxNudges: number;         // after N nudges, escalate (default: 3)
}
```

For execution-phase gates where sub-agents are actively working, grace is NOT a simple timer. The engine checks **child activity**:

```
Tick logic per gate:

  enteredAt = mission_gate_state.entered_at
  elapsed = now - enteredAt

  // Check child activity tree
  if (gatedAgent has any child with state "working"):
    reset grace timer
    return  // real work happening, don't nudge

  if (elapsed < graceMs):
    return  // within grace, agent is working

  if (!conditionMet):
    if (nudgeIntervalMs elapsed since last nudge):
      nudge agent with specific guidance
      UPDATE mission_gate_state SET nudge_count = nudge_count + 1

  if (nudge_count >= maxNudges):
    escalate: check if agent dead, suspend if unrecoverable
```

Per-gate grace overrides:

| Gate category | Grace | Rationale |
|---|---|---|
| Agent dispatch (coordinator dispatches analyst) | 2 min | Agent needs time to boot, read instructions, prime context |
| Heavy work (plan writing, architect design) | 5 min | Complex cognitive tasks take time |
| Full dev cycle (WS execution) | 10 min + activity-based | Sub-agents (builders, testers, reviewers) doing real work |
| Review verdict collection | 6 min + activity-based | Multiple critics running in parallel |
| Post-action (handoff, finalization) | 2 min | Simple action after preconditions met |

### Dead Agent Smart Recovery Flow

```
Agent detected as zombie (via evaluateHealth from health.ts)
  |
  +-- Check: worker_done mail exists for this agent?
  |     YES --> mark completed, don't respawn
  |
  +-- Check: rate_limited_since set in DB?
  |     YES --> wait for rate_limit_resumes_at, do NOT respawn
  |
  +-- Check: context overflow markers in session log?
  |     YES --> respawn (new session = clean context)
  |
  +-- Check: respawn_count < max_retries (from mission_gate_state)?
  |     YES --> respawn with backoff (calculateBackoff from resilience/engine.ts)
  |     NO  --> circuit breaker: suspend mission + notify operator
  |
  +-- Check: manually stopped?
  |     YES --> respect operator intent, don't respawn
  |
  +-- Unknown cause:
        --> Tier 1 triage (triageAgent from watchdog/triage.ts)
        --> retry | terminate | extend based on triage result
```

Existing infrastructure reused:
- Rate limit detection: `evaluateHealth()` in `src/watchdog/health.ts` + `swapRuntime()` in `src/watchdog/swap.ts`
- Circuit breaker: `recordFailure()`, `getState()` in `src/resilience/circuit-breaker.ts`
- Backoff calculation: `calculateBackoff()` in `src/resilience/engine.ts`
- Tier 1 triage: `triageAgent()` in `src/watchdog/triage.ts`
- Role respawn: `startMissionCoordinator()`, `startMissionAnalyst()`, etc. in `src/missions/roles.ts`

---

## Key Design Decisions

### 1. Engine runs inside watchdog tick (not separate process)

**Decision**: `runMissionTick()` is called as a pure function within `runDaemonTick()` (`src/watchdog/daemon.ts:637`).

**Rationale**:
- All infrastructure already available in daemon context: stores (session, mail, events), tmux access, config, resilience store
- No new process to manage, no new SQLite contention
- Daemon already runs on a configurable interval with progressive escalation
- Engine tick is cheap: reconstruct from checkpoint, check a few conditions, optionally advance

**Concurrency guard**: The daemon uses `setInterval` with async callbacks. If a tick takes longer than the interval (e.g., Tier 1 triage spawns a Claude session), the next tick fires while the previous is still running. To prevent duplicate gate processing, `runMissionTick()` acquires a per-mission advisory lock using a dedicated table:

```sql
CREATE TABLE mission_tick_lock (
  mission_id TEXT PRIMARY KEY,
  locked_at TEXT NOT NULL,
  locked_by TEXT  -- daemon PID for debugging
);
```

```typescript
// Acquire lock (atomic: INSERT OR IGNORE + check if our insert won)
const now = new Date().toISOString();
const timeoutSec = intervalMs * 2 / 1000;
// First, clear stale locks (older than 2x interval)
db.prepare(
  `DELETE FROM mission_tick_lock
   WHERE mission_id = $id
   AND (julianday($now) - julianday(locked_at)) * 86400 > $timeout`
).run({ $id: missionId, $now: now, $timeout: timeoutSec });
// Then try to acquire
const result = db.prepare(
  `INSERT OR IGNORE INTO mission_tick_lock (mission_id, locked_at, locked_by)
   VALUES ($id, $now, $pid)`
).run({ $id: missionId, $now: now, $pid: String(process.pid) });
if (result.changes === 0) return; // another tick holds the lock
// ... process mission ...
// Release lock
db.prepare(`DELETE FROM mission_tick_lock WHERE mission_id = $id`).run({ $id: missionId });
```

One row per mission. `INSERT OR IGNORE` is atomic. Stale lock cleanup prevents dead-lock from daemon crashes. No OS-level locking needed.

**Singleton enforcement**: The watchdog daemon already writes a PID file at `.overstory/watchdog.pid` (`src/commands/watch.ts`). The `startDaemon()` function checks for an existing PID file and refuses to start if another daemon is running. This prevents concurrent `ov watch` instances.

**Confidence**: High -- the daemon already has all required dependencies injected via `DaemonOptions`.

### 2. Subgraphs for all phases (not just execute)

**Decision**: Every phase (understand, plan, execute, done) gets a subgraph modeling its real workflow.

**Rationale**:
- **understand** has: parallel scout spawning, freeze/unfreeze cycle, multi-step evaluation
- **plan** has: plan-review convergence loop (already a cell subgraph), conditional architect branch (TDD), revision cycle
- **execute** has: workstream dispatch loop, sequential deps, post-merge architecture review
- **done** has: multiple cleanup steps, optional holdout validation

Without subgraphs for understand and plan, the engine cannot detect/recover from the exact failures shown in bugs #96 and #97 (analyst dead mid-research, coordinator dead before handoff).

**Confidence**: High -- the engine already supports subgraphs (`src/missions/engine.ts:152-175`) with checkpoint isolation via `checkpointKeyPrefix`.

### 3. Engine as controller (nudge mode + recovery mode)

**Decision**: Engine nudges agents when conditions are met but action has not been taken. Engine respawns agents when they die. Engine does NOT make mission-level decisions (what to research, how to plan, whether to approve).

**Rationale**:
- Agents are LLMs with full context -- they make better decisions about their domain
- Engine has no LLM access -- it can only check conditions and send tmux nudges
- This preserves the agent autonomy that makes the swarm effective
- Recovery mode is mechanical: detect death, diagnose cause, respawn or escalate
- Nudge mode is advisory: "conditions X, Y, Z are met -- please advance"

**Confidence**: High -- this matches the existing watchdog philosophy (Tier 0 = mechanical, Tier 1 = AI triage only when mechanical fails).

### 4. SQLite `mission_gate_state` table for gate timing

**Decision**: Use a dedicated SQLite table instead of storing gate timing in checkpoint JSON.

**Schema**:
```sql
CREATE TABLE mission_gate_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  entered_at TEXT NOT NULL,
  nudge_count INTEGER NOT NULL DEFAULT 0,
  last_nudge_at TEXT,
  respawn_count INTEGER NOT NULL DEFAULT 0,
  last_respawn_at TEXT,
  grace_ms INTEGER NOT NULL,
  nudge_interval_ms INTEGER NOT NULL DEFAULT 60000,
  max_nudges INTEGER NOT NULL DEFAULT 3,
  max_total_wait_ms INTEGER NOT NULL DEFAULT 3600000,
  resolved_at TEXT,
  resolved_trigger TEXT,
  UNIQUE(mission_id, node_id)
);
CREATE INDEX idx_mgs_active ON mission_gate_state(mission_id, resolved_at);
```

**Rationale**:
- Watchdog tick can efficiently query active gates: `WHERE resolved_at IS NULL`
- No JSON deserialization per tick (checkpoint `snapshot_data` is opaque JSON)
- Respawn counts are per-gate, not per-agent -- an agent can die at different points in the graph with independent circuit breakers
- Co-resident in `sessions.db` alongside `missions`, `mission_node_checkpoints`, `mission_state_transitions`

**Separation of concerns**:
- `mission_gate_state` -- timing, nudge counts, respawn counts (engine control plane)
- `mission_node_checkpoints` -- handler business data: dispatched WS IDs, critic verdicts (handler data plane)
- `mission_state_transitions` -- audit trail of node-to-node transitions (history)

**Confidence**: High -- follows the existing pattern of `sessions.db` as the shared store with `PRAGMA user_version` migrations (`src/missions/store.ts:165`).

### 5. Single writer for workstream status

**Decision**: Engine is the sole writer for workstream `completed` status, stored in the `workstream_status` SQLite table (not workstreams.json). Agents do NOT write `completed` status.

**Rationale**:
- Bug #97 root cause: nobody writes `"completed"` after merge
- Having agents write status is unreliable (they die, they forget, they get confused)
- Engine detects `merged` mail (with corroborating git evidence), writes `status: "completed"` to `workstream_status` table, then re-evaluates `packageHandoffs()` for sequential dispatch
- SQLite provides transactional writes, crash safety (WAL), and no file corruption risk
- `workstreams.json` remains the plan definition (workstream names, objectives, deps, scope, TDD mode) — status lives in SQLite
- Agents can write `planned → active` (when starting work) without conflicting with engine's `→ completed` writes
- `ov mission workstream-complete <ws-id>` CLI command as operator escape hatch

**Confidence**: High -- this directly fixes the root cause of bug #97.

### 6. Mail verification with corroborating evidence

**Decision**: Gate conditions check multiple signals, not just a single mail message.

**Rationale**:
- Mail alone is unreliable (agent could send premature "done" mail)
- Gate evaluators cross-reference: mail received AND artifact exists (e.g., `architect_ready` mail AND `architecture.md` file exists)
- For workstream completion: `merged` mail AND branch actually merged (git check)
- This prevents false-positive gate advancement

**Confidence**: Medium -- the exact corroborating checks per gate need validation during implementation. Some gates may need only mail (e.g., `plan_critic_verdict` from a trusted critic agent).

### 7. Circuit breaker per-gate per-mission

**Decision**: Respawn tracking uses `respawn_count` and `last_respawn_at` in `mission_gate_state`, scoped to `(mission_id, node_id)`.

**Rationale**:
- An agent dying at `await-research` (understand phase) is independent from dying at `await-ws-completion` (execute phase)
- Per-gate tracking prevents a single phase's failures from poisoning the circuit breaker for later phases
- Existing `src/resilience/circuit-breaker.ts` provides the state machine logic (`closed -> open -> half_open`); `mission_gate_state` provides the per-gate counters
- When `respawn_count >= max` within a time window, the mission is suspended (not just the agent killed)

**Interaction with existing per-capability circuit breaker**: The existing `src/resilience/circuit-breaker.ts` operates on `capability` strings globally (across all missions). For mission-level recovery, we use **only** the per-gate `respawn_count` from `mission_gate_state`. The global capability breaker is NOT consulted for mission agent respawns — it remains for non-mission agent spawning (coordinator leads, standalone workers). This avoids mission A's failures blocking mission B's agents.

**Confidence**: High -- clean separation: per-gate counters for mission agents, per-capability breaker for non-mission agents.

### 8. Atomic writes for workstreams.json

**Decision**: Workstream status is stored in a dedicated SQLite table (`workstream_status`), not in `workstreams.json`. All status transitions go through `updateWorkstreamStatus()` which writes to the table transactionally.

**Rationale**: File-based status tracking is fragile (corruption on partial write, TOCTOU races, no locking). SQLite provides transactional writes, crash safety via WAL mode, and no corruption risk.

**Implementation**: `updateWorkstreamStatus()` wraps the read-modify-write in a SQLite transaction instead of file locking:

```sql
-- New table in sessions.db
CREATE TABLE workstream_status (
  mission_id TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK(status IN ('planned', 'active', 'paused', 'completed')),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,  -- 'engine' | 'agent' | 'operator'
  PRIMARY KEY(mission_id, workstream_id)
);
```

The engine writes `completed` status to this table (transactional, crash-safe). `workstreams.json` remains the initial plan definition (created by analyst). Status reads come from `workstream_status` table. `packageHandoffs()` is updated to query the table instead of parsing workstreams.json status fields.

This eliminates:
- File-level locking (no `.lock` sentinel needed)
- TOCTOU races (SQLite transactions)
- Partial write corruption (WAL mode)
- Dual-writer conflicts (single authoritative source)

**Confidence**: High -- follows existing SQLite patterns in the codebase. Migration is straightforward.

### 9. Architect respawn context recovery

**Decision**: When the engine respawns an architect during the execute phase, it injects a startup nudge via tmux: "You were respawned. Check inbox for unanswered architecture_question mails."

**Rationale**: Architect is persistent and answers `architecture_question` mails from builders/testers during execution. If respawned, the new session has no conversation context. The mail store preserves all messages, but the architect needs to be explicitly told to process them.

**Implementation**: The `respawnAgent()` function in `mission-tick.ts` accepts a `postRespawnNudge?: string` parameter. For architect capability, this is set to the inbox-check message. The nudge is sent 5 seconds after spawn (allowing boot time).

**Confidence**: High -- simple, low-risk addition.

### 10. Activity-based grace ceiling

**Decision**: Activity-based grace extension has an absolute maximum: `maxTotalWaitMs` per gate (default: 1 hour). After this ceiling, engine nudges regardless of child activity.

**Rationale**: Without a ceiling, a stalled agent that keeps sending trivial tool calls (keeping `lastActivity` fresh) can block mission progress indefinitely. The ceiling ensures missions always make progress or escalate.

**Implementation**: `mission_gate_state` gets an additional column `max_total_wait_ms INTEGER NOT NULL DEFAULT 3600000`. Engine logic:
```
if (totalElapsed > maxTotalWaitMs):
  // absolute ceiling hit, ignore child activity
  nudge or escalate regardless
```

Per-gate overrides: execution WS gates get longer ceilings (4 hours) since real builds take time. Research/planning gates keep 1 hour default.

**Confidence**: High -- simple addition with clear safety benefit.

### 11. Backward compatibility: enabling engine on existing missions

**Decision**: When `graphExecution` transitions from `false` to `true` for an existing mission, the engine seeds its checkpoint from the mission's current `phase:state` instead of starting from `understand:active`.

**Implementation**: In `runMissionTick()`, on first tick where no checkpoint exists for a mission:
```typescript
const existing = checkpointStore.getLatestCheckpoint(mission.id);
if (!existing) {
  // Seed from current mission state
  const startNode = nodeId(mission.phase, mission.state);
  checkpointStore.saveCheckpoint(mission.id, startNode, { seeded: true });
}
```

This ensures the engine starts monitoring from the correct position, not from `understand:active`.

**Confidence**: High -- simple bootstrap logic.

### 12. Audit trail for engine actions

**Decision**: All engine-initiated actions (respawn, nudge, gate advancement, workstream status update) are recorded in the `events.db` event store via `recordMissionEvent()`.

**Event types added**:
- `engine_gate_entered` -- engine enters a new gate
- `engine_nudge_sent` -- engine nudges an agent (includes target, message, nudge_count)
- `engine_agent_respawned` -- engine respawns a dead agent (includes cause, respawn_count)
- `engine_gate_advanced` -- engine advances past a gate (includes trigger, condition details)
- `engine_ws_status_updated` -- engine updates workstream status
- `engine_mission_suspended` -- circuit breaker triggers mission suspension

These events are queryable via `ov trace` and visible in `ov dashboard`.

**Confidence**: High -- follows existing event recording pattern in `src/events/store.ts`.

---

## Phase Subgraph Details

### Understand Phase

```
[ensure-coordinator]
  handler: check coordinator session alive
    alive --> "coordinator_ready"
    dead  --> respawn via startMissionCoordinator() --> "coordinator_ready"

  --coordinator_ready-->

[await-research]  gate: async, graceMs: 120_000
  Engine tick checks:
    1. Has coordinator dispatched analyst? (dispatch mail exists)
       No + grace expired --> nudge coordinator: "dispatch analyst for research"
    2. Is analyst alive? (session state via evaluateHealth)
       Dead --> smart recovery (respawn/suspend)
    3. Are scouts running? (child sessions of analyst)
       Yes --> extend grace (scouts working, analyst managing them)
    4. Has analyst sent research result? (result mail from analyst to coordinator)
       Yes --> "research_complete"

  --research_complete-->

[evaluate]  gate: async, graceMs: 120_000
  Engine tick checks:
    1. Is coordinator alive? --> dead --> recovery
    2. Has coordinator frozen mission? (mission.state === "frozen")
       Yes --> "frozen"
    3. Has coordinator advanced phase? (phase changed to "plan")
       Yes --> "ready"
    4. Grace expired, coordinator idle?
       Nudge: "research complete, evaluate and advance to plan when ready"

  --frozen--> [frozen]  gate: human
    Engine: nothing, waiting for operator.
    (freezeTimeoutMs per config can auto-escalate)
    --answer--> [evaluate]

  --ready--> [terminal: understand-complete]
```

### Plan Phase

```
[dispatch-planning]  graceMs: 120_000
  handler: coordinator dispatched analyst for planning?
  --planning_started-->

[await-plan]  gate: async, graceMs: 300_000
  check: workstreams.json populated? (not empty {version:1, workstreams:[]})
  activity: analyst children (scouts) active --> extend grace
  --plan_written-->

[check-tdd]
  handler: any workstream has tddMode !== "skip"?
  --tdd_required--> [architect-design]
  --no_tdd--> [review]

[architect-design]  gate: async, graceMs: 300_000
  check: architect_ready mail received + architecture.md + test-plan.yaml exist
  activity: architect children (scouts) active --> extend grace
  nudge: coordinator ("spawn architect") or architect ("send architect_ready")
  --architect_ready--> [review]

[review]  subgraph: plan-review cell (EXISTS in src/missions/cells/plan-review.ts)
  graceMs on collect-verdicts: 360_000
  activity: critic sessions active --> extend grace
  --approved--> [await-handoff]
  --stuck--> [review-stuck]

[review-stuck]
  handler: nudge coordinator "plan review stuck after N rounds"
  gate: async, graceMs: 300_000
  if coordinator doesn't respond --> freeze mission (human gate)
  --resolved--> [review]  (re-enter if plan revised)
  --override--> [await-handoff]  (coordinator overrides)

[await-handoff]  gate: async, graceMs: 120_000
  check: phase changed to "execute"? (coordinator called ov mission handoff)
  nudge: coordinator "all prereqs met, call ov mission handoff"
  --handoff_complete--> [terminal: plan-complete]
```

### Execute Phase

```
[ensure-ed]
  handler: ED session alive? dead --> respawn
  --ed_ready-->

[dispatch-ready]
  handler: read workstreams.json (plan definition) + workstream_status table,
           call packageHandoffs() to find dispatchable WS
    any dispatchable --> save IDs to checkpoint, "dispatched"
    none (all waiting) --> "waiting"
  --dispatched--> [await-ws-completion]
  --waiting--> [await-ws-completion]

[await-ws-completion]  gate: async, graceMs: 600_000
  Engine tick checks per tick:
    1. ED alive? --> dead --> recovery
    2. [TDD] Architect alive? --> dead --> recovery (must stay alive for questions)
    3. Any lead active? Their children active?
       Yes --> extend grace
    4. merged mail received for any active WS? --> "ws_merged"
    5. Lead done + no merge yet? --> nudge ED/coordinator
    6. All children done, lead/ED idle? --> nudge with specifics
  --ws_merged-->

[update-status]
  handler: find merged WS, call updateWorkstreamStatus(wsId, "completed")
           (writes to workstream_status SQLite table)
  --status_updated-->

[check-remaining]
  handler: query workstream_status table via packageHandoffs()
    all completed + has TDD? --> "all_done_tdd"
    all completed + no TDD? --> "all_done"
    more dispatchable? --> "more_ws"
    some still active? --> "waiting"
  --more_ws--> [dispatch-ready]     (LOOP back)
  --waiting--> [await-ws-completion] (LOOP back)
  --all_done--> [terminal: execute-complete]
  --all_done_tdd--> [arch-review-dispatch]

[arch-review-dispatch]  graceMs: 120_000
  handler: coordinator dispatches architect "Architecture Review"?
  --review_dispatched-->

[arch-review]  subgraph: architecture-review cell (EXISTS in src/missions/cells/architecture-review.ts)
  graceMs on collect-verdicts: 360_000
  --approved--> [check-refactor]
  --stuck--> nudge coordinator, freeze if no response

[check-refactor]
  handler: architect issued refactor_spec mails?
  --refactor_needed--> [await-refactor]
  --no_refactor--> [await-arch-final]

[await-refactor]  gate: async, graceMs: 600_000
  check: refactor builders completed?
  activity: builder sessions active --> extend grace
  --refactor_done--> [await-arch-final]

[await-arch-final]  gate: async, graceMs: 300_000
  check: architecture_final mail received from architect?
  activity: architect session active --> extend grace
  --architecture_final--> [terminal: execute-complete]
```

**Architect liveness monitoring**: The engine checks architect liveness on every tick during the entire execute phase, not just at specific gates. This ensures builders can always reach the architect with `architecture_question` mails.

**Direct execution variant**: For tier:direct missions (single-workstream, no persistent agents), src/missions/cells/execute-direct-phase.ts provides a simplified execute phase subgraph that skips ED dispatch and architecture review, running the workstream directly through the lead agent.

### Done Phase

```
[summary]  gate: async, graceMs: 180_000
  handler: dispatch analyst "produce final summary"
  check: summary artifact exists in mission artifacts
  activity: analyst session active --> extend grace
  --summary_ready-->

[holdout]
  handler: config.mission.holdout.enabled?
    no --> "skip"
    yes + pass --> "holdout_pass"
    yes + fail + blockOnFailure --> "holdout_fail"
    yes + fail + !blockOnFailure --> "holdout_pass" (warn only)
  --skip--> [cleanup]
  --holdout_pass--> [cleanup]
  --holdout_fail--> gate: async, nudge coordinator to resolve

[cleanup]
  handler:
    1. Extract learnings (ml record)
    2. Stop remaining persistent agents (analyst, architect, ED)
    3. Coordinator commits state (git add + commit, NO push)
  --cleanup_done--> [terminal: mission-complete]
```

---

## Tier-Aware Execution

The graph engine handles missions at three tiers, each running a different subset of lifecycle phases.

### Tier Definitions

`TIER_PHASES` in `src/missions/engine-wiring.ts:75-79` maps each tier to its active phases:

| Tier | Active phases |
|---|---|
| `direct` | `execute`, `done` |
| `planned` | `understand`, `plan`, `execute`, `done` |
| `full` | `understand`, `align`, `decide`, `plan`, `execute`, `done` |

### Graph Construction

`buildLifecycleGraph()` in `src/missions/engine-wiring.ts` filters the full lifecycle graph to include only the nodes for the mission's active phases. Phases not in the tier's list are skipped entirely. When a phase is skipped, the edges that would have connected it to its neighbors are reconstructed to link the preceding active phase directly to the next active phase, preserving graph validity.

This means a `direct` mission's lifecycle graph contains only `execute:active` and `done:active` nodes — the graph engine never sees `understand`, `align`, `decide`, or `plan` nodes.

### Execute-Direct-Phase Cell

For `direct` tier missions, `src/missions/cells/execute-direct-phase.ts` provides a simplified execute phase subgraph (`CELL_TYPE="execute-phase"`) that replaces the standard execute-phase subgraph. It skips persistent-agent orchestration (no execution-director, no architecture review):

```
Nodes:
  dispatch-leads    (handler)
  await-leads-done  (async gate, timeout: 14400s)
  merge-all         (handler)
  complete          (terminal)

Edges:
  dispatch-leads   --dispatched-->  await-leads-done
  await-leads-done --lead_done-->   merge-all
  merge-all        --more_leads-->  await-leads-done   (LOOP: batch remaining leads)
  merge-all        --all_merged-->  complete
```

`dispatch-leads` reads the mission's workstreams and dispatches lead agents directly (no ED intermediary). `await-leads-done` is an async gate that resolves when a lead sends `worker_done` mail. `merge-all` calls `ov merge` for the completed lead's branch and loops back if more leads remain unmerged.

### Engine Wiring

`CELL_REGISTRY` in `src/missions/engine-wiring.ts` maps `"execute-phase"` to either the standard execute-phase subgraph or `execute-direct-phase.ts`, selected based on `mission.tier`. The `startLifecycleEngine()` function wires the correct cell into `buildLifecycleGraph()` before handing the graph to the engine.

---

## Addressing Review Concerns

### C1: Tick-level mutual exclusion (CRITICAL)

**Concern**: Two overlapping async ticks can both evaluate the same gate, causing duplicate respawns or double state transitions.

**Resolution**: Per-mission advisory lock via dedicated `mission_tick_lock` table (one row per mission). `INSERT OR IGNORE` acquires lock atomically. Stale lock cleanup prevents deadlock. See Decision #1 for schema and implementation. Watchdog PID file prevents concurrent `ov watch` instances.

### C2: Subgraph execution model mismatch (CRITICAL)

**Concern**: Design describes tick-based gate evaluation but engine runs subgraphs synchronously via `run()`.

**Resolution**: Gate evaluators are **external to the engine**, living in `mission-tick.ts`. Tick uses `engine.step()` (not `run()`), evaluates gate conditions externally, calls `engine.advanceNode(trigger)` when met. `maxSteps: 5` passed to engine caps all operations including subgraph execution. See "Gate Evaluation Model" section above.

### C3: align/decide phases absent (CRITICAL)

**Concern**: Graph has 5 working phases but design only covers 4.

**Resolution**: `align` and `decide` get auto-advance handlers since they are not used in production missions. See "align and decide Phases" section above.

### H1: Unauthenticated mail-driven transitions (HIGH)

**Concern**: Any agent can send fake `merged` or `architect_ready` mail.

**Resolution**: Gate conditions require corroborating evidence. See Decision #6. Example: `architect_ready` requires mail from agent with `architect` capability AND `architecture.md` file exists on disk. `merged` requires mail AND `git branch --merged` confirms branch.

### H2: workstreams.json TOCTOU (HIGH)

**Concern**: Engine and coordinator both write workstreams.json without coordination.

**Resolution**: Engine is sole writer for `status: "completed"`. See Decision #5. Agents can write `planned -> active`. File lock for read-modify-write. See Decision #8.

### H3: Circuit breaker scope mismatch (HIGH)

**Concern**: Per-capability global breaker vs per-gate per-mission counters — two uncoordinated mechanisms.

**Resolution**: Clean separation. Per-gate `respawn_count` for mission agents. Global capability breaker for non-mission agents only. See Decision #7.

### H4: workstreams.json corruption (HIGH)

**Concern**: Partial write = corrupted JSON = engine can't determine WS status.

**Resolution**: Atomic writes via `persistWorkstreamsFile()` + file lock. See Decision #8.

### H5: Architect respawn breaks architecture_question flow (HIGH)

**Concern**: Respawned architect has no context, unanswered questions in inbox.

**Resolution**: Post-respawn nudge: "Check inbox for unanswered mails." See Decision #9.

### H6: Grace period gaming (HIGH)

**Concern**: Stalled agent keeps `lastActivity` fresh by looping trivial tool calls.

**Resolution**: Absolute `maxTotalWaitMs` ceiling (default 1 hour). See Decision #10.

### Complexity Budget

**Concern**: Adding subgraphs for all 4 phases significantly increases the number of nodes, edges, handlers, and gate evaluators.

**Mitigation**: Each handler is 10-30 lines. Gate evaluators are pure functions that check mail/session/file state and return a trigger string or null. The subgraph definitions are declarative data (node/edge arrays). Complexity is distributed across many small, focused, independently testable units rather than concentrated in one large orchestration function. The alternative (no subgraphs for understand/plan) leaves bugs #96 and #97 unfixed.

### State Machine Explosion

**Concern**: The number of possible states across all subgraphs is large. Testing all transitions is expensive.

**Mitigation**: Each subgraph is tested independently. The engine core (`src/missions/engine.ts`) is already tested for subgraph support. Gate evaluators are pure functions testable with mocked stores. The existing `src/missions/cells/plan-review.ts` and `architecture-review.ts` demonstrate the pattern works at this scale. Integration tests cover the critical paths (happy path + agent death at each gate).

### Race Conditions Between Engine and Agents

**Concern**: Engine advances state while agent is simultaneously acting. For example, engine nudges coordinator to "dispatch analyst" while coordinator is already dispatching.

**Mitigation**:
1. Grace periods provide a buffer -- engine does not act for 2-10 minutes after entering a gate
2. Nudges are advisory, not imperative -- a coordinator receiving "dispatch analyst" while already dispatching simply ignores it
3. `updateWorkstreamStatus()` is idempotent -- writing "completed" when already "completed" is a no-op
4. Gate advancement checks conditions, not actions -- if the condition is already met, the engine advances without nudging

### Single Writer Rigidity

**Concern**: Making the engine the sole writer for workstream status prevents agents from updating status themselves, which may be needed for intermediate states like "active".

**Mitigation**: The engine owns the `planned -> completed` transition (the one that was missing). Agents can still write `planned -> active` (when they start working on a WS) without conflict. The critical invariant is: only the engine writes `completed`, because that triggers `packageHandoffs()` for sequential dispatch. A `ov mission workstream-complete <ws-id>` CLI command is also provided as an escape hatch for operators.

### Checkpoint Collision Between Parent and Subgraph Engines

**Concern**: Parent engine and subgraph engine writing to the same `mission_node_checkpoints` table could collide on `(mission_id, node_id)` keys.

**Mitigation**: Already handled. The engine uses `checkpointKeyPrefix` (`src/missions/engine.ts:82-85`) for subgraph isolation. A subgraph running inside `execute:active` uses the effective key `execute:active:<missionId>`, which is distinct from the parent's `<missionId>`. This was designed for exactly this purpose.

### Daemon Tick Latency

**Concern**: Adding `runMissionTick()` to every daemon tick could increase tick duration beyond acceptable limits (currently ~10-50ms per tick).

**Mitigation**: Mission tick work is lightweight per tick:
1. Query `mission_gate_state` for active gates (single indexed SQL query)
2. For each active gate, check 1-3 conditions (mail query, session state check, file existence)
3. Most ticks: no action taken (within grace period or condition not met)
4. Expensive operations (respawn, triage) are rare and already async

Estimated overhead: 5-15ms per active mission per tick. With 1-2 active missions (typical), this is negligible.

---

## Implementation Plan

### Step 1: Foundation (no dependencies)

- `updateWorkstreamStatus()` function in `src/missions/workstreams.ts` (writes to `workstream_status` SQLite table)
- `workstream_status` table migration in `src/missions/store.ts`
- Graph edge fixes from epic #68 (missing `suspended -> stopped`, `frozen -> failed` edges in `src/missions/graph.ts`)
- Auto-advance handlers for `align` and `decide` phases
- Change `shouldUseEngine()` default from `false` to `true` in `src/missions/engine-wiring.ts:45`
- Add `mission_gate_state` table + `mission_tick_lock` table migrations to `src/missions/store.ts`
- Add `maxSteps` option to `createGraphEngine()` in `src/missions/engine.ts` (propagated to subgraphs)
- Add engine event types to `src/events/store.ts` (`engine_nudge_sent`, `engine_agent_respawned`, etc.)

### Step 2: Mission tick (depends on Step 1)

- New file: `src/watchdog/mission-tick.ts` -- `runMissionTick()` function
- Per-mission advisory lock via `mission_tick_lock` table (INSERT OR IGNORE + stale cleanup)
- Gate evaluation model: `engine.step()` + external condition check + `engine.advanceNode()`
- Engine created with `maxSteps: 5` (caps all operations including subgraph execution)
- Smart recovery logic: cause diagnosis, respawn with backoff, post-respawn nudge for architect
- Per-gate circuit breaker via `mission_gate_state.respawn_count` (NOT global capability breaker)
- `maxTotalWaitMs` ceiling check (absolute grace cap)
- Audit trail: `recordMissionEvent()` for every engine action
- Backward compat: seed checkpoint from current mission phase on first enable
- Wire into `runDaemonTick()` in `src/watchdog/daemon.ts` (call at end of tick)

### Step 3: Phase subgraphs (depends on Step 1, parallel with Step 2)

- Subgraph definitions for understand, plan, execute, done phases
- Small focused handlers per subgraph node (10-30 lines each)
- Wire subgraphs into `buildDefaultGraph()` in `src/missions/graph.ts`
- Extend `CELL_REGISTRY` in `src/missions/engine-wiring.ts` with `startLifecycleEngine()`
- Corroborating evidence checks in gate evaluators (mail + artifact existence + git state)

### Step 4: Integration (depends on Steps 2 + 3)

- Engine-aware `lifecycle.ts`: `missionAnswer()` and `missionHandoff()` notify the engine
- Workstream status update triggers `packageHandoffs()` re-evaluation for sequential dispatch
- `ov mission workstream-complete <ws-id>` CLI command (operator escape hatch)
- Prompt update: `agents/mission-analyst.md` — architecture feedback routing on BLOCK
- End-to-end tests: mission start to completion with simulated agent deaths

---

## Consequences

### Positive

- **Fixes bug #96**: Dead coordinator/analyst detected and respawned; mission advances when research is complete even if coordinator died
- **Fixes bug #97**: Engine writes `status: "completed"` to `workstream_status` table after merge, then re-evaluates `packageHandoffs()` to dispatch WS2
- **Missions no longer stall silently**: Every phase has gate evaluators that detect stuck states and either nudge or escalate
- **Dead agent recovery is automatic**: Smart diagnosis determines the right response (wait, respawn, suspend)
- **Existing infrastructure is maximally reused**: Engine core, checkpoint store, transition history, review cells, role spawners, health evaluation, circuit breaker, resilience engine -- all already exist and are tested

### Negative

- **Increased complexity**: ~15 new handler functions, ~20 gate evaluator conditions, 1 new SQLite table, 1 new module (`mission-tick.ts`)
- **More files to maintain**: Subgraph definitions, gate evaluators, and handlers add ~5-8 new files
- **Tighter coupling between watchdog and missions**: Daemon now has mission-specific logic, though isolated in `mission-tick.ts`
- **Testing surface area increases**: Each gate evaluator needs unit tests with mocked stores; integration tests need simulated agent lifecycle

### Risks

- **Nudge storms**: If grace periods are too short, engine could nudge agents faster than they can process. Mitigated by activity-based grace extension and configurable `nudgeIntervalMs`.
- **False-positive gate advancement**: Engine advances past a gate based on stale or misleading signals. Mitigated by corroborating evidence checks (mail + artifact existence).
- **Checkpoint store growth**: Every engine step writes to `mission_node_checkpoints` and `mission_state_transitions`. For long-running missions with many workstreams, this could grow large. Mitigated by cleanup on mission completion.
- **Subgraph definitions diverge from actual agent behavior**: As agent prompts evolve, subgraphs may model outdated workflows. Mitigated by keeping subgraphs focused on observable conditions (mail received, file exists, phase changed) rather than internal agent logic.

## Implementation Status

All 12 design decisions documented in this ADR have been verified as implemented and operational (audit 2026-04-04). The graph engine runs as the always-on mission lifecycle controller in production across all mission tiers.

---

## References

- Issue #98: Design proposal and discussion
- Bug #96: Mission stuck in understand phase
- Bug #97: WS2 never dispatched after WS1 merge
- Epic #68: Graph engine improvements (batches 2, 3, 6 subsumed)
- `src/missions/engine.ts`: Graph engine core
- `src/missions/checkpoint.ts`: Checkpoint store
- `src/missions/graph.ts`: Lifecycle graph definition
- `src/missions/engine-wiring.ts`: Engine bridge + cell registry
- `src/missions/cells/plan-review.ts`: Plan review cell (reused as plan:review subgraph)
- `src/missions/cells/architecture-review.ts`: Architecture review cell (reused as execute:arch-review subgraph)
- `src/missions/cells/execute-direct-phase.ts`: Direct-tier execute phase cell (dispatch-leads → await-leads-done → merge-all → complete)
- `src/watchdog/daemon.ts`: Watchdog daemon (`runDaemonTick`)
- `src/watchdog/health.ts`: Health evaluation (`evaluateHealth`, ZFC principle)
- `src/watchdog/triage.ts`: Tier 1 AI triage (`triageAgent`)
- `src/missions/roles.ts`: Role spawners
- `src/missions/workstreams.ts`: Workstream schema, `packageHandoffs()`, `persistWorkstreamsFile()`
- `src/resilience/circuit-breaker.ts`: Circuit breaker state machine
- `src/resilience/engine.ts`: Retry logic, backoff calculation
