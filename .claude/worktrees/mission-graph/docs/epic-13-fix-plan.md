# Epic #13 Fix Plan

Date: 2026-03-13

Related docs:

- `docs/epic-13-verification-review.md`
- `docs/ov-mission.md`
- `docs/ov-mission-implementation.md`

Target:

- Close the remaining gaps so `ov mission v1` can be considered "real" under the Definition of Done in `docs/ov-mission-implementation.md`.

Current status:

- Mission happy-path is implemented and broadly working.
- `ov mission v1` is still not DoD-complete because of:
  - missing runtime enforcement for `Execution Director -> lead only`
  - incomplete stale-spec safety model
  - incomplete canonical task bridge wiring
  - selective ingress not enforced in runtime routing
  - incomplete recovery/shared-surface/review CLI proof

## Success Criteria

This plan is complete only when all of the following are true:

- `Execution Director` can dispatch leads, and only leads, through the real runtime.
- Mission stale/missing spec metadata blocks builder/reviewer dispatch and workstream resume until regenerated.
- Workstream `taskId` values are canonical against the tracker on the real handoff path.
- Selective ingress is enforced in code and routing, not only by prompts.
- Shared `status` and `dashboard` surfaces show the required mission lifecycle and role presence.
- Crash/recovery and terminal-path proof match Phase 13.
- `ov review missions` and `ov review mission <id>` have functional CLI proof.
- `ov coordinator` fast-path remains green.

## Execution Order

Recommended order:

1. Mission context recovery foundation
2. Hierarchy enforcement for `Execution Director`
3. Stale-spec hardening
4. Canonical task bridge wiring
5. Selective ingress routing enforcement
6. Shared status/dashboard surface completion
7. Review CLI proof
8. Phase 13 recovery and terminal-path proof

Rationale:

- Phases 1-4 remove the current blocking gaps.
- Phases 5-8 close the remaining document-compliance and proof-quality gaps.

## Work Backlog

## Phase 1: Shared Mission Context Recovery

Status: planned

Goal:

- Make mission-aware runtime behavior depend on durable mission state, not only pointer files.

Why this phase exists:

- Today `resolveCurrentMissionId()` in `ov mission` can recover from `MissionStore`.
- `ov sling` still uses `.overstory/current-mission.txt` directly to decide whether mission-mode guards apply.
- Phase 13 explicitly requires recovery coverage for lost `current-mission.txt` and lost `current-run.txt`.

Primary files:

- `src/commands/mission.ts`
- `src/commands/sling.ts`
- `src/commands/mail.ts`
- `src/commands/status.ts`
- `src/commands/dashboard.ts`
- Possibly a new shared helper module under `src/missions/`

Implementation tasks:

- Extract mission pointer read/write/recovery logic from `src/commands/mission.ts` into a shared helper.
- Add a mission context resolver that can:
  - read `current-mission.txt` when present
  - recover the active mission from `MissionStore` when missing
  - recover `runId` from the active mission record
  - rewrite pointer files after recovery
- Update `src/commands/sling.ts` to use the shared mission context resolver instead of checking `current-mission.txt` directly.
- Review `src/commands/mail.ts` and any other mission-aware code paths to make them use the same recovery source of truth.
- Keep pointer files as a cache/convenience layer, not the only source of mission identity.

Tests to add:

- `src/commands/mission.test.ts`
  - recovery still restores both mission and run pointers
- `src/commands/sling.test.ts`
  - mission-mode capability/spec guard still activates when `current-mission.txt` is missing but active mission exists in store
- `src/commands/mission.e2e.test.ts`
  - remove `current-mission.txt` mid-flow and confirm mission-aware commands still work
  - remove `current-run.txt` and confirm run-scoped behavior can recover

Acceptance criteria:

- Mission-aware behavior does not silently degrade when pointer files are lost.
- `ov sling` still applies mission-aware guards after recovery.
- Pointer files are restored automatically from durable state.

Risks:

- Changing mission resolution in shared code can accidentally affect non-mission fast paths.
- Run scoping must not regress coordinator behavior.

Dependencies:

- None. This should be the foundation for later phases.

## Phase 2: Runtime Hierarchy Enforcement For Execution Director

Status: planned

