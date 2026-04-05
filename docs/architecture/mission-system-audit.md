> **Superseded — 2026-04-05**
>
> This audit was written against the pre-engine codebase. Key findings have since been addressed:
>
> - **F-01**: The graph execution engine is now the authoritative mission lifecycle controller, running inside the watchdog daemon tick via `runMissionTick()` in `src/watchdog/mission-tick.ts`.
> - **F-03**: `lifecycle.ts` has been fully split from 1,900 LOC into a 23-line barrel re-export (`lifecycle.ts`) with logic distributed across `lifecycle-helpers.ts`, `lifecycle-ops.ts`, `lifecycle-start.ts`, `lifecycle-suspend.ts`, `lifecycle-terminate.ts`, and `lifecycle-types.ts`.
> - **F-04**: Phase cells are now tested; the `execute-direct-phase.ts` cell and existing `plan-review.ts` / `architecture-review.ts` cells all have coverage.
> - **F-05**: Auto-advance behavior for `align` and `decide` phases is documented in the ADR.
> - **F-06**: ADR status is Accepted (previously Proposed).
>
> See [`adr-graph-engine-lifecycle.md`](adr-graph-engine-lifecycle.md) for the full architecture decision and [`workflows.md`](workflows.md) for the updated workflow diagrams.

# Mission System Audit

Date: 2026-04-02
Scope: Full audit of `ov mission` workflow — code, architecture, documentation, tests, gaps.

## Executive Summary

The mission system is a **13,580 LOC** subsystem across **40 source files** (+767 LOC in watchdog integration) that orchestrates long-running multi-agent objectives through a graph execution engine. It is the most complex subsystem in overstory.

**Verdict:** The system is architecturally sound but has significant implementation gaps:
- A dual control path (CLI advisory vs engine enforcing) that can desync state
- 2 phantom phases (`align`, `decide`) that do nothing
- `onTimeout` declared in types but never invoked anywhere
- 15 modules with zero test coverage, including the most critical ones
- `lifecycle.ts` at 1,900 LOC violates the project's 500-line limit

---

## 1. Component Map

### Core (5,494 LOC)

| File | LOC | Purpose |
|------|-----|---------|
| `lifecycle.ts` | 1,900 | Start, stop, complete, pause, resume, answer, update — the "fat controller" |
| `store.ts` | 1,098 | SQLite store: 7 tables, 5 migrations, WAL mode |
| `workstream-control.ts` | 848 | Handoff, brief refresh, workstream pause/resume |
| `graph.ts` | 550 | Default graph builder, validation, Mermaid renderer |
| `render.ts` | 507 | CLI output: status, show, list, output, artifacts, graph |
| `engine.ts` | 300 | Graph execution: step/run/advanceNode loop |
| `engine-wiring.ts` | 291 | Cell registries, bridge between engine and lifecycle |

### Support (4,000+ LOC)

| File | Purpose |
|------|---------|
| `types.ts` | All domain types (~180 lines) |
| `roles.ts` | Start/stop mission roles (coordinator, analyst, execution-director) |
| `messaging.ts` | Mail send/drain/nudge helpers |
| `context.ts` | Beacon, prompt materialization, artifact scaffolding |
| `runtime-context.ts` | Pointer files, active mission resolution |
| `events.ts` | Mission event recording |
| `narrative.ts` | Narrative builder for mission output |
| `bundle.ts` | Export mission artifacts to results/ |
| `learnings.ts` | Extract mulch learnings from completed missions |
| `review.ts` | Post-mission review generation |
| `holdout.ts` | 3-level holdout validation |
| `pause.ts` | Workstream pause/resume in store |
| `checkpoint.ts` | Node checkpoint + transition persistence |
| `score.ts` | Mission health scoring |
| `ingress.ts` | Finding escalation classifier |
| `workstreams.ts` | Workstream file parsing + task tracker sync |
| `brief-refresh.ts` | Brief hash staleness detection |
| `spec-meta.ts` | Spec metadata files |
| `architecture.ts` | architecture.md parser |
| `test-plan.ts` | test-plan.yaml parser |
| `tdd.ts` | TDD mode helpers |
| `mail-bridge.ts` | Mission-scoped mail routing |
| `plan-review.ts` | Brief path guard (legacy) |
| `artifact-staleness.ts` | Artifact freshness checks |

