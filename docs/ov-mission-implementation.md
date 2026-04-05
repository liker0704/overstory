# `ov mission` Implementation Guide

This document turns the agreed `ov mission` RFC into a concrete implementation
plan and implementation reference for Overstory.

Primary design source:

- [`docs/ov-mission.md`](./ov-mission.md)
- [`docs/ov-mission-usage.md`](./ov-mission-usage.md)

Current status:

- `ov mission v1` shipped in Epic #13 and is no longer experimental.
- This document remains the implementation reference and acceptance contract.
- The PR-order sections below are still useful, but some are now historical
  delivery context rather than future work.

This guide is intentionally implementation-oriented:

- recommended PR order
- migration sequence
- files likely to change
- test strategy
- rollout and fallback rules

It is written for incremental delivery.
The goal is to land `ov mission` without destabilizing the current fast path.

---

## 1. Implementation Principles

Implementation should follow these rules:

- keep the current `ov coordinator` fast path working
- reuse existing Overstory primitives wherever possible
- land infrastructure before prompts
- land persistence before UI polish
- land mission-mode features behind explicit `ov mission` entrypoints
- prefer additive migrations over destructive rewrites

Recommended order:

1. runtime substrate
2. mission persistence
3. mission CLI shell
4. tracker/workstream bridge
5. execution-role plumbing
6. mission mail protocol
7. brief/spec refresh chain
8. mission status/dashboard
9. result bundle and review
10. prompt files and rollout

---

## 2. Non-Goals For The First Implementation

The first implementation should **not** try to solve everything.

Explicit non-goals for `v1`:

- multiple concurrent active missions per project
- multiple peer mission analysts
- a new global analytics database
- a new runtime `AgentState = paused`
- a new standalone mission event store
- fully polished mission TUI before the lifecycle works
- replacing the current coordinator fast path

---

## 3. Recommended Delivery Shape

Treat the work as a sequence of small PRs, not one giant branch.

Recommended PR sequence:

1. `Phase 0 groundwork: root agents + run model`
2. `MissionStore + filesystem layout`
3. `ov mission` command skeleton
4. `workstreams/task bridge + execution handoff skeleton`
5. `Execution Director runtime path`
6. `Mission Analyst runtime path`
7. `mail protocol + pause metadata + selective ingress`
8. `brief/spec revision chain`
9. `status/dashboard integration`
10. `mission events + result bundle export`
11. `mission review contour migration`
12. `prompt files + end-to-end smoke tests`

Each PR should end in a runnable, testable state.

---

## 4. Phase 0: Runtime Groundwork

This is the mandatory substrate work before mission mode can be real.

### Goal

Generalize the current single-root coordinator assumptions into a reusable
persistent-root abstraction while keeping existing behavior intact.

### Main outcomes

- multiple persistent root capabilities are possible
- current coordinator behavior still works
- mission mode can start `Mission Analyst` and `Execution Director`
- run model can represent `stopped`

### Primary files

- [`src/commands/coordinator.ts`](/home/liker/projects/os-eco/overstory/src/commands/coordinator.ts)
- [`src/types.ts`](/home/liker/projects/os-eco/overstory/src/types.ts)
- [`src/sessions/store.ts`](/home/liker/projects/os-eco/overstory/src/sessions/store.ts)
- [`src/commands/status.ts`](/home/liker/projects/os-eco/overstory/src/commands/status.ts)
- [`src/commands/agents.ts`](/home/liker/projects/os-eco/overstory/src/commands/agents.ts)
- runtime capability allowlists or guards if they key off capabilities

### Step-by-step

1. Extract the persistent-root lifecycle logic out of `coordinator.ts`.
2. Introduce an internal abstraction, for example:
   - `startPersistentAgent(...)`
   - `stopPersistentAgent(...)`
   - `getPersistentAgentStatus(...)`
   - `readPersistentAgentOutput(...)`
3. Keep the existing `ov coordinator ...` commands as wrappers over that
   internal abstraction.
4. Extend capability handling so new root capabilities are first-class:
   - `mission-analyst`
   - `execution-director`
5. Extend `RunStatus` from:
   - `active | completed | failed`
   to:
   - `active | completed | failed | stopped`
