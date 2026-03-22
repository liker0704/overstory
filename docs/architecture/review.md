# Overstory Architecture Review

Repository review date: 2026-03-22
Inspected commit: `6359e58`

This is an architectural review of the repository as implemented today.

## Post-Refactoring Status (2026-03-22)

Ten commits across Phases 0-4 addressed several findings from the original review:

- **P1 Command concentration**: Partially resolved. `mission.ts` reduced from 3,146 to 281 LOC (91% reduction, logic moved to `src/missions/*`). `dashboard.ts` reduced from 1,222 to 174 LOC (86% reduction, extracted to `src/dashboard/*`). `sling.ts` reduced from 1,294 to 909 LOC (30% reduction, SpawnService extracted to `src/agents/spawn.ts`). `config.ts` reduced from 1,066 to 693 LOC (35% reduction, split into `config-yaml.ts` + `config-types.ts`). `coordinator.ts` at 1,284 LOC remains outstanding.
- **P1 Shared kernel**: Resolved. `src/types.ts` decomposed into 17 domain-specific type files (`src/agents/types.ts`, `src/missions/types.ts`, `src/mail/types.ts`, etc.) with `src/types.ts` retained as a barrel re-export for backward compatibility.
- **P2 Boundary leak**: Resolved. `isProcessRunning` and `tailReadLines` moved to `src/process/util.ts`, removing the watchdog-to-commands dependency.
- **P2 Store schema migrations**: Resolved. Unified migration framework introduced in `src/db/migrate.ts`, adopted by all 6 SQLite stores.
- **P3 Config.ts**: Resolved. Split into `src/config.ts` (loader/orchestration) + `src/config-yaml.ts` (YAML parser/serializer) + `src/config-types.ts` (type definitions).

Remaining items from the original review:
- **P1 Command concentration** for `coordinator.ts` (1,284 LOC) — not yet addressed.
- **P2 Persistent root lifecycle consolidation** for monitor — not yet addressed.

## Findings

### P1. The command layer is acting as the application service layer

Evidence:

- `src/commands/mission.ts` is about 3,146 LOC.
- `src/commands/sling.ts`, `src/commands/coordinator.ts`, `src/commands/dashboard.ts`, `src/commands/mail.ts`, and `src/commands/init.ts` are all very large orchestration-heavy modules.
- Production import analysis shows `commands/*` directly depending on config, sessions, worktree, events, mail, runtimes, missions, agents, metrics, tracker, watchdog, and merge modules.

Why this matters:

- Changes are organized around CLI commands instead of reusable use-case services.
- Business logic, process control, persistence, and operator presentation are often in the same file.
- This raises the cost of testing and makes refactors risky because every large command becomes a mini-monolith.

Concrete risk:

- `sling`, `coordinator`, `mission`, and `watch` are all critical-path orchestration commands. Any future changes to worker lifecycle, mission semantics, or runtime support will keep accumulating into already-large files unless the service seams are extracted.

Refactor seam:

- Extract application services such as:
  - `SpawnAgentService`
  - `PersistentRootService`
  - `MissionLifecycleService`
  - `ObservabilityQueryService`
  - `MergeOrchestrationService`
- Keep `src/commands/*` as thin command adapters that parse CLI options and call those services.

### P1. The shared kernel is overloaded

Evidence:

- `src/types.ts` is imported by roughly 181 files.
- `src/errors.ts` is imported by roughly 103 files.
- `src/config.ts` is imported by roughly 50 files.

Why this matters:

- Small changes in one context propagate globally.
- The repository has partial bounded contexts, but the type/config layer is still largely centralized.
- Global coupling makes parallel refactors harder and hides ownership boundaries.

Concrete risk:

- Mission, runtime, mail, review, recovery, and health concerns all depend on a common schema nucleus.
- This is workable at current scale, but it is already a drag on maintainability and will get worse as command and mission features continue to grow.

Refactor seam:

- Split `src/types.ts` into bounded-context type modules:
  - `types/agent.ts`
  - `types/mission.ts`
  - `types/observability.ts`
  - `types/recovery.ts`
  - `types/runtime.ts`
- Split config access into domain-level readers instead of one global entry point everywhere.

### P2. There is a real boundary leak from infrastructure into the CLI layer

Evidence:

- `src/watchdog/daemon.ts` imports `../commands/nudge.ts`.
- `src/watchdog/swap.ts` imports `../commands/nudge.ts`.

Why this matters:

- The watchdog is an infrastructure/mechanical subsystem.
- It should not depend on CLI command modules to perform core control-plane work.
- This makes the layering harder to reason about and is the clearest current example of an inward dependency flowing the wrong way.

Concrete risk:

- Reusing watchdog behavior outside the CLI command surface becomes harder.
- Testing infra logic pulls in command-layer assumptions and operator-facing semantics.

Refactor seam:

- Move runtime-neutral nudge/send-control behavior into a non-command module such as:
  - `src/coordination/nudge.ts`
  - or `src/agents/control.ts`
- Let `commands/nudge.ts` become a wrapper over that service.

### P2. Persistent root lifecycle consolidation is incomplete

Evidence:

- `src/agents/persistent-root.ts` exists and is used for coordinator and mission-root roles.
- `src/commands/monitor.ts` still performs its own deploy/spawn/record/beacon lifecycle instead of fully reusing the persistent-root abstraction.

Why this matters:

- Coordinator, mission roles, and monitor are the same architectural species: long-lived root agents at project root.
- Duplicating their lifecycle guarantees drift over time.

Concrete risk:

- Runtime deployment, environment setup, readiness handling, session bookkeeping, and completion rules may diverge subtly across root-agent types.

Refactor seam:

- Move monitor start/stop/status onto the same persistent-root lifecycle primitives.
- Keep only monitor-specific beacon text and operator UX in the command file.

### P2. Store schema evolution is inconsistent across operational databases

Evidence:

- `src/mail/store.ts` uses explicit schema versioning and table rebuild logic.
- `src/sessions/store.ts` uses incremental column-introspection migrations.
- `src/missions/store.ts` performs table rebuilds via inline introspection logic.
- Config versioning is formally documented and versioned, but store versioning is more ad hoc and spread across modules.

Why this matters:

- Overstory is state-heavy.
- Recovery, upgrades, and long-lived project state depend on predictable schema evolution.
- Right now each store solves migration differently.

Concrete risk:

- Recovery bundles and upgrade behavior will become harder to reason about as more fields and mission features are added.

Refactor seam:

- Introduce explicit per-database migration modules and schema versions for:
  - `sessions.db`
  - `mail.db`
  - `merge-queue.db`
  - `reviews.db`
  - `metrics.db`
- Keep runtime CRUD code separate from migration code.

### P3. The custom YAML parser is now a significant subsystem

Evidence:

- `src/config.ts` is about 1,066 LOC and includes parser behavior, defaults, migrations, merges, and validation orchestration.

Why this matters:

- Configuration is on the startup path of nearly every command.
- A bespoke parser is acceptable when tiny; here it is already a meaningful maintenance burden.

Concrete risk:

- New config features will continue enlarging a module that already does too much.
- Parser behavior is another surface that must be kept safe during refactors.

Refactor seam:

- At minimum, split parser, loader, and merge logic into separate modules.
- Optionally consider a runtime YAML dependency if the zero-dependency goal is no longer worth the complexity cost.

## Strengths

### 1. Runtime abstraction is a real architectural boundary

`src/runtimes/types.ts` and `src/runtimes/registry.ts` define an actual adapter model, not just a naming convention.

That gives the system:

- runtime portability
- a stable spawn/deploy/readiness contract
- headless and interactive execution support
- a future-proof place for provider-specific behavior

### 2. `.overstory/` is a coherent internal platform root

The project has a strong operational center of gravity:

- config
- databases
- pointers
- artifacts
- worktrees
- logs
- generated prompts

This makes the system inspectable and recoverable.

### 3. The repository has serious test weight

Observed repository metrics:

- 191 production TS files
- 157 test TS files
- about 59k production LOC
- about 78k test LOC

That is a healthy signal for a tool that coordinates stateful, failure-prone workflows.

### 4. Mission mode is mostly isolated as a bounded context

Mission complexity is high, but it is at least concentrated in `src/missions/*` and `src/commands/mission.ts` rather than being smeared across the whole repository.

### 5. Observability is a first-class subsystem

The combination of:

- events
- logs
- metrics
- dashboard
- trace/replay/feed/errors
- review contour
- health scoring

is unusually strong for a CLI orchestrator. This is one of the most valuable parts of the architecture and should be preserved.

## Recommended Refactor Order

### Phase 1. Extract service seams from the largest commands — PARTIALLY COMPLETE

Target first:

- `src/commands/sling.ts` — done (SpawnService extracted to `src/agents/spawn.ts`, 909 LOC remaining)
- `src/commands/coordinator.ts` — **not started** (1,284 LOC)
- `src/commands/mission.ts` — done (281 LOC, logic in `src/missions/*`)
- `src/commands/monitor.ts` — not started
- `src/commands/dashboard.ts` — done (174 LOC, extracted to `src/dashboard/*`)

Desired outcome:

- command files become option parsing + output formatting
- orchestration services become reusable and testable units

### Phase 2. Split the shared kernel — COMPLETE

Target:

- `src/types.ts` — done (decomposed into 17 domain type files, barrel re-export retained)
- `src/config.ts` — done (split into config.ts + config-yaml.ts + config-types.ts)
- selected global error types if needed — not yet needed

Desired outcome:

- clearer ownership boundaries
- less incidental coupling between mission/runtime/review/recovery code

### Phase 3. Repair layering leaks — COMPLETE

Target:

- move nudge/control logic out of command modules — done (`src/process/util.ts`)
- make watchdog depend only on services/infrastructure abstractions — done
- move monitor onto persistent-root lifecycle — not yet done

Desired outcome:

- cleaner directional dependencies
- more reusable infrastructure code

### Phase 4. Centralize schema migrations — COMPLETE

Target:

- store-specific migration modules — done (unified framework in `src/db/migrate.ts`)
- explicit versioning — done (all 6 stores adopted)
- shared migration test patterns — done

Desired outcome:

- safer upgrades
- easier recovery guarantees

### Phase 5. Simplify configuration internals — COMPLETE

Target:

- parser/merge/validation split — done (`config.ts` + `config-yaml.ts` + `config-types.ts`)
- reduce the size and responsibility count of `src/config.ts` — done (1,066 to 693 LOC)

Desired outcome:

- lower startup-path complexity
- cleaner config evolution model

## What I Would Not Change First

These parts are not where the main architectural risk lives:

- the runtime adapter contract
- the `.overstory/` state-root concept
- SQLite as the main operational state layer
- the strong observability surface
- mission mode as a distinct bounded context

Those are strengths or at least good-enough bets. The main gains are in reducing command concentration and clarifying boundaries around that core.

## Bottom Line

The architecture is already more mature than a typical CLI orchestration tool in three areas:

- adapterization
- state visibility
- operational introspection

The main problem is not lack of subsystems. The main problem is that too much orchestration still lives at the CLI command edge instead of in a thinner application-service layer.

That is a refactorable problem, not a foundational rewrite problem.
