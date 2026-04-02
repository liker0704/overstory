import { describe, expect, test } from "bun:test";
import { validateGraph } from "../graph.ts";
import { createMockCheckpointStore, createMockMissionStore } from "../test-mocks.ts";
import { understandPhaseCell } from "./understand-phase.ts";
import type { PhaseCellConfig, PhaseCellDeps } from "./types.ts";

const config: PhaseCellConfig = {
	missionId: "m1",
	artifactRoot: "/tmp/artifacts",
	projectRoot: "/tmp/project",
};

function makeDeps(): PhaseCellDeps {
	return {
		mailSend: async () => {},
		checkpointStore: createMockCheckpointStore(),
		missionStore: createMockMissionStore(),
	};
}

describe("understandPhaseCell.buildSubgraph", () => {
	const graph = understandPhaseCell.buildSubgraph(config);

	test("produces a valid graph", () => {
		const result = validateGraph(graph, { startNodeId: "understand-phase:ensure-coordinator" });
		expect(result.valid).toBe(true);
	});

	test("all nodes prefixed with understand-phase:", () => {
		for (const node of graph.nodes) {
			expect(node.id).toStartWith("understand-phase:");
		}
	});

	test("await-research has gate: async", () => {
		const node = graph.nodes.find((n) => n.id === "understand-phase:await-research");
		expect(node).toBeDefined();
		expect(node!.gate).toBe("async");
	});

	test("evaluate has gate: async", () => {
		const node = graph.nodes.find((n) => n.id === "understand-phase:evaluate");
		expect(node).toBeDefined();
		expect(node!.gate).toBe("async");
	});

	test("frozen has gate: human", () => {
		const node = graph.nodes.find((n) => n.id === "understand-phase:frozen");
		expect(node).toBeDefined();
		expect(node!.gate).toBe("human");
	});
});

describe("understandPhaseCell.buildHandlers", () => {
	test("ensure-coordinator handler returns coordinator_ready", async () => {
		const handlers = understandPhaseCell.buildHandlers(makeDeps());
		const handler = handlers["ensure-coordinator"];
		expect(handler).toBeDefined();
		const result = await handler!({ getMission: () => null, checkpoint: null } as never);
		expect(result.trigger).toBe("coordinator_ready");
	});
});