6. Add migrations and tests for the new `runs.status` value.
7. Preserve current null-run root coordinator behavior.

### Key design rule

The persistent coordinator should remain a project-root session outside the
mission-owned run.

Mission-owned run membership in `v1`:

- `mission-analyst`
- `execution-director`
- all mission leads and downstream workers

The coordinator is linked via mission metadata, not rebound into the mission
run.

### Acceptance criteria

- existing `ov coordinator start/status/output/stop` still work
- a new root capability can be started without cloning coordinator logic
- `RunStatus = stopped` is accepted by types, storage, and tests
- `status.ts` behavior around null-run root sessions remains correct

### Tests to add or update

- root lifecycle unit tests around the new abstraction
- `RunStatus` migration tests
- status tests proving null-run root sessions still appear in run-scoped views
- command tests proving existing coordinator commands are behaviorally unchanged

---

## 5. Phase 1: Mission Persistence And Filesystem Layout

### Goal

Introduce mission identity, mission summary storage, and mission filesystem
layout without yet implementing the full mission workflow.

### Main outcomes

- mission root directory exists
- missions table exists in `sessions.db`
- `current-mission.txt` exists
- compact mission state can be queried fast

### Primary files

- [`src/sessions/store.ts`](/home/liker/projects/os-eco/overstory/src/sessions/store.ts)
- new mission-store module near existing session/run stores
- [`src/types.ts`](/home/liker/projects/os-eco/overstory/src/types.ts)
- [`docs/ov-mission.md`](/home/liker/projects/os-eco/overstory/docs/ov-mission.md)

### Required schema

Add `missions` table with fields aligned to the RFC:

- `id`
- `slug`
- `objective`
- `run_id`
- `state`
- `phase`
- `first_freeze_at`
- `pending_user_input`
- `pending_input_kind`
- `pending_input_thread_id`
- `reopen_count`
- `artifact_root`
- `paused_workstream_ids`
- `paused_lead_names`
- `pause_reason`
- `coordinator_session_id`
- `analyst_session_id`
- `execution_director_session_id`
- `started_at`
- `updated_at`
- `completed_at`

### Step-by-step

1. Add `MissionState`, `MissionPhase`, `PendingInputKind`, and `MissionSummary`
   types.
2. Add a `MissionStore` in the same style as the current run/session stores.
3. Implement:
   - `createMission`
   - `getMission`
   - `getActiveMission`
   - `listMissions`
   - `bindSessions`
   - `setPhase`
   - `setPendingInput`
   - `clearPendingInput`
   - `markFrozen`
   - `reopenMission`
   - `completeMission`
4. Create filesystem layout:
   - `.overstory/missions/<mission-id>/`
   - `mission.md`
   - `decisions.md`
   - `open-questions.md`
   - `research/current-state.md`
   - `research/_summary.md`
   - `plan/workstreams.json`
   - `workstreams/<workstream-id>/brief.md`
5. Add `.overstory/current-mission.txt`.
6. Define the source-of-truth rule in code comments and tests:
   - `missions` table is indexed state authority
   - `current-mission.txt` is convenience pointer

### Acceptance criteria

- a mission can be created and looked up
- one active mission invariant is enforced
- paused-workstream fields round-trip correctly
- `current-mission.txt` stays in sync with active mission creation/terminalization

### Tests to add

- MissionStore CRUD and transition tests
- migration tests for `missions` table
- pointer-file tests for `current-mission.txt`
- invariant tests for pending input and paused metadata

---

## 6. Phase 2: `ov mission` Command Shell

### Goal

Add the user-facing mission command family before full execution logic exists.

### Primary files

- new [`src/commands/mission.ts`](/home/liker/projects/os-eco/overstory/src/commands)
- command registration / CLI wiring
- [`src/commands/coordinator.ts`](/home/liker/projects/os-eco/overstory/src/commands/coordinator.ts)

### Required commands

- `ov mission start`
- `ov mission status`
- `ov mission output`
- `ov mission answer`
- `ov mission artifacts`
- `ov mission handoff`
- `ov mission pause`
- `ov mission resume`
- `ov mission refresh-briefs`
- `ov mission complete`
- `ov mission stop`
- `ov mission list`
- `ov mission show`
- `ov mission bundle`

