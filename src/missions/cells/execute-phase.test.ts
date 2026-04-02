import { describe, expect, test } from "bun:test";
import { validateGraph } from "../graph.ts";
import { executePhaseCell } from "./execute-phase.ts";
import type { PhaseCellConfig } from "./types.ts";

const config: PhaseCellConfig = {
	missionId: "m1",
	artifactRoot: "/tmp/artifacts",
	projectRoot: "/tmp/project",
};

describe("executePhaseCell.buildSubgraph", () => {
	const graph = executePhaseCell.buildSubgraph(config);

	test("produces a valid graph", () => {
		const result = validateGraph(graph, { startNodeId: "execute-phase:ensure-ed" });
		expect(result.valid).toBe(true);
	});

	test("all nodes prefixed with execute-phase:", () => {
		for (const node of graph.nodes) {
			expect(node.id).toStartWith("execute-phase:");
		}
	});

	test("await-ws-completion has gate: async", () => {
		const node = graph.nodes.find((n) => n.id === "execute-phase:await-ws-completion");
		expect(node).toBeDefined();
		expect(node!.gate).toBe("async");
	});

	test("dispatch-ready node exists", () => {
		const node = graph.nodes.find((n) => n.id === "execute-phase:dispatch-ready");
		expect(node).toBeDefined();
	});
});
