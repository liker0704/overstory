# `ov mission`

This document captures the design agreements and rationale behind `ov mission`
mode in Overstory. It started as the RFC for the feature and now serves as the
design reference for the shipped `v1`.

Current references:

- [Operator guide](./ov-mission-usage.md)
- [Implementation guide](./ov-mission-implementation.md)

Current status:

- `ov mission v1` is implemented and considered real after Epic #13.
- This document remains the design / RFC reference, not the day-to-day
  operator manual.

Agreement status:

- Sections 1-18 capture the intended `v1` product model.
- Later sections retain design rationale, constraints, and prompt/reference
  material.

---

## 1. Product Model

`ov mission` is a separate mode, not a flag on the existing coordinator.

It is intended for complex tasks where execution should not begin until the
system has first:

1. Understood the task as a user outcome.
2. Aligned on constraints and acceptance criteria.
3. Made the required mission-level decisions.
4. Planned decomposition, execution handoff, and dispatch.
5. Started execution.

Core principle:

```text
understand -> align -> decide -> plan -> execute
```

Mission tiers (`direct`, `planned`, `full`) allow the operator to select how
much phase discipline a mission uses. The `TIER_PHASES` mapping determines which
phases are active for each tier. The `direct` tier skips understanding and
planning entirely, starting at `execute`. The `planned` tier uses the standard
four-phase flow. The `full` tier adds `align` and `decide` phases for maximum
rigor. New missions start in assess mode (`tier=null`) until the coordinator
selects a tier.

### Graph Execution Engine

The graph execution engine is the runtime controller for phase transitions. It
runs inside the watchdog daemon tick — not as a separate process — which keeps
it observable and co-located with agent health monitoring.

Design rationale: phase transitions should be automatic and observable, not
manually triggered. The engine evaluates gate conditions each tick, nudges stuck
agents when grace periods expire, and recovers dead agents. This means an
operator can leave a mission running overnight and trust that the system will
advance phases, escalate blockers, and surface failures without intervention.

Reference: `docs/architecture/adr-graph-engine-lifecycle.md` contains the full
design and implementation decisions for the graph engine.

The main product value of `ov mission` is to combine:

- the phase discipline from `orchestrate`
- the live, mail-driven, persistent coordination model from `overstory`

`ov mission` exists alongside the current execution-first coordinator flow.
The existing coordinator remains the fast path for smaller or already-clear
tasks.

---

## 2. Core Roles

### Coordinator

The mission coordinator is one of the three long-lived central roles.

Responsibilities:

- Communicates with the user
- Owns mission intent
- Owns product decisions
- Owns mission freeze
- Owns reopen / refreeze state transitions
- Owns the global plan
- Owns the execution handoff into the execution layer
- Decides only mission-contract-impacting findings and user-facing changes

Non-responsibilities:

- Does not act as the main codebase researcher
- Does not implement code
- Does not directly own workstream dispatch
- Does not directly own local workstream execution
- Does not perform first-pass triage for ordinary technical execution findings

### Mission Analyst

The mission analyst is the second long-lived central role.

Responsibilities:

- Owns mission-level knowledge
- Maintains the research/evidence layer
- Synthesizes current-state understanding
- Answers retrieval-style context questions from coordinator, leads, and
  occasionally execution director
- Promotes important findings into shared mission artifacts
- Owns workstream `brief.md` synthesis
- Performs first-pass triage for execution-discovered findings
- Resolves technical findings that stay within the existing mission contract
- Escalates only mission-contract-impacting findings to the coordinator

Non-responsibilities:

- Does not make product decisions
- Does not own dispatch
- Does not spawn or manage workstreams directly
- Does not silently change user-visible behavior, acceptance criteria, or mission
  scope

Mission analyst is a knowledge owner, not a decision owner.

In practice, mission analyst is the primary resolver for technical ambiguity
and the owner of mission knowledge, while coordinator remains the guardian of
product intent and mission contract.

`v1` intentionally keeps a single mission analyst.
The preferred way to improve analyst throughput is stronger selective ingress,
better retained evidence, and better post-mission analysis, not a second equal
peer analyst by default.

Operational lifecycle for `v1`:

- mission analyst starts when `ov mission start` creates the mission
- mission analyst joins the mission-owned run immediately
- mission analyst is mission-scoped, not a project-global idle background role
- mission analyst remains active for the full mission lifecycle
- mission analyst stops when the mission completes or is stopped
- mission analyst should be visible in mission-aware status surfaces and
  dashboard summaries

Selective-ingress rule:

- mission analyst is **not** the default sink for every interesting local finding
- leads should escalate to mission analyst only when a finding:
  - crosses workstream boundaries
  - invalidates or materially weakens the current brief
  - changes shared assumptions or hidden constraints
  - may affect accepted semantics or mission memory
- non-blocking local findings that remain inside one workstream should stay with
  the lead by default

### Execution Director

The execution director is the third long-lived central role.

Responsibilities:

- Owns workstream dispatch after mission freeze and planning
- Launches leads
- Owns execution sequencing, pauses, resumes, and operational coordination
- Owns lead lifecycle monitoring
- Owns merge progression and execution-layer completion flow
- Applies coordinator mission decisions to the execution layer
- Consumes mission briefs and refreshes produced by mission analyst
- Communicates with mission analyst only when execution needs impact
  clarification, brief refresh, or propagation guidance

Non-responsibilities:

- Does not talk to the user
- Does not own mission intent
- Does not make product decisions
- Does not own mission freeze or reopen decisions
- Does not replace leads as the primary source of new mission findings

Execution director is the owner of motion, not meaning.

### Lead

Each lead owns exactly one workstream.

Responsibilities:

- Owns local workstream execution
- Decomposes local work if needed
- Spawns local scouts/builders/reviewers
- Produces local specs and handoffs
- Delivers the workstream to merge
- Routes mission-relevant findings and ambiguity upward through mission analyst
- Reports operational execution status upward through execution director

Non-responsibilities:

- Does not own global mission intent
- Does not reinterpret the user objective globally
- Does not make mission-wide product decisions

Only the execution director launches leads.

### Scout and Builder

Scout and builder remain short-lived roles.

- Scout stays read-only and focused on local investigation
- Builder stays focused on implementation inside a narrow scope

Their short lifetime is acceptable because mission memory is stored in shared
artifacts and mediated by the mission analyst.

### Reviewer

Reviewer remains a short-lived role used for verification and mission-aligned
quality checks.

### Architect

No persistent architect role is planned for `v1`.

Architecture remains a phase and a responsibility shared between coordinator
and mission analyst, with temporary support from other agents if needed.

---

## 3. Shared Memory and Source of Truth

Mail is not source of truth. Mail exists for live coordination only.

Mission-level source of truth:

- `mission.md` = mission goal and acceptance criteria
- `decisions.md` = accepted mission-level decisions
- `open-questions.md` = unresolved uncertainty
- `workstreams.json` = decomposition and dispatch units
- `research/current-state.md` = current system shape and constraints
- `research/_summary.md` = synthesized evidence/current-state layer

`faq.md` is not required in `v1`.

### Proposed artifact root

```text
.overstory/missions/<mission-id>/
  mission.md
  decisions.md
  open-questions.md
  research/
    current-state.md
    _summary.md
  plan/
    workstreams.json
  workstreams/
    <workstream-id>/
      brief.md
```

Additional files can be added later, but the list above is the minimum agreed
source-of-truth set so far.

### 3.1 `workstreams.json` must bridge to real runtime tasks

`workstreams.json` is not a second planning namespace detached from the runtime.

In `v1`, each workstream must map to a canonical tracker task, because current
`overstory` execution, dispatch, dashboard, and merge-close logic all assume
real `taskId` ownership.

That means:

- each workstream has a stable `workstreamId`
- each workstream also has a canonical `taskId`
- `taskId` is the runtime bridge for `ov sling`, agent sessions, merge-close,
  and tracker-driven status

Suggested minimum schema:

```json
{
  "workstreams": [
    {
      "id": "backend-scheduling",
      "taskId": "123",
      "objective": "Add backend scheduling support for future post publication.",
      "fileScope": ["src/jobs/**", "src/models/post.ts"],
      "dependsOn": [],
      "briefPath": "workstreams/backend-scheduling/brief.md",
      "status": "planned"
    }
  ]
}
```

This should be treated as the minimum `v1` direction unless later runtime
changes remove the current task-centric assumptions.

---

## 4. Context Delivery Model

The system must separate:

1. where knowledge is stored
2. what context is actually injected into each agent

Those are not the same thing.

A file may be source of truth without being preloaded into every agent prompt.

### Mission Analyst Context

Mission analyst should have mission-level context.

That includes:

- mission intent
- accepted decisions
- unresolved questions
- current-state understanding
- mission-relevant findings discovered during execution
- cross-stream dependencies
- important risks

Mission analyst should **not** absorb all raw execution noise.

### Lead Context

Lead should not receive the full mission context.

Each workstream should have a curated `brief.md` that acts as a focused context
packet for the lead. This brief is not a full mission dump.

`brief.md` should be synthesized by the mission analyst from:

- `mission.md`
- relevant `decisions.md` entries
- relevant `open-questions.md` entries
- the global plan / workstream decomposition
- mission-relevant research findings

For `v1`, the chosen shape is a layered markdown brief.

Recommended sections:

- `TL;DR`
- `Objective`
- `Why This Matters`
- `Scope`
- `Out of Scope`
- `Acceptance`
- `Relevant Mission Decisions`
- `Dependencies And Contracts`
- `Known Risks / Watchouts`
- `Escalate If`

This keeps the brief focused enough to read quickly while still giving the lead
enough context to coordinate the workstream responsibly.

`brief.md` ownership is no longer open: the mission analyst owns brief
synthesis and updates.

### Lead Spec Derivation

`brief.md` is not the final execution contract consumed by builders and
reviewers.

Current `overstory` lead execution is spec-driven, with worker dispatch centered
on `.overstory/specs/<task-id>.md`.

So in `ov mission`, the intended chain is:

- mission artifacts -> `brief.md`
- `brief.md` -> lead-owned spec
- lead-owned spec -> builder/reviewer dispatch

That means `brief.md` refresh is not enough by itself.

For `v1`, each workstream should also carry a `briefRevision`, and the lead
should treat its local spec as a derived artifact from the current brief.

Required rule:

- if `briefRevision` changes, the active lead must regenerate or invalidate its
  local spec before continuing builder/reviewer execution

Without this rule, mission refresh/refreeze would not actually prevent stale
execution context from persisting in lead-owned worker specs.

Recommended `v1` realization:

- keep the existing primary spec path:
  - `.overstory/specs/<task-id>.md`
- add adjacent lightweight spec metadata/history:
  - `.overstory/specs/<task-id>.meta.json`
- store at minimum:
  - `briefRevision`
  - `specRevision`
  - `generatedAt`
  - `status: active | stale | superseded`

This keeps compatibility with the current lead/builder path model while making
refresh/refreeze semantics explicit.

Worker dispatch should include the expected `specRevision` so that stale work can
be detected and invalidated rather than silently continuing.

### Builder Context

Builder should receive an even narrower local slice.

Builders should not preload the full mission dossier. If they need additional
context, they should ask upward through the lead and, if necessary, retrieve a
mission-level answer via the mission analyst.

This means builder context is intentionally asymmetric:

- storage layer = rich and persistent
- builder prompt layer = narrow and selective

### Retrieval Model

The intended model is:

- shared artifacts store mission memory
- mission analyst acts as the retrieval and synthesis layer
- leads and builders receive only relevant slices
- important repeated findings are promoted into shared artifacts

This avoids both:

- repeated rediscovery of the same mission context
- unnecessary prompt bloat from preloading everything into every worker

### Recommended `brief.md` example

```md
# Brief: Backend Scheduling

## TL;DR
Implement backend support for scheduled publishing using the existing durable
jobs path. Do not redesign the whole post lifecycle.

## Objective
Add backend support so posts can be scheduled for future publication and
published automatically.

## Why This Matters
This workstream owns backend state transitions and scheduling mechanics needed
for the user-visible scheduled publishing mission.

## Scope
- post status transitions
- scheduling persistence
- delayed publication trigger
- backend validation

## Out of Scope
- admin form UX
- notifications
- analytics

## Acceptance
- backend accepts future publish time
- scheduled posts are not published immediately
- past timestamps publish immediately
- unschedule returns post to draft

## Relevant Mission Decisions
- D-002: `scheduled` is a first-class state
- D-004: unschedule returns to draft
- D-005: UTC in storage, local timezone only for display

## Dependencies And Contracts
- admin UI depends on the backend status contract
- jobs reliability depends on durable delayed execution

## Known Risks / Watchouts
- existing filters assume only `draft/published`
- only one queue backend survives restart for delayed jobs

## Escalate If
- queue durability cannot satisfy accepted behavior
- a status change breaks another workstream contract
```

### Example: source of truth vs prompt payload

Suppose the mission is "scheduled publishing for posts".

Mission-level storage may contain:

- accepted decisions about time semantics
- current-state notes about the existing jobs runner
- cross-stream constraints around status enums

But a builder working only on the admin scheduling form should receive only:

- the workstream objective
- the relevant acceptance criteria
- the few decisions that affect the UI workstream
- its file scope

It should not receive the entire mission dossier by default. If it later needs
to know how delayed jobs survive restart, that should be retrieved on demand
through the lead and mission analyst.

---

## 5. Workflow Architecture

Current agreed high-level pipeline:

1. User objective
2. Initial clarification
3. Current-state analysis
4. Targeted follow-up questions
5. Mission freeze
6. Research dossier established and kept live
7. Architecture gate if needed
8. Planning
9. Execution handoff
10. Dispatch
11. Execution
12. Review / merge
13. Retrospective

### Important clarification: research dossier is a living layer

Research dossier should not be treated as a one-off late phase that ends before
planning.

Instead, it should be treated as a living mission knowledge layer:

- it starts during current-state analysis
- it becomes structured by mission freeze
- it informs planning, execution handoff, and dispatch
- it remains available during execution
- it is updated only when mission-relevant findings appear

This means research is not "done forever" after an early report. The dossier
persists across the mission and can be refined when execution uncovers new
information that changes mission understanding.

### What gets promoted back into the dossier

Only mission-relevant findings should be elevated back into shared mission
artifacts.

Examples:

