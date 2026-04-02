# Mission Lifecycle Graph Audit

## 1. `src/missions/graph.ts` — Graph Builder

### 1.1 Phase Transition Coverage

`buildDefaultGraph()` (graph.ts:40-171) builds transition edges for these working phases:
```typescript
const workingPhases: MissionPhase[] = ["understand", "align", "decide", "plan", "execute"];
```
Phase-advance edges are built at lines 122-132:
```typescript
for (let i = 0; i < workingPhases.length - 1; i++) {
    const from = workingPhases[i]!;
    const to = workingPhases[i + 1]!;
    const trigger = from === "plan" && to === "execute" ? "handoff" : "phase_advance";
    edges.push({ from: nodeId(from, "active"), to: nodeId(to, "active"), trigger, weight: 10 });
}
```

**BUG-1 (Medium): Phase-advance edges originate exclusively from `active` state.**
The graph has no edge `<phase>:frozen → <nextPhase>:active` for any phase. Every phase-advance edge has the form `<phase>:active → <nextPhase>:active`. This means there is no graph path for advancing a phase while frozen, so any code that attempts this will generate a `graph_transition_warning` event (advisory mode) rather than failing hard. Confirmed by `adviseGraphTransition` at lifecycle.ts:119 — warnings are logged, not hard-blocked.

**BUG-2 (Medium): No `stop` edge from `suspended` state.**
The loop at graph.ts:101-111 adds `stop` edges only from `active` and `frozen`:
```typescript
edges.push({ from: nodeId(phase, "active"), to: nodeId("done", "stopped"), trigger: "stop" });
edges.push({ from: nodeId(phase, "frozen"), to: nodeId("done", "stopped"), trigger: "stop" });
```
There is no `<phase>:suspended → done:stopped` edge. In `missionStop()` at lifecycle.ts:1228, when `--kill` is passed with a suspended mission, it calls `terminalizeMission()` which calls `adviseGraphTransition(overstoryDir, missionStore, mission, "done", "stopped")` (lifecycle.ts:429). Since no `suspended → stopped` edge exists in the graph, this fires a `graph_transition_warning`. The mission does end up in the correct terminal state because the advisory layer does not block the transition, but the graph is inaccurate.

**BUG-3 (Low): No `fail` edge from `frozen` or `suspended` states.**
Lines 113-118 add fail edges only from `active`:
```typescript
edges.push({ from: nodeId(phase, "active"), to: nodeId("done", "failed"), trigger: "fail" });
```
There is no `<phase>:frozen → done:failed` or `<phase>:suspended → done:failed` edge. A frozen or suspended mission has no graph path to the `failed` terminal node.

### 1.2 Dead-end / no-outgoing-edge analysis

Terminal nodes `done:completed`, `done:stopped`, `done:failed` are correctly marked with `terminal: true` and the engine treats them as terminal (engine.ts:135). No non-terminal node in the default graph has zero outgoing edges except for `done:*` which are explicitly terminal. No stuckable non-terminal states are created.

### 1.3 `handoff` trigger consistency

The graph registers `handoff` as the trigger for `plan:active → execute:active` (graph.ts:125). In `missionHandoff()` (workstream-control.ts:443), the actual code calls:
```typescript
adviseGraphTransition(overstoryDir, missionStore, mission, "execute", "active");
missionStore.updatePhase(mission.id, "execute");
```
(workstream-control.ts:632-634)

`adviseGraphTransition` calls `validateTransition(DEFAULT_MISSION_GRAPH, mission.phase, mission.state, "execute", "active")` (lifecycle.ts:119-125). This validates the edge based on `(fromPhase, fromState) → (toPhase, toState)` matching, not trigger name. The trigger label appears in `GraphTransitionResult.reason` ("Legal transition via 'handoff'"). Trigger name is not separately verified by the advisory layer, so this is internally consistent.

**BUG-4 (Medium): `missionHandoff` does not check current phase before advancing.**
`missionHandoff()` only checks `mission.pendingUserInput`, `mission.firstFreezeAt`, and whether the execution director is already running (workstream-control.ts:477-507). It does NOT verify `mission.phase === "plan"`. If called when `mission.phase` is `"understand"`, `"align"`, `"decide"`, or even `"execute"`, the function proceeds, `adviseGraphTransition(... "execute", "active")` logs a warning for any phase other than `plan:active`, and then unconditionally sets `missionStore.updatePhase(mission.id, "execute")` (workstream-control.ts:634). Because `adviseGraphTransition` is advisory-only, execution proceeds regardless of starting phase.

