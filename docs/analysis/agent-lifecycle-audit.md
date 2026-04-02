# Agent Lifecycle & Session Management Audit

**Date**: 2026-04-02
**Scope**: Complete analysis of agent birth, life, death, and completion marking across the overstory swarm system.

---

## 1. Agent Lifecycle State Machine

### State Diagram

```
                    ov sling / startPersistentAgent
                              |
                              v
                        +---------+
                        | booting |
                        +---------+
                              |
                              | (first tool event via log.ts updateLastActivity)
                              v
                        +---------+
                  +---->| working |<----+
                  |     +---------+     |
                  |         |           |
                  |         |  (no activity for staleMs)
                  |         v           |
                  |    +---------+      |
                  |    | stalled |------+  (activity resumes within zombieMs)
                  |    +---------+
                  |         |
                  |         | (no activity for zombieMs OR tmux/pid dead)
                  |         v
                  |    +--------+
                  |    | zombie |
                  |    +--------+
                  |         |
                  |         | (watchdog killAgent OR tmux already dead)
                  |         v
                  |   +-----------+
                  +---| completed |
                      +-----------+
                           ^
                           |
           (session-end hook via log.ts transitionToCompleted)
           (hasRecentCompletionSignal reconciliation)
           (TUI reconciliation: zombie + ready prompt + session_end + no RL history)
           (tmux dead + session_end event + no RL history)
```

### State Transition Rules

**Forward-only invariant**: `health.ts:transitionState()` enforces ordering `booting(0) < working(1) < completed(2) < stalled(3) < zombie(4)`. State never regresses.

**Exception**: `reconcileSessionToCompleted()` can move a `zombie` to `completed`. This is an explicit override, not handled by `transitionState()`.

### Who Triggers Each Transition

| Transition | Trigger | Code Location |
|---|---|---|
| (spawn) -> booting | `ov sling` or `startPersistentAgent` records session | `spawn.ts`, `persistent-root.ts` |
| booting -> working | First tool event updates lastActivity | `log.ts:updateLastActivity()` line 71 |
| working -> stalled | Watchdog detects `elapsedMs > staleMs` | `health.ts:evaluateTimeBased()` line 137 |
| stalled -> working | Agent resumes activity (escalationLevel reset) | `daemon.ts` line 1400 |
| working -> zombie | Watchdog detects `elapsedMs > zombieMs` OR tmux/pid dead | `health.ts` lines 127, 268-280 |
| stalled -> zombie | Watchdog detects `elapsedMs > zombieMs` OR tmux/pid dead | `health.ts` lines 127, 268-280 |
| booting -> zombie | Watchdog detects dead tmux on booting session | `daemon.ts` line 857 |
| any -> completed | Stop hook fires `session-end` for non-persistent agent | `log.ts:transitionToCompleted()` line 168 |
| zombie -> completed | Watchdog reconciliation (session_end event + no RL history) | `daemon.ts` lines 1226, 1253 |
| working/booting -> completed | Watchdog `hasRecentCompletionSignal` reconciliation | `daemon.ts` line 837 |

### Critical Design Note: `completed` Has Lower Order Than `stalled`/`zombie`

`STATE_ORDER` puts completed at 2, stalled at 3, zombie at 4. This means `transitionState()` will never move a stalled or zombie agent to completed via the normal forward-only path. The only way to mark a stalled/zombie agent as completed is through explicit reconciliation (`reconcileSessionToCompleted` or direct `store.updateState`).

---

## 2. Session Death Scenarios

### 2.1 Non-Persistent (Leaf) Agent Death

**Agent types**: scout, builder, reviewer, merger, tester, plan critics, architecture critics

**What happens when Claude Code exits (Stop hook fires)**:

1. **log.ts `session-end` handler runs** (line 669):
   - Calls `transitionToCompleted()` (line 672)
   - Since capability is NOT in `PERSISTENT_CAPABILITIES`, it checks for rate limit
   - If not rate-limited, sets `state = "completed"` in SessionStore
   - Records metrics, auto-records mulch expertise
   - Clears `.current-session` marker file

