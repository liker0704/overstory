/**
 * Tests for the plan-review cell definition.
 *
 * Follows the same mock patterns as engine-wiring.test.ts.
 */

import { describe, expect, test } from "bun:test";
import type { CheckpointStore, MissionStore, PlanCriticVerdictPayload } from "../../types.ts";
import { validateGraph } from "../graph.ts";
import type { HandlerContext } from "../types.ts";
import { guardBriefPath, planReviewCell, validateVerdictSender } from "./plan-review.ts";
import type { ReviewCellConfig, ReviewCellDeps } from "./types.ts";

// === Mock stores (same pattern as engine-wiring.test.ts) ===

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
			hasEmittedWsProducerWrite: false,
			tier: null,
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
			hasEmittedWsProducerWrite: false,
			tier: null,
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
		markProducerWritten: noop,
		areAllWorkstreamsDone: () => false,
		checkpoints: createMockCheckpointStore(),
		acquireTickLock: () => true,
		releaseTickLock: noop,
		ensureGateState: () => ({
			entered_at: new Date().toISOString(),
			nudge_count: 0,
			last_nudge_at: null,
			respawn_count: 0,
			grace_ms: 120000,
			nudge_interval_ms: 60000,
			max_nudges: 3,
			max_total_wait_ms: 3600000,
			resolved_at: null,
			ceiling_emitted_at: null,
		}),
		incrementNudgeCount: noop,
		markCeilingEmitted: noop,
		resolveGate: noop,
		updateWorkstreamStatus: noop,
		transaction: <T>(fn: () => T): T => fn(),
		updateTier: noop,
		clearGateStates: noop,
		clearCheckpoints: noop,
		close: noop,
	};
}

const defaultConfig: ReviewCellConfig = {
	tier: "full",
	maxRounds: 3,
	artifactRoot: "/tmp/test-artifacts",
};

function makeDeps(overrides?: Partial<ReviewCellDeps>): ReviewCellDeps {
	const mailSent: Array<{ to: string; subject: string; body: string; type: string }> = [];
	return {
		mailSend: async (to, subject, body, type) => {
			mailSent.push({ to, subject, body, type });
		},
		checkpointStore: createMockCheckpointStore(),
		missionStore: createMockMissionStore(),
		...overrides,
	};
}

function makeHandlerCtx(
	overrides?: Partial<HandlerContext>,
): HandlerContext & { saved: unknown[] } {
	const saved: unknown[] = [];
	return {
		missionId: "mission-test-1",
		nodeId: "plan-review:dispatch-critics",
		checkpoint: null,
		saveCheckpoint: async (data) => {
			saved.push(data);
		},
		sendMail: async () => {},
		getMission: () => null,
		saved,
		...overrides,
	};
}

// === Graph structure tests ===

describe("planReviewCell.buildSubgraph", () => {
	test("validates via validateGraph with plan-review:dispatch-critics as start", () => {
		const graph = planReviewCell.buildSubgraph(defaultConfig);
		const result = validateGraph(graph, { startNodeId: "plan-review:dispatch-critics" });
		expect(result.valid).toBe(true);
	});

	test("all node IDs prefixed with plan-review:", () => {
		const graph = planReviewCell.buildSubgraph(defaultConfig);
		for (const node of graph.nodes) {
			expect(node.id.startsWith("plan-review:")).toBe(true);
		}
	});

	test("collect-verdicts node has gate: async and gateTimeout: 600", () => {
		const graph = planReviewCell.buildSubgraph(defaultConfig);
		const node = graph.nodes.find((n) => n.id === "plan-review:collect-verdicts");
		expect(node).toBeDefined();
		if (!node || node.kind !== "cell") throw new Error("expected cell node");
		expect(node.gate).toBe("async");
		expect(node.gateTimeout).toBe(600);
	});

	test("collect-verdicts has onTimeout: timeout-escalate", () => {
		const graph = planReviewCell.buildSubgraph(defaultConfig);
		const node = graph.nodes.find((n) => n.id === "plan-review:collect-verdicts");
		if (!node || node.kind !== "cell") throw new Error("expected cell node");
		expect(node.onTimeout).toBe("timeout-escalate");
	});

	test("approved and escalate nodes are terminal", () => {
		const graph = planReviewCell.buildSubgraph(defaultConfig);
		const approved = graph.nodes.find((n) => n.id === "plan-review:approved");
		const escalate = graph.nodes.find((n) => n.id === "plan-review:escalate");
		expect(approved?.terminal).toBe(true);
		expect(escalate?.terminal).toBe(true);
	});
});