### 1.4 Weight consistency

The `weight: 10` values appear only on phase-advance edges and the `execute:active → done:completed` edge (graph.ts:122-148). All other edges default to weight 0. `getAvailableTransitions` at graph.ts:189-196 sorts by descending weight — this ordering is cosmetic in advisory mode. In engine mode, `performAdvance` selects edges by trigger name (engine.ts:117), not by weight. Weights are consistent but currently have no operational effect in either mode.

### 1.5 `validateGraph()` coverage

`validateGraph()` (graph.ts:229-306) checks: edge source/target existence, at least one terminal, BFS reachability, non-empty handler keys, cell node ID prefix convention, subgraph-not-terminal invariant, and recursive subgraph validation.

**BUG-5 (Low): `validateGraph` does not detect duplicate node IDs.**
There is no check that `graph.nodes` contains unique IDs. If two nodes share an ID, the BFS marks the ID reachable on first visit and the second node appears as a duplicate-but-reachable. `nodeMap` in the engine (engine.ts:81-86) silently overwrites the first node with the second.

**BUG-6 (Low): `validateGraph` does not check for duplicate edge `(from, to, trigger)` tuples.**
No uniqueness constraint. `performAdvance` at engine.ts:117 uses `edges.find(...)` and would silently use the first matching edge if duplicates existed.

**BUG-7 (Low): Subgraph start node inferred from `nodes[0]?.id`.**
At graph.ts:293-296, if a subgraph is empty, `startNodeId` is undefined and `validateGraph` defaults to `"understand:active"` as the start. That node almost certainly does not exist in a cell subgraph, causing a misleading "Start node not found" error.

---

## 2. `src/missions/lifecycle.ts` — State Transitions

### 2.1 `adviseGraphTransition()` correctness

```typescript
export function adviseGraphTransition(
    overstoryDir: string,
    missionStore: MissionStore,
    mission: Mission,
    toPhase: MissionPhase,
    toState: MissionState,
): void {
    const result = validateTransition(DEFAULT_MISSION_GRAPH, mission.phase, mission.state, toPhase, toState);
    const targetNode = nodeId(toPhase, toState);
    missionStore.updateCurrentNode(mission.id, targetNode);   // always executes
    if (!result.valid) {
        recordMissionEvent({ ... kind: "graph_transition_warning" ... });
    }
}
```
(lifecycle.ts:112-141)

`updateCurrentNode` executes unconditionally regardless of whether the transition is graph-valid. `current_node` always reflects the intended target even when the transition is graph-illegal. This is by design for the advisory pattern.

### 2.2 Transitions that bypass the graph

The following direct store operations are not routed through `adviseGraphTransition`:

- `missionStore.freeze(...)` — called from `src/missions/messaging.ts`. `freeze()` at store.ts:473-474 sets `current_node = phase || ':frozen'` directly via SQL string concatenation without consulting the graph.
- `missionStore.unfreeze(...)` — store.ts:486 sets `current_node = phase || ':active'` by the same SQL pattern, also without graph advisory.
- `missionStore.completeMission(...)` — store.ts:576-589 updates `state = 'completed'` without touching `current_node`. The `terminalizeMission` code calls `adviseGraphTransition` first (lifecycle.ts:417), which sets `current_node = "done:completed"` via `updateCurrentNode`, then calls `completeMission` which does not reset `current_node`. Consistent end state.

**BUG-8 (High): `freeze()` and `unfreeze()` in the store bypass `adviseGraphTransition` entirely.**
The `freeze()` and `unfreeze()` statements compute `current_node` from the current `phase` column value via SQL, with no graph validation and no `graph_transition_warning` event recorded. Any direct store caller gets `current_node` updated silently.

### 2.3 `missionStart()` initial node

At lifecycle.ts:627:
```typescript
missionStore.updateCurrentNode(missionId, nodeId("understand", "active"));
```
This correctly sets `current_node = "understand:active"`. The graph's BFS default start node is also `"understand:active"` (graph.ts:253). Consistent. Confidence: High (95%).

### 2.4 Freeze/unfreeze graph consistency

**BUG-9 (Medium): `missionAnswer()` calls `adviseGraphTransition` before `unfreeze()`.**
At lifecycle.ts:986-987:
```typescript
adviseGraphTransition(overstoryDir, missionStore, mission, mission.phase, "active");
missionStore.unfreeze(missionId);
```
`adviseGraphTransition` calls `missionStore.updateCurrentNode(mission.id, "<phase>:active")` (lifecycle.ts:127). Then `unfreeze()` immediately overwrites `current_node` again with `phase || ':active'` via SQL (store.ts:486). Both compute the same value so the end state is identical, but `current_node` is written twice.