- a hidden integration point that affects multiple workstreams
- a previously unknown constraint that changes the chosen approach
- a cross-stream dependency that was not visible during planning
- a finding that invalidates an existing mission decision
- a user-visible behavior implication discovered during implementation

### What does not get promoted

Examples of execution noise that should stay local:

- lint-only fixes
- local test fixture issues
- one-off implementation details with no mission-level impact
- mechanical branch or diff chatter

This keeps mission memory useful without turning it into a dump of execution
logs.

### Example: why the dossier stays live

Suppose the mission analyst initially records:

- the repo already has a delayed jobs runner
- posts currently support only `draft` and `published`
- admin edit flow already supports local datetime input

Later, during execution, a backend builder discovers that delayed jobs survive
restart only for one queue implementation. That finding affects scheduling
reliability across multiple workstreams.

That should not stay buried in a local mail thread. Instead:

1. the lead escalates it to mission analyst
2. mission analyst classifies it as mission-relevant
3. the research layer is updated
4. affected `brief.md` files are refreshed
5. execution director is notified only if execution propagation is needed
6. coordinator is notified only if the finding threatens the mission contract

This is what "living dossier" means in practice: execution can refine mission
knowledge without turning every execution detail into mission memory.

---

## 6. User Interaction Model

The user interaction model should optimize for:

- asking fewer questions
- asking better questions
- grounding follow-up questions in the actual codebase
- avoiding premature execution before the mission is clear enough

The coordinator is the only role that talks to the user directly.

### 6.1 Interaction Principle

The system should not choose between:

- "ask the user everything immediately"
- "analyze first and ask later"

Instead, `ov mission` should use a staged interaction loop:

1. short initial clarification
2. current-state analysis
3. targeted follow-up questions
4. mission freeze

This avoids both failure modes:

- broad, low-value questions asked before the system understands the repo
- deep repo analysis done in the wrong direction because the mission was too vague

### 6.2 Step 1: User Objective Intake

The mission starts with a high-level objective from the user.

Examples:

- "Add scheduled publishing for posts"
- "Implement magic-link auth"
- "Refactor the background jobs system to support retries"

At this point, the system should treat the objective as incomplete and not yet
safe for execution.

### 6.3 Step 2: Initial Clarification

Before current-state analysis, the coordinator may ask a small number of
high-value framing questions.

The purpose of this step is not to fully specify the task. Its purpose is to
avoid analyzing the wrong problem.

Guidelines:

- ask only what materially changes the direction of analysis
- prefer 2-4 short questions
- do not ask implementation-level questions yet
- do not ask questions that should be answerable from the codebase

Examples of valid initial clarification questions:

- is this a new capability or an extension of an existing flow?
- who is the primary user or actor for this change?
- are there hard constraints such as provider choice, security policy, or
  backward compatibility requirements?
- what is explicitly out of scope?

### 6.4 Step 3: Current-State Analysis

Once the objective has enough initial framing, the coordinator starts a
current-state analysis via the mission analyst.

The mission analyst should answer questions such as:

- what already exists in the codebase that is relevant?
- what current user flows or system contracts already exist?
- what hidden constraints are visible in the implementation?
- what parts of the task are already partially implemented?
- what follow-up questions now become concrete and worth asking?

Outputs from this step should populate:

- `research/current-state.md`
- `research/_summary.md`

The result of this step is not execution. The result is a grounded view of the
repo that makes the next user questions more precise.

### 6.5 Step 4: Targeted Follow-Up Questions

After current-state analysis, the coordinator may ask the user a second round
of questions.

These questions should be grounded in actual findings, not abstractions.

Bad question:

- "How do you want auth to work?"

Good question:

- "The repo already has cookie-based admin sessions and email identity records.
  Should magic-link login attach to the existing session model, or should this
  introduce a separate token-based flow?"

Guidelines:

- ask only questions that block mission decisions
- ask only questions that could not be resolved from code or existing evidence
- reference current-state findings when asking
- prefer grouped decision questions over many small interruptions

### 6.6 Step 5: Mission Freeze

Mission freeze is the point where the mission becomes clear enough for planning
and execution.

Mission freeze does **not** require every uncertainty to be removed. It does
require that blocking uncertainty be resolved or explicitly recorded.

Mission freeze criteria:

- the user-visible objective is clear
- acceptance criteria are clear enough to evaluate success
- out-of-scope items are documented
- key constraints are documented
- blocking product decisions are resolved
- `research/current-state.md` and `research/_summary.md` are strong enough to
  support planning without guesswork
- unresolved but non-blocking uncertainty is recorded in `open-questions.md`
- there is enough clarity to produce a valid global plan

Mission freeze writes or updates:

- `mission.md`
- `decisions.md`
- `open-questions.md`

No workstream dispatch should happen before mission freeze.

Mission freeze does **not** require:

- all implementation details to be known
- all technical risks to be removed
- every edge case to be fully answered
- the research dossier to stop evolving

It only requires that blocking ambiguity be removed or explicitly isolated.

### 6.7 Step 6: Execution Authorization

After mission freeze, the coordinator can move into:

- research continuation
- architecture gate if needed
- planning
- execution handoff

At this point, execution is authorized because the mission has crossed the
minimum clarity threshold required for end-to-end work.

Dispatch begins only after execution handoff is complete and execution
director has the frozen mission package, workstreams, and current briefs.

### 6.7.1 Minimal Architecture Gate Contract

The architecture gate cannot remain only a phrase in the pipeline. Even in
`v1`, it needs a minimal operational contract.

Recommended `v1` rule:

- coordinator decides whether the gate is required
- mission analyst supplies discovery and current-state evidence
- temporary supporting agents may be used if needed, but no persistent architect
  role exists in `v1`

The gate should be required when at least one of the following is true:

- a new shared contract affects multiple workstreams
- several subsystems must change in coordinated ways
- the change cannot be safely expressed as a straightforward extension of the
  current implementation
- multiple plausible design directions exist and the choice affects downstream
  decomposition

Minimum required outputs:

- `architecture.md`
- at least two considered alternatives
- the selected approach and rationale
- the workstreams and contracts affected by that decision

### 6.8 Freeze Blocker Rule

A question is a freeze blocker if it changes any of:

- user-visible behavior
- acceptance criteria
- mission scope
- a cross-stream contract
- a key product or policy constraint

A question is **not** a freeze blocker if it only changes:

- local implementation detail
- helper selection
- naming
- test structure
- local refactoring approach

This rule keeps freeze meaningful without turning it into "know everything
before doing anything".

### 6.9 Question Routing Rules

The coordinator should ask the user only when the answer is:

- product-defining
- policy-defining
- preference-defining
- not recoverable from codebase evidence

The coordinator should **not** ask the user when the answer should come from:

- current implementation behavior
- existing repository conventions
- existing APIs or type contracts
- local implementation detail that a lead can resolve safely

### 6.10 Reopen and Refreeze

Mission freeze is not permanent. `ov mission` should allow controlled reopen
when execution reveals a contradiction or ambiguity that crosses back into the
mission-contract layer.

#### Reopen triggers

Reopen should be considered when a new finding:

- contradicts an existing mission decision
- changes user-visible behavior
- changes acceptance criteria
- reveals a hidden constraint that invalidates the plan
- exposes a cross-stream incompatibility
- shows that the mission was frozen on a false assumption

#### What should not trigger reopen

The following should stay below the mission-contract layer:

- local test failures
- lint/type/build noise
- one-off implementation difficulties
- module-local tradeoffs that do not affect other workstreams
- technical facts that mission analyst can safely absorb without changing
  product behavior

#### Reopen flow

The intended flow is:

1. builder or scout reports a finding to the lead
2. lead escalates mission-relevant findings to mission analyst
3. mission analyst performs first-pass triage:
   - factual/contextual update
   - technical decision within mission contract
   - mission-contract impact
4. if the finding is purely technical and stays within mission contract:
   - mission analyst updates the research layer and affected `brief.md`
   - mission analyst informs the lead directly
   - mission analyst informs execution director only if execution propagation is
     needed
5. if the finding impacts mission contract:
   - mission analyst escalates to coordinator with a structured recommendation
   - coordinator decides whether to reopen mission clarification
6. if reopened:
   - execution director pauses only affected workstreams by default
   - unaffected workstreams continue
   - coordinator updates mission-level artifacts as needed
   - mission analyst refreshes affected research/brief artifacts
   - execution director applies the resulting execution changes
7. once the blocking ambiguity is resolved, the mission is refrozen

This keeps coordinator out of the technical weeds while still preserving
mission-level control.

#### Example: technical finding without reopen

During implementation, a builder discovers that the existing jobs runner
supports durable delayed jobs only through one queue backend.

If the mission can still satisfy its accepted behavior by switching to that
backend without changing user-facing semantics:

- mission analyst should resolve that as a technical lane decision
- coordinator should simply confirm the recommendation
- no reopen is necessary

#### Example: finding that requires reopen

If the same discovery means scheduled publishing can no longer guarantee
"publish at the selected time after restart", and that guarantee is part of the
accepted behavior, then:

- mission analyst should escalate the contradiction
- coordinator should reopen the mission
- acceptance or decisions may need to be revised

### 6.11 Example Lifecycle

Example objective:

```text
Add scheduled publishing for posts.
```

Interaction flow:

1. User provides the objective.
2. Coordinator asks a few framing questions:
   - is this for admins only?
   - should scheduling publish automatically without user confirmation later?
   - what is out of scope?
3. Mission analyst scans the repo and finds:
   - existing post statuses
   - an admin edit flow
   - a delayed jobs mechanism used elsewhere
4. Coordinator asks targeted follow-up questions:
   - should scheduled posts remain editable until publish time?
   - if a scheduled time is already in the past, should save publish immediately
     or reject it?
5. Coordinator freezes the mission:
   - writes acceptance
   - records decisions
   - records any unresolved non-blocking questions
6. Planning completes, execution handoff is prepared, and execution director
   begins dispatch.

This model ensures that questions become better after analysis, but analysis
does not happen without any initial direction.

### 6.12 Operational Smell

If a lead receives its `brief.md` and still has to ask:

- "what does correct user behavior actually mean here?"
- "which outcome are we optimizing for?"
- "which interpretation should this workstream follow?"

then mission freeze was probably premature.

This is a useful operational smell for evaluating whether the mission layer is
doing its job.

---

## 7. Mission Telemetry And Learning Loop

`ov mission` should not rely only on intuition for improvement. The system
needs a mission telemetry layer that records how missions actually behave so the
workflow, prompts, routing, and decision model can be improved over time.

This telemetry should cover every mission run, not just failures.

At minimum, the system should persist:

- mission identity and objective
- number of clarification rounds
- time to mission freeze
- number of reopen events
- reason for each reopen
- architecture gate usage
- planning / handoff / dispatch timing
- mission completion status
- major blockers or escalations
- final outcome summary

The purpose is not surveillance. The purpose is learning:

- which missions freeze too early
- which prompts produce repeated confusion
- which kinds of findings most often trigger reopen
- where workstream briefs are too weak
- which tasks should have gone through mission mode vs fast path

This telemetry will later support:

- better prompts
- better routing heuristics
- better `ov eval`
- better `ov health`
- better mission retrospectives

The exact schema can evolve, but the requirement itself is agreed:

- every `ov mission` run must leave behind enough structured evidence that the
  system can improve from real usage
- logging and retained results are a first-class requirement, not optional
- `v1` should prefer richer retention over a second analyst or more mission
  roles

### 7.1 Logging And Result Retention Are Mandatory

For `v1`, the preferred direction is:

- keep a single `Mission Analyst`
- do not add a second peer analyst as the primary bottleneck mitigation
- instead, invest in stronger mission logging, richer result retention, and
  better post-mission analysis

The reasoning is simple:

- a second equal analyst would create split-brain risk in mission knowledge
- retained evidence improves the system across every future mission
- strong logging helps prompts, routing, health, review, and retrospective at
  the same time

### 7.2 Required Mission Evidence Bundle

Every mission should retain an evidence bundle that is sufficient for later
inspection, scoring, review, and system improvement.

At minimum, `v1` should preserve:

- mission artifacts (`mission.md`, `decisions.md`, `open-questions.md`,
  `research/*`, `plan/*`, `brief.md`)
- mission summary state (`MissionSummary` in `sessions.db`)
- mission narrative events (via the mission event log)
- session metrics for all mission-owned agents
- final mission outcome summary
- reopen / refreeze history
- enough execution evidence to explain why the mission succeeded, failed,
  stopped, or partially completed

This should be treated as a mission-level equivalent of the existing eval
artifact pattern:

- `manifest.json`
- `summary.json`
- `events.jsonl`
- `sessions.json`
- `metrics.json`

The exact filenames may differ, but the retention goal should be similar:
mission runs must be inspectable after the fact without replaying the whole
system from raw tmux output.

### 7.3 Reuse Existing Overstory Analysis Layers

`ov mission` should not invent a parallel analytics stack if the current
overstory ecosystem already provides the right primitives.

The preferred reuse direction is:

- `events.db` for append-only mission narrative and runtime history
- `metrics.db` for mission-owned session metrics and token/cost snapshots
- `reviews.db` for deterministic post-mission review and staleness tracking
- mission artifacts on disk for human-readable source-of-truth context

This matches the way existing overstory subsystems already work:

- eval persists full run artifacts for later inspection
- health computes scores from existing stores rather than from ad-hoc logs
- review persists deterministic scores and stale-state separately from runtime

`ov mission` should follow the same pattern instead of adding a new opaque log
layer.

### 7.4 Learning Loop Beyond Raw Logs

The goal is not just to store more bytes. The goal is to retain results in a
form that can later be turned into:

- mission-level review records
- health signals and recommendations
- eval scenario improvements
- routing improvements (`fast path` vs `mission path`)
- prompt corrections for coordinator, analyst, execution director, and lead

Where possible, outcome-bearing mission learnings should also be promotable into
the existing expertise layer rather than living only in mission logs.

That means the system should preserve enough data to later record:

- successful mission patterns
- repeated failure patterns
- partial outcomes
- useful decisions and conventions that are worth carrying forward

The intended direction is closer to `mulch`-style outcome history than to
throwaway debug logging.

### 7.5 Mission Result Bundle

Every mission should export a derived result bundle under:

```text
.overstory/missions/<mission-id>/results/
```

This directory is not a new source of truth. It is a retained analysis bundle
built from:

