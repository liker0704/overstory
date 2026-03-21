# Global Swarm Recovery Root Hooks Isolation Fix Plan

Date: 2026-03-21
Revision: 4 (post-simulation)

Scope:

- Active mission: `global-swarm-recovery`
- Mission id: `mission-1774105629604-mission-1774105629601`
- Run id: `run-2026-03-21T15-07-09-604Z-mission`
- Primary runtime target for this fix: Claude Code shared-root hook deployment used by the live mission
- Runtime parity note: the same capability-set gaps exist in ALL runtime guard generators (`gemini-guards.ts`, `pi-guards.ts`, `sapling.ts`) — not just Claude Code. Cross-runtime parity must be fixed as part of Phase 3, not deferred.
- Headless runtime note: headless runtimes (Sapling, Codex, OpenCode, Pi) do not use Claude Code hooks or tmux sessions. They are out of scope for this fix. If a headless runtime is ever configured as a persistent root agent, `startPersistentAgent()` must reject it — add an explicit guard. See constraint C9.

Related docs:

- `docs/ov-mission.md`
- `docs/ov-mission-implementation.md`
- `docs/runtime-abstraction.md`
- `docs/runtime-adapters.md`

Primary target:

- Eliminate the shared-root hook/env identity bug that caused the live `mission-analyst` and `execution-director` sessions in `global-swarm-recovery` to become `zombie`.

## Problem Summary

The current persistent mission roles all run at the project root:

- `coordinator` (capability: `coordinator` or `coordinator-mission`)
- `mission-analyst`
- `execution-director`

Each role startup re-deploys Claude hooks into the same project-root `.claude/settings.local.json`, and each startup also rewrites the same `.claude/.agent-env`.

Because the deployed hook commands are baked with a specific agent name, the last-started root role captures shared root hook ownership for all other root roles. In the live `global-swarm-recovery` run this produced event attribution drift in SQLite:

- coordinator runtime session id `d3714a86-...` logged as `mission-analyst`
- later the same coordinator runtime session id `d3714a86-...` logged as `execution-director`
- true `mission-analyst` and `execution-director` tmux sessions then died and were reconciled as `zombie`

The hook surface is also asymmetric:

- `PreToolUse`, `PostToolUse`, and `Stop` can receive hook payloads over stdin
- `SessionStart`, `UserPromptSubmit`, and `PreCompact` do not provide stdin payloads, yet still invoke `ov prime` and `ov mail check --inject`

That means a fix based only on stdin `session_id` handling in `ov log` is incomplete. Shared-root identity resolution must also work for non-stdin hooks.

This is not a one-off data issue. It is a structural flaw in how shared-root persistent agents deploy hooks and recover hook identity.

The observed breakage happened in the mission trio, but the bug class is broader than mission mode. Other project-root agents such as `monitor` and `supervisor` also share hook infrastructure and must not regress under the same fix.

Another project-root persistent role also exists on the same lifecycle path:

- `plan-review-lead` (ephemeral — runs only during plan review, but still needs correct guards and identity while active)

### Guard Asymmetry Between Template and Generated Hooks

There is an important asymmetry in the current codebase that any fix must account for:

- **Template hooks** (`hooks.json.tmpl`) use a simple guard: `[ -z "$OVERSTORY_AGENT_NAME" ] && exit 0` — **no `.agent-env` fallback**. They pass a baked `{{AGENT_NAME}}` to `--agent`.
- **Generated capability guards** (`hooks-deployer.ts`) use `ENV_GUARD` which **includes** the `.agent-env` fallback: `[ -f .claude/.agent-env ] && . .claude/.agent-env`.

This means after compaction/restart:
- Template hooks: `$OVERSTORY_AGENT_NAME` is still in tmux env (survives compaction), so the guard passes, but the baked `--agent <last-deployed-role>` is wrong — this is the primary attribution drift vector.
- Capability guards: `ENV_GUARD` sources `.agent-env`, which may contain the wrong agent's name if another role started later.

**IMPORTANT:** Whether `$OVERSTORY_AGENT_NAME` truly survives all compaction/restart paths is an unverified assumption. The `.agent-env` fallback exists precisely because someone already discovered env survival is not guaranteed. See Phase 4 risks.

### ENV_GUARD vs. Human Sessions (C6 Conflict)

The current `ENV_GUARD` has a fundamental design conflict with constraint C6 (human sessions must remain inert):

```sh
# Current ENV_GUARD — BROKEN for C6
if [ -z "$OVERSTORY_AGENT_NAME" ]; then
  [ -f .claude/.agent-env ] && . .claude/.agent-env;
  [ -z "$OVERSTORY_AGENT_NAME" ] && exit 0;
fi;
```

