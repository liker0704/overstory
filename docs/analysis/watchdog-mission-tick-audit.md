# Audit: Watchdog Daemon + Mission Tick Integration

## Analysis Points

---

### 1. Store Lifecycle — Is missionStore Used After close()?

**Not under normal control flow.**

The structure in `daemon.ts:1675-1712` is:

```typescript
const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
try {
    const { runMissionTick } = await import("./mission-tick.ts");
    await runMissionTick({ ..., missionStore, ... });
} catch (err) {
    // error logging only — no missionStore usage after this point
} finally {
    missionStore.close();   // line 1711
}
```
(`daemon.ts:1675-1712`)

`runMissionTick` is `await`-ed to completion before the `finally` block runs, and the `catch` block only touches `eventStore`. After `missionStore.close()` fires at line 1711, the `missionStore` reference goes out of scope along with the entire `if` block. The outer `finally` at line 1714 closes `store` (sessionStore), `mailStore`, `eventStore`, etc. — none of which reference `missionStore`. **Confidence: High (95%)**

---

### 2. Dynamic Imports — Safety and Stale Cache

`mission-tick.ts` performs dynamic imports at two places:

**Line 103:**
```typescript
const engineFactory =
    opts._startEngine ?? (await import("../missions/engine-wiring.ts")).startLifecycleEngine;
```
(`mission-tick.ts:102-103`)

**Line 203:**
```typescript
const phaseCell = (await import("../missions/engine-wiring.ts")).PHASE_CELL_REGISTRY[cellType];
```
(`mission-tick.ts:203`)

Both import the same module specifier `"../missions/engine-wiring.ts"`. Bun (like V8/Node) caches ES module imports by resolved URL after the first load. The second `await import(...)` at line 203 returns the already-cached module object — no re-evaluation, no second parse. Both calls in the same tick resolve to the identical module instance.

The `startLifecycleEngine` function at line 103 receives a `missionStore` and `checkpointStore` reference. These are passed into `createGraphEngine` inside `engine-wiring.ts` and used synchronously during `engine.step()` / `engine.advanceNode()`. The engine holds no background handles or timers — it does not create any SQLite stores of its own; it operates on the `checkpointStore` and `missionStore` that were passed in. Both of those are closed only after `runMissionTick` resolves (line 1711). **Confidence: High (90%)**

The DI escape hatch `opts._startEngine` at line 103 exists for tests; the dynamic import at line 203 has no equivalent DI path. That second import is always live (not overridable), though since it is the same cached module, this is not observable at runtime.

---

### 3. Error Handling — Does releaseTickLock Fire After processMission Throws?

`runMissionTick` uses a try/finally around `processMission`:

```typescript
try {
    await processMission(mission, opts);
} finally {
    missionStore.releaseTickLock(mission.id);   // mission-tick.ts:83
}
```
(`mission-tick.ts:80-85`)

The `finally` block is unconditional. If `processMission` throws synchronously or rejects asynchronously, the `finally` still executes and `releaseTickLock` fires. The error then propagates up to `runMissionTick`'s caller in `daemon.ts`, where it is caught by the outer `catch (err)` at line 1688 and logged as a non-fatal `mission_tick_error` event. The `missionStore.close()` in the `finally` at line 1711 then still fires. **Confidence: High (95%)**

---

### 4. sessionStore vs missionStore — Shared sessions.db

Both stores open independent `Database` connections to the same file:

- `openSessionStore(overstoryDir)` at `daemon.ts:666` → `createSessionStore(join(overstoryDir, "sessions.db"))` (`sessions/compat.ts:90`) — opens `sessions.db`, stores reference in `store`
- `createMissionStore(join(overstoryDir, "sessions.db"))` at `daemon.ts:1675` — opens a second `Database` connection to the same `sessions.db`

Each store creates its own `bun:sqlite` `Database` object and prepares its own statement handles:

```typescript
// sessions/store.ts:332-338
const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");
...
const upsertStmt = db.prepare<...>(`INSERT INTO sessions ...`);
```

