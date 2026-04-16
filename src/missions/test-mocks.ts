/**
 * Shared in-memory mock stores for mission tests.
 *
 * Extracted from engine.test.ts to eliminate duplication across
 * engine.test.ts, engine-wiring.test.ts, plan-review.test.ts,
 * and architecture-review.test.ts.
 */

import type { CheckpointStore, Mission, MissionStore } from "../types.ts";

export interface StoredCheckpoint {
	data: unknown;
	version: number;
	schemaVersion: number;
}

export interface StoredTransition {
	fromNode: string;
	toNode: string;
	trigger: string;
	createdAt: string;
	error?: string;
}

export function createMockCheckpointStore(): CheckpointStore & {
	transitions: StoredTransition[];
} {
	const checkpoints = new Map<string, StoredCheckpoint>();
	const transitions: StoredTransition[] = [];
	let lastInsertKey: string | null = null;

	const key = (missionId: string, nodeId: string) => `${missionId}:${nodeId}`;

	return {
		transitions,

		saveCheckpoint(missionId: string, nodeId: string, data: unknown): void {
			const k = key(missionId, nodeId);
			const existing = checkpoints.get(k);
			checkpoints.set(k, {
				data,
				version: (existing?.version ?? 0) + 1,
				schemaVersion: 1,
			});
			lastInsertKey = k;
		},

		getCheckpoint(
			missionId: string,
			nodeId: string,
		): { data: unknown; version: number; schemaVersion: number } | null {
			return checkpoints.get(key(missionId, nodeId)) ?? null;
		},

		getLatestCheckpoint(
			missionId: string,
		): { nodeId: string; data: unknown; version: number } | null {
			if (!lastInsertKey) return null;
			const prefix = `${missionId}:`;
			let latest: { nodeId: string; data: unknown; version: number } | null = null;
			for (const [k, cp] of checkpoints) {
				if (k.startsWith(prefix)) {
					const nodeId = k.slice(prefix.length);
					if (!latest || cp.version >= latest.version) {
						latest = { nodeId, data: cp.data, version: cp.version };
					}
				}
			}
			return latest;
		},

		listCheckpoints(
			missionId: string,
		): Array<{ nodeId: string; version: number; createdAt: string }> {
			const prefix = `${missionId}:`;
			const result: Array<{ nodeId: string; version: number; createdAt: string }> = [];
			for (const [k, cp] of checkpoints) {
				if (k.startsWith(prefix)) {
					result.push({ nodeId: k.slice(prefix.length), version: cp.version, createdAt: "" });
				}
			}
			return result;
		},

		recordTransition(
			_missionId: string,
			fromNode: string,
			toNode: string,
			trigger: string,
			_data?: unknown,
			error?: string,
		): void {
			transitions.push({ fromNode, toNode, trigger, createdAt: new Date().toISOString(), error });
		},

		getTransitionHistory(_missionId: string): Array<{
			fromNode: string;
			toNode: string;
			trigger: string;
			createdAt: string;
			error?: string;
		}> {
			return [...transitions];
		},

		saveStepResult(
			missionId: string,
			fromNode: string,
			toNode: string,
			trigger: string,
			checkpointData: unknown,
		): void {
			this.saveCheckpoint(missionId, toNode, checkpointData);
			this.recordTransition(missionId, fromNode, toNode, trigger);
		},

		deleteCheckpoints(_missionId: string): void {
			checkpoints.clear();
		},
	};
}