When a human opens Claude Code at the project root:
1. `$OVERSTORY_AGENT_NAME` is unset (human session has no overstory env)
2. `.agent-env` exists (written by the last-started root role)
3. Guard sources `.agent-env`, setting `OVERSTORY_AGENT_NAME` to the last-started agent's name
4. Guard does NOT exit — the hook activates for the human session as if it were an agent

This violates C6. The fix requires a **session discriminator** — a way to distinguish "agent whose env was lost after compaction" from "human who opened Claude Code." The discriminator is `$OVERSTORY_RUNTIME_SESSION_ID`, which is set in the tmux session env by Phase 1 and is NOT present in human sessions:

```sh
# ENV_GUARD v2 — safe for human sessions
if [ -z "$OVERSTORY_AGENT_NAME" ]; then
  [ -z "$OVERSTORY_RUNTIME_SESSION_ID" ] && exit 0;
  [ -f .claude/.agent-env.$OVERSTORY_AGENT_NAME ] && . .claude/.agent-env.$OVERSTORY_AGENT_NAME;
  [ -z "$OVERSTORY_AGENT_NAME" ] && exit 0;
fi;
```

Wait — if `OVERSTORY_AGENT_NAME` is unset, we can't source `.agent-env.$OVERSTORY_AGENT_NAME`. The correct pattern uses `OVERSTORY_RUNTIME_SESSION_ID` as both the discriminator AND the lookup key:

```sh
# ENV_GUARD v2 — correct
if [ -z "$OVERSTORY_AGENT_NAME" ]; then
  [ -z "$OVERSTORY_RUNTIME_SESSION_ID" ] && exit 0;
  OVERSTORY_AGENT_NAME=$(ov identity-resolve "$OVERSTORY_RUNTIME_SESSION_ID" 2>/dev/null);
  [ -z "$OVERSTORY_AGENT_NAME" ] && exit 0;
  export OVERSTORY_AGENT_NAME;
fi;
```

This requires a lightweight `ov identity-resolve` CLI command that does a sessions.db lookup by `runtimeSessionId` and outputs the agent name. Cost: ~5ms (bun startup + sqlite query). This runs only on the compaction-recovery fallback path, not the happy path.

If the CLI call is too expensive for hooks, the alternative is agent-scoped env files keyed by `OVERSTORY_RUNTIME_SESSION_ID`:

```sh
# ENV_GUARD v2 — file-based alternative
if [ -z "$OVERSTORY_AGENT_NAME" ]; then
  [ -z "$OVERSTORY_RUNTIME_SESSION_ID" ] && exit 0;
  [ -f ".claude/.agent-env.$OVERSTORY_RUNTIME_SESSION_ID" ] && . ".claude/.agent-env.$OVERSTORY_RUNTIME_SESSION_ID";
  [ -z "$OVERSTORY_AGENT_NAME" ] && exit 0;
fi;
```

This requires writing `.agent-env.{runtimeSessionId}` files at startup (one per root role), which solves BOTH the C6 conflict AND the singleton content problem. See Phase 1.

### Pre-existing Template Bug: Unguarded git push Block

The `hooks.json.tmpl` `PreToolUse` Bash guard for `git push` blocking (line 40-48) uses `read -r INPUT` directly without any `ENV_GUARD` or agent guard. This means it blocks `git push` for ALL Claude Code sessions in the project root, including non-overstory human sessions. This must be corrected as part of Phase 2 template cleanup.

### Stdin Model

Claude Code provides independent stdin per hook entry and runs hooks within a matcher group in parallel. The `git push` guard's `read -r INPUT` does NOT consume stdin for subsequent hooks. This has been verified via Claude Code documentation.

## Root Cause

The observed live attribution drift is caused by all of the following:

1. Persistent mission roles deploy hooks into one shared project root.
2. Hook commands are generated with a baked `{{AGENT_NAME}}` — the template uses deploy-time substitution instead of runtime `$OVERSTORY_AGENT_NAME`.
3. Existing overstory hooks are replaced wholesale on each deployment.

An additional coupled hazard makes recovery and guard behavior less reliable:

4. Hook fallback identity for shared-root recovery currently depends on one shared `.claude/.agent-env` file (singleton content problem).
5. Shared-root lifecycle cleanup paths can overwrite or delete that singleton file when one root role starts, stops, or is reaped.
6. The current `ENV_GUARD` `.agent-env` fallback activates overstory hooks for human sessions at the project root (C6 violation).

A third class of bug exists in capability guard classification:

7. Several root role capabilities (`coordinator-mission`, `execution-director`, `plan-review-lead`) are absent from all guard classification sets in `hooks-deployer.ts` (and in all other runtime guard generators). They receive no capability-specific guards at all.
8. `plan-review-lead` is absent from `PERSISTENT_CAPABILITIES` in `log.ts:88-94`, causing incorrect `completed` transitions on every Stop hook.

