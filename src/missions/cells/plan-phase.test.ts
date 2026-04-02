import { describe, expect, test } from "bun:test";
import { validateGraph } from "../graph.ts";
import { planPhaseCell } from "./plan-phase.ts";
import type { PhaseCellConfig } from "./types.ts";

const config: PhaseCellConfig = {
	missionId: "m1",
	artifactRoot: "/tmp/artifacts",
	projectRoot: "/tmp/project",
};

describe("planPhaseCell.buildSubgraph", () => {
	const graph = planPhaseCell.buildSubgraph(config);

	test("produces a valid graph", () => {
		const result = validateGraph(graph, { startNodeId: "plan-phase:dispatch-planning" });
		expect(result.valid).toBe(true);
	});

	test("all nodes prefixed with plan-phase:", () => {
		for (const node of graph.nodes) {
			expect(node.id).toStartWith("plan-phase:");
		}
	});

	test("await-plan has gate: async", () => {
		const node = graph.nodes.find((n) => n.id === "plan-phase:await-plan");
		expect(node).toBeDefined();
		expect(node!.gate).toBe("async");
	});
});