Goal:

- Enforce in code that `Execution Director` may spawn only `lead`.

Why this phase exists:

- Current hierarchy checks only distinguish root/no-parent versus parented spawns.
- That leaves ED able to spawn workers directly.

Primary files:

- `src/commands/sling.ts`
- `src/commands/sling.test.ts`
- `agents/execution-director.md`

Implementation tasks:

- Replace the current boolean-style hierarchy check with a capability-aware parent/child matrix.
- Resolve parent capability from session metadata when `--parent` is set.
- Enforce at minimum:
  - root/coordinator-human path: existing allowed behavior preserved unless explicitly changed
  - `execution-director -> lead` only
  - `lead -> scout|builder|reviewer|merger`
  - disallow `execution-director -> builder|scout|reviewer|merger`
- Decide whether `mission-analyst` should be allowed to spawn anything; current design suggests no.
- Keep `--force-hierarchy` as an explicit bypass if that behavior is still desired for debugging.
- Update error messages so they explain which parent capability caused the rejection.

Tests to add:

- `src/commands/sling.test.ts`
  - `execution-director -> lead` allowed
  - `execution-director -> builder` rejected
  - `execution-director -> scout` rejected
  - `execution-director -> reviewer` rejected
  - `lead -> builder/reviewer/scout` still allowed
  - existing coordinator fast-path cases unchanged or intentionally adjusted
- `src/commands/coordinator.test.ts`
  - rerun regression suite to prove no coordinator breakage

Acceptance criteria:

- ED can dispatch leads through real runtime commands.
- ED cannot dispatch workers directly.
- Existing lead-to-worker hierarchy still works.

Risks:

- Parent capability lookup depends on session-store correctness.
- Over-tightening root rules can break existing coordinator flow.

Dependencies:

- Prefer after Phase 1 if parent/run recovery is reused.

## Phase 3: Stale-Spec Hardening

Status: planned

Goal:

- Make stale/missing mission spec state block local execution exactly as Phase 8 and Phase 9 require.

Why this phase exists:

- Current safety model has holes for missing metadata, missing mission pointers, and missing `--spec`.

Primary files:

- `src/commands/sling.ts`
- `src/missions/workstream-control.ts`
- `src/missions/brief-refresh.ts`
- `src/commands/spec.ts`
- `src/commands/mission.ts`
- `agents/lead-mission.md`

Implementation tasks:

- In mission mode, require `--spec` for `builder` and `reviewer`.
- Treat missing companion `.meta.json` as invalid/non-current, not as a soft no-op.
- Update `validateWorkstreamResume()` so `metas.length === 0` becomes blocking when a resumable workstream should already have a current lead spec.
- Update brief refresh flow so a workstream without current spec metadata is still marked as requiring regeneration and remains/resets paused.
- Ensure regenerated spec metadata clears the stale block only when:
  - `status === current`
  - brief revision matches current brief
- Audit whether any lead/reviewer dispatch paths can skip spec linkage and close those loopholes.
- Keep prompts aligned with the new runtime truth.

Tests to add:

- `src/missions/workstream-control.test.ts`
  - missing-meta resume rejection
  - stale-meta resume rejection
  - current-meta resume success
- `src/commands/sling.test.ts`
  - mission builder/reviewer spawn without `--spec` rejected
  - mission builder/reviewer spawn with missing meta rejected
  - mission builder/reviewer spawn with stale meta rejected
- `src/commands/spec.test.ts`
  - regenerated spec metadata transitions to `current`
- `src/commands/mission.e2e.test.ts`
  - refresh-briefs with missing metadata still forces regeneration path
  - resume stays blocked until spec is rewritten current

Acceptance criteria:

- Builder/reviewer dispatch references a current spec revision in mission mode.
- Missing metadata blocks execution the same way stale metadata does.
- Resume does not succeed until the spec is current.

Risks:

- Some existing lead flows may rely on optional `--spec`.
- Need to avoid breaking non-mission builder/reviewer behavior.

Dependencies:

- Phase 1 strongly recommended first so stale checks do not depend on pointer presence.

## Phase 4: Canonical Task Bridge Wiring

Status: planned

Goal:

- Ensure every workstream has a real canonical tracker `taskId` before lead handoff.