**BUG-10 (Medium): Double-unfreeze is possible without guard.**
If `missionAnswer()` is called twice concurrently (two CLI processes), both read `mission.pendingUserInput === true` before either write commits, both pass the guard at lifecycle.ts:966, and both call `missionStore.unfreeze()`. Since `unfreezeStmt` has only `WHERE id = $id` with no `WHERE state = 'frozen'` guard, the second call succeeds and increments `reopen_count` a second time.

### 2.5 `terminalizeMission()` from all states

`missionComplete()` (lifecycle.ts:1513) accepts an explicit `missionId` parameter, bypassing `resolveActiveMissionContext` (which only returns `active`/`frozen` missions). If a suspended mission ID is passed directly:
- `resolveCurrentMissionId` via pointer is not used
- `mission.pendingUserInput` is `false` for suspended missions, so the guard at lifecycle.ts:1543 passes
- `terminalizeMission()` proceeds to terminate it, calling `adviseGraphTransition(..., "done", "completed")` with `mission.state = "suspended"`, generating a graph warning since no `<phase>:suspended → done:completed` edge exists

---

## 3. `src/missions/engine.ts` and `src/missions/engine-wiring.ts` — The Engine

### 3.1 `shouldUseEngine()` gating

```typescript
export function shouldUseEngine(mission: Mission, config: OverstoryConfig): boolean {
    void mission;
    return config.mission?.graphExecution === true;
}
```
(engine-wiring.ts:161-165)

The `mission` parameter is explicitly discarded. This is a pure config flag. In `missionStart()` (lifecycle.ts:775), the engine flag check only records an event — it does not gate any actual engine calls. All lifecycle transitions (freeze, unfreeze, phase advance, complete, stop) go through `adviseGraphTransition` regardless of the engine flag. The engine is only wired to cell sub-workflows (`plan-review`, `architecture-review`) via `startCellEngine`/`advanceCellGate`.

**BUG-11 (Medium): `shouldUseEngine()` is checked in `missionStart()` but the engine is not used for lifecycle transitions.**
The `if (shouldUseEngine(mission, config))` block at lifecycle.ts:775-782 only records an informational event. Enabling `config.mission.graphExecution` does not change the lifecycle transition path.

### 3.2 Engine `step()` — all node types

`step()` (engine.ts:130-206) handles:
1. `node.terminal` → returns `"terminal"` (line 135)
2. `node.gate === "human" | "async"` → returns `"gate"` (line 140)
3. `node.kind === "lifecycle" && node.subgraph` → runs subgraph (line 145)
4. `node.handler` → invokes handler, gets trigger (line 163)
5. No handler + zero outgoing edges → returns `"terminal"` (line 194)
6. No handler + one edge → auto-triggers (line 197)
7. No handler + multiple edges → returns `"gate"` (line 201)

**BUG-12 (Medium): Subgraph error propagated as `gate`, discarding error details.**
At engine.ts:155-158:
```typescript
if (subResult.status !== "completed") {
    // Subgraph gated or errored — propagate as gate
    return { status: "gate", fromNodeId: nodeId, toNodeId: nodeId, trigger: null };
}
```
If the subgraph errors (`subResult.status === "error"`), the parent step returns `"gate"`, not `"error"`. The error message from the subgraph is dropped. The caller's `run()` loop treats this as a normal gate and pauses execution with no error indication.

**BUG-13 (Low): Subgraph engine shares `missionId` with parent engine, causing checkpoint collision.**
At engine.ts:146-154, the subgraph engine is created with `missionId: opts.missionId`. `resolveStartNodeId()` reads `getLatestCheckpoint(missionId)` (checkpoint.ts:80-85), which returns the latest checkpoint row by `rowid DESC` for that `missionId`. If the parent engine has checkpoints (e.g., `"plan:active"`), the subgraph engine resolves its start node to `"plan:active"`, which does not exist in the cell subgraph's `nodeMap`. `getNode(id)` at engine.ts:108-112 throws `"Node 'plan:active' not found in graph"`. This exception is caught by `run()`'s try/catch (engine.ts:213-218), returning `status: "error"`.

### 3.3 Checkpoint consistency on crash