Result:

- the last-started root role overwrites logging, prime, mail-check, and guard behavior for every other root role in the same cwd
- event attribution in `events.db` drifts away from the real runtime session owner
- `last_activity` and `session_end` updates apply to the wrong session rows
- the real root sessions can be left untracked and later become `zombie`
- non-stdin hooks like `SessionStart`, `UserPromptSubmit`, and `PreCompact` have no hook-payload identity and therefore need an explicit shared-root resolution path
- shared-root recovery paths remain brittle because `.agent-env` is singleton state rather than per-role state
- one root role's stop/watchdog cleanup can invalidate fallback state for other still-live root roles
- `stopPersistentAgent()` calls `removeAgentEnvFile(projectRoot)` unconditionally — stopping ANY root role deletes the fallback file for ALL other root roles
- human Claude Code sessions at the project root have overstory hooks activated via `.agent-env` sourcing (C6 violation)
- unclassified capabilities fall through `getCapabilityGuards()` with zero guards
- `plan-review-lead` gets incorrectly transitioned to `completed` on every Stop hook

## Constraints

- C1: Do not break worker/worktree agents; they already have per-worktree isolation.
- C2: Do not regress the existing `ov coordinator` fast path.
- C3: Do not rely on prompt-only discipline; fix must be enforced in runtime behavior.
- C4: Do not patch only the hook template while leaving capability guards baked per role.
- C5: Fix must work for restart/compaction flows, not only clean startups.
- C6: Human Claude sessions at the repo root must remain inert; overstory hooks must not activate for non-overstory sessions. The `ENV_GUARD` must use `$OVERSTORY_RUNTIME_SESSION_ID` as a session discriminator — see "ENV_GUARD vs. Human Sessions" above.
- C7: Preserve existing user hooks and non-hook keys in `.claude/settings.local.json` during shared-root deployment changes.
- C8: Preserve explicit manual CLI behavior for `ov prime --agent ...`, `ov mail check --agent ...`, and similar commands outside hook-driven shared-root execution.
- C9: Headless runtimes (Sapling, Codex, OpenCode, Pi) must NOT be used as persistent root agents. Add a guard in `startPersistentAgent()`.
- C10: Phases 1-3 MUST ship as a single atomic deployment (one branch, one merge). Phase 4 ships with them if env-survival is proven, otherwise deferred — Phases 1-3 are independently correct and must not be blocked by Phase 4's prerequisite.

## Success Criteria

This plan is complete only when all of the following are true:

- Root mission roles can coexist in one project root without overwriting each other's hook identity.
- Events for a root role are always attributed to the correct `agent_name` and `runtime_session_id`.
- Shared root `settings.local.json` is stable and does not need to be rewritten for each root role startup.
- Hook behavior for root roles is derived from runtime env or durable session lookup, not from the most recently deployed role.
- Capability guards remain correct for each live root role.
- `mission-analyst` and `execution-director` no longer drift to `zombie` because of hook identity corruption.
- Existing worktree agent behavior remains unchanged.
- Human Claude sessions at repo root do not trigger overstory hooks (C6 — verified by ENV_GUARD v2 discriminator).
- All root role capabilities have explicit guard classifications across all runtime guard generators.
- Stopping one root role does not break the identity or guard state of other live root roles.
- `$OVERSTORY_CAPABILITY` is validated against sessions.db — env alone is not the sole authority.
- Unset `$OVERSTORY_CAPABILITY` triggers maximum-restrictiveness failsafe for agent sessions (but NOT for human sessions — C6).

## Recommended Execution Order

Phases 1-3 ship atomically (constraint C10). Phase 4 ships with them if prerequisite passes, otherwise deferred:

1. Shared-root runtime identity primitives + session-scoped `.agent-env` files + safety patches + conservative capability classification
2. Dynamic shared-root base hooks (core template fix + ENV_GUARD v2)
3. Dynamic capability guards (Option B: capability-based) + cross-runtime parity
4. Remove `.agent-env` fallback entirely (only after env-survival proven by automated test)
5. Regression coverage (Priority 1 tests written alongside Phases 1-3)
6. Live recovery/remediation path for active missions

Rationale:

- Phase 1 establishes identity model, fixes live safety bugs, provides session-scoped `.agent-env` files that solve both the singleton content problem AND the C6 violation.
- Phase 2 is the core attribution fix — template hooks use `$OVERSTORY_AGENT_NAME` with ENV_GUARD v2.
- Phase 3 makes guards stable and capability-aware via Option B (no concurrent write problem).
- Phase 4 removes `.agent-env` dependency entirely once env-survival is proven. If env-survival test fails, `.agent-env` remains but is now session-scoped (safe).
- Phase 5 tests are written alongside Phases 1-3, not as a trailing phase.
- Phase 6 recovers the live mission.