Why this phase exists:

- Current code models task bridge helpers but does not enforce them on the production mission handoff path.

Primary files:

- `src/missions/workstreams.ts`
- `src/commands/mission.ts`
- Tracker integration modules under `src/tracker/`

Implementation tasks:

- Define one canonical behavior for missing tasks:
  - either fail handoff until tasks exist
  - or create tasks and persist returned tracker IDs as the canonical `taskId`
- If creation is allowed, update `workstreams.json` with the actual ID returned by the tracker.
- Run task bridge validation before `dispatchCommands` are generated in `missionHandoff`.
- Remove `--skip-task-check` from ED-generated lead dispatch commands once handoff enforces canonical tracker state.
- Keep `--skip-task-check` only for lead-owned internal worker dispatch where appropriate.
- Ensure error output clearly identifies which workstream failed task bridging.

Tests to add:

- `src/missions/workstreams.test.ts`
  - created task ID is persisted/canonicalized if tracker returns a different ID
  - missing task bridge failure blocks handoff when configured to fail
- `src/commands/mission.e2e.test.ts`
  - handoff fails when canonical task bridge fails
  - handoff succeeds when bridge verification passes
- Potential tracker integration tests depending on backend abstraction

Acceptance criteria:

- Handoff cannot dispatch a lead against an unverified/non-canonical task ID.
- `dispatchCommands` reflect canonical tracker-backed task IDs.
- The task bridge is on the real runtime boundary, not only in unit helpers.

Risks:

- Writing back canonical IDs may complicate artifact immutability expectations.
- Tracker create/show behavior differs by backend.

Dependencies:

- Can start after Phase 1; independent from Phase 2/3 except shared tests.

## Phase 5: Selective Ingress Enforcement In Routing

Status: planned

Goal:

- Enforce selective ingress in code and routing, not only via prompts.

Why this phase exists:

- The helper exists but is not on the production routing path.

Primary files:

- `src/missions/ingress.ts`
- `src/commands/mail.ts`
- Potentially `src/mail/client.ts`
- Potentially mission runtime command handlers if additional routing logic is needed

Implementation tasks:

- Decide the enforcement point:
  - validate on `ov mail send` when `--to mission-analyst --type mission_finding`
  - optionally validate again when consuming mission finding mail
- Require structured payload sufficient for ingress validation.
- Reject non-qualifying `mission_finding` messages before they enter the analyst channel.
- Preserve a useful error message telling the lead to resolve locally.
- Keep typed protocol support unchanged for valid escalations.

Tests to add:

- `src/commands/mail.test.ts`
  - non-qualifying `mission_finding` to analyst rejected
  - cross-stream escalation allowed
  - brief-invalidating escalation allowed
  - malformed payload rejected
- Keep unit tests in `src/missions/ingress.test.ts`

Acceptance criteria:

- A local non-blocking lead finding cannot be routed to mission analyst without an explicit validation failure.
- The analyst is not a default sink for all findings.

Risks:

- Over-validating at send-time can block legacy/manual usage if payload requirements are too strict.

Dependencies:

- None. Can run in parallel with later phases once core blockers are addressed.

## Phase 6: Shared Mission Surfaces Completion

Status: planned

Goal:

- Bring `ov status` and `ov dashboard` mission surfaces up to Phase 10 expectations.

Why this phase exists:

- Shared surfaces show lifecycle state, but they do not yet show runtime presence of coordinator/analyst/execution director inline.

Primary files:

- `src/commands/status.ts`
- `src/commands/status.test.ts`
- `src/commands/dashboard.ts`
- `src/commands/dashboard.test.ts`

Implementation tasks:

- Extend the mission summary rendered by `ov status` to show role presence fields.
- Extend the dashboard mission strip or nearby panel so it includes role presence without cluttering the screen.
- Keep mission lifecycle rendering independent from agent health rendering.
- Ensure JSON output, if any, remains stable or intentionally versioned.

Tests to add:

- `src/commands/status.test.ts`
  - role presence visible in mission section
- `src/commands/dashboard.test.ts`
  - mission strip includes role-presence data
  - pending/pause data still visible

Acceptance criteria:

- Shared operator surfaces visibly show:
  - mission state
  - phase
  - pending input
  - paused workstreams
  - runtime presence of coordinator/analyst/execution director

Risks:

- Dashboard layout is width-sensitive; mission strip changes may break formatting tests.

Dependencies:

- None, though Phase 1 helps if role presence is tied to recovered mission context.

## Phase 7: Review CLI Functional Proof

Status: planned

Goal:

- Add real command-level proof for `ov review missions` and `ov review mission <id>`.

Why this phase exists:

- Implementation exists, but proof quality is weaker than other mission areas.

Primary files:

- `src/commands/review.ts`
- `src/commands/review.test.ts`
- `src/missions/review.ts`
- `src/review/analyzers/mission.ts`

Implementation tasks:

- Build temp-project integration tests for:
  - listing recent completed/stopped mission reviews
  - scoring a single mission by ID
  - scoring a single mission by slug
  - no-terminal-missions case
- Seed mission records, events, sessions, metrics, and artifacts as needed.
- Verify CLI text output and/or JSON output at the command action level, not only command registration.

Tests to add:

- `src/commands/review.test.ts`
  - functional `missions --json`
  - functional `mission <id> --json`
  - slug lookup path
  - empty-result path

Acceptance criteria:

- Command-level proof exists that mission review CLI works against real stores.

Risks:

- Test setup may become verbose because review generation touches multiple stores.

Dependencies:

- Independent. Can be done after blocker phases.

## Phase 8: Phase 13 Recovery And Terminal Proof

Status: planned

Goal:

- Add the missing end-to-end proof required by Phase 13.

Why this phase exists:

- The happy-path e2e is good, but the required crash/recovery scenarios are still missing.

Primary files:

- `src/commands/mission.e2e.test.ts`
- `src/commands/mission.test.ts`
- `src/commands/sling.test.ts`
- `src/commands/coordinator.test.ts`

Implementation tasks:

- Add e2e scenario for lost `current-mission.txt`.
- Add e2e or integration scenario for lost `current-run.txt`.
- Add restart/recovery scenario for paused workstreams.
- Add stop-path e2e to prove:
  - terminal state becomes `stopped`
  - run is terminalized as `stopped`
  - result bundle exports
  - mission review materializes
- Reconfirm `ov coordinator` fast-path regression after all changes.

Tests to add:

- `src/commands/mission.e2e.test.ts`
  - lost mission pointer recovery
  - lost run pointer recovery
  - paused workstream recovery after restart
  - stopped terminal path bundle/review export
- `src/commands/coordinator.test.ts`
  - rerun full suite as regression gate

Acceptance criteria:

- Required Phase 13 crash/recovery scenarios are explicitly covered.
- Stopped and completed mission terminal paths both produce retained artifacts and review data.

Risks:

- E2E setup may become large; keep helpers reusable to prevent brittle tests.

Dependencies:

- Best done after Phases 1-4, otherwise recovery proof may still be invalid.

## Validation Gates

Run after every major phase:

1. `bun x tsc --noEmit`
2. `bun test src/commands/mission.e2e.test.ts src/commands/mission.test.ts src/commands/spec.test.ts src/missions/workstream-control.test.ts src/commands/completions.test.ts src/commands/status.test.ts src/commands/dashboard.test.ts src/commands/mail.test.ts src/commands/sling.test.ts`
3. `bun test src/commands/coordinator.test.ts`

Run after Phases 4-8 as expanded mission proof:

4. `bun test src/commands/review.test.ts src/missions/review.test.ts src/review/analyzers/mission.test.ts src/missions/bundle.test.ts src/missions/workstreams.test.ts src/missions/ingress.test.ts`

Recommended final full regression:

5. Full `bun test`

## Detailed Design

This section turns the phase plan into an implementation spec. A phase is not
"done" when code compiles; it is done only when the contracts in this section
hold and the tests named here are green.

### Cross-Cutting Rules

- Keep all mission recovery logic behind one shared resolver. Do not leave
  separate ad-hoc `current-mission.txt` reads in commands that enforce mission
  guardrails.
- Keep pointer files as cache/output artifacts, not the authoritative source.
- Mission-only guardrails must remain mission-scoped. Non-mission `ov sling`,
  `ov mail`, and `ov coordinator` behavior must remain unchanged unless
  explicitly noted below.
