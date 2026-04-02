/**
 * Graph execution engine for mission workflow traversal.
 *
 * Traverses a MissionGraph by invoking node handlers, recording transitions,
 * and persisting checkpoints for resumability.
 */

import type {
	CheckpointStore,
	MissionGraph,
	MissionGraphEdge,
	MissionGraphNode,
	MissionStore,
} from "../types.ts";
import type { HandlerContext, HandlerRegistry } from "./types.ts";

// === Engine types ===

export interface GraphEngineOpts {
	/** The workflow graph to execute. */
	graph: MissionGraph;
	/** Handler registry for node execution. */
	handlers: HandlerRegistry;
	/** Checkpoint store for transition + snapshot persistence. */
	checkpointStore: CheckpointStore;
	/** Mission ID for checkpoint/transition scoping. */
	missionId: string;
	/** Override starting node ID. If omitted, resumes from checkpoint or graph.nodes[0]. */
	startNodeId?: string;
	/** Optional mission store — used to call updateCurrentNode on each transition. */
	missionStore?: MissionStore;
	/** Send mail injected into HandlerContext. */
	sendMail?: (to: string, subject: string, body: string, type: string) => Promise<void>;
	/** Optional prefix to namespace checkpoint keys (used by subgraph engines to avoid parent collisions). */
	checkpointKeyPrefix?: string;
	/** Cap iterations in run(). When exceeded, run() returns as if hitting a gate. Propagated to subgraph engines. */
	maxSteps?: number;
}

export interface StepResult {
	/** Outcome of the step. */
	status: "advanced" | "gate" | "terminal" | "error";
	/** Node that was active at the start of the step. */
	fromNodeId: string;
	/** Node that is active after the step (same as fromNodeId if not advanced). */
	toNodeId: string;
	/** Trigger that fired the transition, or null if none. */
	trigger: string | null;
	/** Error description if status is 'error'. */
	error?: string;
}

export interface RunResult {
	/** Overall run outcome. */
	status: "completed" | "gate" | "error";
	/** All steps executed during this run, in order. */
	steps: StepResult[];
	/** Node where execution is now paused (terminal, gate, or error). */
	currentNodeId: string;
	/** Gate type if status is 'gate'. */
	gateType?: "human" | "async";
	/** Error description if status is 'error'. */
	error?: string;
}

export interface GraphEngine {
	/** Get the current node ID. */
	currentNodeId(): string;
	/**
	 * Advance from the current gate node using the given trigger, then continue
	 * execution until the next gate, terminal, or error. Returns a RunResult.
	 * Errors if the current node is not a gate node (gate: "human" | "async").
	 */
	advanceNode(trigger: string): Promise<RunResult>;
	/** Execute one step at the current node (invoke handler, then advance). */
	step(): Promise<StepResult>;
	/** Run the engine until a terminal node, gate, or error. */
	run(): Promise<RunResult>;
	/** Force a transition via trigger regardless of gate status. Single-step, no continuation. */
	forceAdvance(trigger: string): Promise<StepResult>;
}

// === Factory ===