2. **tmux behavior**: The tmux pane command was `claude --session-id ... --append-system-prompt-file ...`. When Claude Code exits, the pane's shell exits too (the command was the shell's only job). The tmux session lingers as a dead pane but tmux eventually cleans up, or the watchdog kills it.

3. **Watchdog on next tick** (daemon.ts line 888):
   - Sees `state === "completed"` and `rateLimitedSince === null`
   - If tmux session is still alive, kills it (line 892)
   - If headless, kills process tree
   - `continue` -- skips further health checks

4. **Nudge system for dead agent**:
   - `resolveTargetSession()` (nudge.ts line 66): checks session state, skips if `state === "zombie"` or `state === "completed"`. Returns null.
   - `nudgeIfIdle()` (mail.ts line 87): calls `resolveTargetSession()`, gets null, returns without nudging.
   - `writePendingNudge()` still writes a marker file -- but nobody reads it since the agent is dead.

5. **Can agent be woken?** NO. Once completed, the session is terminal. A new agent must be spawned for new work. The `ov resume` command exists but only works for sessions that crashed mid-work (zombie/stalled with live tmux).

### 2.2 Persistent Agent Death

**Agent types**: coordinator, coordinator-mission, mission-analyst, execution-director, monitor, plan-review-lead

**What happens when Claude Code exits (Stop hook fires)**:

1. **log.ts `transitionToCompleted()`** (line 118):
   - Checks `PERSISTENT_CAPABILITIES` set -- capability IS in the set
   - **Special case**: For `coordinator`, checks if `ov run complete` was already called. If the run status is `"completed"`, marks the session as completed too.
   - **Default case**: For all other persistent agents, it DOES NOT mark completed. It only calls `store.updateLastActivity()` and returns.
   - **CRITICAL**: Claude Code fires the Stop hook on EVERY turn boundary, not just at true session exit. So the Stop hook is essentially a no-op for persistent agents (it just updates lastActivity).

2. **tmux behavior**: Same as non-persistent -- pane shell exits when Claude Code exits. But the difference is that the session-end hook did NOT mark the session as completed.

3. **Watchdog on next tick**:
   - Session state is still `"working"` (or whatever it was before)
   - tmux is now dead
   - `evaluateHealth()` hits ZFC Rule 1: tmux dead -> zombie, action: terminate
   - Watchdog kills the (already dead) tmux session
   - Sets state to `zombie`
   - **But before that**, the daemon checks `hasRecentCompletionSignal()` (line 835) -- if the agent sent `worker_done` or `merge_ready` recently, it transitions to `completed` instead
   - Also checks the TUI reconciliation path (line 1245-1268): if tmux is dead, session_end event exists, and no recent rate-limit history, reconciles to completed

4. **The gap**: A persistent agent that dies without sending a completion signal and without a `session_end` event gets stuck as zombie. The `session-end` event IS written by `log.ts` at line 812, so this should fire. But there's a timing question: if the watchdog tick runs before the session-end hook completes, the event may not be recorded yet.

### 2.3 PERSISTENT_CAPABILITIES Inconsistency

**CRITICAL BUG/DISCREPANCY**: `plan-review-lead` is in the `PERSISTENT_CAPABILITIES` set in `log.ts` (line 94) but NOT in `health.ts` (lines 47-53) or `daemon.ts` (lines 88-94).

| Set Location | plan-review-lead included? |
|---|---|
| `log.ts:PERSISTENT_CAPABILITIES` | YES |
| `health.ts:PERSISTENT_CAPABILITIES` | NO |
| `daemon.ts:PERSISTENT_CAPABILITIES` | NO |
| `headroom/priority.ts:PERSISTENT_CAPABILITIES` | NO |