- mission artifacts on disk
- mission summary state in `sessions.db`
- mission events from `events.db`
- mission-owned session metrics from `metrics.db`
- optional review records from `reviews.db`

Recommended `v1` contents:

- `manifest.json`
- `summary.json`
- `events.jsonl`
- `sessions.json`
- `metrics.json`
- `review.json` when a mission review has been computed

Optional later additions:

- `retrospective.md`
- `promotion-candidates.json`

The key rule is:

- mission artifacts remain the source of truth for context and decisions
- the `results/` bundle exists to support later analysis, debugging, scoring,
  and system improvement

#### 7.5.1 Export timing

For `v1`, the preferred export behavior is:

- materialize or refresh the `results/` bundle when a mission reaches a terminal
  state (`completed` or `stopped`)
- allow later commands such as `ov mission show` or retrospective tooling to
  regenerate derived exports if a bundle is missing or stale

The initial terminal export should be owned by the mission terminalization path
itself:

- mission completion path writes/refreshed the bundle once the mission is marked
  terminal
- `ov mission stop` does the same for intentional stop
- later commands may repair or backfill exports if needed

This keeps export timing deterministic at mission end while still allowing
repair or backfill without changing mission source-of-truth artifacts.

### 7.6 `manifest.json`

`manifest.json` should be the compact index for the result bundle.

Recommended fields:

- `bundleVersion`
- `missionId`
- `slug`
- `runId`
- `objective`
- `state`
- `startedAt`
- `firstFreezeAt`
- `completedAt`
- `coordinatorSessionId`
- `analystSessionId`
- `executionDirectorSessionId`

This file should answer:

- which mission this bundle belongs to
- which run it maps to
- whether the mission completed, stopped, or failed to reach a good outcome

### 7.7 `summary.json`

`summary.json` should be the normalized post-mission summary used for later
analysis and improvement work.

Recommended shape:

```json
{
  "missionId": "mission-scheduled-publishing",
  "runId": "run-2026-03-12T10-00-00Z",
  "objective": "Add scheduled publishing for posts",
  "state": "completed",
  "outcome": {
    "status": "success",
    "summary": "Scheduled publishing shipped for admin posts.",
    "primaryReasons": ["mission_frozen", "execution_completed"]
  },
  "startedAt": "2026-03-12T10:00:00Z",
  "firstFreezeAt": "2026-03-12T10:18:00Z",
  "completedAt": "2026-03-12T11:42:00Z",
  "durationMs": 6120000,
  "clarificationRounds": {
    "initial": 1,
    "followUp": 1,
    "reopen": 1
  },
  "reopenCount": 1,
  "architectureGateUsed": true,
  "workstreams": {
    "total": 3,
    "completed": 3,
    "deferred": 0,
    "pausedAtEnd": 0
  },
  "execution": {
    "totalSessions": 8,
    "completedSessions": 8,
    "runtimeSwaps": 0,
    "stalledSessions": 0,
    "zombieSessions": 0
  },
  "cost": {
    "estimatedUsd": 4.21,
    "inputTokens": 123456,
    "outputTokens": 45678
  },
  "blockers": [],
  "artifactPaths": {
    "mission": ".overstory/missions/mission-scheduled-publishing/mission.md",
    "decisions": ".overstory/missions/mission-scheduled-publishing/decisions.md",
    "workstreams": ".overstory/missions/mission-scheduled-publishing/plan/workstreams.json"
  }
}
```

The exact field names may evolve, but `v1` should preserve these categories:

- identity
- lifecycle timing
- clarification / reopen counts
- architecture-gate usage
- workstream totals
- execution totals
- cost totals
- blockers
- final outcome summary

### 7.8 `events.jsonl`, `sessions.json`, and `metrics.json`

These files should be export views over the existing overstory stores.

`events.jsonl`:

- high-signal mission narrative events only
- filtered from `events.db`
- append-only export for mission replay and retrospectives

`sessions.json`:

- all mission-owned agent sessions filtered by the mission `runId`
- enough data to understand role participation, completion, and failures

`metrics.json`:

- aggregated mission metrics plus any useful per-agent rollups
- should be derived from existing `metrics.db` data rather than re-invented

This keeps the result bundle portable without making the file exports the new
canonical source of truth.

### 7.9 Mission-Level Review Summary

`ov mission` should support mission-level review in the same spirit as the
existing deterministic review contour.

The preferred `v1` direction is:

- extend `ReviewSubjectType` with `mission`
- store mission review records in the existing `reviews.db`
- export the latest review into `results/review.json` for portability

This is the right reuse direction, but it should not be treated as a trivial
enum tweak.
It is a real review-contour migration that will likely touch:

- `ReviewSubjectType`
- `reviews.db` schema and constraints
- staleness rules
- analyzer registration
- operator/reporting surfaces that render review results

Mission review should remain deterministic in `v1`.
It should score a completed or stopped mission using existing mission artifacts,
summary state, events, and metrics.

Recommended inputs:

- `MissionSummary`
- mission artifacts (`mission.md`, `decisions.md`, `brief.md`, `workstreams.json`)
- mission-owned sessions and metrics
- mission narrative events

Recommended dimensions:

- `clarity`
  - mission goal, acceptance, and decisions are explicit and coherent
- `actionability`
  - workstreams, briefs, and task bridges were concrete enough to execute
- `completeness`
  - result bundle, final outcome, and execution evidence are present
- `signal-to-noise`
  - mission did not thrash through excessive reopen, pause, or clarification churn
- `correctness-confidence`
  - mission reached a high-confidence outcome with low unresolved risk
- `coordination-fit`
  - coordinator, analyst, execution director, and leads stayed within role boundaries

This gives `ov mission` a durable answer to:

- was this mission well framed?
- did the mission layer actually help?
- which failures were structural versus incidental?

### 7.10 Promotion Into The Learning Layer

Mission bundles should preserve enough evidence that later tooling can promote
important learnings into the broader expertise layer.

The intended direction is:

- repeated mission success patterns can later become reusable conventions or guides
- repeated mission failure patterns can later become reusable failure records
- partial outcomes can be tracked rather than collapsed into binary success/failure

This is intentionally closer to `mulch` outcome history than to raw debug logs.

---

## 8. Reuse Existing Overstory Infrastructure

`ov mission` should be built as a product layer on top of the existing
overstory coordinator/session/mail infrastructure whenever possible.

The goal is not to create a second orchestration system inside the repo. The
goal is to reuse the current foundation and extend it where the mission mode
really needs new behavior.

### Existing primitives to reuse

The current implementation already provides strong building blocks:

- persistent project-root agents
- mail threads and typed operator messages
- synchronous request/reply patterns
- coordinator output capture / attach
- run and session tracking
- watchdog / monitor integration

`ov mission` should lean on these primitives rather than replacing them.

### Important current constraint

The current implementation is still shaped around a single execution-first
coordinator. `ov mission` should reuse that infrastructure where possible, but
mission mode now explicitly introduces three persistent root-level roles:

- `coordinator` for mission understanding and user interaction
- `mission-analyst` for mission knowledge and brief synthesis
- `execution-director` for execution-layer orchestration

As a result, `v1` should assume:

- one active mission per project at a time
- one mission coordinator per project
- one mission analyst per active mission
- one execution director per active mission

For clarity:

- `v1` intentionally uses one `Mission Analyst`
- the preferred answer to analyst load is better logging, retained evidence, and
  stronger post-mission analysis
- not a second equal long-lived analyst by default

Mission history can still be listed and inspected later, but parallel active
missions should not be assumed in `v1`.

### 8.1 Runtime prerequisite: persistent root agent abstraction

This is a real implementation prerequisite, not a minor follow-up.

Current `overstory` lifecycle management is hardcoded around a single
`coordinator` root agent. `ov mission` requires that to be generalized into a
persistent root-agent abstraction.

Minimum required `v1` direction:

- root-scoped persistent capabilities must include:
  - `coordinator`
  - `mission-analyst`
  - `execution-director`
- all three are project-root agents with no worktree
- all three are depth-0 actors in hierarchy terms
- all three remain non-task workers at the runtime layer:
  - no canonical `taskId`
  - workstream/task ownership starts at the lead layer
- all three need lifecycle support analogous to:
  - start
  - stop
  - status
  - output
  - recovery / resume-aware status reconciliation

Practically, `startCoordinator()` is too special-case for the new model.
`ov mission` should assume a generalized primitive more like:

- `startPersistentAgent(name, capability, roleConfig)`

This generic abstraction is an internal runtime direction, not a user-facing
CLI requirement. User-facing commands may remain role- or mission-oriented.

This must be treated as Phase 0 groundwork before mission mode is fully
implementable.

### 8.2 Run ownership in `v1`

To stay compatible with current `overstory` status/dashboard/mail/feed
assumptions, `ov mission` should create a run immediately at
`ov mission start`, not only after execution handoff.

That means:

- `current-run.txt` is written at mission start
- `current-mission.txt` is written at mission start
- mission analyst belongs to that run from the beginning
- coordinator remains a persistent root session outside the mission-owned run and
  is referenced by mission metadata rather than rebound into the run
- execution director joins the same mission-owned run later at handoff

This keeps mission mode aligned with current run-scoped infrastructure instead
of introducing a pre-run shadow lifecycle.

#### 8.2.1 Terminal run semantics in `v1`

The mission-owned run should mirror the terminal mission outcome.

Preferred `v1` direction:

- mission `completed` -> run `completed`
- mission `stopped` -> run `stopped`

This means mission mode should extend the current `RunStatus` model to include
`stopped` rather than overloading user-initiated stop as `failed`.

### Product consequence

`ov mission` should therefore behave as a mission-oriented interface over the
existing overstory runtime, not as a wholly separate orchestration stack.

In practice this means:

- `ov mission start` ensures mission coordinator is active
- `ov mission start` also creates the mission-owned run immediately
- mission state is layered on top of the existing runtime lifecycle
- execution director starts only after planning / execution handoff
- mission output should reuse existing coordinator output patterns where
  possible
- mission request/response flows should reuse the current operator mail model
  where possible

### Prompt consequence

The current coordinator prompt is execution-first and does not match mission
coordinator behavior.

So while the runtime and much of the execution infrastructure should be reused,
`ov mission` requires:

- a mission-specific coordinator definition
- a separate execution director definition

This lets `ov mission` preserve infrastructure reuse without inheriting the
wrong top-level behavior.

---

## 9. CLI Surface

The CLI for `ov mission` should expose mission-oriented behavior, not raw
coordinator internals.

The user should interact with:

- a mission lifecycle
- mission state and phases
- mission artifacts
- mission question/answer loops

The user should **not** need to think in terms of:

- raw coordinator mail commands
- correlation ids
- low-level run/session internals

### 9.1 CLI Design Principles

The agreed design principles are:

- mission-first UX
- reuse of the current session/mail/runtime infrastructure
- one active mission per project in `v1`
- explicit human answers when mission input is required
- mission-aware status rather than coordinator-only runtime status

### 9.2 Active Mission vs Explicit Mission ID

Because `v1` assumes one active mission per project, the default CLI model
should be:

- active mission commands do not require a mission id
- historical inspection commands may take a mission id

This keeps the common path light while still leaving room for mission history.

Examples:

```bash
ov mission status
ov mission output
ov mission answer --body "..."
ov mission show mission-scheduled-publishing
```

### 9.3 Current `v1` Command Set

Current command family:

```bash
ov mission start --slug <slug> --objective "<objective>"
ov mission status
ov mission output
ov mission answer --body "..."
ov mission answer --file <path>
ov mission artifacts
ov mission handoff
ov mission pause <workstream-id> [--reason "<text>"]
ov mission resume <workstream-id>
ov mission refresh-briefs [--workstream <id>]
ov mission complete
ov mission stop
ov mission list
ov mission show <mission-id-or-slug>
ov mission bundle [--mission-id <id>] [--force]
```

Post-mission review commands:

```bash
ov review missions [--recent <n>]
ov review mission <mission-id-or-slug>
```

### 9.4 `ov mission start`

`ov mission start` is the product entrypoint for mission mode.

It should:

- ensure the coordinator runtime is available
- refuse to start if an active mission already exists
- require both `--slug` and `--objective`
- create a mission record and mission artifact root
- persist the initial objective
- switch mission lifecycle into `initial-clarification`
- route the objective into the existing coordinator/mail infrastructure

Execution director should not start at mission creation time. It should start
only after mission freeze, planning, and execution handoff.

Example:

```bash
ov mission start --slug scheduled-publishing --objective "Add scheduled publishing for posts"
```

Example output:

```text
Mission started: mission-scheduled-publishing
State: awaiting-input
Phase: initial-clarification

Need 3 framing answers before current-state analysis:
1. Is this admin-only or also API-visible?
2. Should publish happen automatically at the scheduled time?
3. What is explicitly out of scope?
```

### 9.5 `ov mission status`

`ov mission status` should report both:

- a coarse user-facing mission state
- a more detailed mission phase

Recommended coarse states:

- `awaiting-input`
- `working`
- `blocked`
- `completed`
- `stopped`

Recommended detailed phases:

- `initial-clarification`
- `analyzing-current-state`
- `targeted-follow-up`
- `frozen`
- `architecting`
- `planning`
- `dispatching`
- `executing`
- `reopened`
- `reviewing`
- `retrospective`

Recommended status fields:

- mission id
- coarse state
- detailed phase
- freeze reached or not
- pending user input or not
- reopen count
- active workstream count or names
- paused workstream count or names
- coordinator runtime state
- mission analyst runtime state
- execution director runtime state
- mission artifact root

Example:

```text
Mission: mission-scheduled-publishing
State: working
Detailed phase: analyzing-current-state
Freeze: not reached
Pending user input: no
Reopens: 0
Active workstreams: none
Coordinator: running
Mission Analyst: running
Execution Director: not-started
Artifacts: .overstory/missions/mission-scheduled-publishing/
```

### 9.6 `ov mission output`

`ov mission output` should show a mission-centric narrative rather than a raw
runtime dump whenever possible.

In early implementation, it may reuse existing coordinator and execution
director output primitives.
Over time it should evolve toward a clearer mission event stream.

Example ideal output:

```text
[mission] initial clarification complete
[analyst] current-state analysis started
[analyst] existing delayed jobs runner found
[mission] 2 blocking follow-up questions prepared
[mission] awaiting user input
```