### Step-by-step

1. Add the CLI command surface with no-op or minimally functional handlers.
2. Wire `ov mission start` to:
   - ensure coordinator exists
   - create mission-owned run immediately
   - write `current-run.txt`
   - create mission row
   - write `current-mission.txt`
   - create artifact root
3. Make `ov mission status` read `MissionSummary`.
4. Make `ov mission artifacts` print the derived artifact root and known paths.
5. Make `ov mission stop` terminalize the mission and clear pointers.
6. Make `ov mission list/show` use `MissionStore`.

### Important invariant

`ov mission start` must create the mission-owned run immediately.
Do **not** delay run creation until execution handoff.

### Acceptance criteria

- user can start and inspect a mission before execution exists
- mission start writes both pointer files
- mission stop clears both pointer files
- terminal mission moves the mission-owned run into terminal state

### Tests to add

- command tests for all `ov mission` subcommands
- start/stop pointer synchronization tests
- tests for active mission refusal when one mission already exists

---

## 7. Phase 3: Tracker / Workstream Bridge

### Goal

Make workstreams real runtime entities instead of a second planning namespace.

### Primary files

- new mission planning helpers
- [`src/commands/sling.ts`](/home/liker/projects/os-eco/overstory/src/commands/sling.ts)
- tracker integration layer used today by coordinator/sling
- mission artifact generation code

### Required rule

Every workstream in `v1` must have a canonical `taskId`.

### Minimum `workstreams.json` shape

```json
{
  "workstreams": [
    {
      "id": "backend-scheduling",
      "taskId": "task-123",
      "objective": "Implement backend scheduled publishing",
      "fileScope": ["src/jobs/**", "src/models/post.ts"],
      "dependsOn": [],
      "briefPath": "workstreams/backend-scheduling/brief.md",
      "status": "planned"
    }
  ]
}
```

### Step-by-step

1. Add a parser/validator for `workstreams.json`.
2. Decide how `taskId` is created:
   - coordinator creates tracker task before final handoff
   - or mission planning creates them as part of decomposition
3. Ensure `taskId` is present before any lead spawn.
4. Ensure `Execution Director` uses `taskId` as the runtime bridge into `ov sling`.

### Acceptance criteria

- every workstream can be mapped to one tracker task
- every lead can be dispatched with an actual `taskId`
- dashboard and session views can still reason in task-centric terms

### Tests to add

- workstreams schema validation tests
- task bridge tests
- dispatch preparation tests that reject missing `taskId`

---

## 8. Phase 4: Mission Prompts And Artifact Generation

### Goal

Land the new mission-mode prompt files and artifact writers only after the
runtime and persistence substrate exists.

### New prompt files

- [`agents/coordinator-mission.md`](/home/liker/projects/os-eco/overstory/agents)
- [`agents/mission-analyst.md`](/home/liker/projects/os-eco/overstory/agents)
- [`agents/execution-director.md`](/home/liker/projects/os-eco/overstory/agents)
- [`agents/lead-mission.md`](/home/liker/projects/os-eco/overstory/agents)

### Step-by-step

1. Materialize the prompt skeletons from the RFC into real files.
2. Keep existing:
   - [`agents/coordinator.md`](/home/liker/projects/os-eco/overstory/agents/coordinator.md)
   - [`agents/lead.md`](/home/liker/projects/os-eco/overstory/agents/lead.md)
   unchanged for the fast path.
3. Add mission-mode prompt selection logic.
4. Add artifact writers for:
   - `mission.md`
   - `decisions.md`
   - `open-questions.md`
   - `research/current-state.md`
   - `research/_summary.md`
   - `workstreams/<id>/brief.md`

### Acceptance criteria

- mission mode uses different prompt files than fast path
- fast path remains unchanged
- artifact files can be created and updated in the expected layout

### Tests to add

- prompt selection tests
- artifact creation tests
- regression tests proving fast path still uses old prompts

---

## 9. Phase 5: Mission Analyst Runtime Path

### Goal

Make `Mission Analyst` a real mission-scoped root actor with clear lifecycle and
selective ingress.

### Primary files

- persistent-root lifecycle implementation from Phase 0
- mail protocol layer
- mission artifact update helpers
- status/dashboard surfaces

