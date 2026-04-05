# `ov mission` Operator Guide

`ov mission v1` is implemented and no longer experimental.
Use this document for day-to-day operation.

Related references:

- [Design / RFC context](./ov-mission.md)
- [Implementation / acceptance contract](./ov-mission-implementation.md)

## When To Use `ov mission`

Use `ov mission` for larger tasks where you want the system to:

1. clarify the objective first
2. build mission artifacts and workstreams
3. dispatch execution only after handoff
4. keep mission state durable across runtime interruptions

Use the fast-path `ov coordinator` flow when the task is already clear and you
do not need mission-level freeze / handoff discipline.

## Mission Tiers

Missions run at one of three tiers. The tier determines which phases are active
and which roles are spawned.

| Tier | Phases | Roles Spawned | When To Use |
|------|--------|---------------|-------------|
| **direct** | execute → done | Coordinator + Leads (no analyst, no ED) | Task is already clear. Skip understanding and planning. Coordinator dispatches leads directly. |
| **planned** | understand → plan → execute → done | Coordinator + Analyst | Moderate complexity. System explores and plans before executing. |
| **full** | understand → align → decide → plan → execute → done | Coordinator + Analyst + Execution Director + (optional) Architect | Complex or ambiguous. Full phase discipline with alignment and decision steps. |

### Tier Selection Guidance

- **direct**: objective already decomposed, no research needed, fastest path
- **planned**: needs exploration, standard mission flow with analyst
- **full**: ambiguous, multi-subsystem, needs alignment, architectural decisions

### Assess Mode

New missions start in assess mode (`tier=null`). The coordinator evaluates
complexity and selects a tier:

```bash
ov mission tier show
ov mission tier show --json
ov mission tier set planned
```

Tiers can only escalate upward (`direct` → `planned` → `full`), never downward.
Escalation kills active leads, clears gate states and checkpoints, and restarts
from the appropriate phase.

---

## Core Lifecycle

### 1. Start a mission

```bash
ov mission start --slug auth-refresh --objective "Stabilize the auth mission"
```

What this does immediately:

- creates a mission-owned run
- writes `.overstory/current-mission.txt` and `.overstory/current-run.txt`
- creates `.overstory/missions/<mission-id>/...`
- starts the long-lived `mission-analyst`

Execution does **not** start yet.
`execution-director` starts only at `ov mission handoff`.

### 2. Answer pending mission questions

If the mission is waiting on clarification, answer through:

```bash
ov mission answer --body "Admin-only. Keep passwords. No external provider."
```

Or:

```bash
ov mission answer --file answers.md
```

Useful inspection commands while the mission is forming:

```bash
ov mission status
ov mission output
ov mission artifacts
```

## Mission Artifacts

The important paths are:

```text
.overstory/current-mission.txt
.overstory/current-run.txt
.overstory/missions/<mission-id>/
.overstory/missions/<mission-id>/plan/workstreams.json
.overstory/specs/<task-id>.md
.overstory/specs/<task-id>.meta.json
```

`current-mission.txt` is only a convenience pointer.
Mission-aware recovery now falls back to the durable `missions` table when that
pointer is stale or missing.

## Handoff And Execution

Once planning artifacts are ready, hand off execution:

```bash
ov mission handoff
```

Runtime requirements enforced by `v1`:

- every workstream in `plan/workstreams.json` must have a canonical `taskId`
- dispatch happens against the canonical task before runtime spawn
- `execution-director` can spawn only `lead`
- mission `builder` / `reviewer` dispatch requires `--spec`
- stale or missing mission spec metadata blocks spawn / resume

After handoff, monitor the mission with:

```bash
ov mission status
ov mission output
ov status
ov dashboard
```

Shared `ov status` and `ov dashboard` now show mission runtime presence for:

- coordinator
- mission analyst
- execution director

## Refresh Briefs And Resume Workstreams

When a brief changes, refresh the affected workstream:

```bash
ov mission refresh-briefs --workstream ws-auth
```

Effect:

- the workstream is paused at mission level
- the current spec metadata is marked stale
- missing metadata is treated as regeneration-required, not as a pass

To make the workstream resumable again, regenerate the current spec from the
current brief:

```bash
ov spec write task-auth --agent lead-auth --workstream-id ws-auth --brief-path .overstory/missions/<mission-id>/plan/ws-auth.md < auth-spec.md
```

Then resume:

```bash
ov mission resume ws-auth
```

`ov mission resume` will refuse to continue if the workstream has no current
spec metadata.

If you need a manual operator pause without changing runtime agent state:

```bash
ov mission pause ws-auth --reason "Waiting on product clarification"
```

## Finish Or Abort

Complete the mission:

```bash
ov mission complete
```

Or stop it intentionally:

```bash
ov mission stop
```

Both terminal paths export a mission result bundle.
You can also force bundle regeneration later:

```bash
ov mission bundle --mission-id <mission-id> --force
```

## Review Commands

Mission review now has command-level proof for both list and single-mission
paths:

```bash
ov review missions
ov review mission <mission-id-or-slug>
```

Add `--json` when you want machine-readable output.

## Recommended Operator Loop

For most real missions, the operator-facing loop is:

```bash
ov mission start --slug <slug> --objective "<objective>"
ov mission status
ov mission output
ov mission answer --body "..."
ov mission handoff
ov status
ov dashboard
ov mission refresh-briefs --workstream <id>
ov spec write <task-id> --agent <lead-name> --workstream-id <id> --brief-path <brief-path> < spec.md
ov mission resume <id>
ov mission complete
ov review mission <mission-id-or-slug>
```