### 9.7 `ov mission answer`

`ov mission answer` is the main user response mechanism.

It should:

- require an active mission
- require a pending mission question packet
- accept either inline text or a file
- route the answer through the existing request/reply transport
- resume mission progression after the answer is received

Examples:

```bash
ov mission answer --body "
1. Admin-only.
2. Yes, publish automatically.
3. Out of scope: recurring schedules and notifications.
"
```

```bash
ov mission answer --file answers.md
```

If no pending clarification is waiting, the command should fail clearly rather
than silently sending free-form mail.

### 9.8 `ov mission artifacts`

`ov mission artifacts` should list the mission root and the key artifact paths
for quick inspection and debugging.

Example:

```text
Mission root: .overstory/missions/mission-scheduled-publishing
mission.md
decisions.md
open-questions.md
research/current-state.md
research/_summary.md
plan/workstreams.json
workstreams/backend-scheduling/brief.md
workstreams/admin-ui/brief.md
```

### 9.9 `ov mission stop`

In `v1`, `ov mission stop` should stop the active mission, stop execution
director if one is running, stop mission analyst, and leave the coordinator
runtime alive and idle.

This matches the current persistent coordinator architecture better than
shutting down the whole coordinator process every time a mission ends.

If the user wants to stop the coordinator itself, that remains the
responsibility of the existing coordinator command family.

Example output:

```text
Mission stopped: mission-scheduled-publishing
Coordinator remains running and is now idle.
Mission Analyst stopped.
Execution Director stopped.
```

### 9.10 `ov mission list` and `ov mission show`

Because only one mission is active at a time in `v1`, `list` and `show` are
mainly for history and inspection.

Example list output:

```text
mission-scheduled-publishing   completed      started 2026-03-11
mission-magic-link-auth        stopped        started 2026-03-11
mission-job-retries            completed      started 2026-03-10
```

Example show output:

```text
Mission: mission-magic-link-auth
State: completed
Started: 2026-03-11T10:12:00Z
Completed: 2026-03-11T13:42:00Z
Freeze: reached
Reopens: 1
Workstreams:
- auth-session-integration
- email-link-delivery
- auth-review
```

### 9.11 Commands intentionally excluded from `v1`

The following should stay internal in `v1` rather than becoming user-facing
commands:

- `ov mission freeze`
- `ov mission reopen`
- `ov mission dispatch`
- `ov mission analyst ...`
- `ov mission decide ...`

These are internal lifecycle transitions, not the primary user interface.

### 9.12 Full Example CLI Lifecycle

```bash
ov mission start --slug magic-link-auth --objective "Implement magic-link auth for admin users"
```

Output:

```text
Mission started: mission-magic-link-auth
State: awaiting-input
Phase: initial-clarification

Need 3 framing answers:
1. Admin-only or all users?
2. Replace passwords or coexist?
3. Any provider or backward-compatibility constraints?
```

```bash
ov mission answer --body "
1. Admin-only.
2. Coexist with password login.
3. No external provider. Keep current sessions.
"
```

```bash
ov mission status
```

```text
Mission: mission-magic-link-auth
State: working
Detailed phase: analyzing-current-state
Freeze: not reached
Pending user input: no
Coordinator: running
Execution Director: not-started
```

```bash
ov mission output
```

```text
[analyst] existing cookie-based admin sessions found
[analyst] email identity records already exist
[mission] targeted follow-up required
```

```bash
ov mission answer --body "
Invited-but-not-yet-activated admins should be allowed to authenticate.
"
```

```text
Mission freeze reached.
Planning complete.
Execution handoff started.
```

This gives the user a mission-shaped interface while still reusing the current
coordinator/runtime infrastructure underneath.

---

## 10. Mission Mail Protocol

`ov mission` should not introduce a second orchestration transport in `v1`.

Instead, it should extend the existing typed mail protocol with a small
mission-specific control-plane layer.

This preserves the current strengths of overstory:

- live mail-driven coordination
- thread-aware agent communication
- existing typed protocol payloads
- reuse of current mail storage and nudging behavior

### 10.1 Why typed mission mail is needed

If mission-critical coordination is left entirely to free-form mail, then the
system becomes too dependent on prompt wording.

That causes several problems:

- hard to tell which findings are mission-relevant
- hard to distinguish technical updates from mission-contract changes
- hard to drive reopen / refreeze reliably
- hard to generate telemetry and mission history
- hard to refresh `brief.md` or status views automatically

So the agreed direction is:

- keep mail as the control plane
- keep artifacts as source of truth
- use typed mission protocol messages to move decisions and findings between
  roles

### 10.2 Design constraints

The protocol should:

- reuse existing mail infrastructure
- stay small in `v1`
- separate human-readable summaries from structured payloads
- support both technical-lane decisions and mission-contract escalation
- support telemetry later without inventing a second system

The protocol should **not**:

- let builders bypass leads
- force coordinator to read raw technical chatter
- force execution director to do mission-definition work
- explode into many low-level message types in `v1`

Direct `execution director <-> mission analyst` traffic should stay relatively
rare and should exist mainly for brief refresh, impact clarification, or
execution propagation after analyst triage.

### 10.2.1 Request / reply convention

Some mission interactions are logically synchronous even though mail transport is
asynchronous.

Examples:

- coordinator asks mission analyst for a bounded pre-freeze analysis
- execution director asks mission analyst whether a refreshed brief is ready

The recommended `v1` convention is:

- send a typed request mail in a dedicated thread
- nudge the recipient
- poll mail for a reply in the same thread
- treat timeout as an operational error, not silent success

This matches the existing `askCoordinator()` pattern already present in
`overstory` and should be reused rather than reinvented.

### 10.3 Recommended `v1` mission protocol types

The recommended `v1` set is intentionally small:

- `mission_finding`
- `analyst_resolution`
- `execution_guidance`
- `analyst_recommendation`
- `execution_handoff`
- `mission_resolution`

#### `mission_finding`

Primary sender:

- `lead`

Primary recipient:

- `mission analyst`

Purpose:

- report a mission-relevant finding discovered during workstream execution

Typical meaning:

- "this is not just local noise; this may affect other workstreams, the brief,
  the research layer, or the mission contract"

#### `analyst_resolution`

Primary sender:

- `mission analyst`

Primary recipient:

- `lead`

Purpose:

- return the analyst's classification and operational resolution for a finding

Typical meaning:

- "I classified this, updated the right context, and here is whether you should
  continue, pause locally, or await coordinator"

Selective-ingress rule:

- `mission_finding` should be used for cross-stream, brief-invalidating,
  mission-memory-affecting, or mission-contract-risk findings
- it should **not** become the default path for every local implementation
  detail inside a workstream
- if a finding is local and `blocksWorkstream = false`, the lead may continue
  local execution without waiting for analyst response

#### `execution_guidance`

Primary sender:

- `mission analyst`

Primary recipient:

- `execution director`

Purpose:

- propagate a brief refresh, execution-impact clarification, or affected
  workstream guidance after analyst triage

Typical meaning:

- "knowledge changed in a way that may require pause, refresh, resequencing, or
  propagation in the execution layer"

#### `analyst_recommendation`

Primary sender:

- `mission analyst`

Primary recipient:

- `coordinator`

Purpose:

- send a structured recommendation only when a finding requires mission-level
  update, user clarification, or reopen consideration

Typical meaning:

- "here is my synthesis and my recommended action at the mission layer"

#### `execution_handoff`

Primary sender:

- `coordinator`

Primary recipient:

- `execution director`

Purpose:

- hand the frozen mission package, planning outputs, and current briefs into the
  execution layer

Typical meaning:

- "mission understanding is now stable enough for execution; here is the frozen
  package you must run"

#### `mission_resolution`

Primary sender:

- `coordinator`

Primary recipients:

- `mission analyst`
- `execution director`

Purpose:

- communicate the coordinator's final mission-layer resolution

Typical meaning:

- "confirmed", "blocked", "reopened", or "refrozen"

### 10.4 Recommended payload shape

The exact schema may still evolve, but the protocol should carry enough data to
route, interpret, and persist mission behavior.

#### `mission_finding` payload

- `missionId`
- `workstreamId`
- `taskId`
- `findingId`
- `category`: `fact | risk | conflict | dependency | question`
- `scope`: `local | cross_stream | mission_contract`
- `summary`
- `evidenceRefs`
- `blocksWorkstream`
- `affectedWorkstreams`

#### `analyst_resolution` payload

- `missionId`
- `workstreamId`
- `taskId`
- `findingId`
- `classification`: `context_update | technical_decision | mission_contract_impact`
- `action`: `continue | pause_local | await_coordinator`
- `briefRevision`
- `researchRevision`
- `summary`

#### `analyst_recommendation` payload

- `missionId`
- `findingId`
- `recommendedOutcome`:
  `reopen_mission | ask_user | update_decision`
- `rationale`
- `affectedWorkstreams`
- `proposedArtifactUpdates`

#### `execution_guidance` payload

- `missionId`
- `findingId`
- `guidanceType`: `brief_refresh | impact_update | pause_recommendation | resume_ready`
- `affectedWorkstreams`
- `affectedTaskIds`
- `briefRevisionMap`
- `summary`

#### `execution_handoff` payload

- `missionId`
- `planRevision`
- `workstreams`: array of `{ workstreamId, taskId }`
- `briefRefs`
- `missionRef`
- `decisionRef`
- `openQuestionsRef`
- `summary`

#### `mission_resolution` payload

- `missionId`
- `findingId`
- `resolutionType`: `confirmed | blocked | reopened | refrozen`
- `affectedWorkstreams`
- `requiresBriefRefresh`
- `requiresPause`
- `updatedArtifacts`

### 10.5 Normal technical-lane flow

Example:

1. a builder discovers that durable delayed jobs work only through one queue
   backend
2. the builder reports that to the lead
3. the lead sends `mission_finding` to mission analyst
4. mission analyst determines the issue stays within the existing mission
   contract
5. mission analyst updates `research/_summary.md` and the affected `brief.md`
6. mission analyst sends:
   - `analyst_resolution` to the lead
   - `execution_guidance` to execution director only if execution propagation is needed
7. execution director applies any required propagation
8. the workstream continues without reopen

This is the expected fast path for ordinary mission-relevant technical
discoveries.

### 10.6 Reopen flow

Example:

1. a lead escalates a finding with `mission_finding`
2. mission analyst determines the finding changes accepted mission behavior
3. mission analyst sends `analyst_recommendation` with
   `recommendedOutcome = reopen_mission`
4. coordinator decides the mission must reopen
5. coordinator sends `mission_resolution: reopened` to execution director and
   mission analyst
6. execution director pauses only affected workstreams by default
7. coordinator updates mission-level artifacts
8. mission analyst refreshes research and briefs
9. mission analyst sends any required `execution_guidance`
10. once the blocking ambiguity is resolved, coordinator sends
   `mission_resolution: refrozen`

This preserves the earlier agreement that mission analyst is first-line for
technical triage, while coordinator remains the guardian of mission contract.

### 10.7 Why this is the recommended `v1` model

This model is preferred because it:

- reuses current mail infrastructure
- keeps the protocol small
- gives telemetry and mission history something structured to observe
- keeps coordinator out of low-value technical chatter
- keeps execution director out of mission-definition work
- avoids inventing a parallel event bus too early

It is intentionally conservative. More specialized protocol types can be added
later if real mission usage shows that the minimal set is insufficient.

---

## 11. Mission Status In `status` And `dashboard`

`ov mission` introduces a second kind of state that must be made visible in the
operator UI:

- runtime/health state of agents
- mission lifecycle state

These must not be collapsed into one field.

### 11.1 Keep agent state and mission state separate

Current overstory status surfaces are oriented around:

- agent runtime health
- worktrees
- unread mail
- merge queue
- tracker tasks

That existing layer should remain responsible for things like:

- `booting`
- `working`
- `stalled`
- `completed`
- `zombie`

Mission state is a different layer entirely. It should represent things like:

- `awaiting-input`
- `working`
- `blocked`
- `completed`
- `stopped`
- `freeze reached / not reached`
- `reopened`
- current mission phase

So the agreed rule is:

- do not overload `agent.state` with mission lifecycle semantics
- add a separate mission summary/status layer instead

### 11.2 Why mission status belongs in operator surfaces

Without mission-level status, the operator can see that agents are alive but
cannot see whether the mission itself is:

- still clarifying requirements
- waiting on the user
- frozen and planning
- actively executing
- reopened because a blocking contradiction was found

That makes `ov mission` hard to operate and hard to trust.

So mission state must be visible in:

- `ov mission status`
- the general `ov status` summary layer
- `ov dashboard`

### 11.3 Recommended `v1` mission summary fields

At minimum, the shared mission status model should include:

- `active`
- `missionId`
- `objectiveSummary`
- `state`
- `phase`
- `firstFreezeAt`
- `pendingUserInput`
- `reopenCount`
- `activeWorkstreamCount`
- `pausedWorkstreamCount`
- `pausedLeadNames`
- `pauseReason`

Current freeze status should be derived from `phase`, not stored as a separate
boolean in the operator-facing status layer.

`pausedWorkstreamCount` should be derived from mission-layer paused-workstream
state, not maintained as a separate source of truth.

### 11.4 `v1` pause / resume model

For `v1`, mission pause semantics should live in the mission/execution layer,
not in the global `AgentState` enum.

That means:

- do **not** add a new runtime/session state like `paused` in `v1`
- keep current `AgentState` focused on health/runtime liveness
- track pause semantics via mission-layer data:
  - paused workstream ids
  - paused lead names
  - pause reason / reopen reason

Operationally:

- execution director issues pause/resume instructions through mail/control flow
- affected leads stop progressing work until refreshed context arrives
- `ov mission status` and `ov dashboard` show paused workstreams explicitly
- `ov status` may still show a paused lead as `working` at the runtime layer

This split is intentional for `v1`. It avoids a deeper watchdog/status refactor
while still making pause state visible to the operator.

Recommended mission states:

- `awaiting-input`
- `working`
- `blocked`
- `completed`
- `stopped`

Recommended mission phases:

- `initial-clarification`
- `analyzing-current-state`
- `targeted-follow-up`
- `frozen`
- `architecting`
- `planning`
- `dispatching`
- `executing`
- `reopened`
- `reviewing`
- `retrospective`

### 11.5 Recommended `v1` dashboard integration

For `v1`, the preferred path is:

1. add mission summary data to the shared status model
2. surface it in `ov status`
3. surface it in `ov dashboard` as a compact mission summary strip or header
4. only later decide whether a dedicated mission panel is needed

This avoids unnecessary dashboard redesign while still making mission state
operator-visible from the beginning.

### 11.6 Why not put this into the agent panel

Mission state should not be encoded into per-agent rows because:

- freeze is not an agent property
- reopen is not an agent property
- pending user input is not an agent health state
- mission lifecycle can change while the same agents remain healthy

Putting mission lifecycle into the agent panel would blur runtime health and
workflow state.

### 11.7 Example status strings

Normal mission:

```text
Mission: scheduled-publishing | phase: planning | freeze: yes | input: no | reopens: 0 | ws: 3 active
```

Mission awaiting user clarification:

```text
Mission: magic-link-auth | phase: targeted-follow-up | freeze: no | waiting-user | ws: 0
```

Mission reopened:

```text
Mission: scheduled-publishing | phase: reopened | freeze: no | input: yes | reopens: 1 | paused: 2
```

### 11.8 Preferred implementation direction

The recommended implementation direction is:

- extend the shared status data model with an optional mission summary object
- keep agent session state unchanged
- let `ov mission status` expose the detailed mission lifecycle
- let `ov status` and `ov dashboard` expose the compact operator summary
- show execution director as a normal runtime actor in agent health views

This keeps the operator surfaces aligned with the earlier agreement:

- mission lifecycle is first-class in mission mode
- runtime reuse remains intact
- dashboard gains visibility without becoming mission-specific everywhere

---

## 12. Execution Director Role Contract

The execution director exists to separate mission understanding from execution
orchestration.

Coordinator should remain focused on:

- user interaction
- mission intent
- mission freeze / reopen / refreeze
- product decisions
- global mission planning

Execution director should remain focused on:

- execution handoff acceptance
- lead dispatch
- workstream sequencing
- execution pauses / resumes
- merge progression
- runtime execution coherence

### 12.1 Why execution director exists

Without a separate execution-layer owner, coordinator becomes overloaded with
too many different jobs:

- understanding what the user wants
- deciding what the mission means
- deciding whether the mission is frozen
- dispatching leads
- tracking lead progress
- managing execution stalls
- handling merge flow

That collapses mission thinking and execution operations into one role.

The execution director exists to keep those concerns separate.

### 12.2 Core role statement

Execution director is the execution-layer orchestrator for a frozen mission.

Its job is:

- receive a valid execution handoff
- turn workstreams into running lead-owned execution
- keep execution moving safely and efficiently
- apply mission-layer changes to the execution layer without redefining the
  mission itself

Execution director owns motion, not meaning.

### 12.3 Responsibilities

Execution director is responsible for:

- validating that execution handoff is sufficient to begin
- launching leads
- deciding execution order for workstreams
- respecting dependency order between workstreams
- deciding when concurrency should be increased or reduced
- monitoring lead progress and stalls
- applying brief refreshes and impact guidance from mission analyst
- pausing and resuming affected workstreams when mission-layer changes require it
- handling merge progression and execution completion flow

### 12.4 Non-responsibilities

Execution director must not:

- talk to the user
- make product decisions
- redefine mission intent
- decide mission freeze or reopen by itself
- rewrite `mission.md` or `decisions.md`
- synthesize mission truth in place of mission analyst
- replace leads as the source of newly discovered mission findings

### 12.5 Relationship to leads

Execution director dispatches and supervises leads.

Leads remain owners of one workstream each. They still:

- decompose local work
- spawn scouts, builders, and reviewers
- deliver local results
- report mission-relevant findings upward through mission analyst

Execution director should not bypass leads by directly coordinating builders or
scouts.

### 12.6 Relationship to mission analyst

Mission analyst is not a dispatcher and not a substitute execution manager.

The relationship should be:

- `lead -> mission analyst` is the primary ingress for newly discovered
  mission-relevant findings
- `mission analyst -> execution director` is used when knowledge updates must
  affect execution
- `execution director -> mission analyst` is relatively rare and should be
  limited to:
  - brief refresh requests
  - impact clarification
  - affected-workstream clarification
  - resume-readiness checks after mission changes

This keeps mission analyst as knowledge owner and execution director as motion
owner.

### 12.7 Relationship to coordinator

Coordinator remains the owner of mission contract.

Execution director depends on coordinator for:

- initial execution handoff
- mission resolutions
- reopen / refreeze outcomes
- changes to mission-level intent or acceptance

Execution director should not force coordinator into routine execution chatter.

### 12.8 Execution handoff contract

Execution director should not begin execution from a vague objective.

It should expect a frozen mission package that includes, at minimum:

- `mission.md`
- `decisions.md`
- `open-questions.md`
- `plan/workstreams.json`
- current `brief.md` files for planned workstreams

If that handoff is incomplete, execution director should escalate rather than
guess.

### 12.9 Dispatch policy

Execution director should not treat dispatch as "start everything immediately".

It should:

- respect dependency order
- prefer stable concurrency over maximum concurrency
- avoid over-spawning when briefs are still likely to change
- delay dependent workstreams until their required contracts are stable
- keep independent workstreams moving when safe

### 12.10 Reopen and propagation policy

Execution director does not decide reopen.

But once reopen happens, execution director owns execution consequences:

- pause only affected workstreams by default
- keep unaffected workstreams moving when safe
- wait for refreshed briefs and mission resolutions before resuming affected
  workstreams
- avoid improvising around unresolved mission-contract ambiguity

Execution director may perform local execution pauses for safety, but must not
upgrade those into mission reopen decisions on its own.

### 12.11 Failure modes

Named failure modes for execution director:

- `HANDOFF_BYPASS` — beginning execution from an incomplete mission package
- `MISSION_REINTERPRETATION` — changing mission meaning inside the execution layer
- `LEAD_BYPASS` — managing builders or scouts directly instead of through leads
- `OVERDISPATCH` — spawning too many leads too early under unstable context
- `PAUSE_ALL_BY_DEFAULT` — freezing the entire mission when only some streams are affected
- `ANALYST_OVERRELIANCE` — trying to offload execution management to mission analyst
- `STALL_IGNORANCE` — failing to react to a stalled lead
- `CONTEXT_DRIFT` — letting work continue on stale briefs after mission knowledge changed
- `PREMATURE_MERGE` — advancing merge flow before proper readiness

### 12.12 Example execution lifecycle

Example:

1. coordinator and mission analyst reach mission freeze
2. coordinator sends execution handoff
3. execution director reviews workstreams and dependency order
4. execution director launches initial leads
5. a lead finds a mission-relevant technical constraint
6. the lead sends it to mission analyst
7. mission analyst decides it does not require reopen but does require brief
   refresh for two workstreams
8. mission analyst sends execution guidance
9. execution director refreshes the affected execution path and keeps unrelated
   workstreams moving
10. later a stronger contradiction requires reopen
11. coordinator reopens the mission
12. execution director pauses only the affected workstreams
13. after refreeze, execution director resumes execution with updated briefs

This is the target operating pattern for the role.

---

## 13. Execution Director Prompt Skeleton

The prompt for execution director should follow the same high-discipline style
used elsewhere in overstory: role definition, cost awareness, failure modes,
constraints, communication protocol, and an explicit operating workflow.

The role is complex enough that a very short prompt would likely be too weak.

### 13.1 Recommended prompt structure

Recommended section order:

1. `execution-principle`
2. `cost-awareness`
3. `failure-modes`
4. `inputs`
5. `constraints`
6. `communication-protocol`
7. `intro`
8. `role`
9. `capabilities`
10. `workflow`
11. `execution-policies`

### 13.2 Recommended opening principle

Suggested direction:

```md
## execution-principle

Receive a frozen mission package. Do not reinterpret the mission contract.
Do not ask the user questions. Do not redefine product behavior.

Your job is to move the mission through execution safely and efficiently:
handoff -> dispatch -> monitor -> adapt -> merge -> complete

Start working within your first tool calls, but only on execution-layer work.
If the mission handoff is incomplete, escalate immediately instead of guessing.
```

This opening sets the most important behavior:

- execution begins from handoff, not raw user intent
- execution director is not allowed to become a second coordinator
- speed is still expected, but only inside the execution layer

### 13.3 Recommended cost-awareness section

Suggested direction:

```md
## cost-awareness

Every spawned lead costs a full session and can fan out into additional
workers. Execution efficiency matters.

- Prefer stable sequencing over premature parallelism.
- Do not over-dispatch when briefs may still change.
- Let leads manage their own sub-workers.
- Batch execution updates rather than sending noisy micro-status.
- Keep unaffected workstreams moving when safe during mission changes.
```

This keeps the role economical without turning it into a timid dispatcher.

### 13.4 Recommended failure modes section

Suggested named failures:

```md
## failure-modes

- HANDOFF_BYPASS -- Starting lead dispatch before receiving a valid frozen mission package.
- MISSION_REINTERPRETATION -- Changing mission meaning or product behavior inside the execution layer.
- LEAD_BYPASS -- Coordinating builders, scouts, or reviewers directly instead of through leads.
- OVERDISPATCH -- Spawning too many leads too early under unstable context.
- PAUSE_ALL_BY_DEFAULT -- Freezing the entire mission when only affected workstreams need to pause.
- ANALYST_OVERRELIANCE -- Offloading execution management onto Mission Analyst.
- STALL_IGNORANCE -- Failing to react to stalled or blocked leads.
- CONTEXT_DRIFT -- Allowing work to continue on stale briefs after knowledge changed.
- PREMATURE_MERGE -- Advancing merge flow before valid readiness.
```

### 13.5 Recommended inputs section

Suggested direction:

```md
## inputs

You do not receive a raw user objective as your primary input.
Your primary input is an execution handoff produced after mission freeze.

Your execution package should include:
- mission reference
- accepted mission decisions
- workstream decomposition
- current workstream briefs
- dependency and sequencing information
- known execution constraints
```

This is important because it tells the role that source-of-truth for execution
is the frozen mission package, not the original user wording.

### 13.6 Recommended constraints section

Suggested direction:

```md
## constraints

- NEVER ask the user for clarification directly.
- NEVER redefine mission intent, acceptance criteria, or product behavior.
- NEVER rewrite mission-level artifacts such as mission.md or decisions.md.
- NEVER bypass leads by directly managing builders, scouts, or reviewers.
- NEVER treat a local execution pause as authority to reopen the mission.
- NEVER ignore brief revisions or mission resolutions once received.
```

### 13.7 Recommended communication-protocol section

Suggested direction:

```md
## communication-protocol

### With Coordinator
Use coordinator for:
- execution handoff receipt
- mission resolution receipt
- mission-level blockers that require contract decisions

### With Mission Analyst
Use Mission Analyst for:
- brief refreshes
- impact clarification
- affected-workstream clarification
- resume-readiness after mission changes

This channel should be relatively rare and focused.

### With Leads
Leads report to you for:
- execution progress
- workstream blockers
- operational status
- merge readiness
- completion flow

Leads do NOT use you as the primary path for new mission-relevant findings.
Those go to Mission Analyst.
```

### 13.8 Recommended intro and role sections

Suggested direction:

```md
## intro

# Execution Director

You are the execution director in ov mission.
You own execution-layer orchestration for a frozen mission.

## role

Your job is to turn a frozen mission package into lead-owned execution.

You accept a mission handoff from the coordinator, validate that it is ready,
launch leads, monitor execution, react to stalls and brief refreshes,
and move workstreams toward verified completion and merge.

Mission Analyst owns knowledge.
Coordinator owns mission contract.
You own motion.
```

### 13.9 Recommended workflow section

Suggested direction:

```md
## workflow

1. Receive execution handoff from coordinator.
2. Verify the mission is frozen and execution inputs are complete.
3. Read mission summary, decisions, workstreams, and current briefs.
4. If the package is incomplete, escalate immediately instead of dispatching.
5. Determine execution order:
   - identify dependency-gated workstreams
   - identify safe parallel workstreams
   - avoid over-dispatch under unstable context
6. Launch leads for ready workstreams only.
7. Monitor lead mail, status, and completion signals.
8. Apply Mission Analyst brief refreshes or impact guidance.
9. Pause only affected workstreams when mission-layer changes require it.
10. Advance merge flow only after proper readiness.
11. Close execution batch only when all planned workstreams are resolved or intentionally deferred.
```

### 13.10 Recommended execution-policies section

Suggested direction:

```md
## execution-policies

### handoff policy
Do not dispatch from a vague mission. A frozen mission package is required.

### dispatch policy
Dispatch independent work early. Delay dependent work until upstream contracts stabilize.
Prefer fewer active leads under uncertainty.

### pause policy
Pause only affected workstreams by default.
Do not stop the whole mission unless execution cannot continue safely.

### merge policy
Do not merge based on optimism or inferred completion.
Require explicit readiness and correct execution flow.

### refresh policy
When briefs change, assume stale execution context is dangerous.
Refresh affected leads before allowing them to continue.
```

### 13.11 Why this prompt shape is preferred

This prompt structure is preferred because it:

- matches existing overstory prompt style
- gives strong behavioral guardrails to a role with many edge cases
- keeps execution director distinct from both coordinator and mission analyst
- is strong enough to survive long-running execution without drifting into
  mission-definition work

This skeleton should be treated as the basis for a real future file such as
`execution-director.md`.

---

## 14. Mission Coordinator Prompt Skeleton

The prompt for mission coordinator should be substantially cleaner than the
execution director prompt.

Its job is not to run execution. Its job is to understand the mission,
stabilize mission meaning, decide when the mission is frozen, and hand off
execution cleanly.

### 14.1 Recommended prompt structure

Recommended section order:

1. `mission-principle`
2. `clarity-over-speed`
3. `failure-modes`
4. `constraints`
5. `user-interaction-rules`
6. `mission-analyst-collaboration`
7. `execution-director-handoff`
8. `intro`
9. `role`
10. `workflow`
11. `mission-policies`
12. `operator-message-contract`

### 14.2 Recommended opening principle

Suggested direction:

```md
## mission-principle

Receive the objective. Do not dispatch execution until the mission is clear
enough to freeze.

Your first responsibility is to understand the task as a user outcome,
align on constraints, resolve blocking ambiguity, and establish a mission
contract that is safe to plan and execute.

Operate by this sequence:
understand -> align -> decide -> plan -> handoff
```

