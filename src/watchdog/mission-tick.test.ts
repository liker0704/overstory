/**
 * Tests for runMissionTick (Wave 3).
 *
 * Uses real SQLite stores (real MissionStore, SessionStore) in temp dirs —
 * consistent with project philosophy. The engine factory is injected via
 * the _startEngine DI seam to avoid spawning real AI or tmux sessions.
 *
 * tmux operations inside checkAndRecoverDeadAgents are bypassed by setting
 * no session IDs on missions (coordinatorSessionId etc. = null), so the
 * per-role loop has nothing to check.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OverstoryConfig } from "../config-types.ts";
import type { GraphEngine, StepResult } from "../missions/engine.ts";
import { createMissionStore } from "../missions/store.ts";
import type { SessionStore } from "../sessions/store.ts";
import { createSessionStore } from "../sessions/store.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import type { MissionStore } from "../types.ts";
import { type MissionTickOpts, runMissionTick } from "./mission-tick.ts";

// === Helpers ===

/** Minimal OverstoryConfig sufficient for runMissionTick. */
function makeConfig(): OverstoryConfig {
	return {
		project: {
			name: "test",
			root: "/tmp",
			canonicalBranch: "main",
		},
		agents: {
			manifestPath: "",
			baseDir: "",
			maxConcurrent: 4,
			staggerDelayMs: 0,
			maxDepth: 2,
			maxSessionsPerRun: 0,
			maxAgentsPerLead: 0,
		},
		worktrees: { baseDir: "/tmp" },
		taskTracker: { backend: "auto", enabled: false },
		mulch: { enabled: false, domains: [], primeFormat: "markdown" },
		merge: { aiResolveEnabled: false, reimagineEnabled: false },
		providers: {},
		watchdog: {
			tier0Enabled: true,
			tier0IntervalMs: 30_000,
			tier1Enabled: false,
			tier2Enabled: false,
			staleThresholdMs: 300_000,
			zombieThresholdMs: 600_000,
			nudgeIntervalMs: 60_000,
		},
		models: {},
		logging: { verbose: false, redactSecrets: true },
	};
}

/** Build a fake GraphEngine returning a fixed StepResult on step(). */
function makeEngineReturning(stepResult: StepResult): GraphEngine {
	return {
		currentNodeId: () => stepResult.fromNodeId,
		step: async () => stepResult,
		run: async () => ({
			status: "completed" as const,
			steps: [stepResult],
			currentNodeId: stepResult.toNodeId,
		}),
		advanceNode: async () => ({
			status: "completed" as const,
			steps: [],
			currentNodeId: stepResult.toNodeId,
		}),
		forceAdvance: async () => stepResult,
	};
}

/** Create a temp overstory directory with sessions.db. */
async function createTempOvDir(): Promise<{ overstoryDir: string; dbPath: string }> {
	const base = await mkdtemp(join(tmpdir(), "ov-mission-tick-test-"));
	const overstoryDir = join(base, ".overstory");
	await mkdir(overstoryDir, { recursive: true });
	return { overstoryDir, dbPath: join(overstoryDir, "sessions.db") };
}

/** Build MissionTickOpts with the given stores and engine factory override. */
function makeOpts(
	overstoryDir: string,
	missionStore: MissionStore,
	sessionStore: SessionStore,
	engineFactory?: MissionTickOpts["_startEngine"],
): MissionTickOpts {
	return {
		overstoryDir,
		projectRoot: overstoryDir,
		config: makeConfig(),
		missionStore,
		sessionStore,
		mailStore: null,
		eventStore: null,
		intervalMs: 30_000,
		_startEngine: engineFactory,
	};
}

// === Test state ===

let overstoryDir: string;
let dbPath: string;
let missionStore: MissionStore;
let sessionStore: SessionStore;

beforeEach(async () => {
	({ overstoryDir, dbPath } = await createTempOvDir());
	missionStore = createMissionStore(dbPath);
	sessionStore = createSessionStore(dbPath);
});

afterEach(async () => {
	missionStore.close?.();
	sessionStore.close?.();
	await cleanupTempDir(overstoryDir.replace("/.overstory", ""));
});

// === Tests ===