### Step-by-step

1. Start `mission-analyst` during `ov mission start`.
2. Attach analyst session to the mission-owned run.
3. Store `analystSessionId` in `MissionSummary`.
4. Ensure analyst stop on:
   - mission complete
   - mission stop
5. Implement selective-ingress rules in code and routing, not only in prompt:
   - only cross-stream
   - brief-invalidating
   - shared-assumption changing
   - accepted-semantics risk
6. Ensure local non-blocking findings stay at the lead layer.

### Acceptance criteria

- analyst lifecycle is mission-scoped and deterministic
- analyst is visible in mission-aware status surfaces
- analyst is not a default sink for every local finding

### Tests to add

- lifecycle tests for analyst start/stop
- routing tests for selective ingress
- status tests showing analyst presence

---

## 10. Phase 6: Execution Director Runtime Path

### Goal

Make `Execution Director` a real root runtime role that owns dispatch and
execution motion after handoff.

### Primary files

- persistent-root lifecycle
- mission handoff logic
- [`src/commands/sling.ts`](/home/liker/projects/os-eco/overstory/src/commands/sling.ts)
- mission command layer
- status/dashboard surfaces

### Step-by-step

1. Add `execution-director` as root capability.
2. Start it only after:
   - mission freeze
   - planning
   - workstream/task bridge creation
   - brief generation
3. Ensure it joins the existing mission-owned run.
4. Formalize how it dispatches leads through `ov sling`.
5. Update hierarchy assumptions so it may spawn only leads.
6. Keep lead-to-worker hierarchy unchanged under the new director.

### Required runtime questions to answer in code

- how does `Execution Director` pass parent identity into `ov sling`
- how is depth represented for a root actor that is not coordinator
- how do hierarchy checks distinguish:
  - persistent root actors
  - lead layer
  - worker layer

### Acceptance criteria

- execution director can dispatch leads through the existing runtime
- direct builder/scout/reviewer dispatch remains disallowed
- execution handoff is a real runtime boundary

### Tests to add

- hierarchy tests in `sling.ts`
- execution-director dispatch tests
- runtime tests proving only leads are spawned

---

## 11. Phase 7: Mission Mail Protocol

### Goal

Implement the typed mission protocol on top of existing mail infrastructure.

### Primary files

- [`src/mail/client.ts`](/home/liker/projects/os-eco/overstory/src/mail/client.ts)
- mail types in [`src/types.ts`](/home/liker/projects/os-eco/overstory/src/types.ts)
- mission command/runtime code

### Required protocol types

- `mission_finding`
- `analyst_resolution`
- `execution_guidance`
- `analyst_recommendation`
- `execution_handoff`
- `mission_resolution`

### Step-by-step

1. Extend typed mail payload support.
2. Implement request/reply polling convention:
   - send typed request in thread
   - nudge
   - poll for reply
   - timeout = operational error
3. Enforce routing rules:
   - `Lead -> Mission Analyst` only for selective-ingress findings
   - `Lead -> Execution Director` for operational state
   - `Mission Analyst -> Coordinator` only for mission-contract impact
   - `Mission Analyst <-> Execution Director` for brief propagation and impact sync

### Acceptance criteria

- mission mail types are typed, routable, and testable
- coordinator does not receive raw technical chatter
- execution director does not become the knowledge router

### Tests to add

- typed payload round-trip tests
- polling/request-reply tests
- route validation tests

---

## 12. Phase 8: `brief.md` -> Lead Spec Revision Chain

### Goal

Prevent stale local execution after brief refreshes or mission reopen/refreeze.

### Primary files

- lead mission prompt/runtime logic
- spec generation code
- `.overstory/specs/`
- new spec metadata helper
- [`agents/lead.md`](/home/liker/projects/os-eco/overstory/agents/lead.md) as behavioral reference

### `v1` chosen model

Keep current spec path:

- `.overstory/specs/<task-id>.md`

Add metadata:

- `.overstory/specs/<task-id>.meta.json`

### Minimum metadata direction

Suggested fields:

- `taskId`
- `workstreamId`
- `briefPath`
- `briefRevision`
- `specRevision`
- `status`: `current | stale | superseded`
- `generatedAt`
- `generatedBy`

### Step-by-step