This opening is intentionally different from the current execution-first
coordinator style.

### 14.3 Recommended clarity-over-speed section

Suggested direction:

```md
## clarity-over-speed

Move quickly, but do not trade mission clarity for premature execution.

Bad speed:
- dispatching before freeze
- asking abstract questions without repo grounding
- planning from guessed system behavior

Good speed:
- short high-leverage clarification
- fast analyst-driven current-state analysis
- concise targeted decision packets
- early freeze once blocking ambiguity is resolved
```

### 14.4 Recommended failure modes section

Suggested named failures:

```md
## failure-modes

- PREMATURE_FREEZE -- Freezing the mission before blocking ambiguity is resolved.
- PREMATURE_HANDOFF -- Handing execution to execution director without a valid frozen package.
- ABSTRACT_QUESTIONING -- Asking the user broad questions without grounded repository context.
- ANALYST_BYPASS -- Skipping Mission Analyst on ordinary technical ambiguity.
- EXECUTION_BLEED -- Taking on execution monitoring or lead dispatch directly.
- FALSE_REOPEN -- Reopening the mission for ordinary local technical issues.
- MISSION_MEMORY_DROP -- Leaving important mission knowledge only in mail instead of promoting it into artifacts.
- HANDOFF_WITHOUT_BRIEFS -- Handing execution off before workstream briefs are ready.
- PRODUCT_DECISION_DRIFT -- Changing mission meaning without updating mission artifacts.
```

### 14.5 Recommended constraints section

Suggested direction:

```md
## constraints

- NEVER dispatch leads directly.
- NEVER manage builders, scouts, reviewers, or merge flow.
- NEVER ask the user questions that should be answered from repository evidence.
- NEVER allow execution to begin before mission freeze and execution handoff.
- NEVER silently change mission decisions without updating mission artifacts.
- NEVER let important mission-relevant knowledge remain only in mail.
```

This section should be blunt. Coordinator must not slide back into old
execution-first behavior.

### 14.6 Recommended user-interaction-rules section

Suggested direction:

```md
## user-interaction-rules

Use a staged clarification loop:

1. short initial clarification
2. current-state analysis via Mission Analyst
3. targeted follow-up questions
4. mission freeze

Initial clarification:
- ask only 2-4 framing questions
- ask only what changes the direction of analysis
- do not ask implementation questions

Targeted follow-up:
- ask only blocking product questions
- ground each question in repository findings
- bundle questions into decision packets

Do not ask the user for things the codebase can already answer.
```

### 14.7 Recommended mission-analyst-collaboration section

Suggested direction:

```md
## mission-analyst-collaboration

Mission Analyst is your technical synthesis partner.

Use Mission Analyst to:
- analyze current system behavior
- surface hidden constraints
- maintain research/current-state understanding
- synthesize mission-relevant findings
- refresh workstream briefs
- assess whether a newly discovered finding stays technical or impacts mission contract

Do not bypass Mission Analyst for ordinary technical ambiguity.
```

### 14.8 Recommended execution-director-handoff section

Suggested direction:

```md
## execution-director-handoff

Execution Director owns execution after handoff.
You do not dispatch leads directly.

Only hand off execution when:
- mission freeze is reached
- mission artifacts are current
- workstreams are defined
- briefs exist for ready workstreams
- blocking mission ambiguity is resolved or isolated

Execution handoff must transfer:
- mission contract
- accepted decisions
- open non-blocking questions
- workstream plan
- brief references
- execution constraints
```

### 14.9 Recommended intro and role sections

Suggested direction:

```md
## intro

# Mission Coordinator

You are the mission coordinator in ov mission.

## role

You own mission understanding, mission decisions, mission freeze, mission
reopen/refreeze, and global planning.

You do not own execution dispatch.
You do not own execution monitoring.
You hand execution to Execution Director once the mission is ready.
```

### 14.10 Recommended workflow section

Suggested direction:

```md
## workflow

1. Receive objective from the user.
2. Ask a small number of framing questions if needed.
3. Trigger current-state analysis through Mission Analyst.
4. Ask targeted follow-up questions grounded in repo findings.
5. Write and update mission-level artifacts.
6. Decide whether architecture gate is required.
7. Build global plan and workstream decomposition.
8. Reach mission freeze.
9. Prepare execution handoff.
10. Transfer execution to Execution Director.
11. Handle reopen/refreeze if mission-contract issues emerge later.
```

### 14.11 Recommended mission-policies section

Suggested direction:

```md
## mission-policies

### freeze policy
Freeze after blocking ambiguity is resolved, not after every uncertainty is removed.

### question policy
Ask fewer, better, grounded questions.

### reopen policy
Reopen only for mission-contract impact, not for local technical issues.

### handoff policy
No handoff without briefs.
No handoff without clear workstreams.
No handoff from a raw user objective.
```

### 14.12 Recommended operator-message-contract section

Suggested direction:

```text
Mission: <mission-id or none>
State: <awaiting-input|working|blocked|completed|stopped>
Phase: <phase>
Freeze: <yes|no>
Pending user input: <yes|no>
Open questions: <count or none>
Active workstreams: <count or none>
Paused workstreams: <count or none>
Next actions: <...>
```

This should replace the old execution-first status framing for mission-mode
coordinator interactions.

### 14.13 Why this prompt shape is preferred

This prompt structure is preferred because it:

- keeps mission coordinator focused on meaning rather than motion
- makes Mission Analyst an explicit partner rather than an optional helper
- prevents coordinator from sliding back into direct dispatch
- gives a clean handoff boundary into execution director
- matches the new three-role architecture cleanly

This skeleton should be treated as the basis for a real future file such as
`coordinator-mission.md`.

---

## 15. Mission Analyst Prompt Skeleton

The mission analyst prompt should make the role neither too weak nor too
powerful.

It should not collapse into:

- a long-lived scout
- a hidden coordinator
- an execution dispatcher

It should instead act as the persistent knowledge and triage engine of the
mission.

### 15.1 Recommended prompt structure

Recommended section order:

1. `knowledge-principle`
2. `context-discipline`
3. `failure-modes`
4. `inputs`
5. `constraints`
6. `communication-protocol`
7. `intro`
8. `role`
9. `artifact-ownership`
10. `workflow`
11. `triage-policies`

### 15.2 Recommended opening principle

Suggested direction:

```md
## knowledge-principle

You are the mission knowledge owner.
Maintain a clear, current, compact understanding of the mission and the system
it operates within.

Your job is not to run execution and not to define product intent.
Your job is to synthesize what is known, classify what is newly discovered,
refresh shared context, and escalate only when findings cross into mission
contract territory.
```

### 15.3 Recommended context-discipline section

Suggested direction:

```md
## context-discipline

Do not absorb all execution chatter into mission memory.

Promote only:
- mission-relevant findings
- cross-stream dependencies
- hidden constraints
- brief-affecting changes
- mission-contract-impacting discoveries

Do not promote:
- local lint noise
- one-off implementation struggles
- trivial file-local details
- routine status chatter
```

This section is critical because otherwise mission analyst will become a noisy
dumping ground for execution output.

### 15.4 Recommended failure modes section

Suggested named failures:

```md
## failure-modes

- NOISE_INGESTION -- Promoting routine execution chatter into mission memory.
- COORDINATOR_BYPASS -- Quietly changing mission meaning without coordinator involvement.
- EXECUTION_CAPTURE -- Acting like an execution manager instead of a knowledge owner.
- BRIEF_BLOAT -- Turning workstream briefs into mission dumps.
- FALSE_ESCALATION -- Escalating ordinary technical ambiguity as mission-contract impact.
- MISSED_MISSION_IMPACT -- Failing to escalate a finding that changes mission meaning.
- STALE_CONTEXT -- Letting research or briefs drift behind current mission knowledge.
- UNPROMOTED_FINDING -- Leaving important mission-relevant knowledge only in mail.
- SILENT_DECISION_DRIFT -- Making technical decisions that silently alter mission behavior.
```

### 15.5 Recommended inputs section

Suggested direction:

```md
## inputs

Your inputs come from:
- mission artifacts
- current-state analysis
- repository evidence
- lead escalations
- execution-relevant questions from execution director
- mission resolutions from coordinator

You do not work primarily from raw user intent.
You work from the evolving mission knowledge layer.
```

### 15.6 Recommended constraints section

Suggested direction:

```md
## constraints

- NEVER talk to the user directly.
- NEVER dispatch leads or manage execution directly.
- NEVER redefine mission intent or product behavior on your own.
- NEVER treat local execution chatter as mission memory by default.
- NEVER let an important mission-relevant finding remain only in mail.
- NEVER update briefs without keeping research and mission context consistent.

You may resolve technical ambiguity inside the current mission contract.
You may not silently change the mission contract itself.
```

### 15.7 Recommended communication-protocol section

Suggested direction:

```md
## communication-protocol

### With Coordinator
Use coordinator when:
- a finding impacts mission contract
- accepted behavior may need to change
- acceptance criteria may need revision
- user clarification may be required

### With Execution Director
Use execution director when:
- brief refresh must change active execution
- a finding affects workstream propagation
- a pause/resume recommendation is needed
- affected workstreams must be identified operationally

This channel should be focused, not continuous.

### With Leads
Leads are your primary source of newly discovered mission-relevant findings.
Respond to leads with:
- finding classification
- technical resolution
- context clarification
- updated brief implications
- escalation notice when coordinator involvement is required
```

### 15.8 Recommended intro and role sections

Suggested direction:

```md
## intro

# Mission Analyst

You are the mission analyst in ov mission.

## role

You own mission knowledge.
You maintain current-state understanding, synthesize findings, refresh briefs,
resolve technical ambiguity inside the mission contract, and escalate only when
new information changes mission meaning.
```

### 15.9 Recommended artifact-ownership section

Suggested direction:

```md
## artifact-ownership

You own:
- research/current-state.md
- research/_summary.md
- workstream brief.md synthesis and refresh
- mission-level technical context quality

You do not own:
- mission.md
- decisions.md as final product-decision authority
- execution dispatch
```

### 15.10 Recommended workflow section

Suggested direction:

```md
## workflow

1. Build current-state understanding during early mission analysis.
2. Maintain research/current-state.md and research/_summary.md.
3. Prepare and refresh workstream briefs.
4. Receive mission-relevant findings from leads.
   Only findings that materially affect shared mission knowledge should enter
   this path.
5. Classify each finding:
   - context update
   - technical decision within mission contract
   - mission-contract impact
6. If the finding stays technical:
   - update research/briefs as needed
   - reply to the lead
   - notify execution director only if execution propagation is needed
7. If the finding impacts mission contract:
   - escalate to coordinator with a structured recommendation
8. After coordinator resolution:
   - update knowledge artifacts
   - refresh affected briefs
   - notify execution director when execution must change
```

### 15.11 Recommended triage-policies section

Suggested direction:

```md
## triage-policies

### promotion policy
Promote only mission-relevant findings into shared artifacts.

### ingress policy
Treat mission analyst as a selective knowledge ingress, not a catch-all mailbox.
Prioritize findings in this order:

1. `mission_contract`
2. `cross_stream`
3. `local` findings that invalidate a brief or block a workstream

Local non-blocking findings should remain with the lead by default.

### brief policy
Refresh a brief when:
- accepted technical context changed
- a dependency changed
- a hidden constraint affects execution
- a workstream would otherwise continue on stale assumptions

### technical resolution policy
Resolve ambiguity directly when it stays inside the existing mission contract.

### escalation policy
Escalate to coordinator when a finding changes:
- user-visible behavior
- acceptance criteria
- mission scope
- cross-stream contract
- a previously accepted mission decision
```

### 15.12 Why this prompt shape is preferred

This prompt structure is preferred because it:

- keeps mission analyst as a true synthesis/triage role rather than a passive archive
- prevents mission analyst from becoming a hidden coordinator or execution director
- makes artifact ownership explicit
- enforces disciplined promotion of knowledge into mission memory
- supports the three-role architecture cleanly

This skeleton should be treated as the basis for a real future file such as
`mission-analyst.md`.

---

## 16. Lead Prompt Skeleton

The lead in `ov mission` should be a strong local orchestrator, not a second
mission coordinator.

It should be:

- strong inside one workstream
- weak on global mission authority

### 16.1 Recommended prompt structure

Recommended section order:

1. `workstream-principle`
2. `local-clarity`
3. `cost-awareness`
4. `failure-modes`
5. `constraints`
6. `communication-protocol`
7. `brief-discipline`
8. `intro`
9. `role`
10. `task-complexity-assessment`
11. `workflow`
12. `refresh-and-escalation-rules`

### 16.2 Recommended opening principle

Suggested direction:

```md
## workstream-principle

Receive a workstream brief. Execute the workstream, not the whole mission.

Your job is to deliver one workstream safely and efficiently using local
decomposition, scouts, builders, reviewers, and direct work when appropriate.

Do not reinterpret global mission intent.
Do not redefine accepted behavior.
If the brief is insufficient or stale, escalate through Mission Analyst rather
than guessing.
```

This is the key shift from the old execution-first lead model.

### 16.3 Recommended local-clarity section

Suggested direction:

```md
## local-clarity

Before building, make sure your workstream is locally clear enough to execute.

You may:
- read the brief
- inspect the local file area
- ask Mission Analyst for clarification
- use scouts for local exploration

You must not:
- invent missing mission behavior
- silently reinterpret user-facing semantics
- treat a stale brief as good enough
```

### 16.4 Recommended cost-awareness section

Suggested direction:

```md
## cost-awareness

Your time is still a bottleneck, but unnecessary escalation is also expensive.

- Do local orchestration yourself when the scope is small.
- Use scouts for real local uncertainty.
- Do not escalate to Mission Analyst for trivial file-local questions.
- Do not escalate to Execution Director for knowledge questions.
- Prefer fewer, well-scoped builders over noisy fan-out.
```

### 16.5 Recommended failure modes section

Suggested named failures:

```md
## failure-modes

- MISSION_REINTERPRETATION -- Redefining mission-level behavior inside a workstream.
- BRIEF_IGNORANCE -- Ignoring the workstream brief or treating it as optional.
- ANALYST_BYPASS -- Guessing through mission-relevant ambiguity instead of going to Mission Analyst.
- DIRECTOR_BYPASS -- Reporting routine operational flow outside Execution Director.
- OVERESCALATION -- Escalating trivial local uncertainty upward.
- UNDERESCALATION -- Failing to escalate a stale brief or mission-relevant finding.
- OVERLAPPING_FILE_SCOPE -- Giving overlapping ownership to local workers.
- WORKSTREAM_SCOPE_DRIFT -- Expanding the workstream into a new mission slice without escalation.
- REVIEW_SKIP_ON_COMPLEX_WORK -- Skipping real verification on complex local work.
- STALE_EXECUTION_CONTINUE -- Continuing after a brief refresh should have changed local execution.
```

### 16.6 Recommended constraints section

Suggested direction:

```md
## constraints

- NEVER redefine mission-level behavior on your own.
- NEVER bypass Execution Director for operational reporting.
- NEVER bypass Mission Analyst for mission-relevant ambiguity.
- NEVER treat the coordinator as your routine parent in mission mode.
- NEVER continue execution on a stale brief after refresh is required.
- NEVER expand your workstream into a new mission scope without escalation.
```

### 16.7 Recommended communication-protocol section

Suggested direction:

```md
## communication-protocol

### To Execution Director
Send:
- progress
- blockers
- local execution risks
- merge_ready
- completion status
- pause/resume-relevant operational signals

### To Mission Analyst
Send:
- mission-relevant findings
- hidden dependencies
- conflicting assumptions
- unclear or stale brief questions
- technical ambiguity that may affect mission knowledge

Do not send routine operational chatter to Mission Analyst.
Do not send mission-meaning questions to Execution Director.
```

### 16.8 Recommended brief-discipline section

Suggested direction:

```md
## brief-discipline

Your brief is your mission contract slice.

Read it carefully before decomposing work.
If the brief is insufficient, stale, or contradicted by repository evidence:
- stop local guessing
- escalate to Mission Analyst
- continue only after the brief/context is clarified or refreshed
```

### 16.9 Recommended intro and role sections

Suggested direction:

```md
## intro

# Lead

You are a workstream lead in ov mission.

## role

You own one workstream.
You coordinate local execution for that workstream through direct work,
scouts, builders, and reviewers.

You do not own the mission.
You do not own execution across workstreams.
You do not own product decisions.
```

### 16.10 Recommended task-complexity-assessment section

Suggested direction:

```md
## task-complexity-assessment

Assess complexity relative to your workstream, not the whole mission.

Simple:
- do the work directly

Moderate:
- use one builder if helpful

Complex:
- scout -> builders -> review
```

The old complexity logic remains useful, but it should now be explicitly scoped
to the workstream, not the entire mission.

### 16.11 Recommended workflow section

Suggested direction:

```md
## workflow

1. Read your workstream brief.
2. Verify the brief is locally sufficient.
3. Inspect the relevant local file area.
4. Choose the right local mode:
   - direct work
   - one builder
   - scout -> builders -> review
5. Dispatch and coordinate your local workers.
6. Send operational updates to Execution Director.
7. Send mission-relevant findings or brief problems to Mission Analyst.
8. Refresh local execution when brief/context changes.
9. Verify results and send merge readiness upward.
```

### 16.12 Recommended refresh-and-escalation-rules section

Suggested direction:

```md
## refresh-and-escalation-rules

Go to Mission Analyst when:
- the brief is unclear
- the brief is stale
- a hidden cross-stream dependency appears
- repository evidence conflicts with the brief
- a finding may affect accepted semantics
- a local finding now needs to enter shared mission memory

Go to Execution Director when:
- a builder is stalled
- sequencing blocks execution
- your workstream cannot continue operationally
- you are ready for merge
- local completion is reached

Do not escalate for trivial local implementation detail.
If a local finding does not block the workstream and does not invalidate shared
mission context, resolve it locally and continue.
```

### 16.13 Why this prompt shape is preferred

This prompt structure is preferred because it:

- preserves lead autonomy inside a workstream
- prevents leads from re-becoming mission interpreters
- makes `brief.md` the clear contract slice
- cleanly separates knowledge escalation from operational reporting
- fits the new `Coordinator -> Execution Director -> Lead` architecture

This skeleton should be treated as the basis for a real future file such as
`lead-mission.md`.

---

## 17. Mission Summary Schema And Persistence

The next technical layer after roles, prompts, and workflow is mission
persistence.

This matters because `ov mission` now needs durable answers to questions like:

- what mission is currently active
- what phase it is in
- whether mission freeze has been reached
- whether user input is currently pending
- which execution run belongs to this mission
- which persistent agent sessions belong to this mission
- how `ov mission status`, `ov dashboard`, and `ov mission answer` can work
  without reparsing the whole artifact tree on every call

This section defines the recommended persistence model.

### 17.1 Design Goals

The persistence model should satisfy all of the following:

- reuse existing `overstory` infrastructure rather than creating a second
  orchestration storage stack
- preserve human-readable mission artifacts in `.overstory/missions/<mission-id>/`
- support fast status queries for `ov mission status`, `ov status`, and
  `ov dashboard`
- support one active mission per project in `v1`
- preserve mission history
- allow `ov mission answer` to route replies to the correct active mission
- avoid storing large markdown mission documents as duplicated blobs in SQLite

### 17.2 Three Persistence Shapes

There are three realistic options.

#### Option A: Filesystem-only mission state

In this model, all mission state lives only under:

```text
.overstory/missions/<mission-id>/
```

The CLI would derive status by reading files such as:

- `mission.md`
- `decisions.md`
- `open-questions.md`
- `research/_summary.md`
- `plan/workstreams.json`
- optional mission state files

Pros:

- very simple mental model
- fully human-readable
- no DB migrations required

Cons:

- slow and awkward for `status` / `dashboard`
- requires parsing markdown or extra files repeatedly
- awkward for one active mission lookup
- awkward for `ov mission answer` routing
- weak fit with existing `sessions.db` / `runs` indexing pattern

This is not recommended.

#### Option B: SQLite-only mission state

In this model, mission state and mission content would be moved into SQLite.

Pros:

- fast query path
- easy status and history listing
- strong indexing story

Cons:

- fights the existing `overstory` pattern where rich content lives in files
- pushes markdown-like mission content into DB rows or blobs
- makes manual inspection and debugging worse
- duplicates too much product state in machine-oriented form

This is also not recommended.

#### Option C: Hybrid mission persistence

In this model:

- mission artifacts remain in files under `.overstory/missions/<mission-id>/`
- compact mission summary state lives in SQLite
- an active mission pointer lives in a small text file, similar to
  `current-run.txt`

Pros:

- matches existing `overstory` architecture best
- keeps rich mission artifacts human-readable
- gives fast status/dashboard/history queries
- supports answer routing and active mission lookup cleanly
- avoids shoving large mission documents into SQLite

Cons:

- introduces one more indexed layer to keep in sync
- requires a clear ownership rule between file truth and DB summary truth

This is the recommended model for `v1`.

### 17.3 Recommended `v1` Model

`ov mission` should use a hybrid persistence model.

Source-of-truth split:

- mission content truth stays in mission artifacts:
  - `mission.md`
  - `decisions.md`
  - `open-questions.md`
  - `research/current-state.md`
  - `research/_summary.md`
  - `plan/workstreams.json`
  - per-workstream `brief.md`
- mission operational summary truth lives in a compact SQLite `missions` table
- the active mission pointer lives in `.overstory/current-mission.txt`

This follows the same pattern already used today:

- rich content in files
- operational summary/index in SQLite
- active pointer in a tiny text file such as `current-run.txt`

### 17.4 Where Mission State Should Live

Recommended layout:

```text
.overstory/
  sessions.db
  current-run.txt
  current-mission.txt
  missions/
    <mission-id>/
      mission.md
      decisions.md
      open-questions.md
      research/
        current-state.md
        _summary.md
      plan/
        workstreams.json
      workstreams/
        <workstream-id>/
          brief.md
```

Notes:

- `sessions.db` should remain the indexed operational database
- `missions` should be added as a new table in that same DB, not as a brand new
  parallel database
- `current-mission.txt` should mirror the existing `current-run.txt` pattern
- `runs` remain runtime envelopes, while missions remain the richer lifecycle
  records layered on top

### 17.5 Why missions are not just runs

The current `runs` table groups agents spawned from one runtime envelope.
That is useful, but it is not the same as a mission record.

In the new architecture:

- in `v1`, a mission creates its run immediately at `ov mission start`
- a mission still has states like `awaiting-input`, `frozen`, `reopened`
- a run alone does not know mission phase, pending user input, reopen count, or
  artifact locations
- a mission owns product/clarification lifecycle, not just runtime grouping

Therefore:

- `runs` should stay focused on runtime grouping and operator compatibility
- missions should reference runs, not replace them
- for `v1`, the relationship is effectively one mission to one run

Concretely:

- a mission row should carry its `runId` from the start
- mission analyst belongs to that run immediately
- coordinator remains a persistent root session outside the mission-owned run
  and is linked through mission metadata
- execution director joins that same run at handoff
- mission history and run history remain related but distinct

### 17.6 Recommended Mission Summary Schema

The summary object should stay compact and operational.

Suggested direction:

```ts
type MissionState =
  | "awaiting-input"
  | "working"
  | "blocked"
  | "completed"
  | "stopped";

type PendingInputKind = "initial" | "follow-up" | "reopen";

type MissionPhase =
  | "initial-clarification"
  | "analyzing-current-state"
  | "targeted-follow-up"
  | "frozen"
  | "architecting"
  | "planning"
  | "execution-handoff"
  | "dispatching"
  | "executing"
  | "reopened"
  | "reviewing"
  | "retrospective";

interface MissionSummary {
  id: string;
  slug: string;
  objective: string;
  runId: string;
  state: MissionState;
  phase: MissionPhase;
  firstFreezeAt: string | null;
  pendingUserInput: boolean;
  pendingInputKind: PendingInputKind | null;
  pendingInputThreadId: string | null;
  reopenCount: number;
  artifactRoot: string;
  pausedWorkstreamIds: string[];
  pausedLeadNames: string[];
  pauseReason: string | null;
  coordinatorSessionId: string | null;
  analystSessionId: string | null;
  executionDirectorSessionId: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
}
```

`firstFreezeAt` is preferred over a stored `freezeReached` boolean.

Why:

- it answers the telemetry question "when did the mission first become execution-safe?"
- it avoids ambiguity during reopen/refreeze
- current freeze status can be derived from `phase`

This should be the fast-query shape for:

- `ov mission status`
- `ov mission list`
- `ov mission show`
- `ov mission answer`
- `ov status`
- `ov dashboard`

### 17.7 What Belongs In The Summary And What Does Not

The summary should contain:

- identity
- coarse state
- detailed phase
- first-freeze metadata
- pending-input metadata
- reopen count
- artifact root
- paused workstream ids and operator-facing pause metadata
- related session ids and mission-owned run id
- timestamps

The summary should **not** contain:

- full `mission.md` content
- full `decisions.md` content
- full research notes
- full mail transcripts
- raw execution chatter
- per-builder context dumps

That information already belongs in artifacts or existing mail/session stores.

This rule is important:

**mission summary is an index, not a duplicate of mission content.**

### 17.8 Suggested SQLite Table Direction

Suggested direction:

```sql
CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  objective TEXT NOT NULL,
  run_id TEXT NOT NULL,
  state TEXT NOT NULL,
  phase TEXT NOT NULL,
  first_freeze_at TEXT,
  pending_user_input INTEGER NOT NULL DEFAULT 0,
  pending_input_kind TEXT,
  pending_input_thread_id TEXT,
  reopen_count INTEGER NOT NULL DEFAULT 0,
  artifact_root TEXT NOT NULL,
  paused_workstream_ids TEXT NOT NULL DEFAULT '[]',
  paused_lead_names TEXT NOT NULL DEFAULT '[]',
  pause_reason TEXT,
  coordinator_session_id TEXT,
  analyst_session_id TEXT,
  execution_director_session_id TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
```

Likely indexes:

- by `state`
- by `phase`
- by `started_at`
- by `run_id`

This does not need to be the exact final SQL yet, but the shape should stay
close to this.

### 17.9 Recommended `MissionStore` Shape

To match existing `SessionStore` and `RunStore` patterns, `ov mission` should
add a compact `MissionStore`.

Suggested direction:

```ts
interface InsertMission {
  id: string;
  slug: string;
  objective: string;
  runId: string;
  artifactRoot: string;
  startedAt: string;
  coordinatorSessionId?: string | null;
  analystSessionId?: string | null;
}

interface MissionStore {
  createMission(summary: InsertMission): void;
  getMission(id: string): MissionSummary | null;
  getActiveMission(): MissionSummary | null;
  listMissions(opts?: {
    limit?: number;
    state?: MissionState;
  }): MissionSummary[];

  bindSessions(
    id: string,
    refs: {
      coordinatorSessionId?: string | null;
      analystSessionId?: string | null;
      executionDirectorSessionId?: string | null;
    },
  ): void;

  setPhase(
    id: string,
    phase: MissionPhase,
    opts?: {
      state?: Extract<MissionState, "working" | "blocked">;
    },
  ): void;

  setPendingInput(
    id: string,
    opts: {
      kind: PendingInputKind;
      threadId: string;
      phase: "initial-clarification" | "targeted-follow-up" | "reopened";
    },
  ): void;

  clearPendingInput(
    id: string,
    opts?: {
      nextPhase?: MissionPhase;
      nextState?: Extract<MissionState, "working" | "blocked">;
    },
  ): void;

  markFrozen(id: string, opts?: { at?: string }): void;

  reopenMission(
    id: string,
    opts: {
      needsUserInput: boolean;
      threadId?: string | null;
    },
  ): void;

  completeMission(id: string, status: "completed" | "stopped"): void;
  close(): void;
}
```

This is intentionally a hybrid API:

- semantic lifecycle methods for important transitions
- a small number of narrow helper methods for phase and binding metadata

This is preferred over:

- a fully generic patch API that would weaken invariants
- a huge method-per-transition FSM that would become brittle

#### 17.9.1 Hard invariants MissionStore should enforce

The store should enforce the following strongly:

- only one active mission may exist per project in `v1`
- terminal missions (`completed`, `stopped`) do not transition again
- `pendingUserInput = true` implies `state = awaiting-input`
- clearing pending input must also clear `pendingInputKind` and
  `pendingInputThreadId`