export function createMockMissionStore(): MissionStore & { currentNode: string | null } {
	let currentNode: string | null = null;

	const noop = () => {};

	return {
		get currentNode() {
			return currentNode;
		},
		getById: (id: string) => ({
			id,
			slug: "test",
			objective: "test",
			runId: null,
			state: "active" as const,
			phase: "understand" as const,
			firstFreezeAt: null,
			pendingUserInput: false,
			pendingInputKind: null,
			pendingInputThreadId: null,
			reopenCount: 0,
			artifactRoot: null,
			pausedWorkstreamIds: [],
			analystSessionId: null,
			executionDirectorSessionId: null,
			coordinatorSessionId: null,
			architectSessionId: null,
			pausedLeadNames: [],
			pauseReason: null,
			currentNode,
			startedAt: null,
			completedAt: null,
			createdAt: "",
			updatedAt: "",
			learningsExtracted: false,
			hasEmittedWsProducerWrite: false,
			tier: null,
		}),
		getBySlug: () => null,
		getByRunId: () => null,
		getActive: () => null,
		getActiveList: () => [],
		create: (m) => ({
			...m,
			runId: m.runId ?? null,
			state: "active" as const,
			phase: "understand" as const,
			firstFreezeAt: null,
			pendingUserInput: false,
			pendingInputKind: null,
			pendingInputThreadId: null,
			reopenCount: 0,
			artifactRoot: m.artifactRoot ?? null,
			pausedWorkstreamIds: [],
			analystSessionId: null,
			executionDirectorSessionId: null,
			coordinatorSessionId: null,
			architectSessionId: null,
			pausedLeadNames: [],
			pauseReason: null,
			currentNode: null,
			startedAt: m.startedAt ?? null,
			completedAt: null,
			createdAt: "",
			updatedAt: "",
			learningsExtracted: false,
			hasEmittedWsProducerWrite: false,
			tier: m.tier ?? null,
		}),
		list: () => [],
		delete: noop,
		updateState: noop,
		updatePhase: noop,
		freeze: noop,
		unfreeze: noop,
		updatePausedWorkstreams: noop,
		updateArtifactRoot: noop,
		bindSessions: noop,
		bindCoordinatorSession: noop,
		updatePausedLeads: noop,
		updatePauseReason: noop,
		start: noop,
		completeMission: noop,
		updateSlug: noop,
		updateObjective: noop,
		updateCurrentNode: (_id: string, nodeId: string) => {
			currentNode = nodeId;
		},
		markLearningsExtracted: noop,
		markProducerWritten: noop,
		areAllWorkstreamsDone: () => false,
		updateWorkstreamStatus: noop,
		checkpoints: createMockCheckpointStore(),
		acquireTickLock: () => true,
		releaseTickLock: noop,
		ensureGateState: () => ({
			entered_at: new Date().toISOString(),
			nudge_count: 0,
			last_nudge_at: null,
			respawn_count: 0,
			grace_ms: 120_000,
			nudge_interval_ms: 60_000,
			max_nudges: 3,
			max_total_wait_ms: 3_600_000,
			resolved_at: null,
			ceiling_emitted_at: null,
		}),
		incrementNudgeCount: noop,
		markCeilingEmitted: noop,
		resolveGate: noop,
		updateTier: noop as unknown as MissionStore["updateTier"],
		clearGateStates: noop,
		clearCheckpoints: noop,
		transaction: <T>(fn: () => T): T => fn(),
		close: noop,
	};
}

export function makeMission(overrides?: Partial<Mission>): Mission {
	return {
		id: "mission-test",
		slug: "test",
		objective: "test objective",
		runId: null,
		state: "active",
		phase: "understand",
		firstFreezeAt: null,
		pendingUserInput: false,
		pendingInputKind: null,
		pendingInputThreadId: null,
		reopenCount: 0,
		artifactRoot: null,
		pausedWorkstreamIds: [],
		analystSessionId: null,
		executionDirectorSessionId: null,
		coordinatorSessionId: null,
		architectSessionId: null,
		pausedLeadNames: [],
		pauseReason: null,
		currentNode: null,
		startedAt: null,
		completedAt: null,
		createdAt: "",
		updatedAt: "",
		learningsExtracted: false,
		hasEmittedWsProducerWrite: false,
		tier: null,
		...overrides,
	};
}
