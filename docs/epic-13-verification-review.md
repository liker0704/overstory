# Epic #13 Verification Review

Date: 2026-03-13

Scope:

- Repo: `liker0704/overstory`
- Issue: `#13` `Epic: implement ov mission end-to-end`
- HEAD reviewed: `57a8eb2` `Add mission e2e proof and code-generated lead dispatch`
- Additional reviewed commits:
  - `7b668d7` `Close mission spec refresh and pause control gaps`
  - `87e1efc` `Implement mission v1 runtime and review flow`
- Primary references:
  - `docs/ov-mission.md`
  - `docs/ov-mission-implementation.md`

Excluded from review target as unrelated local changes:

- `.overstory/mail-check-state.json`
- `debug/`
- `opencode-research.md`

## Findings

### High

1. `Execution Director` is not runtime-enforced to spawn leads only.
   **Status: FIXED** — sling.ts now enforces ED can only spawn leads (sling.ts:423-425)

   Impact:

   - The runtime hierarchy check only distinguishes `parentAgent === null` vs non-null.
   - Any parented actor, including `execution-director`, can spawn `builder`, `scout`, or `reviewer`.
   - This contradicts the ED prompt and Phase 6 acceptance criteria that direct worker dispatch remains disallowed and ED may spawn only leads.

   Evidence:

   - `src/commands/sling.ts:387`
   - `src/commands/sling.ts:398`
   - `src/commands/sling.ts:576`
   - `src/commands/sling.test.ts:404`
   - `src/commands/sling.test.ts:438`
   - `agents/execution-director.md:33`
   - `agents/execution-director.md:103`
   - `docs/ov-mission-implementation.md:485`
   - `docs/ov-mission-implementation.md:499`

2. Stale-spec safety does not meet the document's required guarantee level.
   **Status: OPEN** — spec freshness guard still bypassed when mission pointer is lost or --spec omitted

   Impact:

   - `ov sling` checks mission spec freshness only when both:
     - `.overstory/current-mission.txt` exists, and
     - `--spec` is provided.
   - If mission pointer is lost, or a builder/reviewer is spawned without `--spec`, the stale-spec guard is skipped.
   - `refreshBriefChain()` does not mark anything stale when companion `.meta.json` is missing.
   - `validateWorkstreamResume()` returns `ok: true` when a workstream has zero spec meta records.

   This means the following claims are not strictly true:

   - stale or missing mission spec metadata really blocks execution
   - `refresh-briefs` always forces regeneration before resume
   - `resume` never continues until the spec is current

   Evidence:

   - `src/commands/sling.ts:587`
   - `src/commands/sling.ts:592`
   - `src/missions/workstream-control.ts:138`
   - `src/missions/workstream-control.ts:179`
   - `src/missions/brief-refresh.ts:73`
   - `src/missions/brief-refresh.ts:123`
   - `src/commands/mission.ts:1385`
   - `src/commands/mission.ts:98`
   - `src/commands/mission.test.ts:80`
   - `agents/lead-mission.md:233`
   - `docs/ov-mission-implementation.md:604`
   - `docs/ov-mission-implementation.md:611`
   - `docs/ov-mission-implementation.md:815`

### Medium

3. Workstream-to-task bridge is not fully wired into the production handoff path.
   **Status: FIXED** — ensureCanonicalWorkstreamTasks called in handoff path (workstream-control.ts:646)

   Impact:

   - `bridgeWorkstreamsToTasks()` and `validateTaskIds()` exist, but the mission handoff path does not call them.
   - Generated dispatch commands use `--skip-task-check`.
   - If a task must be created, `bridgeWorkstreamsToTasks()` ignores the ID returned by the tracker and still treats the original `ws.taskId` as canonical.

   Result:

   - The code proves that handoff includes runtime-shaped `taskId` arguments.
   - It does not prove that each workstream is bridged to a real canonical tracker task in production before dispatch.

   Evidence:

   - `src/missions/workstreams.ts:223`
   - `src/missions/workstreams.ts:248`
   - `src/missions/workstreams.ts:333`
   - `src/tracker/types.ts:32`
   - `src/commands/mission.ts:925`
   - `src/missions/workstreams.test.ts:242`
   - `src/missions/workstreams.test.ts:391`
   - `docs/ov-mission-implementation.md:353`