export function createGraphEngine(opts: GraphEngineOpts): GraphEngine {
	// Compute effective checkpoint key — prefixed for subgraph isolation
	const effectiveKey = opts.checkpointKeyPrefix
		? `${opts.checkpointKeyPrefix}:${opts.missionId}`
		: opts.missionId;

	// Index nodes and edges with Maps for O(1) lookup
	const nodeMap = new Map<string, MissionGraphNode>();
	const edgeMap = new Map<string, MissionGraphEdge[]>();

	for (const node of opts.graph.nodes) {
		nodeMap.set(node.id, node);
	}
	for (const edge of opts.graph.edges) {
		const existing = edgeMap.get(edge.from);
		if (existing) {
			existing.push(edge);
		} else {
			edgeMap.set(edge.from, [edge]);
		}
	}

	// Resolve starting node: explicit override → checkpoint resume → graph start
	const resolveStartNodeId = (): string => {
		if (opts.startNodeId) return opts.startNodeId;
		const latest = opts.checkpointStore.getLatestCheckpoint(effectiveKey);
		if (latest) return latest.nodeId;
		const first = opts.graph.nodes[0];
		if (!first) throw new Error("Graph has no nodes");
		return first.id;
	};

	const state = { currentNodeId: resolveStartNodeId() };

	const getNode = (id: string): MissionGraphNode => {
		const node = nodeMap.get(id);
		if (!node) throw new Error(`Node '${id}' not found in graph`);
		return node;
	};

	/** Transition from fromNodeId to the node reached via trigger. */
	const performAdvance = async (fromNodeId: string, trigger: string): Promise<StepResult> => {
		const edges = edgeMap.get(fromNodeId) ?? [];
		const edge = edges.find((e) => e.trigger === trigger);
		if (!edge) {
			const err = `No edge with trigger '${trigger}' from node '${fromNodeId}'`;
			return { status: "error", fromNodeId, toNodeId: fromNodeId, trigger, error: err };
		}

		opts.checkpointStore.saveStepResult(effectiveKey, fromNodeId, edge.to, trigger, null);
		opts.missionStore?.updateCurrentNode(opts.missionId, edge.to);
		state.currentNodeId = edge.to;

		return { status: "advanced", fromNodeId, toNodeId: edge.to, trigger };
	};

	const step = async (): Promise<StepResult> => {
		const nodeId = state.currentNodeId;
		const node = getNode(nodeId);

		// Terminal: execution is finished
		if (node.terminal) {
			return { status: "terminal", fromNodeId: nodeId, toNodeId: nodeId, trigger: null };
		}

		// Gate: block awaiting external input
		if (node.gate === "human" || node.gate === "async") {
			return { status: "gate", fromNodeId: nodeId, toNodeId: nodeId, trigger: null };
		}

		// Subgraph: execute embedded graph to completion before advancing
		if (node.kind === "lifecycle" && node.subgraph) {
			const subEngine = createGraphEngine({
				graph: node.subgraph,
				handlers: opts.handlers,
				checkpointStore: opts.checkpointStore,
				missionId: opts.missionId,
				checkpointKeyPrefix: nodeId,
				missionStore: opts.missionStore,
				sendMail: opts.sendMail,
				maxSteps: opts.maxSteps,
			});
			const subResult = await subEngine.run();
			if (subResult.status === "error") {
				return {
					status: "error",
					fromNodeId: nodeId,
					toNodeId: nodeId,
					trigger: null,
					error: subResult.error,
				};
			}
			if (subResult.status !== "completed") {
				return { status: "gate", fromNodeId: nodeId, toNodeId: nodeId, trigger: null };
			}
		}

		// Handler invocation
		let trigger: string | null = null;
		if (node.handler) {
			const handler = opts.handlers[node.handler];
			if (!handler) {
				const err = `Handler '${node.handler}' not registered`;
				return { status: "error", fromNodeId: nodeId, toNodeId: nodeId, trigger: null, error: err };
			}

			const ctx: HandlerContext = {
				missionId: opts.missionId,
				nodeId,
				checkpoint: opts.checkpointStore.getCheckpoint(effectiveKey, nodeId)?.data ?? null,
				saveCheckpoint: async (data: unknown) => {
					opts.checkpointStore.saveCheckpoint(effectiveKey, nodeId, data);
				},
				sendMail: opts.sendMail ?? (async () => {}),
				getMission: () => opts.missionStore?.getById(opts.missionId) ?? null,
			};

			try {
				const result = await handler(ctx);
				trigger = result.trigger;
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				return { status: "error", fromNodeId: nodeId, toNodeId: nodeId, trigger: null, error };
			}
		}

		// No handler: auto-trigger from single outgoing edge
		if (trigger === null) {
			const edges = edgeMap.get(nodeId) ?? [];
			if (edges.length === 0) {
				// No outgoing edges and not marked terminal — treat as terminal
				return { status: "terminal", fromNodeId: nodeId, toNodeId: nodeId, trigger: null };
			}
			if (edges.length === 1 && edges[0]) {
				trigger = edges[0].trigger;
			} else {
				// Multiple edges, no handler to choose — gate
				return { status: "gate", fromNodeId: nodeId, toNodeId: nodeId, trigger: null };
			}
		}

		return performAdvance(nodeId, trigger);
	};

	const run = async (): Promise<RunResult> => {
		const steps: StepResult[] = [];
		let stepCount = 0;

		while (true) {
			if (opts.maxSteps !== undefined && stepCount >= opts.maxSteps) {
				// Budget exhausted — yield control as if hitting a gate
				return { status: "gate", steps, currentNodeId: state.currentNodeId };
			}

			let result: StepResult;
			try {
				result = await step();
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				return { status: "error", steps, currentNodeId: state.currentNodeId, error };
			}

			steps.push(result);
			stepCount++;

			if (result.status === "terminal") {
				return { status: "completed", steps, currentNodeId: state.currentNodeId };
			}

			if (result.status === "gate") {
				const gatedNode = nodeMap.get(state.currentNodeId);
				const gateType =
					gatedNode?.gate === "human" || gatedNode?.gate === "async"
						? (gatedNode.gate as "human" | "async")
						: undefined;
				return { status: "gate", steps, currentNodeId: state.currentNodeId, gateType };
			}

			if (result.status === "error") {
				return {
					status: "error",
					steps,
					currentNodeId: state.currentNodeId,
					error: result.error,
				};
			}
		}
	};

	const advanceNode = async (trigger: string): Promise<RunResult> => {
		const node = getNode(state.currentNodeId);
		if (node.gate !== "human" && node.gate !== "async") {
			return {
				status: "error",
				steps: [],
				currentNodeId: state.currentNodeId,
				error: `Node '${state.currentNodeId}' is not a gate node`,
			};
		}
		const stepResult = await performAdvance(state.currentNodeId, trigger);
		if (stepResult.status === "error") {
			return {
				status: "error",
				steps: [stepResult],
				currentNodeId: state.currentNodeId,
				error: stepResult.error,
			};
		}
		return run();
	};

	const forceAdvance = async (trigger: string): Promise<StepResult> => {
		return performAdvance(state.currentNodeId, trigger);
	};

	return {
		currentNodeId: () => state.currentNodeId,
		advanceNode,
		step,
		run,
		forceAdvance,
	};
}