**Key dependency:** Phase 2 alone (without Phase 3) leaves capability guards in a broken state for concurrent root roles. C10 ensures they ship together.

## Implementation Plan

## Phase 1: Shared-Root Identity Model + Session-Scoped Env Files + Safety Patches + Capability Classification

Status: planned

Goal:

- Add the runtime identity needed to make root hooks dynamic and role-safe.
- Replace singleton `.agent-env` with session-scoped files to solve the content problem and C6 violation.
- Patch the most dangerous live bugs.
- Apply conservative capability classification.

Primary files:

- `src/agents/persistent-root.ts`
- `src/agents/hooks-deployer.ts`
- `src/commands/sling.ts`
- `src/commands/monitor.ts`
- `src/commands/supervisor.ts`
- `src/commands/log.ts`
- `src/worktree/tmux.ts`
- `src/sessions/store.ts`
- `src/types.ts`
- `src/commands/resume.ts`
- `src/watchdog/swap.ts`
- `src/missions/roles.ts`
- `src/runtimes/gemini-guards.ts`
- `src/runtimes/pi-guards.ts`
- `src/runtimes/sapling.ts`

### Env Propagation

- Add `OVERSTORY_CAPABILITY` to spawned agent env in BOTH paths:
  - `tmux.createSession()` env argument (`persistent-root.ts:280-283`)
  - `runtime.buildSpawnCommand()` env block (`persistent-root.ts:275-278`)
  - Both must carry the same value.
- Expose `runtimeSessionId` (already generated at `persistent-root.ts:267`) as `OVERSTORY_RUNTIME_SESSION_ID` in BOTH env paths. This is the same UUID passed to `buildSpawnCommand({ sessionId })`.
- Add `OVERSTORY_TASK_ID` where task-scoped guard behavior depends on it.
- Propagate to ALL root-style spawn paths: persistent root roles, worktree agents (sling.ts), monitor, supervisor.
- Update `resume.ts` and `watchdog/swap.ts` to propagate the same env contract.
- The Phase 4 env-survival test must verify ALL three vars (`OVERSTORY_AGENT_NAME`, `OVERSTORY_RUNTIME_SESSION_ID`, `OVERSTORY_CAPABILITY`) survive compaction.

### Session-Scoped `.agent-env` Files

Replace the singleton `.claude/.agent-env` with session-scoped files keyed by `OVERSTORY_RUNTIME_SESSION_ID`:

- Write `.claude/.agent-env.{runtimeSessionId}` at startup (one per root role). Contains `export OVERSTORY_AGENT_NAME="..." OVERSTORY_CAPABILITY="..."`.
- This solves THREE problems simultaneously:
  1. **Singleton content problem:** Each root role has its own file. Stopping one doesn't affect others.
  2. **C6 violation:** Human sessions don't have `OVERSTORY_RUNTIME_SESSION_ID`, so no file matches, so nothing is sourced.
  3. **Concurrent startup:** Each role writes its own file. No race on a shared file.
- Write with mode `0600` (owner-only) and atomic write via temp-file + rename.
- Cleanup: when a root role is stopped, remove only its own `.agent-env.{sessionId}` file.
- Keep writing the singleton `.agent-env` temporarily for backward compatibility with old hooks that may still reference it. Remove in Phase 4.

### Session Store Enhancements

- Add `SessionStore` lookup by `runtime_session_id` (primary correlation for hook identity).
- Add `SessionStore` lookup by `tmux_session` only as a secondary fallback.
- Add a shared identity resolution helper that prefers:
  1. live process env (`$OVERSTORY_AGENT_NAME`)
  2. runtime `session_id` from hook payload mapped to durable `runtimeSessionId`
  3. explicit env-provided `OVERSTORY_RUNTIME_SESSION_ID` for non-stdin hook paths
  4. durable session lookup fallback
  5. session-scoped `.agent-env.{sessionId}` file as last resort
- The resolution helper must validate `$OVERSTORY_CAPABILITY` against sessions.db when performing capability-based decisions.

### Immediate Safety Patches

- Make `stopPersistentAgent()` remove only the stopped role's session-scoped file, not the singleton. Note: `stopMissionRole()` and `stopPlanReviewLead()` in `missions/roles.ts` both delegate to `stopPersistentAgent()` and are covered.
- Add headless runtime guard in `startPersistentAgent()`: reject non-tmux runtimes for persistent root roles (C9).

### Conservative Capability Classification

Apply these classifications NOW as safe defaults:

| Capability | Classification | Rationale |
|---|---|---|
| `coordinator-mission` | `COORDINATION_CAPABILITIES` | Same as `coordinator` — needs git add/commit, must not push. |
| `execution-director` | `COORDINATION_CAPABILITIES` | Coordinates execution via leads/workers. Needs git add/commit for task sync. Does not directly implement. If later analysis shows ED needs file writes, upgrade in Phase 3. |
| `plan-review-lead` | `NON_IMPLEMENTATION_CAPABILITIES` | Read-only review role. Must not modify project files. |