1. Add spec metadata format.
2. Teach mission lead to generate specs from current brief revision.
3. On brief refresh:
   - mark prior spec metadata stale
   - regenerate spec
   - block or refresh local execution before resume
4. Ensure builders/reviewers are dispatched against the current spec revision.
5. Ensure reviewers know which spec revision they are validating against.

### Acceptance criteria

- a brief refresh cannot silently leave a lead working on a stale spec
- builder/reviewer dispatch references current spec revision
- stale-spec state is inspectable

### Tests to add

- spec generation tests
- stale-spec invalidation tests
- refresh/resume tests
- worker dispatch tests proving revision linkage

---

## 13. Phase 9: Pause / Resume And Mission Summary Propagation

### Goal

Implement mission-layer pause semantics without changing `AgentState` in `v1`.

### Primary files

- mission runtime coordination layer
- `MissionStore`
- [`src/commands/status.ts`](/home/liker/projects/os-eco/overstory/src/commands/status.ts)
- [`src/commands/dashboard.ts`](/home/liker/projects/os-eco/overstory/src/commands/dashboard.ts)

### Step-by-step

1. Add paused-workstream tracking to `MissionSummary`.
2. Ensure `pausedWorkstreamCount` is derived, not separately authoritative.
3. Add mission-level pause/resume instructions through mail/control flow.
4. Show pause state in:
   - `ov mission status`
   - `ov dashboard`
5. Keep runtime `AgentState` unchanged in `v1`.

### Acceptance criteria

- mission-layer pause state is operator-visible
- runtime health state remains unchanged
- reopen can pause only affected workstreams

### Tests to add

- summary pause metadata tests
- mission status tests
- dashboard mission strip tests

---

## 14. Phase 10: Mission Status And Dashboard

### Goal

Surface mission lifecycle cleanly without overloading agent health.

### Primary files

- [`src/commands/status.ts`](/home/liker/projects/os-eco/overstory/src/commands/status.ts)
- [`src/commands/dashboard.ts`](/home/liker/projects/os-eco/overstory/src/commands/dashboard.ts)

### Step-by-step

1. Add mission summary object to shared operator status data.
2. Show:
   - mission id
   - state
   - phase
   - pending input
   - first freeze info
   - reopen count
   - active/paused workstreams
   - runtime presence of coordinator / analyst / execution director
3. Keep agent-state rendering independent.

### Acceptance criteria

- mission state is visible without breaking agent health UI
- paused workstreams and pending input are visible
- analyst and execution director are visible when applicable

---

## 15. Phase 11: Mission Events And Result Bundle

### Goal

Preserve enough retained mission evidence for later analysis and improvement.

### Primary files

- [`src/events/store.ts`](/home/liker/projects/os-eco/overstory/src/events/store.ts)
- mission command/runtime layer
- bundle export helper
- mission artifact directory

### Required direction

- reuse `events.db`
- mission narrative keyed by mission-owned `runId`
- `eventType = "mission"`
- high-signal events only

### Step-by-step

1. Add mission event type to the event layer.
2. Add mission narrative helper on top of the event store.
3. Export result bundle to:
   - `.overstory/missions/<mission-id>/results/manifest.json`
   - `summary.json`
   - `events.jsonl`
   - `sessions.json`
   - `metrics.json`
   - optional `review.json`
4. Materialize/refresh exports on terminal mission state.
5. Allow later regeneration if missing or stale.

### Acceptance criteria

- terminal mission leaves behind a result bundle
- bundle remains derived, not new source of truth
- mission output can be reconstructed without reading raw tmux noise

### Tests to add

- mission event filtering tests
- result bundle export tests
- regeneration tests

---

## 16. Phase 12: Mission Review Contour Migration

### Goal

Extend the existing deterministic review system to support mission-level review.

### Primary files

- [`src/review/types.ts`](/home/liker/projects/os-eco/overstory/src/review/types.ts)
- [`src/review/store.ts`](/home/liker/projects/os-eco/overstory/src/review/store.ts)
- [`src/review/staleness.ts`](/home/liker/projects/os-eco/overstory/src/review/staleness.ts)
- review analyzers
- review command/reporting surfaces

### Important warning

This is **not** a trivial enum tweak.
Treat it as a real contour migration.