- Any runtime invariant that is required by `docs/ov-mission-implementation.md`
  must be enforced in code, not only in prompts.
- Any new recovery helper must be side-effect free by default, with explicit
  pointer rewrite only when recovery actually succeeds.

### Phase 1 Module Contract: Shared Mission Context Recovery

New/shared module to introduce:

- `src/missions/runtime-context.ts`

Suggested exports:

- `currentMissionPointerPath(overstoryDir: string): string`
- `currentRunPointerPath(overstoryDir: string): string`
- `readCurrentMissionPointer(overstoryDir: string): Promise<string | null>`
- `readCurrentRunPointer(overstoryDir: string): Promise<string | null>`
- `writeMissionRuntimePointers(overstoryDir: string, missionId: string, runId: string | null): Promise<void>`
- `clearMissionRuntimePointers(overstoryDir: string): Promise<void>`
- `resolveActiveMissionContext(overstoryDir: string): Promise<{ missionId: string; runId: string | null } | null>`

Expected behavior:

- If `current-mission.txt` exists and points to a non-empty mission ID, return it.
- If `current-mission.txt` is missing but `MissionStore.getActive()` returns a
  mission, recover both `missionId` and `runId`, then rewrite pointers.
- If `current-run.txt` is missing but active mission has `runId`, rewrite it.
- If pointer files exist but mission store has no active mission, trust the
  pointer only for read-only UX paths that already tolerate stale state; do not
  silently invent mission guardrails from a pointer to a non-existent mission.
- `resolveActiveMissionContext()` must never create a new run.

Migration/refactor steps:

- Move pointer helpers out of `src/commands/mission.ts`.
- Re-export thin wrappers from `mission.ts` only if tests depend on them.
- Replace direct `current-mission.txt` reads in:
  - `src/commands/sling.ts`
  - `src/commands/mail.ts`
  - any other mission-aware command path found by `rg "current-mission.txt"`

Tests required:

- `mission.test.ts`
  - resolves active mission from store when mission pointer is missing
  - rewrites both mission and run pointers on recovery
  - returns `null` cleanly when no mission exists
- `sling.test.ts`
  - recovered mission context still enables mission spec guards
- `mission.e2e.test.ts`
  - delete `current-mission.txt`, continue mission flow successfully
  - delete `current-run.txt`, continue mission flow successfully

### Phase 2 Module Contract: Hierarchy Enforcement

Primary file:

- `src/commands/sling.ts`

Implementation shape:

- Replace `validateHierarchy(parentAgent, capability, ...)` with a capability-aware
  version that can inspect the parent session when `--parent` is provided.
- Keep the public function testable. Accept enough data so unit tests do not need
  full CLI setup.

Suggested structure:

- `resolveParentCapability(parentAgent: string | null, sessions: ReadonlyArray<{ agentName: string; capability: string }>): string | null`
- `allowedChildCapabilities(parentCapability: string | null): string[]`
- `validateHierarchy(opts: { parentAgent: string | null; capability: string; name: string; depth: number; forceHierarchy: boolean; sessions: ReadonlyArray<{ agentName: string; capability: string }> }): void`

Required matrix:

- `parent = null`
  - preserve existing direct spawn fast-paths already used by coordinator tests
- `execution-director`
  - allow `lead`
  - reject everything else
- `lead`
  - allow `scout`, `builder`, `reviewer`, `merger`
  - reject `lead`, `mission-analyst`, `execution-director`
- `mission-analyst`
  - reject all children
- unknown parent session
  - fail closed unless `--force-hierarchy`

Error-message contract:

- include the parent agent name
- include the parent capability if known
- include the rejected child capability
- tell the caller which capabilities are allowed instead

Tests required:

- `sling.test.ts`
  - ED -> lead passes
  - ED -> builder/scout/reviewer/merger fails
  - lead -> builder/reviewer/scout/merger passes
  - mission-analyst -> anything fails
  - unknown parent session fails closed
  - `--force-hierarchy` bypass still works
- `coordinator.test.ts`
  - mandatory regression gate only; no new behavior intended