**Consequence**: 
- `log.ts` will NOT mark plan-review-lead as completed on session-end (treats it as persistent)
- But `health.ts` WILL apply stale/zombie time thresholds to it (treats it as ephemeral)
- If plan-review-lead is idle waiting for critic verdicts, the watchdog will escalate it as stalled and eventually terminate it as zombie, while the Stop hook never marks it completed because it thinks it's persistent.

This is either a bug or an intentional design choice that creates fragility.

---

## 3. The "Waiting Agent" Problem

### 3.1 Which Agents Wait and What They Wait For

| Agent | Waits For | How Long | What Happens If It Dies While Waiting |
|---|---|---|---|
| **Coordinator** | `merge_ready` from leads | Minutes to hours | **PERSISTENT** -- nudge system + watchdog keep it alive. If it actually dies, zombie -> manual restart via `ov coordinator start`. Leads' merge_ready mails queue in mail.db. |
| **Lead** | `worker_done` from builder | Minutes | **NOT PERSISTENT** -- told to "stop and do nothing" while waiting. Claude Code exits (Stop). Session-end marks it completed. Builder's `worker_done` mail arrives but lead is dead. **LOST WORK.** |
| **Lead** | `result` from reviewer | Minutes | Same as above. |
| **Lead** | `result` from scout | Minutes | Same as above. |
| **Mission Analyst** | `plan_review_consolidated` from plan-review-lead | Minutes | **PERSISTENT** -- stays alive. But if it dies, the consolidated verdict queues in mail.db. |
| **Mission Analyst** | `result` from scouts | Minutes | **PERSISTENT** -- stays alive. |
| **Execution Director** | `merge_ready` from leads | Minutes to hours | **PERSISTENT** -- stays alive. |
| **Execution Director** | `worker_done` from leads | Minutes to hours | **PERSISTENT** -- stays alive. |
| **Plan-Review-Lead** | `plan_critic_verdict` from critics | Minutes | **PARTIALLY PERSISTENT** -- log.ts treats it as persistent (no auto-complete on session-end), but health.ts does NOT exempt it from stale/zombie detection. Can be terminated by watchdog while waiting for critics. |
| **Builder** | Response to `architecture_question` | Minutes | **NOT PERSISTENT** -- told to stop after sending. But builder.md says "Send `architecture_question`" implying it should wait for a response. If it stops, it's marked completed and the answer is lost. |

### 3.2 The Lead "Stop and Wait" Pattern -- The Central Problem

**How it's supposed to work** (from `lead.md`):
1. Lead spawns builder(s)
2. Lead is told: "NEVER poll mail in a loop. When waiting for results, stop and do nothing."
3. Claude Code interprets "stop" literally and exits (Stop hook fires)
4. session-end handler runs, marks lead as `completed`
5. Builder eventually sends `worker_done` mail
6. `mail send` writes a pending nudge marker for the lead
7. `nudgeIfIdle()` calls `resolveTargetSession()` which sees `state === "completed"` and returns null
8. Nudge is never delivered. The `worker_done` mail sits unread in mail.db forever.

**The auto-nudge on lead completion** (log.ts line 689-709):
When a lead completes (session-end fires), `log.ts` writes a pending nudge marker for the coordinator. This notifies the coordinator that the lead finished, but the coordinator doesn't know WHY the lead finished -- it could be because the lead completed all its work, or because it stopped while waiting.

**The watchdog `hasRecentCompletionSignal` check** (daemon.ts line 835):
Before applying health checks, the watchdog checks if the agent recently sent `worker_done` or `merge_ready`. If so, it marks the agent as completed. But a lead that stopped to WAIT hasn't sent those signals yet -- it's waiting for its workers. So this check doesn't help.

### 3.3 The Nudge-to-Dead-Agent Problem

When a message arrives for an agent that is in `completed` state:

1. **`mail send` path**: `shouldAutoNudge()` returns true for `worker_done`, `result`, etc.
2. `writePendingNudge()` writes a marker file. Nobody reads it.
3. `nudgeIfIdle()` calls `resolveTargetSession()` -> returns null (state is completed). No nudge sent.
4. The message sits in `mail.db` with `state = "queued"`, unread.

**No mechanism exists to wake a completed agent.** The message is effectively lost unless:
- A human manually checks `ov mail list --to <dead-agent> --unread`
- The coordinator notices the lead has been silent and manually checks

### 3.4 Builder `architecture_question` Wait

Builder.md says builders can send `architecture_question` to an architect agent. The builder then needs to wait for a response. But builder.md's completion protocol says "Exit. Do NOT idle, wait for instructions, or continue working." This creates ambiguity -- can a builder wait for an architecture_question response?

In practice, if the builder sends the question and then continues working (doesn't stop), it's fine. But if it stops to wait, same dead-agent problem.

---

## 4. Dependency Graph

### 4.1 Communication Flows

```
Orchestrator (human Claude Code session)
    |
    |-- starts --> Coordinator (persistent, depth 0)
    |                 |
    |                 |-- dispatch --> Lead (ephemeral, depth 1)
    |                 |                  |
    |                 |                  |-- dispatch --> Scout (ephemeral, depth 2)
    |                 |                  |     |-- result --> Lead
    |                 |                  |
    |                 |                  |-- dispatch --> Builder (ephemeral, depth 2)
    |                 |                  |     |-- worker_done --> Lead
    |                 |                  |     |-- question --> Lead
    |                 |                  |     |-- architecture_question --> Architect
    |                 |                  |
    |                 |                  |-- dispatch --> Reviewer (ephemeral, depth 2)
    |                 |                  |     |-- result (PASS/FAIL) --> Lead
    |                 |                  |
    |                 |                  |-- merge_ready --> Coordinator
    |                 |                  |-- worker_done --> (not sent; lead sends merge_ready)
    |                 |                  |-- status --> Coordinator
    |                 |                  |-- error --> Coordinator
    |                 |
    |                 |-- ov merge --> (merges branch)
    |                 |-- close issue
    |
    |-- starts --> Mission Analyst (persistent, depth 0)
    |                 |
    |                 |-- dispatch --> Scout (ephemeral, depth 1)
    |                 |     |-- result --> Mission Analyst
    |                 |
    |                 |-- spawn --> Plan-Review-Lead (semi-persistent, depth 1)
    |                 |                |
    |                 |                |-- dispatch --> Plan Critics (ephemeral, depth 2)
    |                 |                |     |-- plan_critic_verdict --> Plan-Review-Lead
    |                 |                |
    |                 |                |-- plan_review_consolidated --> Mission Analyst
    |                 |
    |                 |-- result --> Coordinator
    |                 |-- analyst_recommendation --> Execution Director
    |
    |-- handoff --> Execution Director (persistent, depth 0)
                      |
                      |-- dispatch --> Lead (ephemeral, depth 1)
                      |                  | (same as coordinator lead flow above)
                      |                  |-- merge_ready --> Execution Director
                      |                        |-- forwards merge_ready --> Coordinator
                      |
                      |-- status --> Coordinator
```

### 4.2 Message Type Matrix

| Sender Dies While Waiting For | Message Type Expected | What Actually Happens |
|---|---|---|
| Lead waiting for scout `result` | `result` | Lead marked completed. Scout result queued in mail.db unread. Coordinator not notified of lead's premature death (unless watchdog completion check triggers). |
| Lead waiting for builder `worker_done` | `worker_done` | Same. Builder's work is done on its branch but lead never sends `merge_ready`. Branch is orphaned. |
| Lead waiting for reviewer `result` | `result` | Same. Review passes but nobody knows. |
| Plan-Review-Lead waiting for critic `plan_critic_verdict` | `plan_critic_verdict` | PRL may be killed by watchdog (stale/zombie detection applies since health.ts doesn't exempt it). Critics' verdicts queue unread. Mission analyst never gets consolidated review. |
| Mission Analyst waiting for scout `result` | `result` | MA is persistent, should survive. But if MA dies/is killed, scout results are lost. |
| Coordinator waiting for lead `merge_ready` | `merge_ready` | Coordinator is persistent, should survive. Lead's merge_ready auto-nudges coordinator. This is the most robust path. |
| Execution Director waiting for lead `merge_ready` | `merge_ready` | ED is persistent, should survive. |

### 4.3 Critical Gap: No Dead Letter / Orphan Detection

When a sender dies while waiting:
- The response message eventually arrives in mail.db
- Nobody reads it
- The watchdog has no concept of "orphaned messages" -- messages addressed to completed agents
- The coordinator has no mechanism to detect "lead died before sending merge_ready, but its builder finished and sent worker_done to the dead lead"

---

## 5. Analysis of Current Mechanisms

### 5.1 What Works

1. **Persistent agents (coordinator, ED, mission-analyst)**: The `PERSISTENT_CAPABILITIES` exemption in both `log.ts` and `health.ts` keeps them alive. The watchdog skips stale/zombie time-based detection. They survive long idle periods.

2. **Auto-nudge on lead completion**: When a lead's session-end fires, `log.ts` writes a pending nudge for the coordinator. This lets the coordinator know the lead finished (but not whether it finished its work or stopped while waiting).

3. **watchdog `hasRecentCompletionSignal`**: Before applying health checks, the daemon checks if the agent sent `worker_done` or `merge_ready`. If so, reconciles to completed. This prevents re-termination loops.

4. **TUI reconciliation**: The watchdog detects agents sitting idle at the prompt with unread mail and sends the mail content directly via tmux. This is a clever workaround for the "Stop hook fires but agent is just idle at prompt" scenario.

5. **Pending nudge markers**: Writing `.overstory/pending-nudges/{agent}.json` and reading them on the next `UserPromptSubmit` hook cycle is an elegant non-invasive nudge mechanism.

### 5.2 What's Broken

1. **Leads die when told to wait**: The instruction "stop and do nothing" causes Claude Code to exit, marking the lead as completed. Worker results then go to a dead agent.

2. **`plan-review-lead` PERSISTENT_CAPABILITIES inconsistency**: Present in `log.ts` but absent in `health.ts` and `daemon.ts`.

3. **No orphan message detection**: Messages sent to completed agents are silently lost.

4. **`resolveTargetSession` filters out completed/zombie**: This means nudges to dead agents are silently dropped, with no error escalation.

5. **Forward-only state ordering puts completed(2) below zombie(4)**: This is counter-intuitive but intentional -- it means `transitionState()` cannot move a zombie to completed. Only explicit reconciliation paths can do this.

---

## 6. Proposed Architecture Improvements

### Option A: Make All Waiting Agents Persistent

Add `lead` and `plan-review-lead` to all `PERSISTENT_CAPABILITIES` sets.

**Pros**: 
- Leads survive while waiting for workers
- Simple to implement (add string to 4 sets)

**Cons**: 
- Leads burn tokens while idle (Claude Code session stays alive)
- Many leads run concurrently -- persistent sessions are expensive
- The Stop hook behavior ("fires every turn") would suppress legitimate completion detection for leads

**Verdict**: Too expensive. A coordinator with 5 leads and each lead having 3 builders means 5 persistent sessions sitting idle.

### Option B: Explicit "waiting" State

Add a `waiting` state between `working` and `completed`:
- Lead enters `waiting` when it spawns workers and has nothing else to do
- `waiting` state exempts from stale/zombie detection (like persistent)
- When mail arrives for a `waiting` agent, the nudge system wakes it
- Stop hook does NOT mark `waiting` agents as completed

**Pros**: 
- Precise: only agents that are actually waiting are exempted
- No token burn: Claude Code can exit, but the session isn't marked completed
- Nudge system can resume the agent

**Cons**: 
- Requires agent to explicitly signal "I'm waiting now"
- Requires changes to `transitionToCompleted()`, `evaluateHealth()`, `resolveTargetSession()`
- State machine gets more complex

**Verdict**: Cleanest semantic solution, but significant code changes needed.

### Option C: Nudge System Handles Resuming Dead Sessions

Instead of preventing death, handle resurrection:
- When `mail send` detects recipient is `completed/zombie`, auto-resume via `ov resume`
- The `ov resume` command respawns Claude Code in the same tmux session with the same overlay
- The resumed agent picks up by checking mail

**Pros**:
- No token burn while waiting
- No state machine changes
- Works with current agent behavior ("stop and do nothing")

**Cons**:
- Resumption has latency (spawning new Claude Code session)
- Context loss on resume (previous conversation context is gone)
- Complex implementation: need to preserve overlay, worktree, branch state
- Need to handle partial completion (what if agent already did some work?)

**Verdict**: Viable but context loss is a significant problem. The resumed agent would need to re-read all its context.

### Option D: Wrapper Script in tmux That Auto-Restarts Claude

Instead of running `claude --session-id ...` directly in tmux, run a wrapper:
```bash
while true; do
  claude --session-id ... --append-system-prompt-file ...
  # Claude exited, check if we should restart
  if [ -f ".overstory/agents/$NAME/stop-marker" ]; then break; fi
  sleep 5
done
```

**Pros**:
- Agent auto-restarts after every Stop
- Picks up mail on restart via `UserPromptSubmit` hook
- No code changes to state machine or nudge system
- tmux session stays alive (watchdog happy)

**Cons**:
- Creates a new Claude Code session each restart (context loss, new session ID)
- Risk of infinite restart loops if Claude keeps crashing
- Stop marker management adds complexity
- Cost: each restart is a new session with prompt cache miss

**Verdict**: Too aggressive. Restarts after every Stop means even intentional completions get restarted.

### Option E (Recommended): Hybrid -- Waiting State + Smart Resume

Combine Options B and C:

1. **Add `waiting` state**:
   - Agent calls `ov status set --state waiting` before stopping
   - Stop hook checks: if state is `waiting`, do NOT mark completed
   - Health.ts: `waiting` agents exempted from stale/zombie (like persistent)
   - State ordering: `booting(0) < working(1) < waiting(2) < completed(3) < stalled(4) < zombie(5)`

2. **Smart nudge for waiting agents**:
   - `resolveTargetSession()`: allow nudge to `waiting` agents (currently filters out completed/zombie)
   - When `mail send` targets a `waiting` agent with no live tmux:
     - Write pending nudge marker (existing behavior)
     - Also trigger `ov resume <agent>` to respawn Claude in the same worktree
   - Resumed agent's first hook cycle picks up the pending nudge and processes mail

3. **Watchdog handling**:
   - `waiting` + tmux dead: don't mark zombie immediately. Instead, wait for mail arrival.
   - `waiting` + tmux alive + idle at prompt: send tmux nudge with unread mail summary
   - `waiting` for more than `waitingTimeoutMs` without any mail arrival: escalate to parent

4. **Lead workflow change**:
   - After spawning workers: `ov status set --state waiting`
   - After processing worker results: state transitions back to `working`

**Benefits**:
- No token burn while waiting
- No lost messages
- Agents can be resumed on demand
- Clear semantic distinction between "done" and "waiting"
- Backward compatible: agents that don't use `waiting` behave exactly as today

**Implementation effort**: Medium. Changes needed in:
- `types.ts`: Add `waiting` to `AgentState`
- `log.ts:transitionToCompleted()`: Skip if state is `waiting`
- `health.ts:evaluateHealth()`: Add `waiting` exemption path
- `health.ts:STATE_ORDER`: Insert `waiting` at position 2
- `daemon.ts`: Handle `waiting` state in tick loop
- `nudge.ts:resolveTargetSession()`: Allow `waiting` state
- `mail.ts:nudgeIfIdle()`: Trigger resume for `waiting` agents with dead tmux
- Agent definitions (`lead.md`, `plan-review-lead.md`): Replace "stop and do nothing" with "set state to waiting, then stop"
- New `ov resume` or `ov wake` command for respawning dead waiting sessions

### Immediate Fix: plan-review-lead PERSISTENT_CAPABILITIES Consistency

Regardless of which option is chosen for the broader problem, the `plan-review-lead` inconsistency should be fixed immediately:

**Option**: Add `plan-review-lead` to `health.ts:PERSISTENT_CAPABILITIES` and `daemon.ts:PERSISTENT_CAPABILITIES` to match `log.ts`. The plan-review-lead runs as a persistent root agent (spawned by mission-analyst, runs at project root) and should be treated consistently as persistent.

### Immediate Fix: Orphan Message Detection

Add a watchdog check in `runDaemonTick`:
```
For each completed agent:
  Check mail.db for unread messages addressed to that agent
  If found: send summary to parent agent or coordinator
  Log as "orphaned_mail" event
```

This doesn't fix the root cause but makes lost messages visible.

---

## Appendix A: PERSISTENT_CAPABILITIES Sets Across Codebase

| Capability | `log.ts` | `health.ts` | `daemon.ts` | `headroom/priority.ts` | `headroom/guard.ts` |
|---|---|---|---|---|---|
| coordinator | Y | Y | Y | Y | Y |
| coordinator-mission | Y | Y | Y | Y | Y |
| mission-analyst | Y | Y | Y | Y | Y |
| execution-director | Y | Y | Y | Y | Y |
| monitor | Y | Y | Y | Y | Y |
| plan-review-lead | **Y** | **N** | **N** | **N** | **N** |

## Appendix B: Agent Completion Signals

| Agent Type | Sends on Completion | Stops After Sending? |
|---|---|---|
| Scout | `result` mail to parent | YES ("Stop. Do not continue exploring after closing.") |
| Builder | `worker_done` mail to parent | YES ("Exit. Do NOT idle, wait for instructions, or continue working.") |
| Reviewer | `result` mail to parent | YES ("Stop. Do not continue exploring after closing.") |
| Merger | `result` mail to parent | YES ("Stop. Do not continue merging after closing.") |
| Plan Critics | `plan_critic_verdict` to plan-review-lead | YES (implicit) |
| Lead | `merge_ready` per builder to coordinator, then `status` summary | YES ("Stop. Do not spawn additional workers after closing.") |
| Coordinator | `ov run complete`, status mail to operator | YES ("Stop processing.") |
| Plan-Review-Lead | `plan_review_consolidated` to mission-analyst | Stops when told by analyst via `ov stop` |
| Mission Analyst | `result` to coordinator | Persistent, stopped via `ov mission complete` |
| Execution Director | `status` (batch complete) to coordinator | Persistent, stopped via mission lifecycle |

## Appendix C: Watchdog Daemon Completion Marking Paths

All paths in `daemon.ts` that mark an agent as completed:

1. **Line 837**: `hasRecentCompletionSignal()` reconciliation -- agent sent `worker_done`/`merge_ready` but state not yet completed. Direct `store.updateState(completed)`.

2. **Line 1226**: TUI reconciliation -- tmux alive, agent at ready prompt, zombie state, session_end event, no recent RL history, no unread mail. Calls `reconcileSessionToCompleted()`.

3. **Line 1253**: Dead tmux reconciliation -- tmux dead, state not completed, session_end event, no recent RL history (or has completion signal). Calls `reconcileSessionToCompleted()`.

4. **Line 888-918**: Completed session cleanup -- state already `completed`, kills lingering tmux/process. Does not CHANGE state, just cleans up.

Note: The watchdog does NOT mark persistent agents as completed via health checks (persistent exemption). It can only mark them completed via the reconciliation paths above.
