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
import type { startLifecycleEngine } from "../missions/engine-wiring.ts";
import { nodeId } from "../missions/graph.ts";
import type { SessionStore } from "../sessions/store.ts";
import type { Mission, MissionStore } from "../types.ts";
import { evaluateGate } from "./gate-evaluators.ts";

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
};

/** Total wait ceiling overrides. */
const MAX_TOTAL_WAIT_OVERRIDES: Record<string, number> = {
	"await-ws-completion": 14_400_000, // 4 hours — real builds take time
	"await-refactor": 14_400_000, // 4 hours
};

function getGraceMs(nodeName: string): number {
	return GRACE_OVERRIDES[nodeName] ?? DEFAULT_GRACE_MS;
}

function getMaxTotalWaitMs(nodeName: string): number {
	return MAX_TOTAL_WAIT_OVERRIDES[nodeName] ?? DEFAULT_MAX_TOTAL_WAIT_MS;
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

	// Read mission once — reused for subgraph detection and later as freshMission
	const latestMission = missionStore.getById(mission.id);
	const currentMissionNode = latestMission?.currentNode;
	let startNodeOverride: string | undefined;
	if (currentMissionNode && currentMissionNode.includes("-phase:")) {
		const phasePart = currentMissionNode.split("-phase:")[0];
		if (phasePart) {
			startNodeOverride = `${phasePart}:active`;
		}
	}

	const engine = engineFactory(
		mission,
		{
			checkpointStore: missionStore.checkpoints,
			missionStore,
			sendMail: opts.mailStore
				? async (to, subject, body, type) => {
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
				: undefined,
			sessionStore: opts.sessionStore,
		},
		startNodeOverride ? { startNodeId: startNodeOverride } : undefined,
	);

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

		// Ensure gate state row exists (uses missionStore's DB connection)
		const gateState = missionStore.ensureGateState(
			mission.id,
			currentNodeId,
			getGraceMs(nodeName),
			getMaxTotalWaitMs(nodeName),
		);

		const now = Date.now();
		const enteredAt = new Date(gateState.entered_at).getTime();
		const elapsed = now - enteredAt;

		// Absolute ceiling check
		if (elapsed > gateState.max_total_wait_ms) {
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

		// Grace period check
		if (elapsed < gateState.grace_ms) {
			return; // Within grace, agent is working
		}

		// Evaluate gate condition (use freshMission for up-to-date phase/state)
		const artifactRoot = mission.artifactRoot ?? join(opts.overstoryDir, "missions", mission.id);
		const evalResult = await evaluateGate(
			currentNodeId,
			freshMission ?? mission,
			{ mailStore: opts.mailStore, sessionStore: opts.sessionStore },
			artifactRoot,
		);

		if (evalResult.met && evalResult.trigger) {
			// Gate resolved — advance
			missionStore.resolveGate(mission.id, currentNodeId, evalResult.trigger);

			// For subgraph gates, find the target node and advance directly
			const cellType = currentNodeId.split(":")[0] ?? "";
			const phaseCell = (await import("../missions/engine-wiring.ts")).PHASE_CELL_REGISTRY[
				cellType
			];
			if (phaseCell) {
				const subgraph = phaseCell.buildSubgraph({
					missionId: mission.id,
					artifactRoot: mission.artifactRoot ?? "",
					projectRoot: opts.projectRoot,
				});
				const edge = subgraph.edges.find(
					(e) => e.from === currentNodeId && e.trigger === evalResult.trigger,
				);
				if (edge) {
					// Subgraph checkpoints use a prefixed key: "parentNodeId:missionId".
					// The parent lifecycle node is derived from cellType:
					//   "understand-phase" → parent "understand:active"
					const phaseName = cellType.replace("-phase", "");
					const parentNodeId = `${phaseName}:active`;
					const subgraphCheckpointKey = `${parentNodeId}:${mission.id}`;

					missionStore.checkpoints.saveStepResult(
						subgraphCheckpointKey,
						currentNodeId,
						edge.to,
						evalResult.trigger,
						null,
					);
					missionStore.updateCurrentNode(mission.id, edge.to);
				}
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
			const lastNudge = gateState.last_nudge_at
				? new Date(gateState.last_nudge_at).getTime()
				: 0;
			const sinceLastNudge = now - lastNudge;

			if (sinceLastNudge >= gateState.nudge_interval_ms) {
				if (gateState.nudge_count < gateState.max_nudges) {
					missionStore.incrementNudgeCount(mission.id, currentNodeId);

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