Apply to ALL four guard generators: `hooks-deployer.ts`, `gemini-guards.ts`, `pi-guards.ts`, `sapling.ts`.

### PERSISTENT_CAPABILITIES Fix

Add `plan-review-lead` to `PERSISTENT_CAPABILITIES` in `src/commands/log.ts:88-94`.

Acceptance criteria:

- Root and worktree agents expose capability via env in both tmux and spawn-command paths.
- Session-scoped `.agent-env.{sessionId}` files exist for each root role.
- Stopping one root role removes only its own session-scoped file.
- Human sessions at root cannot source any session-scoped file (no `OVERSTORY_RUNTIME_SESSION_ID`).
- All root role capabilities have conservative guard classifications.
- `plan-review-lead` is in `PERSISTENT_CAPABILITIES`.

Risks:

- Schema/API additions must not break current callers.
- Conservative `execution-director` classification may be too restrictive — can be relaxed in Phase 3.

## Phase 2: Dynamic Shared-Root Base Hooks

Status: planned

Goal:

- Ensure `prime`, `mail check`, and `log` hooks resolve the executing root role dynamically.

Primary files:

- `templates/hooks.json.tmpl`
- `src/agents/hooks-deployer.ts`
- `src/commands/log.ts`
- `src/commands/prime.ts`
- `src/commands/mail.ts`
- `src/runtimes/types.ts`

### Core Template Fix

Replace every occurrence of baked `{{AGENT_NAME}}` in `hooks.json.tmpl` with `$OVERSTORY_AGENT_NAME`, and upgrade ALL template guards to ENV_GUARD v2:

```diff
-"command": "[ -z \"$OVERSTORY_AGENT_NAME\" ] && exit 0; ov prime --agent {{AGENT_NAME}}"
+"command": "if [ -z \"$OVERSTORY_AGENT_NAME\" ]; then [ -z \"$OVERSTORY_RUNTIME_SESSION_ID\" ] && exit 0; [ -f \".claude/.agent-env.$OVERSTORY_RUNTIME_SESSION_ID\" ] && . \".claude/.agent-env.$OVERSTORY_RUNTIME_SESSION_ID\"; [ -z \"$OVERSTORY_AGENT_NAME\" ] && exit 0; fi; ov prime --agent \"$OVERSTORY_AGENT_NAME\""
```

**ENV_GUARD v2** design:
1. Check `$OVERSTORY_AGENT_NAME` — if set (happy path), proceed. (~0ms)
2. Check `$OVERSTORY_RUNTIME_SESSION_ID` — if unset, this is a human session → exit 0. (~0ms)
3. Source session-scoped `.agent-env.{sessionId}` file (Phase 1 creates these). (~0.03ms)
4. If `OVERSTORY_AGENT_NAME` still unset after sourcing → exit 0. (~0ms)

This satisfies C6 (human sessions exit at step 2) and C5 (compaction recovery sources the correct session-scoped file at step 3).

Apply to ALL hook commands in the template:
- `SessionStart`: `ov prime --agent ...` and `ov mail check --inject --agent ...`
- `UserPromptSubmit`: `ov mail check --inject --agent ...`
- `PreToolUse`: `ov log tool-start --agent ...`
- `PostToolUse`: `ov log tool-end --agent ...` and `ov mail check --inject --agent ...`
- `Stop`: `ov log session-end --agent ...`
- `PreCompact`: `ov prime --agent ... --compact`

### Template Guard Unification

ALL hooks (template-generated and capability-guard-generated) must use ENV_GUARD v2. Update `ENV_GUARD` constant in `hooks-deployer.ts:83-87` to the v2 pattern.

### Additional Template Cleanup

- Fix the unguarded `git push` block (template line 40-48): add ENV_GUARD v2 so it only fires for overstory sessions.
- Remove the `{{AGENT_NAME}}` substitution loop in `deployHooks()` (`hooks-deployer.ts:630`).

### Supporting Command Changes (Defense-in-Depth)

After the template fix, `--agent` will correctly resolve via `$OVERSTORY_AGENT_NAME`. The following are belt-and-suspenders:

- Update `ov log` internals so identity resolution can override stale CLI `--agent` values.
- Add observable audit logging: when hook identity resolution falls back to session-scoped `.agent-env` file (rather than live env), log a warning so attribution drift is detectable before it causes zombies.
- Keep explicit user-invoked CLI `--agent` behavior stable outside hook context.

Acceptance criteria:

- No `{{AGENT_NAME}}` residue in any deployed hook command.
- ALL template hooks use ENV_GUARD v2 with `$OVERSTORY_RUNTIME_SESSION_ID` discriminator.
- Human Claude sessions at root: hooks exit at ENV_GUARD v2 step 2 (verified by test).
- Agent compaction recovery: hooks resolve correct agent name via session-scoped file (verified by test).
- Template `git push` guard is properly gated.
- Fallback identity resolution produces an audit log entry.

Risks:

- Template migration can break existing tests that assume agent name substitution.
- Worker/worktree agents also use the same template — verify `$OVERSTORY_AGENT_NAME` and `$OVERSTORY_RUNTIME_SESSION_ID` are set for them too.

## Phase 3: Dynamic Capability Guards (Option B)

Status: planned

Goal:

- Stop rewriting root guard behavior per role deployment.
- Fix cross-runtime parity.

**Decision: Option B (capability-based dynamic guards).** This is chosen over Option A because:
- The hook file becomes truly static after first deployment — no concurrent write race.
- No need for `deployHooks()` to know about all active root roles.
- Simpler long-term maintenance.
- The C6 conflict is already resolved by ENV_GUARD v2 (Phase 2).

Primary files:

- `src/agents/hooks-deployer.ts`
- `templates/hooks.json.tmpl`
- `src/runtimes/claude.ts`
- `src/runtimes/types.ts`
- `src/runtimes/gemini-guards.ts`
- `src/runtimes/pi-guards.ts`
- `src/runtimes/sapling.ts`
- `src/commands/monitor.ts`
- `src/commands/supervisor.ts`

### Capability-Based Dynamic Guards

Replace `agentGuard(agentName)` checks with capability-based checks that read `$OVERSTORY_CAPABILITY` at execution time:

```sh
# Old: agent-scoped guard
[ "$OVERSTORY_AGENT_NAME" != "mission-analyst" ] && exit 0;

# New: capability-scoped guard
case "$OVERSTORY_CAPABILITY" in scout|reviewer|lead|supervisor|monitor|mission-analyst|plan-review-lead) ;; *) exit 0 ;; esac;
```

Generate one static set of shell scripts that branch on capability. The hook file never needs rewriting for new root roles.

### Mandatory Failsafe

When `$OVERSTORY_CAPABILITY` is unset or empty AND the session IS an overstory session (has `$OVERSTORY_RUNTIME_SESSION_ID`), apply the most restrictive guard set (`NON_IMPLEMENTATION_CAPABILITIES` rules — block all writes, block all file-modifying Bash). An unset capability must NEVER result in zero guards for an agent session.

When `$OVERSTORY_CAPABILITY` is unset AND `$OVERSTORY_RUNTIME_SESSION_ID` is also unset — this is a human session. Exit 0 (no guards). This satisfies C6.

### Capability Validation

`$OVERSTORY_CAPABILITY` must be cross-validated against sessions.db by the identity resolution helper (Phase 1). If the live env value doesn't match the stored value, apply the more restrictive class.

**Limitation:** Multiple agents of the same capability at the project root (e.g., two supervisors) cannot be distinguished by capability-based guards. Agent-scoped branch naming guards (which check `$OVERSTORY_AGENT_NAME`, not capability) are an exception and remain agent-scoped.

### Implementation tasks:

- Replace all `agentGuard(agentName)` calls with capability-based `case` statements.
- Implement the mandatory failsafe.
- Make `deployHooks()` in shared-root mode generate static capability-based guards (no agent name baking).
- Verify/refine Phase 1 capability classifications based on mission workflow analysis.
- Apply same classification changes to `gemini-guards.ts`, `pi-guards.ts`, `sapling.ts`.
- Keep worktree deployments on existing per-agent path.

Acceptance criteria:

- Starting `mission-analyst` after `coordinator` does not change coordinator guard behavior.
- Starting `execution-director` after both does not change either coordinator or analyst guard behavior.
- All root role capabilities have explicit classifications in ALL four guard generators.
- Unset capability + agent session → maximum-restrictiveness failsafe.
- Unset capability + human session → no guards (C6).
- No concurrent write race on `settings.local.json` (file is static after first deploy).

Risks:

- Changing guard classification for previously unguarded capabilities may break existing workflows.
- Shell `case` statements add complexity — keep them simple and well-tested.

## Phase 4: Remove `.agent-env` Fallback

Status: planned (may be deferred)

Goal:

- Remove the `.agent-env` fallback entirely, relying purely on tmux env vars.

**PREREQUISITE:** An automated test must prove that ALL THREE env vars (`OVERSTORY_AGENT_NAME`, `OVERSTORY_RUNTIME_SESSION_ID`, `OVERSTORY_CAPABILITY`) survive Claude Code context compaction within a tmux session. The test must: (1) create a tmux session with exported env vars, (2) simulate the inner process being killed and restarted (as compaction does), (3) verify all three env vars are still available in the new process. Do NOT remove `.agent-env` until this test passes on Linux and macOS.

