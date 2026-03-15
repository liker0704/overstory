/**
 * Declarative workflow graph for the mission lifecycle.
 *
 * Phase 1 (current): passive advisory layer — validates transitions, renders position.
 * Phase 2 (future): active execution — nodes gain handlers, engine traverses graph.
 */

import {
	type GraphTransitionResult,
	MISSION_PHASES,
	MISSION_STATES,
	type MissionGraph,
	type MissionGraphEdge,
	type MissionGraphNode,
	type MissionPhase,
	type MissionState,
} from "../types.ts";

// === Node ID helpers ===

/** Build a node ID from phase + state. */
export function nodeId(phase: MissionPhase, state: MissionState): string {
	return `${phase}:${state}`;
}

const VALID_PHASES = new Set<string>(MISSION_PHASES);
const VALID_STATES = new Set<string>(MISSION_STATES);

/** Parse a node ID back into phase + state. Returns undefined if format is invalid. */
export function parseNodeId(id: string): { phase: MissionPhase; state: MissionState } | undefined {
	const parts = id.split(":");
	if (parts.length !== 2) return undefined;
	const [phase, state] = parts;
	if (!phase || !state || !VALID_PHASES.has(phase) || !VALID_STATES.has(state)) return undefined;
	return { phase: phase as MissionPhase, state: state as MissionState };
}

// === Default Mission Lifecycle Graph ===

function buildDefaultGraph(): MissionGraph {
	const nodes: MissionGraphNode[] = [];
	const edges: MissionGraphEdge[] = [];

	// Build active + frozen nodes for each working phase
	const workingPhases: MissionPhase[] = ["understand", "align", "decide", "plan", "execute"];
	for (const phase of workingPhases) {
		nodes.push({
			id: nodeId(phase, "active"),
			phase,
			state: "active",
			label: `${phase} (active)`,
		});
		nodes.push({
			id: nodeId(phase, "frozen"),
			phase,
			state: "frozen",
			label: `${phase} (frozen)`,
			gate: "human",
		});

		// Freeze / unfreeze edges within each phase
		edges.push({
			from: nodeId(phase, "active"),
			to: nodeId(phase, "frozen"),
			trigger: "freeze",
		});
		edges.push({
			from: nodeId(phase, "frozen"),
			to: nodeId(phase, "active"),
			trigger: "answer",
		});

		// Suspend edges (active/frozen → suspended)
		edges.push({
			from: nodeId(phase, "active"),
			to: nodeId(phase, "suspended"),
			trigger: "suspend",
		});
		edges.push({
			from: nodeId(phase, "frozen"),
			to: nodeId(phase, "suspended"),
			trigger: "suspend",
		});

		// Suspended node + resume edge
		nodes.push({
			id: nodeId(phase, "suspended"),
			phase,
			state: "suspended",
			label: `${phase} (suspended)`,
		});
		edges.push({
			from: nodeId(phase, "suspended"),
			to: nodeId(phase, "active"),
			trigger: "resume",
		});

		// Stop edges (active/frozen → done:stopped)
		edges.push({
			from: nodeId(phase, "active"),
			to: nodeId("done", "stopped"),
			trigger: "stop",
		});
		edges.push({
			from: nodeId(phase, "frozen"),
			to: nodeId("done", "stopped"),
			trigger: "stop",
		});

		// Fail edges (active → done:failed)
		edges.push({
			from: nodeId(phase, "active"),
			to: nodeId("done", "failed"),
			trigger: "fail",
		});
	}

	// Phase advance edges (active → next phase active)
	for (let i = 0; i < workingPhases.length - 1; i++) {
		const from = workingPhases[i]!;
		const to = workingPhases[i + 1]!;
		const trigger = from === "plan" && to === "execute" ? "handoff" : "phase_advance";
		edges.push({
			from: nodeId(from, "active"),
			to: nodeId(to, "active"),
			trigger,
			weight: 10,
		});
	}

	// Terminal: done:completed
	nodes.push({
		id: nodeId("done", "completed"),
		phase: "done",
		state: "completed",
		label: "done",
		terminal: true,
	});
	edges.push({
		from: nodeId("execute", "active"),
		to: nodeId("done", "completed"),
		trigger: "complete",
		weight: 10,
	});

	// Terminal: done:stopped
	nodes.push({
		id: nodeId("done", "stopped"),
		phase: "done",
		state: "stopped",
		label: "stopped",
		terminal: true,
	});

	// Terminal: done:failed
	nodes.push({
		id: nodeId("done", "failed"),
		phase: "done",
		state: "failed",
		label: "failed",
		terminal: true,
	});

	return { version: 1, nodes, edges };
}

/** The canonical mission lifecycle graph. */
export const DEFAULT_MISSION_GRAPH: MissionGraph = buildDefaultGraph();

// === Graph queries ===

/** Find the node matching a phase + state. */
export function findCurrentNode(
	graph: MissionGraph,
	phase: MissionPhase,
	state: MissionState,
): MissionGraphNode | undefined {
	const id = nodeId(phase, state);
	return graph.nodes.find((n) => n.id === id);
}