### Step-by-step

1. Extend `ReviewSubjectType` with `mission`.
2. Migrate DB schema checks and tests.
3. Define mission review analyzer inputs:
   - MissionSummary
   - mission artifacts
   - mission narrative
   - mission metrics
4. Define mission review dimensions:
   - clarity
   - actionability
   - completeness
   - signal-to-noise
   - correctness-confidence
   - coordination-fit
5. Extend staleness rules for mission review.
6. Export latest mission review to `results/review.json`.

### Acceptance criteria

- mission reviews can be stored and queried in existing review infrastructure
- mission staleness is tracked deterministically
- mission review is exportable

### Tests to add

- subject type tests
- store schema tests
- staleness tests
- analyzer tests

---

## 17. Phase 13: Prompts, Rollout, And End-to-End Validation

### Goal

Turn the new runtime and persistence into a usable mission mode.

### Step-by-step

1. Enable mission prompt files in real dispatch/runtime flows.
2. Add smoke scenarios:
   - start mission
   - answer clarification
   - freeze
   - create workstreams/tasks
   - execution handoff
   - lead dispatch
   - reopen
   - refreeze
   - complete
   - export result bundle
3. Add crash/recovery scenarios:
   - lost `current-mission.txt`
   - lost `current-run.txt`
   - paused workstreams after restart
4. Add explicit fast-path regression tests for existing `ov coordinator`.

### Manual test scenarios

Recommended manual scenarios:

1. mission with no reopen
2. mission with one reopen and selective pause
3. mission stopped intentionally
4. mission where brief refresh forces spec regeneration
5. mission where analyst receives multiple findings and local non-blocking ones
   stay with leads

### Rollout recommendation

Roll out in this order:

1. hidden/experimental mission commands
2. internal dogfood in one repo
3. enable status/dashboard mission strip
4. enable result bundle export
5. enable review contour migration
6. only then promote as supported workflow

---

## 18. Detailed File Checklist

This is the practical “where code will move” checklist.

### Very likely to change

- [`src/types.ts`](/home/liker/projects/os-eco/overstory/src/types.ts)
- [`src/sessions/store.ts`](/home/liker/projects/os-eco/overstory/src/sessions/store.ts)
- [`src/commands/coordinator.ts`](/home/liker/projects/os-eco/overstory/src/commands/coordinator.ts)
- [`src/commands/sling.ts`](/home/liker/projects/os-eco/overstory/src/commands/sling.ts)
- [`src/commands/status.ts`](/home/liker/projects/os-eco/overstory/src/commands/status.ts)
- [`src/commands/dashboard.ts`](/home/liker/projects/os-eco/overstory/src/commands/dashboard.ts)
- [`src/events/store.ts`](/home/liker/projects/os-eco/overstory/src/events/store.ts)
- [`src/mail/client.ts`](/home/liker/projects/os-eco/overstory/src/mail/client.ts)
- [`src/review/types.ts`](/home/liker/projects/os-eco/overstory/src/review/types.ts)
- [`src/review/store.ts`](/home/liker/projects/os-eco/overstory/src/review/store.ts)
- [`src/review/staleness.ts`](/home/liker/projects/os-eco/overstory/src/review/staleness.ts)

### New files likely needed

- `src/commands/mission.ts`
- mission store/helper module
- result bundle exporter module
- mission narrative helper
- `agents/coordinator-mission.md`
- `agents/mission-analyst.md`
- `agents/execution-director.md`
- `agents/lead-mission.md`

### Existing prompt files that must remain intact

- [`agents/coordinator.md`](/home/liker/projects/os-eco/overstory/agents/coordinator.md)
- [`agents/lead.md`](/home/liker/projects/os-eco/overstory/agents/lead.md)
- other current worker prompts used by fast path

---

## 19. Implementation Order That Should Be Avoided

Do **not** implement in this order:

- prompts first
- dashboard first
- second analyst first
- mission review first

These will create impressive demos with weak runtime foundations.

Wrong order smells:

- prompts exist but no MissionStore
- workstreams exist but have no canonical `taskId`
- brief refresh exists but no spec revision chain
- mission stop exists but run completion semantics are still undefined
- mission review exists but there is no result bundle to review