`performAdvance` at engine.ts:123-125:
```typescript
opts.checkpointStore.saveStepResult(opts.missionId, fromNodeId, edge.to, trigger, null);
opts.missionStore?.updateCurrentNode(opts.missionId, edge.to);
state.currentNodeId = edge.to;
```
`saveStepResult` is atomic (SQLite transaction, checkpoint.ts:116-147). `updateCurrentNode` is a separate write on the mission store. If the process crashes between these two calls, `mission_node_checkpoints` shows the new node but `missions.current_node` shows the old node. On resume, the engine reads `getLatestCheckpoint` (checkpoint store), so the engine resumes correctly. The `missions.current_node` column remains stale until the next write. The advisory layer uses `missions.current_node` as its source of truth (via `mission.phase` + `mission.state`, not `current_node` directly), so the divergence does not affect lifecycle behavior but does affect observability.

---

## 4. `src/missions/store.ts` — Persistence

### 4.1 Atomicity of DB updates

All prepared statement executions are individual SQLite writes. Related field updates (e.g., `adviseGraphTransition` then `updateState` then `updatePhase`) are three separate writes with no transaction wrapping at the lifecycle layer.

**BUG-14 (High): Multi-step termination in `terminalizeMission` is not wrapped in a transaction.**
At lifecycle.ts:416-430:
```typescript
if (targetState === "completed") {
    adviseGraphTransition(overstoryDir, missionStore, mission, "done", "completed");
    // ^ updateCurrentNode: 1 write
    if (mission.phase !== "done") {
        missionStore.updatePhase(mission.id, "done");
        // ^ updatePhase: 2nd write
    }
    missionStore.completeMission(mission.id);
    // ^ state/pending fields: 3rd write
} else {
    adviseGraphTransition(overstoryDir, missionStore, mission, "done", "stopped");
    missionStore.updateState(mission.id, "stopped");
}
```
A crash between any two writes leaves the DB in a partially-updated state (e.g., `current_node = "done:completed"` but `state = "active"`).

### 4.2 `freeze()` re-freeze behavior

`freezeStmt` at store.ts:457-476 uses `COALESCE(first_freeze_at, $updated_at)` to preserve the original freeze timestamp on re-freeze. `frozen_at` is always overwritten. `pending_input_thread_id` is overwritten with the new thread ID on each call — if `freeze()` is called twice with different thread IDs, the first thread ID is lost. `appendMissionThreadId()` (store.ts:817-849) exists as a separate function that maintains a JSON array of thread IDs, but it opens a fresh DB connection per call and is not called by `freeze()` itself.

### 4.3 `unfreeze()` edge cases

`unfreezeStmt` at store.ts:478-489:
- **Already-unfrozen call**: No `WHERE state = 'frozen'` guard. If called on an `active` mission, it sets `state = 'active'` (no-op for state), clears all pending fields, and increments `reopen_count`. `reopen_count` can be inflated by spurious calls.
- **Suspended mission unfreeze**: If called on a `suspended` mission, it would set `state = 'active'` directly, bypassing `adviseGraphTransition` and any suspend-to-active-specific logic.

### 4.4 `updatePhase()` vs `updateCurrentNode()` consistency

`updatePhase()` at store.ts:679-681 updates only `phase`. `updateCurrentNode()` at store.ts:771-777 updates only `current_node`. The two can diverge if a caller updates one but not the other.

In `terminalizeMission` for `completed` path (lifecycle.ts:417-427): `adviseGraphTransition` sets `current_node = "done:completed"`, then `updatePhase` sets `phase = "done"`, then `completeMission` sets `state = "completed"`. End state: `phase = "done"`, `state = "completed"`, `current_node = "done:completed"` — consistent if all three calls succeed. Inconsistent if any intermediate call fails without a wrapping transaction.

---

## 5. Cross-Cutting Edge Cases

### 5.1 `frozen` state when `complete` is called

`missionComplete()` (lifecycle.ts:1513) resolves the mission ID via `resolveCurrentMissionId`, which via `resolveActiveMissionContext` (runtime-context.ts:88-100) resolves only `active` or `frozen` missions. The check at lifecycle.ts:1543 then gates on `mission.pendingUserInput === true`. A frozen mission has `pending_user_input = 1`, so this guard fires and blocks completion. Correct behavior.

### 5.2 `suspended` state when `handoff` is called