// === Idempotent dispatch tests ===

describe("dispatch-critics handler (idempotent dispatch)", () => {
	test("first call saves checkpoint and returns dispatched", async () => {
		const deps = makeDeps();
		const handlers = planReviewCell.buildHandlers(deps);
		const handler = handlers["dispatch-critics"];
		if (!handler) throw new Error("dispatch-critics handler not found");

		const ctx = makeHandlerCtx();
		const result = await handler(ctx);

		expect(result.trigger).toBe("dispatched");
		expect(ctx.saved.length).toBe(1);
		const saved = ctx.saved[0] as Record<string, unknown>;
		expect(saved.dispatched).toBe(true);
		expect(saved.round).toBe(1);
	});

	test("second call with checkpoint.dispatched=true skips re-dispatch", async () => {
		const deps = makeDeps();
		const handlers = planReviewCell.buildHandlers(deps);
		const handler = handlers["dispatch-critics"];
		if (!handler) throw new Error("dispatch-critics handler not found");

		// First call
		const ctx1 = makeHandlerCtx();
		await handler(ctx1);

		// Second call with same checkpoint (dispatched=true)
		const ctx2 = makeHandlerCtx({
			checkpoint: { dispatched: true, round: 1, agents: ["agent-1"] },
		});
		const result = await handler(ctx2);

		expect(result.trigger).toBe("dispatched");
		// Should NOT save new checkpoint (already dispatched)
		expect(ctx2.saved.length).toBe(0);
	});
});

// === Convergence handler tests ===