```typescript
// missions/store.ts:487-492
const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");
...
const insertStmt = db.prepare<...>(`INSERT INTO missions ...`);
```

Prepared statements are bound to the `Database` object that created them. Closing `missionStore` at line 1711 calls `db.close()` on the missionStore's `Database` instance only — it does not affect the sessionStore's `Database` instance, and vice versa. The outer finally at line 1715 then closes `store` (sessionStore's `Database`).

The WAL mode and `busy_timeout=5000` on both connections handle concurrent writes. Both share `PRAGMA user_version` on `sessions.db` (same file), which is the known shared migration counter documented in CLAUDE.md. **Confidence: High (95%)**

---

### 5. eventStore Availability During mission-tick Execution

`eventStore` is opened at `daemon.ts:690-694` (or injected via DI) and assigned to a local `let eventStore` variable. It is passed into `runMissionTick` at `daemon.ts:1685`:

```typescript
await runMissionTick({
    ...
    eventStore,
    ...
});
```

`eventStore.close()` is only called in the outermost `finally` block at `daemon.ts:1749-1754`, after `runMissionTick` has already completed (it is awaited at line 1678). No code path inside the tick loop closes `eventStore` before mission-tick runs. Therefore when `mission-tick.ts` calls `opts.eventStore.insert(...)` at lines 164, 231, 258, 286, the `eventStore` is still open. **Confidence: High (95%)**

---

### 6. config Access — `options.config?.mission?.graphExecution !== false`

The guard at `daemon.ts:1673`:

```typescript
if (options.config?.mission?.graphExecution !== false) {
```

`options.config` is typed as `config?: OverstoryConfig` (`daemon.ts:487`). Three cases:

| `options.config` value | `options.config?.mission` | `options.config?.mission?.graphExecution` | Result of `!== false` |
|---|---|---|---|
| `undefined` | `undefined` | `undefined` | `undefined !== false` → **`true`** — tick runs |
| `{ mission: undefined }` | `undefined` | `undefined` | `true` — tick runs |
| `{ mission: { graphExecution: true } }` | object | `true` | `true` — tick runs |
| `{ mission: { graphExecution: false } }` | object | `false` | `false` — tick skipped |

When `config` is `undefined`, the optional chain short-circuits to `undefined`, and `undefined !== false` evaluates to `true`. This means the mission tick runs by default when no config is provided. The comment at `config-types.ts:203` states: `"Default: true (set to false to disable)"`, which is consistent with this behavior.

Inside `runMissionTick`, `config` is received as `options.config ?? ({} as OverstoryConfig)` (`daemon.ts:1681`). The `?? {}` fallback means the tick itself never receives `undefined` for `config` — it receives either the real config or an empty object cast to `OverstoryConfig`. `mission-tick.ts` does not read `config` directly for the graph-execution flag (that check is in the daemon). **Confidence: High (95%)**

---

### Summary Table

| Check | Finding |
|---|---|
| missionStore used after close() | No — `runMissionTick` is fully awaited before `finally { missionStore.close() }` runs |
| Dynamic import stale module cache | Not possible — Bun module cache returns same instance; no background stores created |
| releaseTickLock fires on processMission throw | Yes — unconditional `finally` at `mission-tick.ts:82-84` |
| sessionStore/missionStore statement sharing | No sharing — two independent `Database` instances on same file; closing one does not affect the other |
| eventStore open during tick | Yes — closed only in outermost `finally` after `runMissionTick` has resolved |
| config undefined defaults to graphExecution true | Yes — `undefined !== false` is `true`; behavior matches documented default |

---

```yaml
---
status: SUCCESS
files_analyzed: 6
symbols_traced: 18
data_flows_documented: 4
patterns_identified:
  - try/finally lock release pattern
  - dual-connection WAL SQLite sharing
  - DI override pattern for testing (_startEngine)
  - optional-chaining default-true flag evaluation
confidence: 0.95
---
```