**If the test fails:** Phase 4 is deferred. Phases 1-3 are still correct — session-scoped `.agent-env.{sessionId}` files provide safe fallback indefinitely.

Primary files:

- `src/worktree/tmux.ts`
- `src/agents/hooks-deployer.ts`
- `src/agents/persistent-root.ts`
- `src/commands/monitor.ts`
- `src/commands/supervisor.ts`
- `src/watchdog/daemon.ts`
- `src/commands/mission.ts`
- `src/commands/stop.ts`
- `src/commands/clean.ts`
- `src/e2e/agent-env-file.test.ts`

Implementation tasks:

- Stop writing session-scoped `.agent-env.{sessionId}` files at startup.
- Stop writing the backward-compat singleton `.agent-env`.
- Simplify ENV_GUARD v2 to remove the file-sourcing fallback (only env vars remain).
- Update all lifecycle cleanup paths.
- Keep the guard's `[ -z "$OVERSTORY_RUNTIME_SESSION_ID" ] && exit 0` check for C6 compliance.

Acceptance criteria:

- No `.agent-env` files are created for new root role sessions.
- Compaction recovery works via env vars alone.
- Human sessions remain inert (C6).
- Automated env-survival test passes on Linux and macOS.

Risks:

- **HIGH RISK:** If env survival fails on some platforms, Phase 4 must not ship. Session-scoped files remain the fallback.

## Phase 5: Regression Coverage

Status: planned (Priority 1 tests written alongside Phases 1-3)

### Priority 1: Tests That Reproduce the Live Failure

**Must be written alongside implementation, not after.**

1. **End-to-end attribution drift** (the actual failure chain): (a) deploy hooks for coordinator, (b) deploy hooks for mission-analyst (overwriting), (c) read deployed `settings.local.json` and extract the `--agent` value from a hook command, (d) invoke `ov log tool-start` with that extracted value while env says `$OVERSTORY_AGENT_NAME=coordinator`, (e) verify the coordinator's session record is updated (not analyst's). Must FAIL before the fix and PASS after.
2. **Template uses `$OVERSTORY_AGENT_NAME`**: Deploy hooks, verify no `{{AGENT_NAME}}` residue and all `--agent` flags reference `$OVERSTORY_AGENT_NAME`.
3. **Sequential start produces stable hooks**: Start coordinator, then analyst, verify `settings.local.json` base hooks are identical after each.
4. **Stop safety with content verification**: Start coordinator and analyst. Stop analyst. Simulate compaction for coordinator (unset `OVERSTORY_AGENT_NAME`, source the remaining `.agent-env` files). Verify the resolved `OVERSTORY_AGENT_NAME` is `coordinator` (not `mission-analyst`). This verifies both existence AND correctness.
5. **Capability classification completeness**: Verify `getCapabilityGuards()` returns non-empty guards for `coordinator-mission`, `execution-director`, `plan-review-lead`.
6. **Failsafe for unset capability**: Call capability guard logic with empty capability + agent session context → maximum-restrictiveness. Call with empty capability + no session context → no guards (C6).
7. **Human session at root (C6)**: Deploy hooks. Run ENV_GUARD v2 with no `OVERSTORY_*` vars set but `.agent-env` files present. Verify hook exits at step 2 (OVERSTORY_RUNTIME_SESSION_ID check). Verify NO overstory hook commands execute.

### Priority 2: Comprehensive Coverage

(Same as revision 3 — see previous version for full list.)

Additional tests from simulation findings:
- `persistent-root`: headless runtimes rejected for persistent root roles
- `hooks-deployer`: ENV_GUARD v2 discriminator blocks human sessions even when `.agent-env` files exist
- `log`: `plan-review-lead` in `PERSISTENT_CAPABILITIES` prevents incorrect completed transition
- `log`: fallback identity resolution produces audit log entry
- `hooks-deployer`: session-scoped `.agent-env.{sessionId}` files written with mode 0600

### Priority 3: Cross-Runtime Parity + Env Survival

- Verify capability classification in `gemini-guards.ts`, `pi-guards.ts`, `sapling.ts`.
- Automated env-survival test (Phase 4 prerequisite).

Acceptance criteria:

- Priority 1 test #1 (end-to-end attribution drift) fails before fix, passes after.
- Priority 1 test #7 (human session C6) passes.
- All Priority 1 tests pass.

## Phase 6: Live Mission Recovery Path

Status: planned (design phase — decisions below, implementation follows)

Goal:

- Provide a deterministic recovery sequence for active missions.

**Pre-requisite determination:** Claude Code reads `settings.local.json` at session startup, not continuously. It does NOT hot-reload the file mid-session. Therefore, redeploying `settings.local.json` while a session is active has no effect until the session restarts. All recovery sequences require session restart.