---

## 20. Definition Of Done For The First Real Mission Mode

Epic #13 closes this checklist.
The criteria remain listed here as the regression contract for `v1`:

- a mission can be started, inspected, answered, and stopped through `ov mission`
- a mission-owned run is created immediately and terminalized correctly
- mission analyst lifecycle is deterministic and mission-scoped
- execution director can dispatch leads through the real runtime
- each workstream has a canonical `taskId`
- brief refresh can invalidate/regenerate lead specs safely
- selective pause works at mission-layer state
- mission status and dashboard surfaces show mission lifecycle correctly
- mission result bundle is exported on terminal states
- mission review contour can score completed/stopped missions
- current fast-path `ov coordinator` behavior still works

`ov mission v1` satisfies the majority of this definition of done and is
the real mission mode for complex tasks. Known gaps documented in the
[verification review](./epic-13-verification-review.md):

- **Stale-spec safety** (partial): spec freshness checks are gated on the
  `--spec` flag and `current-mission.txt` pointer; if the pointer is lost or
  builders are spawned without `--spec`, the guard is bypassed.
- **Mission review CLI** (improved): functional tests exist but command-level
  proof is lighter than the rest of the flow.

---

## 21. Mission Tiers And Graph Engine Implementation

### TIER_PHASES Mapping

The active phases for each tier are declared in `src/missions/engine-wiring.ts`:

```typescript
export const TIER_PHASES: Record<MissionTier, readonly string[]> = {
  direct: ["execute", "done"],
  planned: ["understand", "plan", "execute", "done"],
  full: ["understand", "align", "decide", "plan", "execute", "done"],
};
```

The graph engine uses this mapping to determine which phase cells to activate
when a mission transitions tiers.

### Cell Registries

Two separate registries exist in `src/missions/engine-wiring.ts`:

- **`CELL_REGISTRY`** — review cells: `plan-review`, `architecture-review`
- **`PHASE_CELL_REGISTRY`** — phase cells: `understand-phase`, `plan-phase`,
  `execute-phase`, `done-phase`

> Note: `align` and `decide` phases do **not** have dedicated cell files.
> They use auto-advance handlers defined in `src/missions/handlers/auto-advance.ts`
> and registered via `autoAdvancePhases` in `src/missions/graph.ts`. These phases
> immediately trigger `phase_advance` and are only active in the `full` tier.

For `direct` tier missions, `execute-phase` is swapped for
`executeDirectPhaseCell` from `src/missions/cells/execute-direct-phase.ts`.

### Execute-Direct Phase

`src/missions/cells/execute-direct-phase.ts` implements the simplified execute
subgraph used only for `direct` tier missions.

Flow:

```
dispatch-leads → await-leads-done → merge-all → (loop or complete)
```

- `await-leads-done` is an `async` gate with a 4-hour timeout
- No Execution Director is involved
- Coordinator dispatches leads directly
- Used only when `tier = 'direct'`

### Key Implementation Files

| File | Purpose |
|------|---------|
| `src/missions/engine-wiring.ts` | `TIER_PHASES`, `CELL_REGISTRY`, `buildLifecycleGraph()`, `buildLifecycleHandlers()` |
| `src/missions/cells/execute-direct-phase.ts` | Direct tier execute cell |
| `src/missions/cells/execute-phase.ts` | Standard execute cell (planned/full) |
| `src/missions/cells/understand-phase.ts` | Understand phase cell |
| `src/missions/cells/plan-phase.ts` | Plan phase cell |
| `src/missions/cells/done-phase.ts` | Done phase cell |
| `src/watchdog/mission-tick.ts` | Engine tick, grace periods, dead agent recovery |
| `src/commands/mission-tier.ts` | CLI for `ov mission tier show/set` |

### Tier Transition Mechanics

Tier transitions are handled by `src/commands/mission-tier.ts`:

- Only upward transitions are allowed (`TIER_ORDER` enforced:
  `direct < planned < full`)
- Escalation kills active leads, clears gate states and checkpoints
- Sets the start phase: `direct` → `execute`; `planned`/`full` → `understand`
- Spawns analyst for `planned`/`full`; spawns Execution Director for `full`
- Sends a tier-specific prompt to coordinator via tmux