### Cells (Phase subgraphs)

| File | Subgraph |
|------|----------|
| `cells/understand-phase.ts` | ensure-coordinator → await-research → evaluate → complete |
| `cells/plan-phase.ts` | dispatch-planning → await-plan → check-tdd → [architect] → review → await-handoff |
| `cells/execute-phase.ts` | ensure-ed → dispatch loop → [arch-review] → complete |
| `cells/done-phase.ts` | summary → holdout → cleanup → complete |
| `cells/plan-review.ts` | dispatch-critics → collect-verdicts → convergence → [loop\|approved\|escalate] |
| `cells/architecture-review.ts` | Same as plan-review with weighted severity |
| `cells/types.ts` | Cell interfaces |

### Watchdog Integration (767 LOC)

| File | LOC | Purpose |
|------|-----|---------|
| `watchdog/mission-tick.ts` | 424 | Per-tick engine evaluation, grace periods, nudging, dead agent recovery |
| `watchdog/gate-evaluators.ts` | 343 | 14 gate evaluators: check mail/filesystem/state for gate resolution |

### CLI Surface

17 subcommands under `ov mission`: `start`, `stop`, `complete`, `pause`, `resume`, `answer`, `update`, `list`, `show`, `status`, `output`, `artifacts`, `graph`, `handoff`, `refresh-briefs`, `bundle`, `extract-learnings`, `holdout`, `workstream-complete`.

---

## 2. State Machine

### Phases

```
understand → align → decide → plan → execute → done
```

`align` and `decide` auto-advance immediately (see Finding F-01).

### States per phase

```
active ←→ frozen (human gate)
  ↓          ↓
suspended ←──┘
  ↓
(resume → active)
```

### Terminal states (done phase only)

`done:completed`, `done:stopped`, `done:failed`

---

## 3. Findings

### Critical

#### F-01: Dual control path — advisory CLI vs enforcing engine

**Location:** `lifecycle.ts:116-145` (`adviseGraphTransition`) vs `engine.ts:139-225` (`step()`)

The CLI commands (start, stop, complete, pause, resume, answer) use `adviseGraphTransition()` which validates the transition but **always updates `currentNode` regardless of validity** — it only logs a warning event on illegal transitions. The graph engine in the watchdog uses strict edge-based traversal that will reject invalid transitions.

This means:
- A CLI command can move the mission to a state the engine considers unreachable
- The engine may then get stuck because the current node has no matching edges
- Two separate code paths control the same state, with no synchronization

**Impact:** State desync between CLI and engine. The engine may halt, nudge indefinitely, or hit the absolute ceiling and suspend the mission.

**Recommendation:** Either make `adviseGraphTransition` reject invalid transitions (throw/return error), or remove the advisory path entirely and route all state changes through the engine.

---

#### F-02: `onTimeout` declared but never implemented

**Location:** `cells/types.ts` (`CellGraphNode.onTimeout`), `cells/plan-review.ts:51` (`onTimeout: "timeout-escalate"`)

The `onTimeout` field is declared on `CellGraphNode` and set to `"timeout-escalate"` on `collect-verdicts` in plan-review. However, `engine.ts` has **zero references** to `onTimeout`. The watchdog's absolute ceiling handler (`mission-tick.ts:259-280`) suspends the entire mission rather than invoking the timeout handler.

**Impact:** Review cells that time out will suspend the whole mission instead of escalating gracefully. The declared timeout behavior is dead code.

**Recommendation:** Either implement `onTimeout` in the engine/tick or remove the field from types and cells.

---

#### F-03: `lifecycle.ts` at 1,900 LOC (4x over limit)

**Location:** `src/missions/lifecycle.ts`