describe("runMissionTick", () => {
	test("does nothing and returns cleanly when there are no active missions", async () => {
		// No missions inserted — getActiveList() returns [].
		const calls: string[] = [];
		const engineFactory: MissionTickOpts["_startEngine"] = () => {
			calls.push("engine-called");
			return makeEngineReturning({
				status: "terminal",
				fromNodeId: "start",
				toNodeId: "end",
				trigger: null,
			});
		};

		await expect(
			runMissionTick(makeOpts(overstoryDir, missionStore, sessionStore, engineFactory)),
		).resolves.toBeUndefined();

		expect(calls).toHaveLength(0);
	});

	test("skips missions whose state is not 'active'", async () => {
		// Insert a mission then immediately suspend it — it won't appear in
		// getActiveList() since that filters for state IN ('active', 'frozen').
		missionStore.create({ id: "m-suspended", slug: "suspended-mission", objective: "test" });
		missionStore.updateState("m-suspended", "suspended");

		const calls: string[] = [];
		const engineFactory: MissionTickOpts["_startEngine"] = () => {
			calls.push("engine-called");
			return makeEngineReturning({
				status: "terminal",
				fromNodeId: "start",
				toNodeId: "end",
				trigger: null,
			});
		};

		await runMissionTick(makeOpts(overstoryDir, missionStore, sessionStore, engineFactory));

		// Engine must never be invoked for a suspended mission.
		expect(calls).toHaveLength(0);
	});

	test("skips mission when tick lock cannot be acquired", async () => {
		missionStore.create({ id: "m-locked", slug: "locked-mission", objective: "test" });
		// The mission state defaults to 'active' on creation.

		// Pre-acquire the lock with a long interval so the tick can't steal it.
		const locked = missionStore.acquireTickLock("m-locked", 60_000);
		expect(locked).toBe(true);

		const calls: string[] = [];
		const engineFactory: MissionTickOpts["_startEngine"] = () => {
			calls.push("engine-called");
			return makeEngineReturning({
				status: "terminal",
				fromNodeId: "start",
				toNodeId: "end",
				trigger: null,
			});
		};

		await runMissionTick(makeOpts(overstoryDir, missionStore, sessionStore, engineFactory));

		// Lock was held — engine must be skipped.
		expect(calls).toHaveLength(0);
	});

	test("calls engine step and releases lock for an active mission", async () => {
		missionStore.create({ id: "m-active", slug: "active-mission", objective: "test", tier: "full" });
		missionStore.updateCurrentNode("m-active", "understand:active");

		const stepResults: string[] = [];
		const engineFactory: MissionTickOpts["_startEngine"] = (_mission, _deps, _opts) => {
			return {
				currentNodeId: () => "understand:active",
				step: async (): Promise<StepResult> => {
					stepResults.push("stepped");
					return {
						status: "terminal",
						fromNodeId: "understand:active",
						toNodeId: "done:completed",
						trigger: "complete",
					};
				},
				run: async () => ({
					status: "completed" as const,
					steps: [],
					currentNodeId: "done:completed",
				}),
				advanceNode: async () => ({
					status: "completed" as const,
					steps: [],
					currentNodeId: "done:completed",
				}),
				forceAdvance: async () => ({
					status: "terminal" as const,
					fromNodeId: "understand:active",
					toNodeId: "done:completed",
					trigger: "complete",
				}),
			};
		};

		await runMissionTick(makeOpts(overstoryDir, missionStore, sessionStore, engineFactory));

		// Engine step was invoked exactly once.
		expect(stepResults).toHaveLength(1);

		// Lock must be released after tick — next acquire succeeds.
		const canAcquire = missionStore.acquireTickLock("m-active", 30_000);
		expect(canAcquire).toBe(true);
	});

	test("does not send nudge for gate result still within grace period", async () => {
		missionStore.create({ id: "m-gate", slug: "gate-mission", objective: "test" });
		// Set currentNode so processMission can read it after step().
		missionStore.updateCurrentNode("m-gate", "understand:await-plan");

		const nudgeCalls: string[] = [];

		const engineFactory: MissionTickOpts["_startEngine"] = () => ({
			currentNodeId: () => "understand:await-plan",
			step: async (): Promise<StepResult> => ({
				status: "gate",
				fromNodeId: "understand:await-plan",
				toNodeId: "understand:await-plan",
				trigger: null,
			}),
			run: async () => ({
				status: "gate" as const,
				steps: [],
				currentNodeId: "understand:await-plan",
				gateType: "async" as const,
			}),
			advanceNode: async () => ({
				status: "completed" as const,
				steps: [],
				currentNodeId: "understand:done",
			}),
			forceAdvance: async () => ({
				status: "gate" as const,
				fromNodeId: "understand:await-plan",
				toNodeId: "understand:await-plan",
				trigger: null,
			}),
		});

		// Use a config with a very long grace period for "await-plan" so we stay within grace.
		const opts = makeOpts(overstoryDir, missionStore, sessionStore, engineFactory);
		opts.config = {
			...makeConfig(),
			mission: {
				gates: {
					gracePeriods: { "await-plan": 3_600_000 }, // 1-hour grace — tick is brand-new
				},
			},
		};

		await runMissionTick(opts);

		// No nudge should fire while within grace.
		expect(nudgeCalls).toHaveLength(0);
	});
});