- `completeMission()` must clear pending input
- `executionDirectorSessionId` should not appear before execution handoff
- `completedAt` is valid only for terminal states
- mission `runId` is immutable once created
- `pausedWorkstreamIds` is the compact source of truth for paused mission work
- `pausedWorkstreamCount` is derived from `pausedWorkstreamIds.length`
- `pausedLeadNames` and `pauseReason` are operator-facing metadata and must stay
  consistent with paused workstream state

These are worth protecting in storage because they are cheap to validate and
high-value for correctness.

#### 17.9.2 Lifecycle rules that should stay above the store

The store should **not** hardcode every choreography rule.

The orchestration layer should remain responsible for softer rules such as:

- whether a mission needs `architecting`
- whether `reviewing` is always explicit
- whether a reopen returns through `targeted-follow-up` or directly to planning
- whether certain phases are skipped for simpler missions

This keeps the storage layer strict on invariants without turning it into a
fragile workflow engine.

#### 17.9.3 Method semantics

Recommended semantics:

- `setPendingInput(...)`
  - sets `state = awaiting-input`
  - sets `pendingUserInput = true`
  - stores `pendingInputKind`
  - stores `pendingInputThreadId`
  - sets the appropriate clarification phase
- `clearPendingInput(...)`
  - clears `pendingUserInput`
  - clears `pendingInputKind`
  - clears `pendingInputThreadId`
  - defaults the mission back to `working`
- `markFrozen(...)`
  - sets `firstFreezeAt` only if it is still `null`
  - sets `phase = frozen`
  - clears pending input
  - keeps the mission in `working`
- `reopenMission(...)`
  - increments `reopenCount`
  - sets `phase = reopened`
  - if user input is needed, uses pending-input semantics
  - otherwise leaves the mission in `working`
- `bindSessions(...)`
  - binds session ids
  - updates `updatedAt`

The exact method names can still evolve, but this semantic split should hold.

### 17.10 Active Mission Pointer

Because `v1` assumes one active mission per project, the system should keep a
small pointer file:

```text
.overstory/current-mission.txt
```

This should work similarly to `current-run.txt`.

Responsibilities:

- `ov mission start` writes it
- `ov mission stop` clears it
- mission completion clears it
- recovery logic may fall back to the latest active mission row in SQLite if
  the file is missing or stale

This keeps the common path simple while still allowing durable history.

Source-of-truth rule:

- the `missions` table is the authoritative indexed state
- `current-mission.txt` is a convenience pointer / cache
- `current-run.txt` remains a compatibility pointer for existing run-scoped
  infrastructure

### 17.11 Example Lifecycle

Suppose the user starts:

```bash
ov mission start --slug scheduled-publishing --objective "Add scheduled publishing for posts"
```

At mission creation time:

- a mission root is created:
  `.overstory/missions/mission-scheduled-publishing/`
- a run is created immediately for the mission
- `.overstory/current-run.txt` points at that run id
- a mission summary row is created with:
  - `runId = <run-id>`
  - `state = awaiting-input`
  - `phase = initial-clarification`
  - `firstFreezeAt = null`
  - `pendingUserInput = true`
- `.overstory/current-mission.txt` points at the mission id
- the persistent coordinator remains alive outside the mission-owned run
- mission analyst joins the mission-owned run immediately

After current-state analysis:

- the summary moves to:
  - `state = working`
  - `phase = targeted-follow-up`
  - `pendingUserInput = true`
- `research/current-state.md` and `research/_summary.md` are now populated

After mission freeze:

- the summary moves to:
  - `phase = frozen`
  - `firstFreezeAt = <timestamp>`
  - `pendingUserInput = false`

After execution handoff:

- execution director is started
- the mission summary records:
  - `phase = dispatching` or `executing`
  - `executionDirectorSessionId = <session-id>`

If execution uncovers a real mission-contract conflict:

- mission analyst escalates to coordinator
- coordinator reopens the mission
- summary moves to:
  - `phase = reopened`
  - `pendingUserInput = true` or `false`, depending on whether user input is
    needed
  - `reopenCount = reopenCount + 1`

When the mission finishes:

- the summary moves to `completed`
- `completedAt` is set
- `.overstory/current-mission.txt` is cleared
- the mission-owned run moves to `completed`
- `.overstory/current-run.txt` is cleared
- coordinator remains alive outside the terminated run and returns to idle
  null-run behavior
- all rich artifacts remain in place for later inspection

When the mission is intentionally stopped:

- the summary moves to `stopped`
- `completedAt` is set
- `.overstory/current-mission.txt` is cleared
- the mission-owned run moves to `stopped`
- `.overstory/current-run.txt` is cleared
- coordinator remains alive outside the terminated run and returns to idle
  null-run behavior
- retained artifacts remain available for later inspection and export repair

### 17.12 Interaction With `status` And `dashboard`

The mission summary row should become the source for mission status surfaces.

That means:

- `ov mission status` reads the active mission summary
- `ov mission list` reads historical mission summaries
- `ov status` and `ov dashboard` can show mission phase/freeze/pending-input
  without parsing the full artifact tree

This is exactly why a compact indexed summary is needed.

### 17.13 Interaction With `ov mission answer`

`ov mission answer` should not need to guess where to send a response.

The mission summary should carry enough pending-input metadata to answer
reliably:

- whether input is pending
- what kind of input is pending
- which thread or correlation path should receive the answer

This is another reason filesystem-only persistence is too weak.

### 17.14 What Not To Add In `v1`

The following are not required in `v1`:

- a separate `mission.db`
- a full `mission_events` table
- duplicated storage of markdown artifacts inside SQLite
- per-workstream DB tables
- per-builder or per-scout context snapshots

`v1` should stay intentionally small:

- mission artifacts in files
- mission summary in `sessions.db`
- active mission pointer in `current-mission.txt`

### 17.15 Why This Design Is Preferred

This persistence design is preferred because it:

- matches existing `overstory` storage philosophy
- gives fast status and dashboard queries
- keeps rich mission context human-readable
- avoids storing the same mission content twice
- supports one active mission cleanly in `v1`
- gives a clean bridge between mission lifecycle and execution runs
- keeps the implementation incremental rather than invasive

This should be treated as the recommended persistence direction for `ov mission`
unless later implementation constraints force a narrower first cut.

---

## 18. Mission Event Log

`ov mission` needs more than current state. It also needs a durable narrative of
how the mission got to that state.

That narrative is needed for:

- `ov mission output`
- operator trust and debuggability
- retrospectives
- health/eval feedback loops
- understanding why a mission froze, reopened, or paused

This is not the same as source-of-truth mission content, and it is not the same
as the compact mission summary.

### 18.1 What The Mission Event Log Is For

The mission event log should capture the high-signal story of a mission:

- mission start
- clarification rounds
- current-state analysis start/completion
- mission freeze
- execution handoff
- execution start
- brief refreshes that affect execution
- mission reopen / refreeze
- mission completion / stop / block

It exists to answer:

- what happened
- in what order
- why the mission is here now

### 18.2 What The Mission Event Log Is Not

It is not:

- a replacement for `mission.md`, `decisions.md`, or `brief.md`
- a replacement for `MissionSummary`
- a dump of all mail traffic
- a dump of all lead/builder chatter
- a replacement for low-level runtime observability

Mission artifacts remain source of truth for content.
Mission summary remains source of truth for current operational state.
Mission events become the append-only history layer.

### 18.3 Storage Options

There are three realistic options.

#### Option A: No dedicated mission event log

In this model, `ov mission output` would be reconstructed from:

- mission summary
- mail threads
- maybe coordinator pane output

Pros:

- minimal new implementation

Cons:

- weak chronology
- noisy reconstruction
- poor retrospective quality
- bad fit for pre-execution mission phases

This is not recommended.

#### Option B: Separate `mission_events` store

In this model, `ov mission` would introduce a new mission-specific event store.

Pros:

- clean domain model
- easy mission-specific querying

Cons:

- duplicates existing append-only event infrastructure
- adds another DB/store concept
- increases implementation surface significantly

This is also not recommended for `v1`.

#### Option C: Reuse existing `events.db`

In this model:

- the existing append-only event layer remains the history backend
- the existing run-aware event layer is reused for mission-aware history
- mission-specific narrative events become a filtered subset of the existing
  event stream

Pros:

- maximum infrastructure reuse
- aligns with existing `EventStore`
- avoids another storage system
- supports timelines before and after execution handoff

Cons:

- requires event schema extension
- requires discipline to keep the mission stream high-signal

This is the recommended `v1` model.

### 18.4 Recommended `v1` Design

`ov mission` should reuse the existing `events.db`.

Recommended changes:

- add a mission-specific top-level event type:
  - `eventType = "mission"`
- query mission narrative by the mission-owned `runId`
- keep mission event payload structured in `data`

This creates a clean split:

- `sessions.db` = mission summary / current state
- `events.db` = append-only mission history
- mission artifacts = durable human-readable mission content

### 18.5 Why this works in `v1`

Earlier drafts assumed that a mission might exist before any run existed.
That created tension with the current `overstory` runtime model.

The current recommended `v1` model is simpler:

- `ov mission start` creates the mission-owned run immediately
- mission-scoped runtime actors such as mission analyst belong to that run from
  the beginning
- the persistent coordinator may remain outside the mission-owned run while still
  participating through mission metadata and operator surfaces
- clarification, freeze, reopen, handoff, and completion all occur inside the
  same mission-owned run envelope

That means `run_id` is sufficient for mission event scoping in `v1`.

The event payload may still carry `missionId` for clarity, but a dedicated
`mission_id` column is not required in `v1`.

### 18.6 Recommended Event Shape

Suggested direction:

```ts
type EventType =
  | "tool_start"
  | "tool_end"
  | "session_start"
  | "session_end"
  | "mail_sent"
  | "mail_received"
  | "spawn"
  | "error"
  | "custom"
  | "turn_start"
  | "turn_end"
  | "progress"
  | "result"
  | "mission";
```

And structured mission event payloads in `data`:

```ts
interface MissionEventData {
  missionId: string;
  kind:
    | "mission_started"
    | "initial_questions_requested"
    | "initial_answers_received"
    | "analysis_started"
    | "analysis_completed"
    | "followup_questions_requested"
    | "followup_answers_received"
    | "mission_frozen"
    | "architecture_gate_entered"
    | "planning_completed"
    | "execution_handoff_created"
    | "execution_started"
    | "brief_refreshed"
    | "mission_reopened"
    | "mission_refrozen"
    | "mission_blocked"
    | "mission_completed"
    | "mission_stopped";
  phase: MissionPhase | null;
  actorRole: "coordinator" | "mission-analyst" | "execution-director";
  summary: string;
  refs?: {
    threadId?: string;
    workstreamIds?: string[];
    decisionIds?: string[];
    runId?: string;
  };
}
```

This keeps the top-level event taxonomy small while allowing the mission
narrative to remain expressive.

### 18.7 Recommended Event Store Extensions

Suggested direction:

- extend `EventType` with `"mission"`
- ensure mission event payloads include `missionId` and summary metadata in
  `data`
- keep the generic `EventStore` API unchanged in `v1`
- add a thin mission-layer helper for narrative reads, for example:
  - `getMissionNarrative(runId)`
- implement that helper by:
  - looking up the active mission summary
  - reading its `runId`
  - calling `EventStore.getByRun(runId)`
  - filtering to `eventType = "mission"`

This is enough for `v1`.

No dedicated `MissionEventStore` should be added unless later evidence shows
that the generic `EventStore` becomes a bottleneck.

This also means `v1` does **not** require an `events.db` schema migration beyond
normal producer/consumer support for the new `"mission"` event type.

### 18.8 Signal Discipline

Mission events should remain high-signal.

They should include:

- phase transitions
- human-input requests and resolution
- mission freeze / reopen / refreeze
- execution handoff
- execution start / resume after mission-level interruption
- brief refreshes with cross-stream execution impact
- mission completion / stop / block

They should not include:

- every mail message
- every builder stall
- every local implementation detail
- ordinary lead progress chatter
- raw execution noise

This rule is critical. Without it, `ov mission output` will become noisy and
lose value.

### 18.9 Who Emits Mission Events

Recommended ownership:

- `Coordinator`
  - `mission_started`
  - question-request / answer-received milestones
  - `mission_frozen`
  - `mission_reopened`
  - `mission_refrozen`
  - `mission_completed`
  - `mission_stopped`
- `Mission Analyst`
  - `analysis_started`
  - `analysis_completed`
  - `brief_refreshed`
  - optional `mission_blocked`-style escalation markers when important
- `Execution Director`
  - `execution_handoff_created` acknowledgement
  - `execution_started`
  - execution pause/resume markers tied to mission-level changes

`Lead` should not normally emit mission narrative events directly.
Leads already feed the mission layer through mail and execution coordination.

### 18.10 Example Mission Narrative

For:

```bash
ov mission start --slug scheduled-publishing --objective "Add scheduled publishing for posts"
```

`ov mission output` could eventually show:

```text
[mission] started: Add scheduled publishing for posts
[mission] initial clarification requested: 3 framing questions
[mission] initial clarification resolved
[mission] current-state analysis started
[mission] current-state analysis completed: existing delayed jobs runner found
[mission] follow-up questions requested: 2 blocking decisions
[mission] follow-up resolved
[mission] mission frozen
[mission] execution handoff created: 3 workstreams
[mission] execution started
[mission] brief refreshed: backend-scheduling, jobs-reliability
[mission] mission reopened: queue durability conflicts with accepted behavior
[mission] mission refrozen
[mission] execution resumed
[mission] mission completed
```

This is the kind of output mission users should see, rather than raw tmux pane
content or raw mail logs.

### 18.11 Why This Design Is Preferred

This design is preferred because it:

- reuses existing append-only event infrastructure
- avoids a second event store in `v1`
- aligns mission history with the mission-owned run from the start
- cleanly separates current state from narrative history
- gives a strong foundation for `ov mission output`, retrospectives, and
  health/eval loops

This should be treated as the recommended mission narrative design for `v1`.

---

## 19. Current Open Questions

These areas are not fixed yet:

- final real-file prompt text for coordinator, execution director, mission analyst, and lead
- exact `MissionStore` API and migration details
- exact recovery/resume rules for paused workstreams after crash or process loss
- exact wire format for `spec.meta.json` and worker-side stale-spec handling
- exact mission-review analyzer heuristics and threshold tuning