4. Selective ingress is implemented as a helper, not as runtime routing enforcement.
   **Status: FIXED** — validateMissionIngress enforced in mail routing (mail.ts:276-292)

   Impact:

   - `validateMissionIngress()` is covered by unit tests.
   - No production call sites were found in mission mail/routing paths.
   - The doc explicitly requires selective-ingress rules "in code and routing, not only in prompt".

   Result:

   - Analyst-side filtering remains prompt-level behavior, not deterministic runtime behavior.

   Evidence:

   - `src/missions/ingress.ts:50`
   - `src/missions/ingress.test.ts:59`
   - `src/mail/client.ts:86`
   - `docs/ov-mission-implementation.md:439`
   - `docs/ov-mission-implementation.md:540`

### Low

5. Shared `status` and `dashboard` surfaces do not fully match the Phase 10 mission strip requirement.
   **Status: FIXED** — dashboard now renders role presence inline (render.ts:624)

   Impact:

   - They show mission lifecycle, pending input, and paused count.
   - They do not show inline runtime presence of `coordinator / analyst / execution director`.
   - `ov mission status` does show those roles, but Phase 10 requires that visibility on the shared operator surfaces.

   Evidence:

   - `src/commands/status.ts:296`
   - `src/commands/dashboard.ts:1008`
   - `src/commands/mission.ts:616`
   - `docs/ov-mission-implementation.md:673`

6. `ov review missions` and `ov review mission <id>` have weaker proof than the rest of the mission flow.
   **Status: IMPROVED** — functional tests added (review.test.ts:177-222), but CLI proof still lighter than rest of flow

   Impact:

   - Implementation exists.
   - Deterministic mission analyzer and bundle export are covered.
   - Command-level tests only validate command shape and options, not functional CLI behavior.

   Evidence:

   - `src/commands/review.ts:425`
   - `src/commands/review.ts:495`
   - `src/commands/review.test.ts:1`
   - `src/missions/review.ts:82`

## Compliance Matrix

| DoD item | Verdict | Notes |
| --- | --- | --- |
| mission can be started, inspected, answered, and stopped through `ov mission` | yes | Implemented and covered by command/e2e tests. `mission answer` replies in-thread and unfreezes mission. Evidence: `src/commands/mission.ts:390`, `src/commands/mission.ts:564`, `src/commands/mission.ts:709`, `src/commands/mission.ts:1548`, `src/commands/mission.e2e.test.ts:213` |
| mission-owned run is created immediately and terminalized correctly | yes | Run is created during `mission start`; terminal path completes/stops run and clears mission/run pointers. Evidence: `src/commands/mission.ts:430`, `src/commands/mission.ts:467`, `src/commands/mission.ts:319`, `src/commands/mission.e2e.test.ts:168`, `src/commands/mission.e2e.test.ts:270` |
| mission analyst lifecycle is deterministic and mission-scoped | yes | Analyst starts on mission start, binds to mission/run, and stops on terminalize. Evidence: `src/commands/mission.ts:469`, `src/commands/mission.ts:482`, `src/commands/mission.ts:276`, `src/commands/coordinator.test.ts:2771` |
| execution director can dispatch leads through the real runtime | yes | Runtime enforcement added in sling.ts:423-425. Evidence: `src/commands/mission.ts:929`, `src/types.ts:439`, `src/commands/mission.e2e.test.ts:227`, `src/commands/sling.ts:398` |
| each workstream has a canonical `taskId` | yes | ensureCanonicalWorkstreamTasks wired into handoff. Evidence: `src/missions/workstreams.ts:103`, `src/missions/workstreams.ts:248`, `src/commands/mission.ts:1025` |
| brief refresh can invalidate/regenerate lead specs safely | no | Missing-meta, missing-pointer, and no-`--spec` paths bypass the intended safety model. Evidence: `src/missions/brief-refresh.ts:123`, `src/missions/workstream-control.ts:179`, `src/commands/sling.ts:592` |
| selective pause works at mission-layer state | yes | Pause/resume state lives in mission state and control mail, without changing `AgentState`. Evidence: `src/commands/mission.ts:1144`, `src/commands/mission.ts:1267`, `src/commands/mission.e2e.test.ts:243` |
| mission status and dashboard surfaces show mission lifecycle correctly | yes | Role presence now shown inline. Evidence: `src/commands/status.ts:301`, `src/commands/dashboard.ts:1018`, `src/commands/status.test.ts:237`, `src/commands/dashboard.test.ts:246` |
| mission result bundle is exported on terminal states | yes | Terminalizer exports bundle; complete path proves it end-to-end. Evidence: `src/commands/mission.ts:333`, `src/commands/mission.ts:359`, `src/missions/bundle.ts:58`, `src/commands/mission.e2e.test.ts:264` |
| mission review contour can score completed/stopped missions | improved | Functional tests added. Evidence: `src/commands/mission.ts:347`, `src/commands/review.ts:425`, `src/commands/review.ts:495`, `src/missions/review.test.ts:142` |
| current fast-path `ov coordinator` behavior still works | yes | Mandatory coordinator regression suite passed, including run/pointer semantics and persistent-root behavior. Evidence: `src/commands/coordinator.test.ts:488`, `src/commands/coordinator.test.ts:1030`, `src/commands/coordinator.test.ts:2748` |