/** Get all edges leaving the given node. */
export function getAvailableTransitions(
	graph: MissionGraph,
	phase: MissionPhase,
	state: MissionState,
): MissionGraphEdge[] {
	const id = nodeId(phase, state);
	return graph.edges.filter((e) => e.from === id).sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
}

/** Validate whether a transition from one (phase, state) to another is legal. */
export function validateTransition(
	graph: MissionGraph,
	fromPhase: MissionPhase,
	fromState: MissionState,
	toPhase: MissionPhase,
	toState: MissionState,
): GraphTransitionResult {
	const fromId = nodeId(fromPhase, fromState);
	const toId = nodeId(toPhase, toState);

	const edge = graph.edges.find((e) => e.from === fromId && e.to === toId);

	if (edge) {
		return {
			valid: true,
			edge,
			reason: `Legal transition via '${edge.trigger}'`,
		};
	}

	return {
		valid: false,
		edge: null,
		reason: `No edge from ${fromId} to ${toId} in workflow graph`,
	};
}

// === Graph validation (static lint) ===

/** Validate graph structure. Returns errors if any. */
export function validateGraph(graph: MissionGraph): { valid: boolean; errors: string[] } {
	const errors: string[] = [];
	const nodeIds = new Set(graph.nodes.map((n) => n.id));

	// Check all edge sources/targets reference existing nodes
	for (const edge of graph.edges) {
		if (!nodeIds.has(edge.from)) {
			errors.push(`Edge source '${edge.from}' not found in nodes`);
		}
		if (!nodeIds.has(edge.to)) {
			errors.push(`Edge target '${edge.to}' not found in nodes`);
		}
	}

	// Check at least one terminal node exists
	const terminals = graph.nodes.filter((n) => n.terminal);
	if (terminals.length === 0) {
		errors.push("No terminal nodes found");
	}

	// Check for unreachable nodes (simple BFS from understand:active)
	const startId = nodeId("understand", "active");
	if (!nodeIds.has(startId)) {
		errors.push(`Start node '${startId}' not found`);
	} else {
		const reachable = new Set<string>();
		const queue = [startId];
		while (queue.length > 0) {
			const current = queue.shift()!;
			if (reachable.has(current)) continue;
			reachable.add(current);
			for (const edge of graph.edges) {
				if (edge.from === current && !reachable.has(edge.to)) {
					queue.push(edge.to);
				}
			}
		}
		for (const node of graph.nodes) {
			if (!reachable.has(node.id)) {
				errors.push(`Node '${node.id}' is unreachable from start`);
			}
		}
	}

	return { valid: errors.length === 0, errors };
}

// === Rendering ===

/**
 * Render a compact ASCII representation of the mission graph position.
 *
 * Example:
 *   understand → align → decide → plan → [execute] → done
 *                                          ↕ frozen
 */
export function renderGraphPosition(
	_graph: MissionGraph,
	currentPhase: MissionPhase,
	currentState: MissionState,
): string {
	const phaseLabels = MISSION_PHASES.map((p) => {
		if (p === currentPhase) {
			return `[${p}]`;
		}
		return p;
	});

	const mainLine = phaseLabels.join(" → ");

	// Show state detail for current phase if not just "active"
	const stateAnnotations: string[] = [];
	if (currentState === "frozen") {
		stateAnnotations.push("↕ frozen (awaiting user input)");
	} else if (currentState === "suspended") {
		stateAnnotations.push("⏸ suspended");
	}

	// Indent annotation under the current phase position
	if (stateAnnotations.length > 0) {
		const beforeCurrent = MISSION_PHASES.slice(0, MISSION_PHASES.indexOf(currentPhase))
			.map((p) => p.length + 4) // "phase → "
			.reduce((sum, len) => sum + len, 0);
		const padding = " ".repeat(beforeCurrent + 1); // +1 for the bracket
		return `${mainLine}\n${padding}${stateAnnotations.join(" ")}`;
	}

	return mainLine;
}

/**
 * Render the graph as a Mermaid diagram string.
 * Highlights the current node if phase/state are provided.
 */
export function toMermaid(
	graph: MissionGraph,
	currentPhase?: MissionPhase,
	currentState?: MissionState,
): string {
	const lines: string[] = ["graph LR"];
	const currentId = currentPhase && currentState ? nodeId(currentPhase, currentState) : undefined;

	// Mermaid-safe ID (replace : with _)
	const safeId = (id: string) => id.replace(/:/g, "_");

	// Render nodes
	for (const node of graph.nodes) {
		const sid = safeId(node.id);
		const label = node.label ?? node.id;
		if (node.terminal) {
			lines.push(`    ${sid}([${label}])`);
		} else if (node.gate === "human") {
			lines.push(`    ${sid}{${label}}`);
		} else {
			lines.push(`    ${sid}[${label}]`);
		}
	}

	// Render edges
	for (const edge of graph.edges) {
		const from = safeId(edge.from);
		const to = safeId(edge.to);
		lines.push(`    ${from} -->|${edge.trigger}| ${to}`);
	}

	// Highlight current node
	if (currentId) {
		lines.push(`    style ${safeId(currentId)} fill:#f96,stroke:#333,stroke-width:3px`);
	}

	return lines.join("\n");
}
