/**
 * SQLite-backed checkpoint and transition store for mission graph execution.
 *
 * Manages mission_node_checkpoints and mission_state_transitions tables.
 * Both tables live in sessions.db alongside missions/sessions/runs.
 */

import type { Database } from "bun:sqlite";
import type { CheckpointStore } from "../types.ts";

// DDL is managed via store.ts migrations; this module only prepares statements.

/** Row shape for mission_node_checkpoints. */
interface CheckpointRow {
	id: string;
	mission_id: string;
	node_id: string;
	version: number;
	snapshot_data: string;
	schema_version: number;
	created_at: string;
}

/** Row shape for mission_state_transitions. */
interface TransitionRow {
	id: number;
	mission_id: string;
	from_node: string;
	to_node: string;
	trigger: string;
	data: string | null;
	error: string | null;
	created_at: string;
}

/** Stored snapshot envelope — snapshot_data column value. */
interface SnapshotEnvelope {
	schemaVersion: number;
	data: unknown;
}

/**
 * Create a CheckpointStore backed by an existing db connection.
 *
 * The caller (createMissionStore) is responsible for creating the tables
 * via migrations before calling this factory.
 */
export function createCheckpointStore(db: Database): CheckpointStore {
	const getMaxVersionStmt = db.prepare<
		{ max_version: number | null },
		{ $mission_id: string; $node_id: string }
	>(
		`SELECT MAX(version) AS max_version FROM mission_node_checkpoints
		 WHERE mission_id = $mission_id AND node_id = $node_id`,
	);

	const insertCheckpointStmt = db.prepare<
		void,
		{
			$id: string;
			$mission_id: string;
			$node_id: string;
			$version: number;
			$snapshot_data: string;
			$schema_version: number;
		}
	>(
		`INSERT INTO mission_node_checkpoints
		   (id, mission_id, node_id, version, snapshot_data, schema_version)
		 VALUES ($id, $mission_id, $node_id, $version, $snapshot_data, $schema_version)`,
	);

	const getCheckpointStmt = db.prepare<CheckpointRow, { $mission_id: string; $node_id: string }>(
		`SELECT * FROM mission_node_checkpoints
		 WHERE mission_id = $mission_id AND node_id = $node_id
		 ORDER BY version DESC
		 LIMIT 1`,
	);

	const getLatestCheckpointStmt = db.prepare<CheckpointRow, { $mission_id: string }>(
		`SELECT * FROM mission_node_checkpoints
		 WHERE mission_id = $mission_id
		 ORDER BY rowid DESC
		 LIMIT 1`,
	);

	const listCheckpointsStmt = db.prepare<
		{ node_id: string; version: number; created_at: string },
		{ $mission_id: string }
	>(
		`SELECT node_id, version, created_at FROM mission_node_checkpoints
		 WHERE mission_id = $mission_id
		 ORDER BY created_at ASC`,
	);

	const insertTransitionStmt = db.prepare<
		void,
		{
			$mission_id: string;
			$from_node: string;
			$to_node: string;
			$trigger: string;
			$data: string | null;
			$error: string | null;
		}
	>(
		`INSERT INTO mission_state_transitions (mission_id, from_node, to_node, trigger, data, error)
		 VALUES ($mission_id, $from_node, $to_node, $trigger, $data, $error)`,
	);

	const deleteCheckpointsStmt = db.prepare<void, { $mission_id: string }>(
		`DELETE FROM mission_node_checkpoints WHERE mission_id = $mission_id`,
	);

	/** Atomic checkpoint + transition in a single transaction. */
	const saveStepResultTx = db.transaction(
		(
			missionId: string,
			fromNode: string,
			toNode: string,
			trigger: string,
			checkpointData: unknown,
		) => {
			const maxRow = getMaxVersionStmt.get({
				$mission_id: missionId,
				$node_id: toNode,
			});
			const nextVersion = (maxRow?.max_version ?? 0) + 1;
			const envelope: SnapshotEnvelope = { schemaVersion: 1, data: checkpointData };
			insertCheckpointStmt.run({
				$id: crypto.randomUUID(),
				$mission_id: missionId,
				$node_id: toNode,
				$version: nextVersion,
				$snapshot_data: JSON.stringify(envelope),
				$schema_version: 1,
			});
			insertTransitionStmt.run({
				$mission_id: missionId,
				$from_node: fromNode,
				$to_node: toNode,
				$trigger: trigger,
				$data: null,
				$error: null,
			});
		},
	);

	return {
		saveCheckpoint(missionId: string, nodeId: string, data: unknown): void {
			const maxRow = getMaxVersionStmt.get({
				$mission_id: missionId,
				$node_id: nodeId,
			});
			const nextVersion = (maxRow?.max_version ?? 0) + 1;
			const envelope: SnapshotEnvelope = { schemaVersion: 1, data };
			insertCheckpointStmt.run({
				$id: crypto.randomUUID(),
				$mission_id: missionId,
				$node_id: nodeId,
				$version: nextVersion,
				$snapshot_data: JSON.stringify(envelope),
				$schema_version: 1,
			});
		},

		getCheckpoint(
			missionId: string,
			nodeId: string,
		): { data: unknown; version: number; schemaVersion: number } | null {
			const row = getCheckpointStmt.get({ $mission_id: missionId, $node_id: nodeId });
			if (!row) return null;
			const envelope = JSON.parse(row.snapshot_data) as SnapshotEnvelope;
			return { data: envelope.data, version: row.version, schemaVersion: envelope.schemaVersion };
		},

		getLatestCheckpoint(
			missionId: string,
		): { nodeId: string; data: unknown; version: number } | null {
			const row = getLatestCheckpointStmt.get({ $mission_id: missionId });
			if (!row) return null;
			const envelope = JSON.parse(row.snapshot_data) as SnapshotEnvelope;
			return { nodeId: row.node_id, data: envelope.data, version: row.version };
		},

		listCheckpoints(
			missionId: string,
		): Array<{ nodeId: string; version: number; createdAt: string }> {
			const rows = listCheckpointsStmt.all({ $mission_id: missionId });
			return rows.map((r) => ({ nodeId: r.node_id, version: r.version, createdAt: r.created_at }));
		},

		recordTransition(
			missionId: string,
			fromNode: string,
			toNode: string,
			trigger: string,
			data?: unknown,
			error?: string,
		): void {
			insertTransitionStmt.run({
				$mission_id: missionId,
				$from_node: fromNode,
				$to_node: toNode,
				$trigger: trigger,
				$data: data !== undefined ? JSON.stringify(data) : null,
				$error: error ?? null,
			});
		},

		getTransitionHistory(
			missionId: string,
			opts?: { limit?: number; offset?: number },
		): Array<{
			fromNode: string;
			toNode: string;
			trigger: string;
			createdAt: string;
			error?: string;
		}> {
			const limit = opts?.limit;
			const offset = opts?.offset;

			let rows: TransitionRow[];
			if (limit !== undefined && offset !== undefined) {
				rows = db
					.prepare<TransitionRow, { $mission_id: string; $limit: number; $offset: number }>(
						`SELECT * FROM mission_state_transitions WHERE mission_id = $mission_id
						 ORDER BY id ASC LIMIT $limit OFFSET $offset`,
					)
					.all({ $mission_id: missionId, $limit: limit, $offset: offset });
			} else if (limit !== undefined) {
				rows = db
					.prepare<TransitionRow, { $mission_id: string; $limit: number }>(
						`SELECT * FROM mission_state_transitions WHERE mission_id = $mission_id
						 ORDER BY id ASC LIMIT $limit`,
					)
					.all({ $mission_id: missionId, $limit: limit });
			} else if (offset !== undefined) {
				rows = db
					.prepare<TransitionRow, { $mission_id: string; $offset: number }>(
						`SELECT * FROM mission_state_transitions WHERE mission_id = $mission_id
						 ORDER BY id ASC LIMIT -1 OFFSET $offset`,
					)
					.all({ $mission_id: missionId, $offset: offset });
			} else {
				rows = db
					.prepare<TransitionRow, { $mission_id: string }>(
						`SELECT * FROM mission_state_transitions WHERE mission_id = $mission_id
						 ORDER BY id ASC`,
					)
					.all({ $mission_id: missionId });
			}

			return rows.map((r) => ({
				fromNode: r.from_node,
				toNode: r.to_node,
				trigger: r.trigger,
				createdAt: r.created_at,
				...(r.error !== null ? { error: r.error } : {}),
			}));
		},

		saveStepResult(
			missionId: string,
			fromNode: string,
			toNode: string,
			trigger: string,
			checkpointData: unknown,
		): void {
			saveStepResultTx(missionId, fromNode, toNode, trigger, checkpointData);
		},

		deleteCheckpoints(missionId: string): void {
			deleteCheckpointsStmt.run({ $mission_id: missionId });
		},
	};
}
