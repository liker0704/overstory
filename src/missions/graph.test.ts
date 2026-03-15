import { describe, expect, test } from "bun:test";
import {
	DEFAULT_MISSION_GRAPH,
	findCurrentNode,
	getAvailableTransitions,
	nodeId,
	parseNodeId,
	renderGraphPosition,
	toMermaid,
	validateGraph,
	validateTransition,
} from "./graph.ts";

describe("nodeId / parseNodeId", () => {
	test("nodeId builds correct ID", () => {
		expect(nodeId("understand", "active")).toBe("understand:active");
		expect(nodeId("done", "completed")).toBe("done:completed");
	});

	test("parseNodeId roundtrips", () => {
		const result = parseNodeId("plan:frozen");
		expect(result).toEqual({ phase: "plan", state: "frozen" });
	});

	test("parseNodeId returns undefined for invalid format", () => {
		expect(parseNodeId("invalid")).toBeUndefined();
		expect(parseNodeId("a:b:c")).toBeUndefined();
	});

	test("parseNodeId returns undefined for invalid phase/state values", () => {
		expect(parseNodeId("garbage:active")).toBeUndefined();
		expect(parseNodeId("understand:garbage")).toBeUndefined();
		expect(parseNodeId("foo:bar")).toBeUndefined();
	});
});

describe("DEFAULT_MISSION_GRAPH", () => {
	test("has version 1", () => {
		expect(DEFAULT_MISSION_GRAPH.version).toBe(1);
	});

	test("has nodes for all working phases", () => {
		const phases = ["understand", "align", "decide", "plan", "execute"];
		for (const phase of phases) {
			expect(DEFAULT_MISSION_GRAPH.nodes.find((n) => n.id === `${phase}:active`)).toBeDefined();
			expect(DEFAULT_MISSION_GRAPH.nodes.find((n) => n.id === `${phase}:frozen`)).toBeDefined();
			expect(DEFAULT_MISSION_GRAPH.nodes.find((n) => n.id === `${phase}:suspended`)).toBeDefined();
		}
	});

	test("has terminal nodes", () => {
		const terminals = DEFAULT_MISSION_GRAPH.nodes.filter((n) => n.terminal);
		expect(terminals.length).toBeGreaterThanOrEqual(3);
		expect(terminals.find((n) => n.id === "done:completed")).toBeDefined();
		expect(terminals.find((n) => n.id === "done:stopped")).toBeDefined();
		expect(terminals.find((n) => n.id === "done:failed")).toBeDefined();
	});

	test("frozen nodes are marked as human gates", () => {
		const frozen = DEFAULT_MISSION_GRAPH.nodes.filter((n) => n.id.endsWith(":frozen"));
		for (const node of frozen) {
			expect(node.gate).toBe("human");
		}
	});
});

describe("validateGraph", () => {
	test("default graph is valid", () => {
		const result = validateGraph(DEFAULT_MISSION_GRAPH);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	test("detects orphan edge targets", () => {
		const graph = {
			...DEFAULT_MISSION_GRAPH,
			edges: [
				...DEFAULT_MISSION_GRAPH.edges,
				{ from: "understand:active", to: "nonexistent", trigger: "bad" },
			],
		};
		const result = validateGraph(graph);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("nonexistent"))).toBe(true);
	});

	test("detects unreachable nodes", () => {
		const graph = {
			...DEFAULT_MISSION_GRAPH,
			nodes: [
				...DEFAULT_MISSION_GRAPH.nodes,
				{
					id: "orphan:active",
					phase: "understand" as const,
					state: "active" as const,
				},
			],
		};
		const result = validateGraph(graph);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("orphan:active"))).toBe(true);
	});
});

