/**
 * Tests for the plan-review cell definition.
 *
 * Follows the same mock patterns as engine-wiring.test.ts.
 */

import { describe, expect, test } from "bun:test";
import type { PlanCriticVerdictPayload } from "../../types.ts";
import { validateGraph } from "../graph.ts";
import { createMockCheckpointStore, createMockMissionStore } from "../test-mocks.ts";
import type { HandlerContext } from "../types.ts";
import { guardBriefPath, planReviewCell, validateVerdictSender } from "./plan-review.ts";
import type { ReviewCellConfig, ReviewCellDeps } from "./types.ts";

// Mock stores imported from test-mocks.ts

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