describe("convergence handler", () => {
	function makeApproveVerdict(): PlanCriticVerdictPayload {
		return {
			criticType: "devil-advocate",
			verdict: "APPROVE",
			concerns: [],
			notes: [],
			round: 1,
			confidence: 0.9,
		};
	}

	function makeBlockVerdict(concernId: string): PlanCriticVerdictPayload {
		return {
			criticType: "security",
			verdict: "BLOCK",
			concerns: [
				{
					id: concernId,
					severity: "high",
					summary: "critical issue",
					detail: "details here",
					affectedWorkstreams: [],
				},
			],
			notes: [],
			round: 1,
			confidence: 0.8,
		};
	}

	function makeRecommendVerdict(): PlanCriticVerdictPayload {
		return {
			criticType: "performance",
			verdict: "RECOMMEND_CHANGES",
			concerns: [
				{
					id: "perf-01",
					severity: "medium",
					summary: "performance issue",
					detail: "details",
					affectedWorkstreams: [],
				},
			],
			notes: [],
			round: 1,
			confidence: 0.7,
		};
	}

	test("all approve verdicts → approved trigger", async () => {
		const deps = makeDeps();
		const handlers = planReviewCell.buildHandlers(deps);
		const handler = handlers["convergence"];
		if (!handler) throw new Error("convergence handler not found");

		const ctx = makeHandlerCtx({
			nodeId: "plan-review:convergence",
			checkpoint: { verdicts: [makeApproveVerdict(), makeApproveVerdict()], round: 1 },
		});
		const result = await handler(ctx);
		expect(result.trigger).toBe("approved");
	});

	test("no verdicts → approved trigger", async () => {
		const deps = makeDeps();
		const handlers = planReviewCell.buildHandlers(deps);
		const handler = handlers["convergence"];
		if (!handler) throw new Error("convergence handler not found");

		const ctx = makeHandlerCtx({ nodeId: "plan-review:convergence", checkpoint: null });
		const result = await handler(ctx);
		expect(result.trigger).toBe("approved");
	});

	test("BLOCK verdict with no previous concerns → revision-needed", async () => {
		const deps = makeDeps();
		const handlers = planReviewCell.buildHandlers(deps);
		const handler = handlers["convergence"];
		if (!handler) throw new Error("convergence handler not found");

		const ctx = makeHandlerCtx({
			nodeId: "plan-review:convergence",
			checkpoint: {
				verdicts: [makeBlockVerdict("sec-01")],
				previousBlockConcerns: [],
				round: 1,
				maxRounds: 3,
			},
		});
		const result = await handler(ctx);
		expect(result.trigger).toBe("revision-needed");
	});

	test("BLOCK verdict with same concern as previous → stuck", async () => {
		const deps = makeDeps();
		const handlers = planReviewCell.buildHandlers(deps);
		const handler = handlers["convergence"];
		if (!handler) throw new Error("convergence handler not found");

		const ctx = makeHandlerCtx({
			nodeId: "plan-review:convergence",
			checkpoint: {
				verdicts: [makeBlockVerdict("sec-01")],
				previousBlockConcerns: ["sec-01"],
				round: 2,
				maxRounds: 3,
			},
		});
		const result = await handler(ctx);
		expect(result.trigger).toBe("stuck");
	});

	test("round >= maxRounds → stuck regardless of concerns", async () => {
		const deps = makeDeps();
		const handlers = planReviewCell.buildHandlers(deps);
		const handler = handlers["convergence"];
		if (!handler) throw new Error("convergence handler not found");

		const ctx = makeHandlerCtx({
			nodeId: "plan-review:convergence",
			checkpoint: {
				verdicts: [makeBlockVerdict("new-concern-99")],
				previousBlockConcerns: [],
				round: 3,
				maxRounds: 3,
			},
		});
		const result = await handler(ctx);
		expect(result.trigger).toBe("stuck");
	});

	test("RECOMMEND_CHANGES verdict → revision-needed", async () => {
		const deps = makeDeps();
		const handlers = planReviewCell.buildHandlers(deps);
		const handler = handlers["convergence"];
		if (!handler) throw new Error("convergence handler not found");

		const ctx = makeHandlerCtx({
			nodeId: "plan-review:convergence",
			checkpoint: {
				verdicts: [makeRecommendVerdict()],
				previousBlockConcerns: [],
				round: 1,
				maxRounds: 3,
			},
		});
		const result = await handler(ctx);
		expect(result.trigger).toBe("revision-needed");
	});
});

// === validateVerdictSender tests ===

describe("validateVerdictSender", () => {
	test("returns true for known sender", () => {
		const checkpoint = {
			dispatched: true,
			round: 1,
			agents: ["plan-devil-advocate", "plan-security"],
		};
		expect(validateVerdictSender("plan-devil-advocate", checkpoint)).toBe(true);
	});

	test("returns false for unknown sender", () => {
		const checkpoint = { dispatched: true, round: 1, agents: ["plan-devil-advocate"] };
		expect(validateVerdictSender("unknown-agent", checkpoint)).toBe(false);
	});

	test("returns false for null checkpoint", () => {
		expect(validateVerdictSender("anyone", null)).toBe(false);
	});

	test("returns false when checkpoint has no agents field", () => {
		expect(validateVerdictSender("plan-devil-advocate", { dispatched: true, round: 1 })).toBe(
			false,
		);
	});
});

// === guardBriefPath tests ===

describe("guardBriefPath", () => {
	const artifactRoot = "/tmp/mission-123/artifacts";

	test("allows path within artifactRoot", () => {
		expect(guardBriefPath("plan/workstream-1.md", artifactRoot)).toBe(true);
	});

	test("allows nested path within artifactRoot", () => {
		expect(guardBriefPath("plan/sub/brief.md", artifactRoot)).toBe(true);
	});

	test("rejects path traversal with ..", () => {
		expect(guardBriefPath("../../etc/passwd", artifactRoot)).toBe(false);
	});

	test("rejects traversal that escapes root via nested ..", () => {
		expect(guardBriefPath("plan/../../etc/shadow", artifactRoot)).toBe(false);
	});

	test("rejects absolute path outside root", () => {
		expect(guardBriefPath("/etc/passwd", artifactRoot)).toBe(false);
	});
});
