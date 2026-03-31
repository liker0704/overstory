/**
 * Tests for the engine wiring bridge module.
 *
 * Uses mock stores following the same pattern as engine.test.ts.
 */

import { describe, expect, test } from "bun:test";
import type { CheckpointStore, Mission, MissionStore } from "../types.ts";
import {
	advanceCellGate,
	CELL_REGISTRY,
	type EngineDeps,
	getCellEngineStatus,
	shouldUseEngine,
	startCellEngine,
} from "./engine-wiring.ts";
import { validateGraph } from "./graph.ts";

// === Mock stores (same pattern as engine.test.ts) ===

interface StoredCheckpoint {
	data: unknown;
	version: number;
	schemaVersion: number;
}

interface StoredTransition {
	fromNode: string;
	toNode: string;
	trigger: string;
	createdAt: string;
	error?: string;
}

function createMockCheckpointStore(): CheckpointStore & { transitions: StoredTransition[] } {
	const checkpoints = new Map<string, StoredCheckpoint>();
	const transitions: StoredTransition[] = [];

	const key = (missionId: string, nodeId: string) => `${missionId}:${nodeId}`;

	return {
		transitions,

		saveCheckpoint(missionId: string, nodeId: string, data: unknown): void {
			const k = key(missionId, nodeId);
			const existing = checkpoints.get(k);
			checkpoints.set(k, {
				data,
				version: (existing?.version ?? 0) + 1,
				schemaVersion: 1,
			});
		},

		getCheckpoint(
			missionId: string,
			nodeId: string,
		): { data: unknown; version: number; schemaVersion: number } | null {
			return checkpoints.get(key(missionId, nodeId)) ?? null;
		},

		getLatestCheckpoint(
			missionId: string,
		): { nodeId: string; data: unknown; version: number } | null {
			const prefix = `${missionId}:`;
			let latest: { nodeId: string; data: unknown; version: number } | null = null;
			for (const [k, cp] of checkpoints) {
				if (k.startsWith(prefix)) {
					const nodeId = k.slice(prefix.length);
					if (!latest || cp.version >= latest.version) {
						latest = { nodeId, data: cp.data, version: cp.version };
					}
				}
			}
			return latest;
		},

		listCheckpoints(
			missionId: string,
		): Array<{ nodeId: string; version: number; createdAt: string }> {
			const prefix = `${missionId}:`;
			const result: Array<{ nodeId: string; version: number; createdAt: string }> = [];
			for (const [k, cp] of checkpoints) {
				if (k.startsWith(prefix)) {
					result.push({ nodeId: k.slice(prefix.length), version: cp.version, createdAt: "" });
				}
			}
			return result;
		},

		recordTransition(
			_missionId: string,
			fromNode: string,
			toNode: string,
			trigger: string,
			_data?: unknown,
			error?: string,
		): void {
			transitions.push({ fromNode, toNode, trigger, createdAt: new Date().toISOString(), error });
		},

		getTransitionHistory(_missionId: string): Array<{
			fromNode: string;
			toNode: string;
			trigger: string;
			createdAt: string;
			error?: string;
		}> {
			return [...transitions];
		},

		saveStepResult(
			missionId: string,
			fromNode: string,
			toNode: string,
			trigger: string,
			checkpointData: unknown,
		): void {
			this.saveCheckpoint(missionId, toNode, checkpointData);
			this.recordTransition(missionId, fromNode, toNode, trigger);
		},

		deleteCheckpoints(_missionId: string): void {
			checkpoints.clear();
		},
	};
}

