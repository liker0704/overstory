/**
 * Mission lifecycle engine tick.
 *
 * Called once per watchdog daemon tick. Evaluates active mission gates,
 * nudges stuck agents, and recovers dead agents.
 *
 * The engine is a controller, not a replacement for agents. It nudges when
 * agents are alive but stuck, and respawns when agents are dead.
 */

import { join } from "node:path";
import type { OverstoryConfig } from "../config-types.ts";
import type { EventStore } from "../events/types.ts";
import type { MailStore } from "../mail/store.ts";
import {
	buildLifecycleGraph,
	buildLifecycleHandlers,
	CELL_REGISTRY,
	type startLifecycleEngine,
} from "../missions/engine-wiring.ts";
import { nodeId } from "../missions/graph.ts";
import type { SessionStore } from "../sessions/store.ts";
import type {
	AgentSession,
	Mission,
	MissionGraph,
	MissionGraphEdge,
	MissionGraphNode,
	MissionStore,
	MissionTier,
} from "../types.ts";
import { listSessions as listTmuxSessions } from "../worktree/tmux.ts";
import { evaluateGate } from "./gate-evaluators.ts";
import { evaluateHealth } from "./health.ts";

// === Types ===

export interface MissionTickOpts {
	overstoryDir: string;
	projectRoot: string;
	config: OverstoryConfig;
	missionStore: MissionStore;
	sessionStore: SessionStore;
	mailStore: MailStore | null;
	eventStore: EventStore | null;
	intervalMs: number;
	/** DI override: custom engine factory. */
	_startEngine?: typeof startLifecycleEngine;
}

// === Grace period defaults (ms) ===

const DEFAULT_GRACE_MS = 120_000; // 2 minutes
const DEFAULT_MAX_TOTAL_WAIT_MS = 3_600_000; // 1 hour absolute ceiling

/** Grace overrides per node name suffix. */
const GRACE_OVERRIDES: Record<string, number> = {
	"await-plan": 300_000, // 5 min — analyst needs time to write plan
	"architect-design": 300_000, // 5 min — architect explores and writes
	"await-ws-completion": 600_000, // 10 min — full dev cycle
	review: 360_000, // 6 min — critics working
	"await-refactor": 600_000, // 10 min — refactor builders working
	"await-arch-final": 300_000, // 5 min — architect finalizing
	summary: 180_000, // 3 min — analyst writing summary
	"await-leads-done": 600_000, // 10 min — direct-tier leads take time
};

/** Total wait ceiling overrides. */
const MAX_TOTAL_WAIT_OVERRIDES: Record<string, number> = {
	"await-ws-completion": 14_400_000, // 4 hours — real builds take time
	"await-refactor": 14_400_000, // 4 hours
	"await-leads-done": 14_400_000, // 4 hours — direct-tier leads
};

function getGraceMs(nodeName: string, config?: OverstoryConfig): number {
	const configOverride = config?.mission?.gates?.gracePeriods?.[nodeName];
	if (configOverride !== undefined) return configOverride;
	return GRACE_OVERRIDES[nodeName] ?? DEFAULT_GRACE_MS;
}

function getMaxTotalWaitMs(nodeName: string, config?: OverstoryConfig): number {
	const configOverride = config?.mission?.gates?.maxTotalWaitMs?.[nodeName];
	if (configOverride !== undefined) return configOverride;
	return MAX_TOTAL_WAIT_OVERRIDES[nodeName] ?? DEFAULT_MAX_TOTAL_WAIT_MS;
}

/**
 * Find a graph node in a pre-built lifecycle graph (including subgraphs).
 * Searches top-level nodes, then phase cell subgraphs, then falls back to
 * CELL_REGISTRY for review cell nodes (plan-review, architecture-review)
 * which are not embedded in the lifecycle graph.
 */
function findGraphNode(
	nodeIdStr: string,
	graph: MissionGraph,
	mission: Mission,
): MissionGraphNode | undefined {
	// Search top-level lifecycle nodes
	const topLevel = graph.nodes.find((n) => n.id === nodeIdStr);
	if (topLevel) return topLevel;

	// Search in phase cell subgraphs attached to lifecycle :active nodes
	for (const node of graph.nodes) {
		if (node.kind === "lifecycle" && node.subgraph) {
			const sub = node.subgraph.nodes.find((n) => n.id === nodeIdStr);
			if (sub) return sub;
		}
	}

	// Fallback: review cell nodes (plan-review, architecture-review) are not
	// embedded in the lifecycle graph. Search CELL_REGISTRY for them.
	const colonIdx = nodeIdStr.indexOf(":");
	if (colonIdx !== -1) {
		const prefix = nodeIdStr.slice(0, colonIdx);
		const reviewCell = CELL_REGISTRY[prefix];
		if (reviewCell) {
			const subgraph = reviewCell.buildSubgraph({
				tier: "full",
				maxRounds: 3,
				artifactRoot: mission.artifactRoot ?? "",
			});
			return subgraph.nodes.find((n) => n.id === nodeIdStr);
		}
	}

	return undefined;
}