Primary files:

- `src/commands/mission.ts`
- possibly `src/commands/doctor.ts`

### Decisions (resolved)

1. **Repair command or manual procedure?** → Dedicated `ov mission repair` command. Manual procedures are error-prone for a multi-role restart sequence.
2. **Must the coordinator be restarted?** → Yes. The coordinator's tmux session was started with the old overstory binary. Its `settings.local.json` has baked hooks. Since Claude Code does not hot-reload hooks, the coordinator must be restarted. The repair command should handle this with: save coordinator state → stop coordinator → redeploy hooks → restart coordinator with saved state context.
3. **Recovery sequence:**
   1. `ov mission repair` verifies the current mission/run is active.
   2. Stops `execution-director` (if running).
   3. Stops `mission-analyst` (if running).
   4. Stops `coordinator`.
   5. Deploys new shared-root hooks (Phase 2/3 template + guards).
   6. Writes session-scoped `.agent-env.{sessionId}` files.
   7. Restarts `coordinator` (new session, new runtimeSessionId, linked to same run).
   8. Restarts `mission-analyst` (linked to same run).
   9. Restarts `execution-director` if the mission phase requires it.
   10. Verifies SQLite event attribution after restart.

Acceptance criteria:

- An already-running mission can be recovered without deleting the mission record.
- All three roles are restarted with correct identity.
- Events after recovery are correctly attributed.

## Rollback Strategy

If the fix causes unexpected issues after deployment:

1. **Full revert:** Since Phases 1-3 ship atomically (C10), rollback means reverting the entire branch. This restores the old template, old ENV_GUARD, old capability sets. The original bugs return but no new bugs are introduced.
2. **Capability relaxation:** If conservative classifications are too restrictive for `execution-director`, widen its classification in a follow-up without reverting the rest.
3. **Phase 4 revert:** If Phase 4 shipped and env-survival fails on some platforms, restore session-scoped `.agent-env` writes. Phases 1-3 remain intact.

**Mid-flight mission rollback:** If a mission is active when rollback is needed: (1) stop all root roles (`ov mission stop`), (2) revert the branch, (3) restart the mission. The old baked hooks will be redeployed. This restores the original attribution drift bug but is operationally safe.

## Deliverables

- Session-scoped `.agent-env.{sessionId}` files replacing singleton `.agent-env`
- ENV_GUARD v2 with `$OVERSTORY_RUNTIME_SESSION_ID` discriminator (C6-safe)
- Dynamic root identity via `$OVERSTORY_AGENT_NAME` in template hooks
- Capability-based dynamic guards (Option B) with failsafe
- Complete capability classification for all root role capabilities across all runtimes
- `ov identity-resolve` CLI command (or file-based alternative) for compaction recovery
- `ov mission repair` command for live recovery
- Regression tests (Priority 1 written alongside implementation)

## Explicit Non-Goals

- Re-architecting worker/worktree isolation
- Rewriting all runtime adapters unless required by the shared-root hook contract
- Solving unrelated mission workflow/prompt bugs in this change
- Supporting headless runtimes as persistent root agents (C9)

## Review Checklist

Before implementation is considered ready, verify:

- [ ] No shared-root hook contains a baked root role name
- [ ] No shared-root guard depends on the most recent deployment rather than runtime env
- [ ] `session_end` or `tool_end` from coordinator cannot be written under analyst or ED
- [ ] Worktree agent behavior is preserved
- [ ] Restart/compaction recovery works via session-scoped `.agent-env` files
- [ ] Recovery path for `global-swarm-recovery` after rollout is tested
- [ ] `coordinator-mission`, `execution-director`, `plan-review-lead` classified in all four guard generators
- [ ] Stopping one root role leaves other root roles' identity and guards intact
- [ ] Template `git push` block is properly gated to overstory sessions
- [ ] No concurrent write race on `settings.local.json` (Option B: static file)
- [ ] Failsafe applies maximum-restrictiveness for agent sessions with unset capability
- [ ] Human sessions at root are fully inert (C6 — ENV_GUARD v2 discriminator)
- [ ] `$OVERSTORY_CAPABILITY` is cross-validated against sessions.db
- [ ] `plan-review-lead` is in `PERSISTENT_CAPABILITIES` in `log.ts`
- [ ] ALL template hooks use ENV_GUARD v2 (not the old simple guard)
- [ ] Rollback path is documented and covers mid-flight missions
- [ ] Phase 4 env-survival test covers all three env vars
- [ ] Headless runtimes are rejected for persistent root roles
- [ ] Session-scoped `.agent-env` files are written with mode 0600 + atomic rename
- [ ] `ov mission repair` handles full stop-redeploy-restart sequence