function createMockMissionStore(): MissionStore {
	const noop = () => {};
	return {
		getById: (id: string) => ({
			id,
			slug: "test",
			objective: "test",
			runId: null,
			state: "active" as const,
			phase: "understand" as const,
			firstFreezeAt: null,
			pendingUserInput: false,
			pendingInputKind: null,
			pendingInputThreadId: null,
			reopenCount: 0,
			artifactRoot: null,
			pausedWorkstreamIds: [],
			analystSessionId: null,
			executionDirectorSessionId: null,
			coordinatorSessionId: null,
			architectSessionId: null,
			pausedLeadNames: [],
			pauseReason: null,
			currentNode: null,
			startedAt: null,
			completedAt: null,
			createdAt: "",
			updatedAt: "",
			learningsExtracted: false,
		}),
		getBySlug: () => null,
		getActive: () => null,
		getActiveList: () => [],
		create: (m) => ({
			...m,
			runId: m.runId ?? null,
			state: "active" as const,
			phase: "understand" as const,
			firstFreezeAt: null,
			pendingUserInput: false,
			pendingInputKind: null,
			pendingInputThreadId: null,
			reopenCount: 0,
			artifactRoot: m.artifactRoot ?? null,
			pausedWorkstreamIds: [],
			analystSessionId: null,
			executionDirectorSessionId: null,
			coordinatorSessionId: null,
			architectSessionId: null,
			pausedLeadNames: [],
			pauseReason: null,
			currentNode: null,
			startedAt: m.startedAt ?? null,
			completedAt: null,
			createdAt: "",
			updatedAt: "",
			learningsExtracted: false,
		}),
		list: () => [],
		delete: noop,
		updateState: noop,
		updatePhase: noop,
		freeze: noop,
		unfreeze: noop,
		updatePausedWorkstreams: noop,
		updateArtifactRoot: noop,
		bindSessions: noop,
		bindCoordinatorSession: noop,
		updatePausedLeads: noop,
		updatePauseReason: noop,
		start: noop,
		completeMission: noop,
		updateSlug: noop,
		updateObjective: noop,
		updateCurrentNode: noop,
		markLearningsExtracted: noop,
		checkpoints: createMockCheckpointStore(),
		close: noop,
	};
}

const baseMission: Mission = {
	id: "mission-test-1",
	slug: "test",
	objective: "test",
	runId: null,
	state: "active",
	phase: "understand",
	firstFreezeAt: null,
	pendingUserInput: false,
	pendingInputKind: null,
	pendingInputThreadId: null,
	reopenCount: 0,
	artifactRoot: null,
	pausedWorkstreamIds: [],
	analystSessionId: null,
	executionDirectorSessionId: null,
	coordinatorSessionId: null,
	architectSessionId: null,
	pausedLeadNames: [],
	pauseReason: null,
	currentNode: null,
	startedAt: null,
	completedAt: null,
	createdAt: "",
	updatedAt: "",
	learningsExtracted: false,
};

function makeDeps(overrides?: Partial<EngineDeps>): EngineDeps {
	return {
		checkpointStore: createMockCheckpointStore(),
		missionStore: createMockMissionStore(),
		...overrides,
	};
}

// === shouldUseEngine ===