/**
 * Find an edge in a subgraph of the pre-built lifecycle graph.
 * Used for timeout routing and gate advancement in place of
 * PHASE_CELL_REGISTRY[cellType].buildSubgraph() lookups.
 */
function findSubgraphEdge(
	graph: MissionGraph,
	fromNodeId: string,
	trigger: string,
): MissionGraphEdge | undefined {
	for (const node of graph.nodes) {
		if (node.kind === "lifecycle" && node.subgraph) {
			const edge = node.subgraph.edges.find((e) => e.from === fromNodeId && e.trigger === trigger);
			if (edge) return edge;
		}
	}
	return undefined;
}

// === Dead agent detection ===

/** Session IDs bound to a mission for critical roles. */
function getMissionRoleSessions(
	mission: Mission,
): Array<{ role: string; sessionId: string | null }> {
	return [
		{ role: "coordinator", sessionId: mission.coordinatorSessionId },
		{ role: "analyst", sessionId: mission.analystSessionId },
		{ role: "execution-director", sessionId: mission.executionDirectorSessionId },
		{ role: "architect", sessionId: mission.architectSessionId },
	];
}

/**
 * Check if critical mission role agents are dead and record events.
 * Checks tmux liveness + PID liveness via evaluateHealth.
 */
async function checkAndRecoverDeadAgents(mission: Mission, opts: MissionTickOpts): Promise<void> {
	const { sessionStore, eventStore } = opts;
	const tmuxSessions = await listTmuxSessions();
	const tmuxNames = new Set(tmuxSessions.map((s) => s.name));
	const thresholds = { staleMs: 300_000, zombieMs: 600_000 };

	for (const { role, sessionId } of getMissionRoleSessions(mission)) {
		if (!sessionId) continue;

		// Get session from store
		let session: AgentSession | undefined;
		const allSessions = sessionStore.getAll();
		session = allSessions.find((s) => s.id === sessionId);
		if (!session) continue;
		if (session.state === "completed" || session.state === "zombie" || session.state === "waiting")
			continue;

		// Evaluate health
		const tmuxAlive = tmuxNames.has(session.tmuxSession);
		const check = evaluateHealth(session, tmuxAlive, thresholds);

		if (check.state === "zombie") {
			// Mark zombie and attempt resume for mission role agents
			const { validateTransition } = await import("../agents/state-machine.ts");
			const vr = validateTransition(
				session.state,
				"zombie",
				{
					agentName: session.agentName,
					capability: session.capability,
					reason: "mission-tick: health check detected zombie",
				},
				{ force: true },
			);
			if (vr.success) {
				sessionStore.updateState(session.agentName, "zombie");
			}

			// Try to resume the dead agent via ov resume
			let resumed = false;
			try {
				const { existsSync } = await import("node:fs");
				if (existsSync(session.worktreePath)) {
					const { loadConfig } = await import("../config.ts");
					const config = await loadConfig(opts.projectRoot);
					const { resumeAgent } = await import("../commands/resume.ts");
					await resumeAgent(session, config, opts.projectRoot);
					resumed = true;
				}
			} catch {
				// Non-fatal: resume failure, agent stays zombie
			}

			if (eventStore) {
				eventStore.insert({
					runId: mission.runId,
					agentName: "engine",
					sessionId: session.id,
					eventType: "engine_agent_respawned",
					toolName: null,
					toolArgs: null,
					toolDurationMs: null,
					level: "warn",
					data: JSON.stringify({
						kind: resumed ? "dead_agent_respawned" : "dead_agent_detected",
						missionId: mission.id,
						role,
						agentName: session.agentName,
						note: check.reconciliationNote,
						resumed,
					}),
				});
			}
		}
	}
}

// === Main tick ===

