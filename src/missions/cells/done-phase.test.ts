import { describe, expect, test } from "bun:test";
import { validateGraph } from "../graph.ts";
import { donePhaseCell } from "./done-phase.ts";
import type { PhaseCellConfig } from "./types.ts";

const config: PhaseCellConfig = {
	missionId: "m1",
	artifactRoot: "/tmp/artifacts",
	projectRoot: "/tmp/project",
};

describe("donePhaseCell.buildSubgraph", () => {
	const graph = donePhaseCell.buildSubgraph(config);

	test("produces a valid graph", () => {
		const result = validateGraph(graph, { startNodeId: "done-phase:summary" });
		expect(result.valid).toBe(true);
	});

	test("all nodes prefixed with done-phase:", () => {
		for (const node of graph.nodes) {
			expect(node.id).toStartWith("done-phase:");
		}
	});

	test("summary has gate: async", () => {
		const node = graph.nodes.find((n) => n.id === "done-phase:summary");
		expect(node).toBeDefined();
		expect(node!.gate).toBe("async");
	});
});