describe("shouldUseEngine", () => {
	test("returns true when flag is absent (enabled by default)", () => {
		const result = shouldUseEngine(baseMission, {
			project: { name: "", root: "", canonicalBranch: "main" },
			agents: {
				manifestPath: "",
				baseDir: "",
				maxConcurrent: 5,
				staggerDelayMs: 0,
				maxDepth: 2,
				maxSessionsPerRun: 0,
				maxAgentsPerLead: 0,
			},
			worktrees: { baseDir: "" },
			taskTracker: { backend: "auto", enabled: false },
			mulch: { enabled: false, domains: [], primeFormat: "markdown" },
			merge: { aiResolveEnabled: false, reimagineEnabled: false },
			providers: {},
			watchdog: {
				tier0Enabled: false,
				tier0IntervalMs: 30000,
				tier1Enabled: false,
				tier2Enabled: false,
				staleThresholdMs: 0,
				zombieThresholdMs: 0,
				nudgeIntervalMs: 60000,
			},
			models: {},
			logging: { verbose: false, redactSecrets: false },
		});
		expect(result).toBe(true);
	});

	test("returns false when flag is explicitly false", () => {
		const result = shouldUseEngine(baseMission, {
			project: { name: "", root: "", canonicalBranch: "main" },
			agents: {
				manifestPath: "",
				baseDir: "",
				maxConcurrent: 5,
				staggerDelayMs: 0,
				maxDepth: 2,
				maxSessionsPerRun: 0,
				maxAgentsPerLead: 0,
			},
			worktrees: { baseDir: "" },
			taskTracker: { backend: "auto", enabled: false },
			mulch: { enabled: false, domains: [], primeFormat: "markdown" },
			merge: { aiResolveEnabled: false, reimagineEnabled: false },
			providers: {},
			watchdog: {
				tier0Enabled: false,
				tier0IntervalMs: 30000,
				tier1Enabled: false,
				tier2Enabled: false,
				staleThresholdMs: 0,
				zombieThresholdMs: 0,
				nudgeIntervalMs: 60000,
			},
			models: {},
			logging: { verbose: false, redactSecrets: false },
			mission: { graphExecution: false },
		});
		expect(result).toBe(false);
	});

	test("returns true when flag is true", () => {
		const result = shouldUseEngine(baseMission, {
			project: { name: "", root: "", canonicalBranch: "main" },
			agents: {
				manifestPath: "",
				baseDir: "",
				maxConcurrent: 5,
				staggerDelayMs: 0,
				maxDepth: 2,
				maxSessionsPerRun: 0,
				maxAgentsPerLead: 0,
			},
			worktrees: { baseDir: "" },
			taskTracker: { backend: "auto", enabled: false },
			mulch: { enabled: false, domains: [], primeFormat: "markdown" },
			merge: { aiResolveEnabled: false, reimagineEnabled: false },
			providers: {},
			watchdog: {
				tier0Enabled: false,
				tier0IntervalMs: 30000,
				tier1Enabled: false,
				tier2Enabled: false,
				staleThresholdMs: 0,
				zombieThresholdMs: 0,
				nudgeIntervalMs: 60000,
			},
			models: {},
			logging: { verbose: false, redactSecrets: false },
			mission: { graphExecution: true },
		});
		expect(result).toBe(true);
	});
});

// === CELL_REGISTRY ===

describe("CELL_REGISTRY", () => {
	test("contains plan-review entry", () => {
		expect(CELL_REGISTRY["plan-review"]).toBeDefined();
	});

	test("contains architecture-review entry", () => {
		expect(CELL_REGISTRY["architecture-review"]).toBeDefined();
	});

	test("plan-review graph is valid", () => {
		const cell = CELL_REGISTRY["plan-review"];
		if (!cell) throw new Error("plan-review not in registry");
		const graph = cell.buildSubgraph({ tier: "full", maxRounds: 3, artifactRoot: "" });
		const result = validateGraph(graph, { startNodeId: "plan-review:dispatch-critics" });
		expect(result.valid).toBe(true);
	});

	test("architecture-review graph is valid", () => {
		const cell = CELL_REGISTRY["architecture-review"];
		if (!cell) throw new Error("architecture-review not in registry");
		const graph = cell.buildSubgraph({ tier: "full", maxRounds: 3, artifactRoot: "" });
		const result = validateGraph(graph, { startNodeId: "arch-review:dispatch-critics" });
		expect(result.valid).toBe(true);
	});
});

// === startCellEngine ===

describe("startCellEngine", () => {
	test("throws for unknown cell type", async () => {
		const deps = makeDeps();
		await expect(startCellEngine(baseMission, "unknown-cell", deps)).rejects.toThrow(
			"Unknown cell type",
		);
	});

	test("creates and runs engine for plan-review — stops at async gate", async () => {
		const deps = makeDeps();
		const result = await startCellEngine(baseMission, "plan-review", deps);
		// Engine should run: dispatch-critics (handler) → collect-verdicts (gate:async) → stop
		expect(result.status).toBe("gate");
		expect(result.gateType).toBe("async");
		expect(result.currentNodeId).toBe("plan-review:collect-verdicts");
	});

	test("creates and runs engine for architecture-review — stops at async gate", async () => {
		const deps = makeDeps();
		const result = await startCellEngine(baseMission, "architecture-review", deps);
		expect(result.status).toBe("gate");
		expect(result.gateType).toBe("async");
		expect(result.currentNodeId).toBe("arch-review:collect-verdicts");
	});

	test("idempotent: calling startCellEngine again resumes from checkpoint, not re-dispatch", async () => {
		const checkpointStore = createMockCheckpointStore();
		const missionStore = createMockMissionStore();
		const deps: EngineDeps = { checkpointStore, missionStore };

		// First call: runs from dispatch-critics → collect-verdicts (gate)
		const first = await startCellEngine(baseMission, "plan-review", deps);
		expect(first.currentNodeId).toBe("plan-review:collect-verdicts");

		// Second call with same checkpointStore: engine resumes from checkpoint
		// Should still be gated at collect-verdicts (not re-dispatch)
		const second = await startCellEngine(baseMission, "plan-review", deps);
		expect(second.status).toBe("gate");
		expect(second.currentNodeId).toBe("plan-review:collect-verdicts");
	});
});