export async function runMissionTick(opts: MissionTickOpts): Promise<void> {
	const { missionStore, intervalMs } = opts;
	const missions = missionStore.getActiveList();

	for (const mission of missions) {
		if (mission.state !== "active") continue;

		// Acquire per-mission tick lock via missionStore (single DB connection)
		if (!missionStore.acquireTickLock(mission.id, intervalMs)) {
			continue; // Another tick is processing this mission
		}

		try {
			await processMission(mission, opts);
		} finally {
			missionStore.releaseTickLock(mission.id);
		}
	}
}

async function processMission(mission: Mission, opts: MissionTickOpts): Promise<void> {
	const { missionStore } = opts;

	// === Dead agent detection for critical mission roles ===
	await checkAndRecoverDeadAgents(mission, opts);

	// Skip engine for assess mode (tier=null AND no currentNode yet).
	// Legacy missions also have tier=null but DO have a currentNode — those keep running as full.
	if (mission.tier === null && mission.currentNode === null) {
		return;
	}

	// Seed checkpoint on first engine tick for this mission (backward compat)
	const checkpoint = missionStore.checkpoints.getLatestCheckpoint(mission.id);
	if (!checkpoint) {
		const startNode = nodeId(mission.phase, mission.state);
		missionStore.checkpoints.saveCheckpoint(mission.id, startNode, { seeded: true });
	}

	// Reconstruct engine from checkpoint.
	// If the current node is a subgraph node (e.g., "understand-phase:evaluate"),
	// tell the parent engine to start at the parent lifecycle node so it can
	// re-enter the subgraph properly.
	const engineFactory =
		opts._startEngine ?? (await import("../missions/engine-wiring.ts")).startLifecycleEngine;

	// Build tier-aware graph and handlers ONCE per tick per mission.
	// Reused by findGraphNode() and findSubgraphEdge() below.
	const tier: MissionTier = mission.tier ?? "full";
	const sendMail = opts.mailStore
		? async (to: string, subject: string, body: string, type: string) => {
				opts.mailStore?.insert({
					id: "",
					from: "engine",
					to,
					subject,
					body,
					type: type as "status",
					priority: "normal",
					threadId: null,
				});
			}
		: undefined;
	const engineDeps = {
		checkpointStore: missionStore.checkpoints,
		missionStore,
		sendMail,
		sessionStore: opts.sessionStore,
	};
	const tickGraph = buildLifecycleGraph(mission);
	const tickHandlers = buildLifecycleHandlers(engineDeps, tier);

	// Read mission once — reused for subgraph detection and later as freshMission
	const latestMission = missionStore.getById(mission.id);
	const currentMissionNode = latestMission?.currentNode;
	let startNodeOverride: string | undefined;
	if (currentMissionNode?.includes("-phase:")) {
		const phasePart = currentMissionNode.split("-phase:")[0];
		if (phasePart) {
			startNodeOverride = `${phasePart}:active`;
		}
	}

	const engine = engineFactory(mission, engineDeps, {
		...(startNodeOverride ? { startNodeId: startNodeOverride } : {}),
		graph: tickGraph,
		handlers: tickHandlers,
	});

	// Execute one step
	const result = await engine.step();

	if (result.status === "gate") {
		// Re-read mission to get latest currentNode (engine.step may have updated it)
		const freshMission = missionStore.getById(mission.id) ?? latestMission;
		const currentNodeId = freshMission?.currentNode ?? engine.currentNodeId();

		// If we fell back to engine.currentNodeId(), it's the parent lifecycle node
		// (e.g., "understand:active"), not the subgraph node. Gate evaluation won't
		// match any subgraph gate — skip this tick rather than evaluate wrong node.
		if (!freshMission?.currentNode && currentNodeId === engine.currentNodeId()) {
			return;
		}
		const nodeName = currentNodeId.split(":")[1] ?? "";

		// Look up the current graph node to read per-node timeout overrides
		const currentGraphNode = findGraphNode(currentNodeId, tickGraph, mission);
		const nodeGateTimeoutMs =
			currentGraphNode?.gateTimeout !== undefined ? currentGraphNode.gateTimeout * 1000 : undefined;

		// Ensure gate state row exists (uses missionStore's DB connection)
		// gateTimeout on the node takes priority over config and hardcoded dictionaries
		const gateState = missionStore.ensureGateState(
			mission.id,
			currentNodeId,
			getGraceMs(nodeName, opts.config),
			nodeGateTimeoutMs ?? getMaxTotalWaitMs(nodeName, opts.config),
		);

		const now = Date.now();
		const enteredAt = new Date(gateState.entered_at).getTime();
		const elapsed = now - enteredAt;

		// Evaluate gate FIRST — if already met, advance regardless of elapsed time.
		// This prevents stale gate states from triggering spurious suspensions when
		// the gate condition was actually satisfied before the ceiling expired.
		const artifactRoot = mission.artifactRoot ?? join(opts.overstoryDir, "missions", mission.id);
		// Use resolved_at as the filter baseline when re-entering a node (loop-back).
		// On first entry resolved_at is null, so entered_at is used.
		// On loop-back, INSERT OR IGNORE keeps the original entered_at but resolved_at
		// reflects when the gate last fired — filtering from that point avoids
		// re-triggering on already-processed mail.
		const gateFilterTime = gateState.resolved_at ?? gateState.entered_at;
		const earlyEval = await evaluateGate(
			currentNodeId,
			freshMission ?? mission,
			{ mailStore: opts.mailStore, sessionStore: opts.sessionStore },
			artifactRoot,
			gateFilterTime,
		);
		if (earlyEval.met && earlyEval.trigger) {
			missionStore.resolveGate(mission.id, currentNodeId, earlyEval.trigger);
			const advanceEdge = findSubgraphEdge(tickGraph, currentNodeId, earlyEval.trigger);
			if (advanceEdge) {
				const phaseName = currentNodeId.split("-phase:")[0] ?? "";
				const parentNodeId = `${phaseName}:active`;
				const subgraphCheckpointKey = `${parentNodeId}:${mission.id}`;
				missionStore.checkpoints.saveStepResult(
					subgraphCheckpointKey,
					currentNodeId,
					advanceEdge.to,
					earlyEval.trigger,
					null,
				);
				// Reset destination gate state on loop-back to prevent stale
				// resolved_at from filtering out events (overstory-5fd9).
				missionStore.resetGateState(mission.id, advanceEdge.to);
				missionStore.updateCurrentNode(mission.id, advanceEdge.to);
			} else {
				await engine.advanceNode(earlyEval.trigger);
			}
			if (opts.eventStore) {
				opts.eventStore.insert({
					runId: mission.runId,
					agentName: "engine",
					sessionId: null,
					eventType: "engine_gate_advanced",
					toolName: null,
					toolArgs: null,
					toolDurationMs: null,
					level: "info",
					data: JSON.stringify({
						kind: "gate_advanced",
						missionId: mission.id,
						nodeId: currentNodeId,
						trigger: earlyEval.trigger,
					}),
				});
			}
			return;
		}

		// Absolute ceiling check (only fires if gate NOT met above)
		if (elapsed > gateState.max_total_wait_ms) {
			// If the node declares onTimeout, route via timeout edge instead of suspending
			const onTimeout = currentGraphNode?.onTimeout;
			if (onTimeout) {
				missionStore.resolveGate(mission.id, currentNodeId, "timeout");

				// Advance the subgraph to the timeout-edge target using pre-built graph.
				const timeoutEdge = findSubgraphEdge(tickGraph, currentNodeId, "timeout");
				if (timeoutEdge) {
					const phaseName = currentNodeId.split("-phase:")[0] ?? "";
					const parentNodeId = `${phaseName}:active`;
					const subgraphCheckpointKey = `${parentNodeId}:${mission.id}`;
					missionStore.checkpoints.saveStepResult(
						subgraphCheckpointKey,
						currentNodeId,
						timeoutEdge.to,
						"timeout",
						null,
					);
					missionStore.updateCurrentNode(mission.id, timeoutEdge.to);
				} else {
					// Top-level or review cell gate — use engine.advanceNode
					await engine.advanceNode("timeout");
				}

				if (opts.eventStore) {
					opts.eventStore.insert({
						runId: mission.runId,
						agentName: "engine",
						sessionId: null,
						eventType: "engine_gate_timeout_routed",
						toolName: null,
						toolArgs: null,
						toolDurationMs: null,
						level: "warn",
						data: JSON.stringify({
							kind: "gate_timeout_routed",
							missionId: mission.id,
							nodeId: currentNodeId,
							onTimeout,
							elapsedMs: elapsed,
						}),
					});
				}
			} else {
				// Original behavior: suspend mission
				missionStore.updateState(mission.id, "suspended");

				if (opts.eventStore) {
					opts.eventStore.insert({
						runId: mission.runId,
						agentName: "engine",
						sessionId: null,
						eventType: "engine_mission_suspended",
						toolName: null,
						toolArgs: null,
						toolDurationMs: null,
						level: "warn",
						data: JSON.stringify({
							kind: "max_total_wait_exceeded",
							missionId: mission.id,
							nodeId: currentNodeId,
							elapsedMs: elapsed,
						}),
					});
				}
			}
			return; // Ceiling breached — stop processing this tick
		}

		// Grace period check
		if (elapsed < gateState.grace_ms) {
			return; // Within grace, agent is working
		}

		// Evaluate gate condition for nudge path (use freshMission for up-to-date phase/state)
		// Note: artifactRoot already declared above in the early-eval block
		const evalResult = await evaluateGate(
			currentNodeId,
			freshMission ?? mission,
			{ mailStore: opts.mailStore, sessionStore: opts.sessionStore },
			artifactRoot,
			gateFilterTime,
		);

		if (evalResult.unknown) {
			if (opts.eventStore) {
				opts.eventStore.insert({
					runId: mission.runId,
					agentName: "engine",
					sessionId: null,
					eventType: "engine_gate_evaluator_missing",
					toolName: null,
					toolArgs: null,
					toolDurationMs: null,
					level: "warn",
					data: JSON.stringify({ nodeId: currentNodeId, nodeName }),
				});
			}
		}

		if (evalResult.met && evalResult.trigger) {
			// Gate resolved — advance
			missionStore.resolveGate(mission.id, currentNodeId, evalResult.trigger);

			// For subgraph gates, find the target node using pre-built graph
			const advanceEdge = findSubgraphEdge(tickGraph, currentNodeId, evalResult.trigger);
			if (advanceEdge) {
				// Subgraph checkpoints use a prefixed key: "parentNodeId:missionId".
				const phaseName = currentNodeId.split("-phase:")[0] ?? "";
				const parentNodeId = `${phaseName}:active`;
				const subgraphCheckpointKey = `${parentNodeId}:${mission.id}`;

				missionStore.checkpoints.saveStepResult(
					subgraphCheckpointKey,
					currentNodeId,
					advanceEdge.to,
					evalResult.trigger,
					null,
				);
				// Reset destination gate state on loop-back (overstory-5fd9).
				missionStore.resetGateState(mission.id, advanceEdge.to);
				missionStore.updateCurrentNode(mission.id, advanceEdge.to);
			} else {
				// Top-level gate — use engine.advanceNode
				await engine.advanceNode(evalResult.trigger);
			}

			if (opts.eventStore) {
				opts.eventStore.insert({
					runId: mission.runId,
					agentName: "engine",
					sessionId: null,
					eventType: "engine_gate_advanced",
					toolName: null,
					toolArgs: null,
					toolDurationMs: null,
					level: "info",
					data: JSON.stringify({
						kind: "gate_advanced",
						missionId: mission.id,
						nodeId: currentNodeId,
						trigger: evalResult.trigger,
					}),
				});
			}
		} else if (evalResult.nudgeTarget && evalResult.nudgeMessage) {
			// Not met — nudge if interval elapsed
			const lastNudge = gateState.last_nudge_at ? new Date(gateState.last_nudge_at).getTime() : 0;
			const sinceLastNudge = now - lastNudge;

			if (sinceLastNudge >= gateState.nudge_interval_ms) {
				if (gateState.nudge_count < gateState.max_nudges) {
					missionStore.incrementNudgeCount(mission.id, currentNodeId);

					// Send actual tmux nudge to the agent
					try {
						const { nudgeAgent } = await import("../commands/nudge.ts");
						await nudgeAgent(
							opts.projectRoot,
							evalResult.nudgeTarget,
							`[ENGINE] ${evalResult.nudgeMessage}`,
							true,
						);
					} catch {
						// Non-fatal: nudge delivery failure
					}

					if (opts.eventStore) {
						opts.eventStore.insert({
							runId: mission.runId,
							agentName: "engine",
							sessionId: null,
							eventType: "engine_nudge_sent",
							toolName: null,
							toolArgs: null,
							toolDurationMs: null,
							level: "info",
							data: JSON.stringify({
								kind: "nudge_sent",
								missionId: mission.id,
								nodeId: currentNodeId,
								target: evalResult.nudgeTarget,
								message: evalResult.nudgeMessage,
								nudgeCount: gateState.nudge_count + 1,
							}),
						});
					}
				}
			}
		}
	}

	// Record gate entry events for new gates
	if (result.status === "advanced" && opts.eventStore) {
		opts.eventStore.insert({
			runId: mission.runId,
			agentName: "engine",
			sessionId: null,
			eventType: "engine_gate_entered",
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			level: "info",
			data: JSON.stringify({
				kind: "step_advanced",
				missionId: mission.id,
				fromNode: result.fromNodeId,
				toNode: result.toNodeId,
				trigger: result.trigger,
			}),
		});
	}
}
