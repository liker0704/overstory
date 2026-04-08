/**
 * Agent state machine: DAG-based transition graph.
 *
 * Replaces the linear STATE_ORDER that enforced forward-only transitions.
 * The real state graph is a DAG — agents can go waiting→working (mail nudge),
 * zombie→booting (respawn), stalled→working (recovery), etc.
 *
 * All state transitions should go through validateTransition() for audit
 * and correctness. Use force:true for ZFC overrides where observable state
 * (tmux/pid) must override the graph.
 */

import type { AgentState } from "./types.ts";

/**
 * The canonical agent state transition graph.
 * Each key maps to the set of states it can transition TO.
 * `completed` is terminal — no outgoing edges.
 */
export const VALID_TRANSITIONS: ReadonlyMap<AgentState, ReadonlySet<AgentState>> = new Map([
	["booting", new Set<AgentState>(["working", "zombie", "completed"])],
	["working", new Set<AgentState>(["waiting", "stalled", "completed", "zombie"])],
	["waiting", new Set<AgentState>(["working", "booting", "zombie", "completed"])],
	["stalled", new Set<AgentState>(["working", "zombie", "completed"])],
	["zombie", new Set<AgentState>(["booting", "completed"])],
	["completed", new Set<AgentState>()],
]);

/** Context for audit logging of state transitions. */
export interface TransitionContext {
	agentName: string;
	capability: string;
	/** Why this transition is happening — used for audit logging. */
	reason: string;
}

/** Result of a transition validation. */
export interface TransitionResult {
	success: boolean;
	from: AgentState;
	to: AgentState;
	/** Whether the graph was bypassed via force flag. */
	forced: boolean;
	reason: string;
}

/**
 * Check whether a transition is valid according to the graph.
 * Does NOT mutate state — pure validation.
 */
export function isValidTransition(from: AgentState, to: AgentState): boolean {
	if (from === to) return true;
	const allowed = VALID_TRANSITIONS.get(from);
	return allowed?.has(to) ?? false;
}

/**
 * Validated state transition. Returns a TransitionResult describing
 * what happened. The caller is responsible for calling store.updateState()
 * only when result.success is true.
 *
 * @param from - Current state
 * @param to - Desired state
 * @param ctx - Context for logging/audit
 * @param opts.force - ZFC override: allow transition even if graph forbids it.
 *                     Used when observable state (tmux/pid) contradicts recorded state.
 */
export function validateTransition(
	from: AgentState,
	to: AgentState,
	ctx: TransitionContext,
	opts?: { force?: boolean },
): TransitionResult {
	if (from === to) {
		return { success: true, from, to, forced: false, reason: "no-op" };
	}

	if (isValidTransition(from, to)) {
		return { success: true, from, to, forced: false, reason: ctx.reason };
	}

	if (opts?.force) {
		return { success: true, from, to, forced: true, reason: `ZFC override: ${ctx.reason}` };
	}

	return {
		success: false,
		from,
		to,
		forced: false,
		reason: `Invalid transition ${from} -> ${to}: ${ctx.reason}`,
	};
}