The project convention is 500 LOC max per file. `lifecycle.ts` contains start, stop, complete, suspend, terminalize, pause, resume, answer, update, extract-learnings — 10+ major operations in one file with deeply nested control flow.

`terminalizeMission()` alone is ~400 lines with self-kill detection, role teardown, descendant cleanup, mail drain, holdout gates, bundle export (twice), review generation, learnings extraction, and arch-sync agent spawn.

**Impact:** Hard to test (it's untested), hard to review, high merge conflict probability.

**Recommendation:** Extract into focused modules: `mission-start.ts`, `mission-terminate.ts`, `mission-freeze.ts`, `mission-suspend.ts`.

---

### High

#### F-04: 15 critical modules have zero test coverage

| Module | Risk |
|--------|------|
| `lifecycle.ts` | Core operations — untested |
| `mission-tick.ts` | Watchdog integration — untested |
| `gate-evaluators.ts` | Gate resolution logic — untested |
| `cells/understand-phase.ts` | Phase cell — untested |
| `cells/plan-phase.ts` | Phase cell — untested |
| `cells/execute-phase.ts` | Phase cell — untested |
| `cells/done-phase.ts` | Phase cell — untested |
| `handlers/auto-advance.ts` | Auto-advance handler — untested |
| `messaging.ts` | Mail helpers — untested |
| `mail-bridge.ts` | Mail routing — untested |
| `render.ts` | CLI output — untested |
| `events.ts` | Event recording — untested |

The tested modules (engine, store, checkpoint, graph, cells/plan-review, cells/architecture-review) are well tested with real SQLite and mock stores. But the **glue layer** that connects everything is the untested part.

**Impact:** Regressions in core workflows go undetected. The most bug-prone code (lifecycle orchestration, gate evaluation) has zero automated verification.

---

#### F-05: Phantom phases `align` and `decide`

**Location:** `graph.ts:46` (`autoAdvancePhases`), `handlers/auto-advance.ts:11-12`

Two of the six phases (`align` and `decide`) exist in the graph with auto-advance handlers that immediately fire `phase_advance`. They have no phase cells in `PHASE_CELL_REGISTRY`. They generate freeze/unfreeze edges that can never be reached (auto-advance fires before any freeze can occur).

Real lifecycle: `understand → plan → execute → done` (4 phases).
Declared lifecycle: `understand → align → decide → plan → execute → done` (6 phases).

**Impact:** Misleading graph output, unnecessary graph complexity (12 extra edges for phantom phases), operator confusion when `ov mission graph` shows phases that do nothing.

**Recommendation:** Either implement `align`/`decide` or remove them from the graph entirely. If they're planned for future use, document that clearly and remove the auto-advance handlers.

---

#### F-06: ADR status "Proposed" but code is shipped and running

**Location:** `docs/architecture/adr-graph-engine-lifecycle.md:3`

The ADR that defines the graph engine lifecycle architecture has `Status: Proposed`, but the engine code is fully implemented and running in production via the watchdog daemon. The implementation guide and usage guide both describe the engine as operational.

**Impact:** Confusing for new contributors — unclear whether the engine is the intended path or experimental.

**Recommendation:** Update ADR status to `Accepted` or `Implemented`.

---

### Medium

#### F-07: `--mission-id` vs `--mission` flag inconsistency

**Location:** `commands/mission.ts`

- 14 subcommands use `--mission <id-or-slug>` via `resolveExplicitMission()`
- `bundle` uses `--mission-id` with its own resolution logic
- `update` handles `--mission` uniquely via `addActiveMission()`/`removeActiveMission()` try/finally

**Recommendation:** Standardize on `--mission` everywhere.

---

#### F-08: `holdout` subcommand not documented

**Location:** `commands/mission.ts:346-413`

The `holdout` subcommand is registered in the CLI but absent from the CLAUDE.md command reference.

---

#### F-09: Double `exportBundle()` in `terminalizeMission()`

**Location:** `lifecycle.ts:607-649`

Bundle is exported twice: once before review generation, once after (to include the review). Both use `force: true`. This is intentional but wasteful — the first export is immediately overwritten.

**Recommendation:** Export once after review, or make the first export conditional on review being disabled.

---

#### F-10: `workstream-complete` opens raw DB connection

**Location:** `commands/mission-workstream-complete.ts:38-49`

This command opens a `MissionStore` to resolve the mission, then opens a **second raw** `bun:sqlite` `Database` to call `updateWorkstreamStatus()`. No other command does this.

**Recommendation:** Add `updateWorkstreamStatus()` to `MissionStore` interface.

---

#### F-11: Mock store duplication across test files

**Location:** `engine.test.ts`, `engine-wiring.test.ts`, `cells/plan-review.test.ts`, `cells/architecture-review.test.ts`

Each file defines its own ~200-line `createMockCheckpointStore()` and `createMockMissionStore()`. Four copies of the same mock implementation.

**Recommendation:** Extract to `src/missions/test-helpers.ts`.

---

#### F-12: Mission lifecycle audit bugs (16) not tracked

**Location:** `docs/mission-lifecycle-audit.md`

The lifecycle audit identified 16 numbered bugs (BUG-1 through BUG-16). No document or issue tracker records which have been fixed.

Notable unfixed items from the audit:
- BUG-14: `terminalizeMission()` multi-step DB updates not wrapped in a transaction
- BUG-8: `freeze()`/`unfreeze()` bypass `adviseGraphTransition` entirely (related to F-01)

---

### Low

#### F-13: Gate evaluator hardcoded grace periods

**Location:** `mission-tick.ts:44-52`

Grace periods (2-10 min) and absolute ceilings (1-4 hours) are hardcoded constants, not configurable. These values may need tuning per-project.

---

#### F-14: `evaluateGate()` default returns `{ met: false }` silently

**Location:** `gate-evaluators.ts:302-343`

Unknown gate node names hit the default case and return `{ met: false }` with no nudge target or message. A typo in a node name would cause the engine to wait indefinitely with no feedback.

**Recommendation:** Log a warning for unrecognized gate names.

---

## 4. Complexity Assessment

### Is the system over-engineered?

**Partially yes.** The core concept (graph-based mission lifecycle with watchdog-driven gate evaluation) is sound for the problem it solves. However:

| Aspect | Assessment |
|--------|-----------|
| Graph engine | Appropriate — clean abstraction, well tested |
| Phase cells | Appropriate — modular, composable |
| Gate evaluators | Appropriate — simple mail/file checks |
| Dual control path | Over-engineered — two ways to change state, neither complete |
| Phantom phases | Unnecessary — 2 phases that auto-skip add complexity for zero value |
| `lifecycle.ts` | Under-modularized — too much in one file |
| Review cells | Appropriate but `onTimeout` is dead code |
| 17 CLI subcommands | Borderline — `output` vs `status` vs `show` overlap significantly |
| Holdout validation | Appropriate for quality gates |
| Bundle/learnings | Appropriate for mission artifacts |

### Estimated active vs dead code

- **Active code:** ~12,000 LOC (used in real workflows)
- **Dead/phantom code:** ~500 LOC (align/decide phases, `onTimeout`, first bundle export)
- **Support code with low ROI:** ~1,000 LOC (narrative rendering, score calculations used only in status display)

---

## 5. Documentation Status

### Existing docs (all current unless noted)

| Document | Type | Status |
|----------|------|--------|
| `docs/ov-mission.md` | Design RFC / v1 reference | Current |
| `docs/ov-mission-implementation.md` | Implementation guide | Current (historical) |
| `docs/ov-mission-usage.md` | Operator guide | Current |
| `docs/architecture/adr-graph-engine-lifecycle.md` | ADR | **"Proposed" — should be "Accepted"** |
| `docs/mission-lifecycle-audit.md` | Code audit | Current (snapshot) |
| `docs/analysis/watchdog-mission-tick-audit.md` | Code audit | Current (snapshot) |
| `docs/mission-monitoring.md` | Operator protocol | Current |
| `docs/mission-e2e-smoke.md` | Verification record | Historical |
| `docs/epic-13-verification-review.md` | Gap audit | Historical |
| `docs/epic-13-fix-plan.md` | Fix plan | Historical (likely completed) |
| `agents/coordinator-mission.md` | Agent prompt | Current |
| `agents/mission-analyst.md` | Agent prompt | Current |
| `agents/execution-director.md` | Agent prompt | Current |
| `agents/lead-mission.md` | Agent prompt | Current |

### Documentation gaps

1. **No single architecture doc** describing the complete mission system as built (this audit partially fills that gap)
2. **`mission_gate_state` table** — undocumented schema and behavior
3. **Flash Quality TDD mode** — referenced in agent prompts but never explained
4. **Plan-review convergence loop** — no documentation of critic types, verdict formats, escalation rules
5. **Audit bug tracking** — 16 bugs identified, none tracked in issue system
6. **`align`/`decide` phases** — no explanation of why they exist but do nothing

---

## 6. Recommendations (Priority Order)

1. **Fix dual control path (F-01)** — Make `adviseGraphTransition` enforce or route through engine. This is the highest-risk architectural issue.
2. **Add tests for lifecycle.ts, mission-tick.ts, gate-evaluators.ts (F-04)** — These are the most critical untested modules.
3. **Split lifecycle.ts (F-03)** — Extract into 4-5 focused modules.
4. **Remove or implement phantom phases (F-05)** — Eliminate `align`/`decide` if not planned.
5. **Implement or remove `onTimeout` (F-02)** — Dead type field creates false expectations.
6. **Update ADR status (F-06)** — Change to "Accepted".
7. **Track lifecycle audit bugs (F-12)** — Create issues for BUG-1 through BUG-16.
8. **Standardize CLI flags (F-07, F-08)** — Fix `--mission-id`, document `holdout`.

---

## 7. File Index

```
src/missions/                        # 40 files, 13,580 LOC (source only)
  types.ts                           # Domain types
  store.ts                           # SQLite store (7 tables)
  graph.ts                           # Default graph, validation
  engine.ts                          # Graph execution engine
  engine-wiring.ts                   # Cell registries, bridge
  lifecycle.ts                       # CLI-facing operations (1,900 LOC!)
  handlers.ts                        # Handler registry + noop
  handlers/auto-advance.ts           # align/decide auto-advance
  cells/types.ts                     # Cell interfaces
  cells/understand-phase.ts          # Understand phase cell
  cells/plan-phase.ts                # Plan phase cell
  cells/execute-phase.ts             # Execute phase cell
  cells/done-phase.ts                # Done phase cell
  cells/plan-review.ts               # Plan review convergence cell
  cells/architecture-review.ts       # Architecture review cell
  roles.ts                           # Mission role lifecycle
  messaging.ts                       # Mail helpers
  context.ts                         # Beacon, prompts, artifacts
  runtime-context.ts                 # Pointer files, resolution
  events.ts                          # Event recording
  workstreams.ts                     # Workstream parsing
  workstream-control.ts              # Handoff, workstream ops
  pause.ts                           # Workstream pause
  checkpoint.ts                      # Node checkpoints
  narrative.ts                       # Mission narrative
  render.ts                          # CLI output
  score.ts                           # Health scoring
  review.ts                          # Post-mission review
  bundle.ts                          # Artifact bundling
  learnings.ts                       # Learnings extraction
  holdout.ts                         # Holdout validation
  brief-refresh.ts                   # Brief staleness
  spec-meta.ts                       # Spec metadata
  architecture.ts                    # architecture.md parser
  test-plan.ts                       # test-plan.yaml parser
  tdd.ts                             # TDD mode helpers
  mail-bridge.ts                     # Mail routing
  plan-review.ts                     # Brief guard (legacy)
  ingress.ts                         # Finding escalation
  artifact-staleness.ts              # Artifact freshness

src/watchdog/
  mission-tick.ts                    # Per-tick engine + gate evaluation
  gate-evaluators.ts                 # 14 gate evaluators
```