// === advanceCellGate ===

describe("advanceCellGate", () => {
	test("returns error when no checkpoint exists", async () => {
		const deps = makeDeps();
		const result = await advanceCellGate(baseMission, "all-returned", null, deps);
		expect(result.status).toBe("error");
		expect(result.error).toContain("No checkpoint");
	});

	test("advances gate and continues execution", async () => {
		const checkpointStore = createMockCheckpointStore();
		const missionStore = createMockMissionStore();
		const deps: EngineDeps = { checkpointStore, missionStore };

		// Start engine — stops at collect-verdicts gate
		await startCellEngine(baseMission, "plan-review", deps);

		// Advance with 'verdicts-collected' — convergence handler returns approved → approved (terminal)
		const result = await advanceCellGate(baseMission, "verdicts-collected", null, deps);
		expect(result.status).toBe("completed");
		expect(result.currentNodeId).toBe("plan-review:approved");
	});

	test("errors when current node is not a gate node", async () => {
		const checkpointStore = createMockCheckpointStore();
		const missionStore = createMockMissionStore();
		const deps: EngineDeps = { checkpointStore, missionStore };

		// Place checkpoint at convergence (not a gate node)
		checkpointStore.saveCheckpoint(baseMission.id, "plan-review:convergence", null);

		// advanceNode requires current node to be gate — convergence is not, so error
		const result = await advanceCellGate(baseMission, "revision-needed", null, deps);
		expect(result.status).toBe("error");
		expect(result.error).toContain("not a gate node");
	});
});

// === getCellEngineStatus ===

describe("getCellEngineStatus", () => {
	test("returns null when no checkpoint exists", () => {
		const deps = makeDeps();
		const result = getCellEngineStatus(baseMission, deps);
		expect(result).toBeNull();
	});

	test("returns status when checkpoint exists", async () => {
		const checkpointStore = createMockCheckpointStore();
		const missionStore = createMockMissionStore();
		const deps: EngineDeps = { checkpointStore, missionStore };

		await startCellEngine(baseMission, "plan-review", deps);

		const status = getCellEngineStatus(baseMission, deps);
		expect(status).not.toBeNull();
		if (!status) throw new Error("expected status to be non-null");
		expect(status.cellType).toBe("plan-review");
		expect(status.currentNodeId).toBe("plan-review:collect-verdicts");
		expect(Array.isArray(status.transitions)).toBe(true);
	});

	test("transitions are recorded in status", async () => {
		const checkpointStore = createMockCheckpointStore();
		const missionStore = createMockMissionStore();
		const deps: EngineDeps = { checkpointStore, missionStore };

		await startCellEngine(baseMission, "plan-review", deps);

		const status = getCellEngineStatus(baseMission, deps);
		if (!status) throw new Error("expected status to be non-null");
		expect(status.transitions.length).toBeGreaterThanOrEqual(1);
		expect(status.transitions[0]).toHaveProperty("fromNode");
		expect(status.transitions[0]).toHaveProperty("toNode");
		expect(status.transitions[0]).toHaveProperty("trigger");
		expect(status.transitions[0]).toHaveProperty("createdAt");
	});
});