`missionHandoff()` (workstream-control.ts:450) calls `resolveCurrentMissionId`. `resolveActiveMissionContext` returns only `active` or `frozen` missions (runtime-context.ts:90). A suspended mission is not returned unless explicitly passed via `--mission`. If explicitly passed:
- `mission.pendingUserInput` is `false` (suspended missions do not have pending input) → guard passes
- `mission.firstFreezeAt` may be set → guard passes
- No check for `mission.state === "suspended"` anywhere in handoff (workstream-control.ts:466-507)
- The function proceeds to spawn the execution director and advance to `execute`

**BUG-15 (Medium): `missionHandoff` does not guard against `suspended` state.**
A direct `--mission <suspended-id>` invocation bypasses all state guards and spawns agents on a suspended mission.

### 5.3 Concurrent `answer` and `complete` calls

`missionAnswer()` reads `mission.pendingUserInput` then calls `unfreeze()`. `missionComplete()` reads `mission.pendingUserInput` and errors if true. SQLite's serialized writer model means the two writes serialize. The `pendingUserInput` check in `missionComplete()` effectively prevents concurrent completion of a frozen mission. There is a narrow TOCTOU window, but WAL mode serializes writers and the `pendingUserInput` read-then-write is effectively a single-writer transaction per operation. Low practical risk.

### 5.4 Workstream dependency cycles

`validateWorkstreams` (workstreams.ts:165-172) checks that each `dependsOn` entry references an existing workstream ID — but does NOT check for cycles. A workstream graph with `ws-a → ws-b → ws-a` passes validation.

`packageHandoffs()` at workstreams.ts:366-385 filters workstreams by:
```typescript
return ws.dependsOn.every((depId) => completedIds.has(depId));
```
With a cycle, none of the cycle participants ever have all dependencies in `completedIds`. `packageHandoffs()` silently excludes them with no warning. The handoff call succeeds with the remaining non-cyclic workstreams, but cyclic ones are silently dropped.

**BUG-16 (Medium): Circular `dependsOn` in workstreams silently drops workstreams from dispatch without error.**
No cycle detection in `validateWorkstreams` (workstreams.ts:140-196) or `packageHandoffs` (workstreams.ts:366-385).

---

## Summary Table

| ID | Severity | Location | Description |
|----|----------|----------|-------------|
| BUG-1 | Medium | graph.ts:122-132 | Phase-advance edges only from `active`; no advance from `frozen` |
| BUG-2 | Medium | graph.ts:101-111 | No `stop` edge from `suspended` state |
| BUG-3 | Low | graph.ts:113-118 | No `fail` edge from `frozen` or `suspended` states |
| BUG-4 | Medium | workstream-control.ts:477 | `missionHandoff()` does not check `mission.phase === "plan"` before advancing |
| BUG-5 | Low | graph.ts:229 | `validateGraph()` does not detect duplicate node IDs |
| BUG-6 | Low | graph.ts:229 | `validateGraph()` does not detect duplicate edges |
| BUG-7 | Low | graph.ts:293 | Subgraph start-node inference fails/misleading for empty subgraphs |
| BUG-8 | High | store.ts:473, 486 | `freeze()`/`unfreeze()` bypass `adviseGraphTransition`; no graph advisory, no warning events |
| BUG-9 | Medium | lifecycle.ts:986-987 | `adviseGraphTransition` + `unfreeze()` write `current_node` twice (redundant, last write wins) |
| BUG-10 | Medium | store.ts:478 | `unfreeze()` has no `WHERE state = 'frozen'` guard; double-call inflates `reopen_count` |
| BUG-11 | Medium | lifecycle.ts:775 | `shouldUseEngine()` checked in `missionStart` but engine is never used for lifecycle transitions |
| BUG-12 | Medium | engine.ts:155-158 | Subgraph error propagated as `gate`, discarding error details |
| BUG-13 | Low | engine.ts:146 | Subgraph engine shares `missionId` with parent; checkpoint collision causes crash if parent has checkpoints |
| BUG-14 | High | lifecycle.ts:416-430 | Multi-step termination not wrapped in a transaction; partial state on crash |
| BUG-15 | Medium | workstream-control.ts:466 | `missionHandoff()` does not guard against `mission.state === "suspended"` |
| BUG-16 | Medium | workstreams.ts:165-172 | No cycle detection in `dependsOn`; cyclic workstreams silently dropped from dispatch |

Search tools: grep ✅ | read ✅

```yaml
---
status: SUCCESS
files_analyzed: 7
symbols_traced: 44
data_flows_documented: 9
patterns_identified:
  - advisory-graph-validation
  - sql-atomic-single-statement
  - cell-subgraph-engine
  - checkpoint-resume
  - two-layer-lifecycle-state
confidence: 0.92
---
```