### Phase 3 Module Contract: Stale-Spec Hardening

Files:

- `src/commands/sling.ts`
- `src/missions/workstream-control.ts`
- `src/missions/brief-refresh.ts`
- `src/commands/mission.ts`
- `src/commands/spec.ts`

Behavioral contract:

- In mission context, `builder` and `reviewer` must always provide `--spec`.
- In mission context, provided `--spec` must resolve to:
  - a task ID derivable from filename
  - existing companion meta
  - `meta.status === "current"`
  - matching current brief revision
- Missing companion meta is a hard failure, not advisory state.
- A workstream paused due to brief refresh cannot resume while its spec metadata
  is missing, stale, or out of date.

Implementation notes:

- Introduce a shared mission-context check in `sling.ts` based on Phase 1 helper.
- Add a small helper in `workstream-control.ts` to express whether a workstream
  requires current spec metadata:
  - `workstreamRequiresCurrentSpec(workstream: Workstream): boolean`
  - For v1, any workstream with `briefPath !== null` should require current spec.
- Update `validateWorkstreamResume()`:
  - if workstream requires spec and `metas.length === 0`, return `ok: false`
  - if multiple metas exist and any is stale, return `ok: false`
  - optionally ensure at least one `current` meta record belongs to the
    workstream task ID
- Update `refreshBriefChain()` return shape so callers can distinguish:
  - `metaMissing`
  - `revisionChanged`
  - `specWasStale`
  - `specMarkedStale`
  - `regenerationRequired`
- Update `missionRefreshBriefsCommand()` pause logic to key off
  `regenerationRequired`, not only `specMarkedStale || specWasStale`
- Update `spec write` path only if needed to ensure regenerated meta always lands
  in `current` state for the exact workstream/task pair

Required command-path enforcement:

- `ov sling <task> --capability builder --parent <lead>` in mission mode with no
  `--spec` must fail
- same for `reviewer`
- same commands outside mission mode must keep current behavior

Tests required:

- `workstream-control.test.ts`
  - workstream with brief and zero meta records fails resume
  - workstream with stale meta fails resume
  - workstream with current meta passes resume
- `brief-refresh.test.ts`
  - missing meta yields `regenerationRequired: true`
  - changed brief marks stale when meta exists
- `sling.test.ts`
  - mission builder without `--spec` fails
  - mission reviewer without `--spec` fails
  - mission builder with missing meta fails
  - mission builder with stale meta fails
  - non-mission builder without `--spec` still allowed if previously allowed
- `mission.e2e.test.ts`
  - refresh-briefs with missing meta pauses workstream and blocks resume
  - regenerated spec unblocks resume

### Phase 4 Module Contract: Canonical Task Bridge

Files:

- `src/missions/workstreams.ts`
- `src/commands/mission.ts`
- tracker client tests/mocks used by mission tests

Canonical behavior to implement:

- `mission handoff` must verify every dispatched workstream has a real tracker task.
- If tracker `show(taskId)` succeeds, keep the existing ID.
- If `show(taskId)` reports not found and tracker `create()` succeeds:
  - capture the returned ID
  - persist that exact ID back into `workstreams.json`
  - use the returned ID in handoff payload and `dispatchCommands`
- If verification/create fails for any eligible handoff workstream:
  - abort the entire handoff
  - print which workstream failed and why

Refactor target:

- extend `TaskBridgeResult` so it can carry `canonicalTaskId`
- add a persistence helper, for example:
  - `persistCanonicalTaskIds(filePath: string, updates: Array<{ workstreamId: string; taskId: string }>): Promise<void>`
- add a single top-level runtime entry point:
  - `ensureCanonicalWorkstreamTasks(filePath: string, tracker: TrackerClient): Promise<{ workstreams: Workstream[]; results: TaskBridgeResult[] }>`

Dispatch command contract:

- `slingArgsFromHandoff()` must stop emitting `--skip-task-check` for ED -> lead dispatch.
- The task ID embedded in the command must be the canonical tracker-backed ID.

Tests required:

- `workstreams.test.ts`
  - persists returned tracker ID when create returns a different value
  - preserves existing ID when show succeeds
  - surfaces hard tracker errors without mutating file
