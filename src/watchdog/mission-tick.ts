/**
 * Mission lifecycle engine tick.
 *
 * Called once per watchdog daemon tick. Evaluates active mission gates,
 * nudges stuck agents, and recovers dead agents.
 *
 * The engine is a controller, not a replacement for agents. It nudges when
 * agents are alive but stuck, and respawns when agents are dead.
 */

import type { Database } from "bun:sqlite";
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

// === Tick lock ===

function acquireTickLock(db: Database, missionId: string, intervalMs: number): boolean {
	const now = new Date().toISOString();
	const timeoutSec = (intervalMs * 2) / 1000;

	// Clear stale locks (older than 2x interval)
	db.prepare(
		`DELETE FROM mission_tick_lock
		 WHERE mission_id = $id
		 AND (julianday($now) - julianday(locked_at)) * 86400 > $timeout`,
	).run({ $id: missionId, $now: now, $timeout: timeoutSec });

	// Try to acquire lock
	const result = db
		.prepare(
			`INSERT OR IGNORE INTO mission_tick_lock (mission_id, locked_at, locked_by)
		 VALUES ($id, $now, $pid)`,
		)
		.run({ $id: missionId, $now: now, $pid: String(process.pid) });

	return result.changes > 0;
}

function releaseTickLock(db: Database, missionId: string): void {
	db.prepare("DELETE FROM mission_tick_lock WHERE mission_id = $id").run({
		$id: missionId,
	});
}

// === Gate state management ===

interface GateStateRow {
	mission_id: string;
	node_id: string;
	entered_at: string;
	nudge_count: number;
	last_nudge_at: string | null;
	respawn_count: number;
	last_respawn_at: string | null;
	grace_ms: number;
	nudge_interval_ms: number;
	max_nudges: number;
	max_total_wait_ms: number;
	resolved_at: string | null;
}

function getGraceMs(nodeName: string): number {
	return GRACE_OVERRIDES[nodeName] ?? DEFAULT_GRACE_MS;
}

function getMaxTotalWaitMs(nodeName: string): number {
	return MAX_TOTAL_WAIT_OVERRIDES[nodeName] ?? DEFAULT_MAX_TOTAL_WAIT_MS;
}

function ensureGateState(db: Database, missionId: string, nodeId: string): GateStateRow {
	const nodeName = nodeId.split(":")[1] ?? "";
	const graceMs = getGraceMs(nodeName);
	const maxTotalWaitMs = getMaxTotalWaitMs(nodeName);

	db.prepare(
		`INSERT OR IGNORE INTO mission_gate_state
		 (mission_id, node_id, entered_at, grace_ms, max_total_wait_ms)
		 VALUES ($missionId, $nodeId, $now, $graceMs, $maxTotalWaitMs)`,
	).run({
		$missionId: missionId,
		$nodeId: nodeId,
		$now: new Date().toISOString(),
		$graceMs: graceMs,
		$maxTotalWaitMs: maxTotalWaitMs,
	});

	const row = db
		.prepare<GateStateRow, { $missionId: string; $nodeId: string }>(
			`SELECT * FROM mission_gate_state
			 WHERE mission_id = $missionId AND node_id = $nodeId`,
		)
		.get({ $missionId: missionId, $nodeId: nodeId });

	if (!row) throw new Error(`Gate state row not found for ${missionId}:${nodeId}`);
	return row;
}

function incrementNudgeCount(db: Database, missionId: string, nodeId: string): void {
	db.prepare(
		`UPDATE mission_gate_state
		 SET nudge_count = nudge_count + 1, last_nudge_at = $now
		 WHERE mission_id = $missionId AND node_id = $nodeId`,
	).run({
		$missionId: missionId,
		$nodeId: nodeId,
		$now: new Date().toISOString(),
	});
}

function resolveGate(db: Database, missionId: string, nodeId: string, trigger: string): void {
	db.prepare(
		`UPDATE mission_gate_state
		 SET resolved_at = $now, resolved_trigger = $trigger
		 WHERE mission_id = $missionId AND node_id = $nodeId`,
	).run({
		$missionId: missionId,
		$nodeId: nodeId,
		$now: new Date().toISOString(),
		$trigger: trigger,
	});
}

// === Main tick ===

export async function runMissionTick(opts: MissionTickOpts): Promise<void> {
	const { missionStore, intervalMs } = opts;
	const sessionsDbPath = join(opts.overstoryDir, "sessions.db");

	// Import Database dynamically to avoid circular deps at module level
	const { Database } = await import("bun:sqlite");
	const gateDb = new Database(sessionsDbPath);
	gateDb.exec("PRAGMA journal_mode=WAL");
	gateDb.exec("PRAGMA busy_timeout=5000");

	try {
		const missions = missionStore.getActiveList();

		for (const mission of missions) {
			if (mission.state !== "active") continue;

			// Acquire per-mission tick lock
			if (!acquireTickLock(gateDb, mission.id, intervalMs)) {
				continue; // Another tick is processing this mission
			}

			try {
				await processMission(mission, opts, gateDb);
			} finally {
				releaseTickLock(gateDb, mission.id);
			}
		}
	} finally {
		gateDb.close();
	}
}

async function processMission(
	mission: Mission,
	opts: MissionTickOpts,
	gateDb: Database,
): Promise<void> {
	const { missionStore } = opts;

	// Seed checkpoint on first engine tick for this mission (backward compat)
	const checkpoint = missionStore.checkpoints.getLatestCheckpoint(mission.id);
	if (!checkpoint) {
		const startNode = nodeId(mission.phase, mission.state);
		missionStore.checkpoints.saveCheckpoint(mission.id, startNode, { seeded: true });
	}

	// Reconstruct engine from checkpoint
	const engineFactory =
		opts._startEngine ?? (await import("../missions/engine-wiring.ts")).startLifecycleEngine;

	const engine = engineFactory(mission, {
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
	});

	// Execute one step
	const result = await engine.step();

	if (result.status === "gate") {
		const currentNodeId = engine.currentNodeId();

		// Ensure gate state row exists
		const gateState = ensureGateState(gateDb, mission.id, currentNodeId);

		const now = Date.now();
		const enteredAt = new Date(gateState.entered_at).getTime();
		const elapsed = now - enteredAt;

		// Absolute ceiling check
		if (elapsed > gateState.max_total_wait_ms) {
			// Ceiling exceeded — escalate regardless of activity
			if (opts.eventStore) {
				opts.eventStore.insert({
					runId: mission.runId,
					agentName: "engine",
					sessionId: null,
					eventType: "engine_nudge_sent",
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

		// Evaluate gate condition
		const artifactRoot = mission.artifactRoot ?? join(opts.overstoryDir, "missions", mission.id);
		const evalResult = await evaluateGate(
			currentNodeId,
			mission,
			{
				mailStore: opts.mailStore,
				sessionStore: opts.sessionStore,
			},
			artifactRoot,
		);

		if (evalResult.met && evalResult.trigger) {
			// Condition met — advance engine
			resolveGate(gateDb, mission.id, currentNodeId, evalResult.trigger);
			await engine.advanceNode(evalResult.trigger);

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
			// Condition not met — nudge if interval elapsed
			const lastNudge = gateState.last_nudge_at ? new Date(gateState.last_nudge_at).getTime() : 0;
			const sinceLastNudge = now - lastNudge;

			if (sinceLastNudge >= gateState.nudge_interval_ms) {
				if (gateState.nudge_count < gateState.max_nudges) {
					incrementNudgeCount(gateDb, mission.id, currentNodeId);

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
				// maxNudges exceeded — agent may be dead, let watchdog health checks handle
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