describe("validateTransition", () => {
	test("legal: understand:active → understand:frozen (freeze)", () => {
		const result = validateTransition(
			DEFAULT_MISSION_GRAPH,
			"understand",
			"active",
			"understand",
			"frozen",
		);
		expect(result.valid).toBe(true);
		expect(result.edge?.trigger).toBe("freeze");
	});

	test("legal: understand:frozen → understand:active (answer)", () => {
		const result = validateTransition(
			DEFAULT_MISSION_GRAPH,
			"understand",
			"frozen",
			"understand",
			"active",
		);
		expect(result.valid).toBe(true);
		expect(result.edge?.trigger).toBe("answer");
	});

	test("legal: understand:active → align:active (phase_advance)", () => {
		const result = validateTransition(
			DEFAULT_MISSION_GRAPH,
			"understand",
			"active",
			"align",
			"active",
		);
		expect(result.valid).toBe(true);
		expect(result.edge?.trigger).toBe("phase_advance");
	});

	test("legal: plan:active → execute:active (handoff)", () => {
		const result = validateTransition(DEFAULT_MISSION_GRAPH, "plan", "active", "execute", "active");
		expect(result.valid).toBe(true);
		expect(result.edge?.trigger).toBe("handoff");
	});

	test("legal: execute:active → done:completed (complete)", () => {
		const result = validateTransition(
			DEFAULT_MISSION_GRAPH,
			"execute",
			"active",
			"done",
			"completed",
		);
		expect(result.valid).toBe(true);
		expect(result.edge?.trigger).toBe("complete");
	});

	test("legal: any active → stopped (stop)", () => {
		for (const phase of ["understand", "align", "decide", "plan", "execute"] as const) {
			const result = validateTransition(DEFAULT_MISSION_GRAPH, phase, "active", "done", "stopped");
			expect(result.valid).toBe(true);
			expect(result.edge?.trigger).toBe("stop");
		}
	});

	test("legal: any active → suspended (suspend)", () => {
		for (const phase of ["understand", "align", "decide", "plan", "execute"] as const) {
			const result = validateTransition(DEFAULT_MISSION_GRAPH, phase, "active", phase, "suspended");
			expect(result.valid).toBe(true);
			expect(result.edge?.trigger).toBe("suspend");
		}
	});

	test("legal: suspended → active (resume)", () => {
		for (const phase of ["understand", "align", "decide", "plan", "execute"] as const) {
			const result = validateTransition(DEFAULT_MISSION_GRAPH, phase, "suspended", phase, "active");
			expect(result.valid).toBe(true);
			expect(result.edge?.trigger).toBe("resume");
		}
	});

	test("illegal: understand:active → execute:active (skip phases)", () => {
		const result = validateTransition(
			DEFAULT_MISSION_GRAPH,
			"understand",
			"active",
			"execute",
			"active",
		);
		expect(result.valid).toBe(false);
		expect(result.reason).toContain("No edge");
	});

	test("illegal: done:completed → understand:active (leave terminal)", () => {
		const result = validateTransition(
			DEFAULT_MISSION_GRAPH,
			"done",
			"completed",
			"understand",
			"active",
		);
		expect(result.valid).toBe(false);
	});
});

describe("findCurrentNode", () => {
	test("finds existing node", () => {
		const node = findCurrentNode(DEFAULT_MISSION_GRAPH, "plan", "active");
		expect(node).toBeDefined();
		expect(node?.id).toBe("plan:active");
	});

	test("returns undefined for nonexistent", () => {
		const node = findCurrentNode(DEFAULT_MISSION_GRAPH, "done", "active");
		expect(node).toBeUndefined();
	});
});

describe("getAvailableTransitions", () => {
	test("understand:active has freeze, phase_advance, suspend, stop, fail edges", () => {
		const edges = getAvailableTransitions(DEFAULT_MISSION_GRAPH, "understand", "active");
		const triggers = edges.map((e) => e.trigger);
		expect(triggers).toContain("freeze");
		expect(triggers).toContain("phase_advance");
		expect(triggers).toContain("suspend");
		expect(triggers).toContain("stop");
		expect(triggers).toContain("fail");
	});

	test("understand:frozen has answer, suspend, stop edges", () => {
		const edges = getAvailableTransitions(DEFAULT_MISSION_GRAPH, "understand", "frozen");
		const triggers = edges.map((e) => e.trigger);
		expect(triggers).toContain("answer");
		expect(triggers).toContain("suspend");
		expect(triggers).toContain("stop");
	});

	test("terminal nodes have no outgoing edges", () => {
		const edges = getAvailableTransitions(DEFAULT_MISSION_GRAPH, "done", "completed");
		expect(edges).toEqual([]);
	});

	test("higher weight edges come first", () => {
		const edges = getAvailableTransitions(DEFAULT_MISSION_GRAPH, "understand", "active");
		const weighted = edges.filter((e) => e.weight !== undefined && e.weight > 0);
		expect(weighted.length).toBeGreaterThan(0);
		expect(edges[0]?.trigger).toBe("phase_advance"); // weight: 10
	});
});

describe("renderGraphPosition", () => {
	test("highlights current phase", () => {
		const output = renderGraphPosition(DEFAULT_MISSION_GRAPH, "plan", "active");
		expect(output).toContain("[plan]");
		expect(output).not.toContain("[understand]");
	});

	test("shows frozen annotation", () => {
		const output = renderGraphPosition(DEFAULT_MISSION_GRAPH, "align", "frozen");
		expect(output).toContain("[align]");
		expect(output).toContain("frozen");
	});

	test("shows suspended annotation", () => {
		const output = renderGraphPosition(DEFAULT_MISSION_GRAPH, "execute", "suspended");
		expect(output).toContain("[execute]");
		expect(output).toContain("suspended");
	});
});

describe("toMermaid", () => {
	test("outputs valid mermaid header", () => {
		const output = toMermaid(DEFAULT_MISSION_GRAPH);
		expect(output).toStartWith("graph LR");
	});

	test("highlights current node with style", () => {
		const output = toMermaid(DEFAULT_MISSION_GRAPH, "plan", "active");
		expect(output).toContain("style plan_active");
	});

	test("contains edges with triggers", () => {
		const output = toMermaid(DEFAULT_MISSION_GRAPH);
		expect(output).toContain("-->|freeze|");
		expect(output).toContain("-->|phase_advance|");
	});
});