## Evidence

Commands executed:

1. `gh issue view 13 --repo liker0704/overstory`
2. `gh issue view 13 --repo liker0704/overstory --json number,title,state,labels,url,body`
3. `git show --stat 87e1efc`
4. `git show --stat 7b668d7`
5. `git show --stat 57a8eb2`
6. `git diff origin/main..HEAD --stat`
7. `bun x tsc --noEmit`
8. `bun test src/commands/mission.e2e.test.ts src/commands/mission.test.ts src/commands/spec.test.ts src/missions/workstream-control.test.ts src/commands/completions.test.ts src/commands/status.test.ts src/commands/dashboard.test.ts src/commands/mail.test.ts src/commands/sling.test.ts`
9. `bun test src/commands/coordinator.test.ts`
10. `bun test src/commands/review.test.ts src/missions/review.test.ts src/review/analyzers/mission.test.ts src/missions/bundle.test.ts src/missions/workstreams.test.ts src/missions/ingress.test.ts`
11. Multiple targeted `rg` and `nl -ba` audits over required source files, prompts, and docs

Results:

- `bun x tsc --noEmit`: passed
- Mission-related required test bundle: passed, `346 pass / 0 fail`
- Coordinator regression suite: passed, `141 pass / 0 fail`
- Additional review/bundle/workstreams/ingress suites: passed, `87 pass / 0 fail`

## Final Verdict

`ov mission v1` should not yet be considered "real" under `docs/ov-mission-implementation.md`.

Why not:

- The runtime does not enforce the `Execution Director -> lead only` invariant.
- Stale-spec safety is not airtight in the exact failure modes the document calls out.
- Canonical task bridging is not fully wired into production handoff.
- Selective ingress is not enforced in runtime routing.

What is already solid:

- The primary happy-path mission flow is implemented and covered.
- `mission answer` unfreezes correctly.
- Terminal mission path exports bundle and generates mission review.
- Fast-path `ov coordinator` behavior still passes regression coverage.

Residual risks and testing gaps:

- No crash/recovery proof for:
  - lost `current-mission.txt`
  - lost `current-run.txt`
  - paused workstreams after restart
- No negative test proving ED cannot spawn non-leads
- No resume test for missing spec metadata
- No stale-spec guard test when mission pointer is absent
- No functional CLI proof for `ov review missions` and `ov review mission <id>`