## Graph Engine & Waiting State

The mission graph engine runs inside the watchdog daemon (`ov watch`), one tick
per interval. It is the runtime controller for automated phase transitions and
agent lifecycle management.

**What it does:**

- Evaluates graph gates each tick and auto-advances phases when conditions are
  met (e.g., scout finishes → advance to next step)
- Nudges stuck agents when their grace period expires
- Detects dead agents (zombie tmux sessions) and auto-resumes them
- Enforces timeout ceilings (`maxTotalWaitMs`) and escalates when exceeded

**Configuration in `config.yaml`:**

```yaml
mission:
  graphExecution: true          # Enable/disable engine (default: true)
  maxConcurrent: 1              # Max active missions (default: 1)
  freezeTimeoutMs: 1800000      # Frozen mission auto-unfreeze (default: 30 min)
```

Set `graphExecution: false` to disable automatic phase transitions and rely on
manual advancement instead.

**Grace period overrides:**

The engine waits a grace period before nudging a stuck agent. Defaults range
from 2 minutes (general) to 10 minutes (long-running gates). Override in config:

```yaml
mission:
  gates:
    gracePeriods:
      await-plan: 300000        # 5 min
      await-ws-completion: 600000  # 10 min
    maxTotalWaitMs:
      await-ws-completion: 14400000  # 4 hours
```

### Phase Subgraphs

Each lifecycle phase has an internal subgraph that automates its step-by-step
flow. Gates are either `async` (resolved by mail/artifact detection) or `human`
(resolved by operator via `ov mission answer`).

- **understand-phase**: ensure-coordinator → await-research → evaluate →
  (frozen if user input needed) → complete
- **plan-phase**: dispatch-planning → await-plan → check-tdd →
  (optional architect-design) → review → await-handoff → complete
- **execute-phase** (planned/full): ensure-ed → dispatch-ready →
  await-ws-completion → update-status → check-remaining → (loop or complete).
  Includes optional architecture review path for TDD missions.
- **execute-direct-phase** (direct tier only): dispatch-leads → await-leads-done
  → merge-all → (loop or complete). Simplified — no Execution Director.
- **done-phase**: summary → holdout → cleanup → complete

For architecture-level graph engine internals, see
`docs/architecture/adr-graph-engine-lifecycle.md`.

### Agent Waiting State

When agents dispatch sub-agents (scouts, builders), they set `state=waiting`
before stopping. The system keeps them alive:

- Agents are NOT marked completed while in `waiting` state
- When sub-agents send results, the waiting agent is auto-resumed
- The watchdog skips stale/zombie escalation for waiting agents

If an agent gets stuck in `waiting` for too long, the graph engine's
`maxTotalWaitMs` ceiling triggers escalation.

### Manual Workstream Completion

If the engine's automatic workstream status tracking fails, operators can
manually mark a workstream as completed:

```bash
ov mission workstream-complete <workstream-id>
```

## Autonomous Operation

Missions run autonomously. The operator monitors progress via a sleep-based
polling loop — no manual intervention unless agents ask questions.

```bash
# Typical autonomous monitoring loop (max 15 min sleep between checks)
while true; do
  ov mission status
  ov mail check --agent operator
  sleep 900   # 15 minutes max between checks
done
```

Shorter sleep intervals (60-300s) are appropriate during active phases like
handoff and early execution. Use 900s (15 min) for steady-state monitoring.

Answer agent questions promptly via `ov mission answer` or `ov mail reply` —
agents block until they get a response.

### Linking GitHub Issues

When the mission objective comes from a GitHub issue, reference it explicitly
so the coordinator can fetch full context via `gh`:

```bash
ov mission start --slug http-server \
  --objective "Implement HTTP server foundation per GitHub issue #47. \
Coordinator: run 'gh issue view 47' to read the full spec and acceptance criteria."
```

This ensures the coordinator reads the issue body (requirements, file scope,
dependencies) instead of working from the slug alone.

## Monitoring Operator Mail

Agents (coordinator, analyst, leads) send mail to `operator` for questions,
status updates, and results. Check it regularly during a mission:

```bash
# Check for new unread messages addressed to operator
ov mail check --agent operator

# List all messages sent to operator (including already read)
ov mail list --to operator

# Read a specific message
ov mail read <message-id>

# Reply to an agent's question
ov mail reply <message-id> --body "Your answer here"
```

Typical mail you will receive:

- **question** (HIGH priority) — agent needs clarification to proceed
- **status** — progress update from coordinator or execution-director
- **result** — mission or workstream completion report
- **error** — something broke, agent needs help

Tip: run `ov mail check --agent operator` between lifecycle commands
(`status`, `output`, `handoff`) to catch pending questions early.

## Troubleshooting

- `ov mission handoff` fails:
  check that `plan/workstreams.json` is valid, every workstream has a canonical
  `taskId`, and each dispatchable workstream has a real `briefPath`.
- `ov mission resume` fails:
  the workstream still has stale or missing `.overstory/specs/<task-id>.meta.json`;
  regenerate the spec with `ov spec write`.
- `builder` / `reviewer` spawn fails under mission mode:
  supply `--spec`, and make sure the spec metadata matches the task being
  dispatched.