- `mission.e2e.test.ts`
  - handoff fails on task-bridge failure
  - handoff succeeds with canonicalized IDs and generated commands use them

### Phase 5 Module Contract: Selective Ingress Routing

Files:

- `src/commands/mail.ts`
- `src/missions/ingress.ts`

Runtime contract:

- When sending mail to `mission-analyst` with `--type mission_finding`, a valid
  structured payload is mandatory.
- The payload must parse as `MissionFindingPayload`.
- `validateMissionIngress(payload)` must run before message persistence.
- Invalid ingress must fail the command before the mail is written.

Practical validation rules:

- reject missing payload
- reject invalid JSON
- reject payloads missing `workstreamId`, `category`, `summary`, or `affectedWorkstreams`
- reject payloads that fail `validateMissionIngress`

Error-message contract:

- tell the sender whether the issue is malformed or non-qualifying
- when non-qualifying, direct them to resolve at lead level

Tests required:

- `mail.test.ts`
  - invalid `mission_finding` without payload rejected
  - malformed payload rejected
  - local non-cross-stream finding rejected
  - cross-stream finding accepted
  - brief-invalidating finding accepted

### Phase 6 Module Contract: Shared Mission Surfaces

Files:

- `src/commands/status.ts`
- `src/commands/dashboard.ts`

Required UI contract:

- Shared surfaces must show:
  - mission slug
  - mission state + phase
  - pending input state
  - paused workstream count
  - coordinator runtime state
  - analyst runtime state
  - execution director runtime state

Implementation note:

- Reuse the same role-state semantics as `ov mission status`:
  - `running`
  - `stopped`
  - `not started`
  - `unknown`

Tests required:

- `status.test.ts`
  - mission section includes the three role-state lines
- `dashboard.test.ts`
  - mission strip or companion line includes compact role-presence info

### Phase 7 Module Contract: Review CLI Proof

Files:

- `src/commands/review.test.ts`
- `src/commands/review.ts`

Proof target:

- test real command actions, not only registration

Suggested helper to add in test file:

- temp project bootstrap with:
  - `.overstory/reviews.db`
  - `.overstory/sessions.db`
  - optional mission artifact bundle files
  - seeded mission records

Functional cases:

- `review missions --json`
  - returns recent mission review rows
- `review mission <id> --json`
  - returns one materialized review
- `review mission <slug> --json`
  - resolves by slug
- empty result path stays deterministic

### Phase 8 Module Contract: Phase 13 Recovery Proof

Required end-to-end scenarios:

- lost `current-mission.txt` after mission start
- lost `current-run.txt` during mission execution
- paused workstream after process restart / fresh store open
- `mission stop` terminal path exports:
  - mission state `stopped`
  - terminalized run
  - result bundle
  - mission review

Test-design guidance:

- Reuse the existing mission e2e bootstrap helpers; do not duplicate setup.
- Prefer explicit assertions on store contents and exported artifact files over
  stdout-only checks.

## Suggested Commit Slices

Suggested implementation slices to keep reviewable diffs:

1. `mission: add shared mission context recovery helpers`
2. `mission: enforce execution director lead-only hierarchy`
3. `mission: harden stale spec blocking and resume semantics`
4. `mission: wire canonical task bridge into handoff`
5. `mission: enforce selective ingress in mail routing`
6. `mission: complete status and dashboard mission role surfaces`
7. `mission: add functional review cli coverage`
8. `mission: add crash recovery and stopped-path e2e proof`

## Exit Checklist

- [ ] Phase 1 merged and recovery helpers adopted by mission-aware runtime paths
- [ ] Phase 2 merged and ED hierarchy invariant enforced by code
- [ ] Phase 3 merged and stale/missing spec state blocks dispatch/resume
- [ ] Phase 4 merged and canonical task bridge is on the production handoff path
- [ ] Phase 5 merged and selective ingress is enforced in routing
- [ ] Phase 6 merged and shared surfaces show required mission lifecycle + role presence
- [ ] Phase 7 merged and review CLI has functional proof
- [ ] Phase 8 merged and required recovery/terminal e2e proof exists
- [ ] Required focused suites green
- [ ] `coordinator` regression suite green
- [ ] Final DoD re-review says `yes` for every item
