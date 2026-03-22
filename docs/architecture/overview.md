# Overstory Architecture Overview

Repository review date: 2026-03-22
Inspected commit: `6359e58`

## 1. What This System Is

Overstory is a CLI-first multi-agent orchestration engine for coding agents.

At the repository level, the project is best described as:

- a **modular monolith**
- with a **Commander-based CLI application shell**
- backed by **SQLite + filesystem state inside `.overstory/`**
- with **adapter boundaries** around external runtimes, trackers, git, tmux, and sibling os-eco tools

It is **not** a strict hexagonal architecture today. The codebase has some adapter-style boundaries, but many command handlers still orchestrate persistence, external process control, and domain logic directly.

## 2. Shape Of The Codebase

Implementation footprint from direct repository inspection:

| Metric | Value |
| --- | --- |
| Production TypeScript files | 191 |
| Test TypeScript files | 157 |
| Production TypeScript LOC | 59,010 |
| Test TypeScript LOC | 78,305 |
| Command modules in `src/commands` | 44 |
| Mission modules in `src/missions` | 24 |
| Runtime adapters in `src/runtimes` | 14 |
| Base agent definitions in `agents/` | 20 |

Large production hotspots:

| File | Approx LOC | Role |
| --- | ---: | --- |
| `src/missions/lifecycle.ts` | 1,601 | mission lifecycle operations (extracted from mission.ts) |
| `src/watchdog/daemon.ts` | 1,316 | tier-0 health loop, escalation, reconciliation |
| `src/commands/coordinator.ts` | 1,284 | persistent coordinator lifecycle |
| `src/commands/mail.ts` | 993 | message CLI and delivery flows |
| `src/commands/sling.ts` | 909 | worker spawn CLI wiring, delegates to SpawnService |
| `src/missions/workstream-control.ts` | 710 | workstream control operations |
| `src/config.ts` | 693 | config parsing, loading, migration orchestration |
| `src/agents/spawn.ts` | 646 | SpawnService — agent spawn orchestration (extracted from sling) |
| `src/commands/mission.ts` | 281 | mission CLI wiring only, delegates to src/missions/* |
| `src/commands/dashboard.ts` | 174 | dashboard CLI wiring, delegates to src/dashboard/* |

High fan-in shared modules:

| Module | Imported by approx files | Meaning |
| --- | ---: | --- |
| `src/types.ts` | 139 | barrel re-export of 17 domain type files (see `src/*/types.ts`) |
| `src/errors.ts` | 103 | global error vocabulary |
| `src/config.ts` | 50 | global config entry point |
| `src/events/store.ts` | 36 | common observability store |
| `src/sessions/store.ts` | 35 | common lifecycle store |

Note: `src/types.ts` was decomposed from a monolithic shared-kernel schema into a barrel re-export. Actual type definitions now live in 17 domain-specific type files (`src/agents/types.ts`, `src/missions/types.ts`, `src/mail/types.ts`, etc.). New code should import directly from the domain type files.

## 3. Architectural Categories

### 3.1 Interface Layer

| Category | Primary paths | Responsibility |
| --- | --- | --- |
| CLI entry | `src/index.ts` | global flags, command registration, top-level error handling |
| Command handlers | `src/commands/*` | application shell, operator UX, orchestration entry points |
| Prompt assets | `agents/`, `templates/` | base agent behavior, overlay templates, hook templates |

Notes:

- `src/index.ts` is a thin router, but `src/commands/*` contains most application logic.
- The command layer is the main integration surface between user intent and the orchestration engine.

### 3.2 Orchestration Core

| Category | Primary paths | Responsibility |
| --- | --- | --- |
| Agent lifecycle | `src/agents/*` | manifest, identities, overlays, hooks, persistent-root lifecycle |
| Mission orchestration | `src/missions/*`, `src/commands/mission.ts` | long-running objective management, mission artifacts, workstreams, mission roles |
| Merge orchestration | `src/merge/*`, `src/commands/merge.ts` | merge queue and tiered conflict resolution |
| Health/recovery | `src/watchdog/*`, `src/recovery/*` | liveness, escalation, snapshot/restore, reconciliation |

### 3.3 Persistence And State

| Category | Primary paths | Responsibility |
| --- | --- | --- |
| Session state | `src/sessions/*` | agent sessions, runs, compatibility bridge |
| Mail state | `src/mail/*` | inter-agent messaging, delivery state, DLQ, broadcast |
| Event state | `src/events/*` | tool events, timelines, headless event tailing |
| Metrics state | `src/metrics/*` | usage and cost tracking |
| Review state | `src/review/*` | deterministic review contour and staleness |
| Mission state | `src/missions/store.ts` | mission records inside `sessions.db` |

State model style:

- SQLite is used for durable structured state.
- The filesystem is used for logs, agent artifacts, pointers, prompts, and worktree-local files.
- `.overstory/` acts as the internal platform root.

### 3.4 Integration And Execution Substrate

| Category | Primary paths | Responsibility |
| --- | --- | --- |
| Runtime adapters | `src/runtimes/*` | spawn, instruction deployment, readiness detection, transcripts, RPC/headless modes |
| Task tracker adapters | `src/tracker/*` | seeds, beads, GitHub issue bridge |
| Worktree control | `src/worktree/*` | git worktrees, tmux sessions, headless subprocesses |
| Sibling tool clients | `src/mulch/*`, `src/canopy/*`, `src/beads/*` | os-eco integrations |

### 3.5 Observability, Evaluation, And Operational Quality

| Category | Primary paths | Responsibility |
| --- | --- | --- |
| Logging/presentation | `src/logging/*` | console theming, formatting, NDJSON logger, sanitizer |
| Health scoring | `src/health/*` | operational scoring and recommendations |
| Doctor checks | `src/doctor/*` | setup and consistency diagnostics |
| Eval framework | `src/eval/*`, `evals/` | scenario-based system evaluation |
| Review contour | `src/review/*` | deterministic scoring of sessions, handoffs, specs, missions |

## 4. Bounded Context View

Another useful way to slice the repository is by business concern rather than by layer:

| Bounded context | Core paths | Main entities |
| --- | --- | --- |
| Bootstrapping and project install | `src/commands/init.ts`, `src/config*.ts` | config, manifest, hooks, bootstrap tools |
| Live agent execution | `src/commands/sling.ts`, `src/agents/*`, `src/worktree/*`, `src/runtimes/*` | agent, identity, overlay, worktree, runtime |
| Persistent coordination | `src/commands/coordinator.ts`, `src/agents/persistent-root.ts`, `src/commands/monitor.ts` | coordinator, monitor, persistent session |
| Mission mode | `src/commands/mission.ts`, `src/missions/*` | mission, workstream, mission role, mission artifacts |
| Coordination messaging | `src/mail/*`, `src/commands/mail.ts`, `src/commands/nudge.ts` | message, thread, delivery state, DLQ |
| Merge and delivery | `src/merge/*`, `src/commands/merge.ts` | merge entry, resolution tier, conflict history |
| Observability | `src/events/*`, `src/metrics/*`, `src/commands/status.ts`, `src/commands/dashboard.ts`, `src/commands/inspect.ts`, `src/commands/trace.ts`, `src/commands/replay.ts`, `src/commands/feed.ts`, `src/commands/logs.ts`, `src/commands/errors.ts`, `src/commands/costs.ts` | event, metric, feed, timeline |
| Recovery | `src/recovery/*`, `src/commands/snapshot.ts`, `src/commands/recover.ts`, `src/commands/resume.ts` | snapshot, bundle, reconciliation report |
| Operational judgment | `src/review/*`, `src/health/*`, `src/doctor/*`, `src/eval/*` | review record, health signal, doctor check, eval scenario |

## 5. State Surfaces Inside `.overstory/`

The internal platform directory is architecturally central.

| Surface | Type | Purpose |
| --- | --- | --- |
| `config.yaml` | file | project configuration |
| `config.local.yaml` | file | local override layer |
| `agent-manifest.json` | file | registered agent definitions and capabilities |
| `current-run.txt` | pointer file | active run cache |
| `current-mission.txt` | pointer file | active mission cache |
| `session-branch.txt` | pointer file | merge target / session branch coordination |
| `sessions.db` | SQLite | sessions, runs, missions |
| `mail.db` | SQLite | inter-agent messages and delivery lifecycle |
| `merge-queue.db` | SQLite | merge queue |
| `events.db` | SQLite | event stream |
| `metrics.db` | SQLite | usage/cost records |
| `reviews.db` | SQLite | review contour results |
| `agents/` | filesystem | identities, checkpoints, handoffs, mission role prompts |
| `logs/` | filesystem | per-agent session logs and headless stdout/stderr |
| `specs/` | filesystem | task specs |
| `worktrees/` | filesystem | isolated git worktrees |
| `missions/<id>/` or mission artifact root | filesystem | mission documents, workstreams, results |

Design implication:

- Most workflows are eventually about reading or mutating one of these surfaces.
- The architecture is easier to understand by following state transitions than by following only class/module boundaries.

## 6. Runtime Adapter Portfolio

Registered runtime adapters from `src/runtimes/registry.ts`:

| Runtime | Stability | Primary instruction path | Execution style |
| --- | --- | --- | --- |
| `claude` | stable | `.claude/CLAUDE.md` | interactive tmux |
| `sapling` | stable | `SAPLING.md` | headless subprocess |
| `codex` | experimental | `AGENTS.md` | interactive/headless support via adapter |
| `pi` | experimental | `.claude/CLAUDE.md` | interactive or RPC-oriented |
| `copilot` | experimental | `.github/copilot-instructions.md` | interactive tmux |
| `cursor` | experimental | `.cursor/rules/overstory.md` | interactive tmux |
| `gemini` | experimental | `GEMINI.md` | interactive/headless support via adapter |
| `opencode` | experimental | `AGENTS.md` | interactive/headless support via adapter |
| `qwen` | experimental | `AGENTS.md` | interactive/headless support via adapter |

Architectural assessment:

- This is a real adapter boundary, not documentation theater.
- `src/runtimes/types.ts` is one of the cleanest abstractions in the repository.
- Headless vs tmux execution is the main complexity axis inside the runtime layer.

## 7. Command Surface Map

Top-level command groups by architectural responsibility:

| Group | Commands |
| --- | --- |
| Bootstrap and install | `init`, `hooks`, `update`, `upgrade`, `ecosystem`, `completions` |
| Agent lifecycle | `sling`, `stop`, `attach`, `resume`, `recover`, `snapshot`, `worktree`, `agents` |
| Persistent orchestration | `coordinator`, `discover`, `monitor`, `supervisor` |
| Mission mode | `mission` |
| Messaging and control | `mail`, `nudge`, `spec`, `group`, `run`, `prime`, `log` |
| Delivery | `merge` |
| Observability | `status`, `dashboard`, `inspect`, `trace`, `replay`, `feed`, `logs`, `errors`, `costs`, `metrics` |
| Operational quality | `review`, `health`, `next-improvement`, `doctor`, `eval`, `clean`, `watch` |

Important interpretation:

- The command surface is broad, but it all terminates into a smaller set of internal engines: sessions, mail, runtimes, worktree/tmux, missions, watchdog, merge, review.
- The repository is command-rich but engine-poor: many operator entry points, fewer deeply shared service objects.

## 8. Dependency Shape Between Categories

Observed directionality from production code imports:

- `commands -> config/json/logging/errors/types`
- `commands -> sessions/worktree/events/mail/missions/runtimes`
- `missions -> sessions/events/review/metrics`
- `watchdog -> runtimes/sessions/worktree/events/mail/mulch`
- `runtimes -> agents/types/config`

Most important non-ideal edge:

- `watchdog -> commands` exists today, because watchdog code imports CLI nudge helpers.

That edge matters in the review because it means infrastructure code depends on the interface layer.

## 9. High-Level Component Diagram

```mermaid
flowchart LR
    User["Operator or agent runtime"] --> CLI["src/index.ts<br/>Commander CLI"]
    CLI --> Commands["src/commands/*"]

    Commands --> Orchestration["agents | missions | merge | watchdog | recovery"]
    Commands --> Stores["sessions | mail | events | metrics | review"]
    Commands --> Adapters["runtimes | tracker | worktree | mulch | canopy"]

    Orchestration --> Stores
    Orchestration --> Adapters

    Stores --> DotOverstory[".overstory/*<br/>dbs + logs + pointers + artifacts"]
    Adapters --> External["git | tmux | sd/bd/gh | agent CLIs"]
```

## 10. State Topology Diagram

```mermaid
flowchart TD
    Config["config.yaml"] --> Commands
    Manifest["agent-manifest.json"] --> Commands
    Commands --> Sessions["sessions.db"]
    Commands --> Mail["mail.db"]
    Commands --> Merge["merge-queue.db"]
    Commands --> Events["events.db"]
    Commands --> Metrics["metrics.db"]
    Commands --> Reviews["reviews.db"]
    Commands --> Logs["logs/"]
    Commands --> Agents["agents/"]
    Commands --> Specs["specs/"]
    Commands --> Worktrees["worktrees/"]
    Commands --> MissionArtifacts["mission artifact root"]

    Sessions --> Missions["missions table / mission state"]
    Logs --> Events
    Agents --> Reviews
    Specs --> Reviews
    MissionArtifacts --> Missions
```

## 11. Bottom-Line Classification

If this repository had to be tagged with one concise architecture label, the most accurate one is:

**CLI-driven modular monolith for multi-agent orchestration, with adapterized runtime integration and a shared `.overstory/` operational state platform.**
