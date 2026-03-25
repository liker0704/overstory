/**
 * SQLite-backed mail storage for inter-agent messaging.
 *
 * Provides low-level CRUD operations on the messages table.
 * Uses bun:sqlite for zero-dependency, synchronous database access.
 * The higher-level mail client (L2) wraps this store.
 *
 * v2: Adds delivery state tracking (claim/ack/nack), lease-based expiry,
 * retry with backoff, dead-letter queue, and atomic batch inserts.
 */

import { Database } from "bun:sqlite";
import { ensureMigrations, type Migration, rebuildTable } from "../db/migrate.ts";
import { MailError } from "../errors.ts";
import type { MailDeliveryState, MailMessage } from "../types.ts";
import { MAIL_DELIVERY_STATES, MAIL_MESSAGE_TYPES } from "../types.ts";

export interface MailStore {
	insert(
		message: Omit<
			MailMessage,
			| "read"
			| "createdAt"
			| "payload"
			| "state"
			| "claimedAt"
			| "attempt"
			| "nextRetryAt"
			| "failReason"
			| "missionId"
		> & { payload?: string | null; missionId?: string | null },
	): MailMessage;

	/** Insert multiple messages atomically (for broadcast fan-out). */
	insertBatch(
		messages: Array<
			Omit<
				MailMessage,
				| "read"
				| "createdAt"
				| "payload"
				| "state"
				| "claimedAt"
				| "attempt"
				| "nextRetryAt"
				| "failReason"
				| "missionId"
			> & { payload?: string | null; missionId?: string | null }
		>,
	): MailMessage[];

	getUnread(agentName: string, missionId?: string): MailMessage[];
	getAll(filters?: {
		from?: string;
		to?: string;
		unread?: boolean;
		state?: MailDeliveryState;
		limit?: number;
	}): MailMessage[];
	getById(id: string): MailMessage | null;
	getByThread(threadId: string): MailMessage[];
	markRead(id: string): void;

	/**
	 * Expire stale claims, promote retryable failures, then claim available
	 * messages for the given agent. Sets state='claimed' and claimed_at=now.
	 */
	claim(agentName: string, leaseTimeoutSec?: number, missionId?: string): MailMessage[];

	/** Acknowledge successful processing. Sets state='acked', read=1. */
	ack(id: string, agentName?: string): void;

	/** Acknowledge multiple messages in a single transaction. */
	ackBatch(ids: string[]): void;

	/**
	 * Negative-acknowledge a claimed message. Increments attempt count,
	 * computes next retry with exponential backoff, or moves to dead_letter
	 * if max attempts exceeded.
	 */
	nack(
		id: string,
		options?: {
			reason?: string;
			maxAttempts?: number;
			backoffBaseSec?: number;
			backoffMaxSec?: number;
		},
	): { deadLettered: boolean };

	/** Get dead-lettered messages. */
	getDlq(filters?: { agent?: string; limit?: number }): MailMessage[];

	/** Replay a dead-lettered message: reset to queued state. */
	replayDlq(id: string): void;

	/** Replay multiple dead-lettered messages in a single transaction. */
	replayDlqBatch(ids: string[]): number;

	/** Purge dead-letter messages. Returns the number deleted. */
	purgeDlq(options?: { olderThanMs?: number; agent?: string }): number;

	/** Delete messages matching the given criteria. Returns the number of messages deleted. */
	purge(options: { all?: boolean; olderThanMs?: number; agent?: string }): number;

	/** Record a mail check timestamp for debounce tracking. */
	recordMailCheck(agent: string): void;

	/** Check if a mail check is within the debounce window. */
	isMailCheckDebounced(agent: string, debounceMs: number): boolean;

	close(): void;
}

/** Row shape as stored in SQLite (snake_case columns, integer boolean). */
interface MessageRow {
	id: string;
	from_agent: string;
	to_agent: string;
	subject: string;
	body: string;
	type: string;
	priority: string;
	thread_id: string | null;
	payload: string | null;
	read: number;
	created_at: string;
	state: string;
	claimed_at: string | null;
	attempt: number;
	next_retry_at: string | null;
	fail_reason: string | null;
	mission_id: string | null;
}

/**
 * Validate that a value is safe for embedding in DDL (SQL schema definitions).
 * Only alphanumeric characters and underscores are allowed — prevents SQL injection
 * in dynamically-built CHECK constraints.
 */
function assertSafeForDdl(value: string): void {
	if (!/^[a-z0-9_]+$/.test(value)) {
		throw new Error(`Unsafe DDL value: ${value}`);
	}
}

// Validate all type/state constants at module load time
for (const t of MAIL_MESSAGE_TYPES) assertSafeForDdl(t);
for (const s of MAIL_DELIVERY_STATES) assertSafeForDdl(s);

/** Build the CHECK constraint for message types from the runtime constant. */
const TYPE_CHECK = `CHECK(type IN (${MAIL_MESSAGE_TYPES.map((t) => `'${t}'`).join(",")}))`;
const STATE_CHECK = `CHECK(state IN (${MAIL_DELIVERY_STATES.map((s) => `'${s}'`).join(",")}))`;

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'status' ${TYPE_CHECK},
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  thread_id TEXT,
  payload TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  state TEXT NOT NULL DEFAULT 'queued' ${STATE_CHECK},
  claimed_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  fail_reason TEXT,
  mission_id TEXT
)`;

/** Migrations for the mail store. Version 4: add mail_check_state table for debounce tracking. */
const MAIL_MIGRATIONS: Migration[] = [
	{
		version: 1,
		description: "original schema (no delivery state)",
		up: () => {
			// Initial schema — created by CREATE TABLE IF NOT EXISTS
		},
		detect: (db) => {
			const row = db
				.prepare<{ sql: string }, []>(
					"SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'",
				)
				.get();
			return !!row;
		},
	},
	{
		version: 2,
		description: "delivery state columns + CHECK constraints",
		up: (db) => {
			const row = db
				.prepare<{ sql: string }, []>(
					"SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'",
				)
				.get();
			if (!row) return;

			const hasCurrentTypeSet = MAIL_MESSAGE_TYPES.every((type) => row.sql.includes(`'${type}'`));
			const hasCurrentStateSet = MAIL_DELIVERY_STATES.every((s) => row.sql.includes(`'${s}'`));
			const hasPayloadColumn = row.sql.includes("payload");
			const hasStateColumn = row.sql.includes("state");
			const hasCheckConstraints = row.sql.includes("CHECK");

			if (
				hasCheckConstraints &&
				hasPayloadColumn &&
				hasCurrentTypeSet &&
				hasStateColumn &&
				hasCurrentStateSet
			) {
				return;
			}

			const validTypes = MAIL_MESSAGE_TYPES.map((t) => `'${t}'`).join(",");
			const validStates = MAIL_DELIVERY_STATES.map((s) => `'${s}'`).join(",");
			const oldHasPayload = row.sql.includes("payload");
			const oldHasState = row.sql.includes("state");
			const payloadSelect = oldHasPayload ? "payload" : "NULL";

			const allColumns = [
				"id",
				"from_agent",
				"to_agent",
				"subject",
				"body",
				"type",
				"priority",
				"thread_id",
				"payload",
				"read",
				"created_at",
				"state",
				"claimed_at",
				"attempt",
				"next_retry_at",
				"fail_reason",
			];

			const selectExprs: Record<string, string> = {
				type: `CASE WHEN type IN (${validTypes}) THEN type ELSE 'status' END`,
				priority: `CASE WHEN priority IN ('low','normal','high','urgent') THEN priority ELSE 'normal' END`,
				payload: payloadSelect,
			};

			if (oldHasState) {
				selectExprs.state = `CASE WHEN state IN (${validStates}) THEN state ELSE 'queued' END`;
				selectExprs.attempt = "COALESCE(attempt, 0)";
			} else {
				selectExprs.state = "CASE WHEN read = 1 THEN 'acked' ELSE 'queued' END";
				selectExprs.claimed_at = "NULL";
				selectExprs.attempt = "0";
				selectExprs.next_retry_at = "NULL";
				selectExprs.fail_reason = "NULL";
			}

			rebuildTable({
				db,
				table: "messages",
				createSql: `CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'status' CHECK(type IN (${validTypes})),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  thread_id TEXT,
  payload TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN (${validStates})),
  claimed_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  fail_reason TEXT
)`,
				columns: allColumns,
				selectExprs,
			});
		},
		detect: (db) => {
			const row = db
				.prepare<{ sql: string }, []>(
					"SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'",
				)
				.get();
			if (!row) return false;
			return (
				MAIL_MESSAGE_TYPES.every((type) => row.sql.includes(`'${type}'`)) &&
				MAIL_DELIVERY_STATES.every((s) => row.sql.includes(`'${s}'`)) &&
				row.sql.includes("payload") &&
				row.sql.includes("state")
			);
		},
	},
	{
		version: 3,
		description: "add mission_id column + composite index",
		up: (db) => {
			// Check if the table exists first — fresh DBs have no table yet;
			// CREATE_TABLE (run after migrations) already includes mission_id.
			const tableRow = db
				.prepare<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='messages'",
				)
				.get();
			if (!tableRow) return;

			// Idempotent: check if column already exists before altering
			const colRow = db
				.prepare<{ name: string }, { $table: string }>(
					"SELECT name FROM pragma_table_info($table) WHERE name = 'mission_id'",
				)
				.get({ $table: "messages" });
			if (!colRow) {
				db.exec("ALTER TABLE messages ADD COLUMN mission_id TEXT");
			}
			db.exec(
				"CREATE INDEX IF NOT EXISTS idx_messages_mission ON messages(to_agent, mission_id, state)",
			);
		},
		detect: (db) => {
			const row = db
				.prepare<{ name: string }, { $table: string }>(
					"SELECT name FROM pragma_table_info($table) WHERE name = 'mission_id'",
				)
				.get({ $table: "messages" });
			return !!row;
		},
	},
	{
		version: 4,
		description: "add mail_check_state table for debounce tracking",
		up: (db) => {
			db.exec(`
        CREATE TABLE IF NOT EXISTS mail_check_state (
          agent TEXT PRIMARY KEY,
          last_checked_at INTEGER NOT NULL
        )
      `);
		},
		detect: (db) => {
			const row = db
				.prepare<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='mail_check_state'",
				)
				.get();
			return !!row;
		},
	},
];

const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_state ON messages(to_agent, state, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_from_agent ON messages(from_agent);
CREATE INDEX IF NOT EXISTS idx_messages_mission ON messages(to_agent, mission_id, state)`;

/** Generate a random 12-character alphanumeric ID (unbiased). */
function randomId(): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	// 252 is the largest multiple of 36 that fits in a byte, avoiding modulo bias
	const maxUnbiased = 252;
	const result: string[] = [];
	while (result.length < 12) {
		const bytes = new Uint8Array(16);
		crypto.getRandomValues(bytes);
		for (let i = 0; i < bytes.length && result.length < 12; i++) {
			const byte = bytes[i];
			if (byte !== undefined && byte < maxUnbiased) {
				result.push(chars[byte % chars.length] ?? "a");
			}
		}
	}
	return result.join("");
}

/** Convert a database row (snake_case) to a MailMessage object (camelCase). */
function rowToMessage(row: MessageRow): MailMessage {
	return {
		id: row.id,
		from: row.from_agent,
		to: row.to_agent,
		subject: row.subject,
		body: row.body,
		type: row.type as MailMessage["type"],
		priority: row.priority as MailMessage["priority"],
		threadId: row.thread_id,
		payload: row.payload,
		read: row.read === 1,
		createdAt: row.created_at,
		state: row.state as MailDeliveryState,
		claimedAt: row.claimed_at,
		attempt: row.attempt,
		nextRetryAt: row.next_retry_at,
		failReason: row.fail_reason,
		missionId: row.mission_id ?? null,
	};
}

/** Default lease timeout for claimed messages (seconds). */
const DEFAULT_LEASE_TIMEOUT_SEC = 120;
/** Default max retry attempts before dead-lettering. */
const DEFAULT_MAX_ATTEMPTS = 3;
/** Default backoff base in seconds (doubles per attempt). */
const DEFAULT_BACKOFF_BASE_SEC = 5;
/** Default maximum backoff in seconds. */
const DEFAULT_BACKOFF_MAX_SEC = 60;

/**
 * Create a new MailStore backed by a SQLite database at the given path.
 *
 * Initializes the database with WAL mode and a 5-second busy timeout.
 * Creates the messages table and indexes if they do not already exist.
 */
export function createMailStore(dbPath: string): MailStore {
	const db = new Database(dbPath);

	// Configure for concurrent access from multiple agent processes.
	// WAL mode allows concurrent readers with one writer.
	// synchronous=NORMAL balances safety and performance in WAL mode.
	// busy_timeout retries for up to 5 seconds on lock contention.
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA busy_timeout = 5000");

	// Run migrations before CREATE TABLE so legacy tables are upgraded first.
	// Migrations are idempotent and handle missing tables gracefully.
	ensureMigrations(db, MAIL_MIGRATIONS);

	// Create schema (if table doesn't exist yet, creates with CHECK constraints)
	db.exec(CREATE_TABLE);
	db.exec(CREATE_INDEXES);

	// Create debounce tracking table
	db.exec(`
    CREATE TABLE IF NOT EXISTS mail_check_state (
      agent TEXT PRIMARY KEY,
      last_checked_at INTEGER NOT NULL
    )
  `);

	// Prepare statements for all queries
	const insertStmt = db.prepare<
		void,
		{
			$id: string;
			$from_agent: string;
			$to_agent: string;
			$subject: string;
			$body: string;
			$type: string;
			$priority: string;
			$thread_id: string | null;
			$payload: string | null;
			$read: number;
			$created_at: string;
			$state: string;
			$mission_id: string | null;
		}
	>(`
		INSERT INTO messages
			(id, from_agent, to_agent, subject, body, type, priority, thread_id, payload, read, created_at, state, mission_id)
		VALUES
			($id, $from_agent, $to_agent, $subject, $body, $type, $priority, $thread_id, $payload, $read, $created_at, $state, $mission_id)
	`);

	const getByIdStmt = db.prepare<MessageRow, { $id: string }>(`
		SELECT * FROM messages WHERE id = $id
	`);

	/** Hard cap on messages returned per poll to prevent unbounded memory use. */
	const MAX_POLL_BATCH = 200;

	const getUnreadStmt = db.prepare<MessageRow, { $to_agent: string }>(`
		SELECT * FROM messages
		WHERE to_agent = $to_agent
		  AND state = 'queued'
		  AND (next_retry_at IS NULL OR next_retry_at <= datetime('now'))
		ORDER BY created_at ASC
		LIMIT ${MAX_POLL_BATCH}
	`);

	const getUnreadByMissionStmt = db.prepare<
		MessageRow,
		{ $to_agent: string; $mission_id: string }
	>(`
		SELECT * FROM messages
		WHERE to_agent = $to_agent
		  AND state = 'queued'
		  AND (next_retry_at IS NULL OR next_retry_at <= datetime('now'))
		  AND (mission_id = $mission_id OR mission_id IS NULL)
		ORDER BY created_at ASC
		LIMIT ${MAX_POLL_BATCH}
	`);

	const getByThreadStmt = db.prepare<MessageRow, { $thread_id: string }>(`
		SELECT * FROM messages WHERE thread_id = $thread_id ORDER BY created_at ASC
		LIMIT ${MAX_POLL_BATCH}
	`);

	// Only transition queued/claimed messages — don't bypass DLQ or failed state
	const markReadStmt = db.prepare<void, { $id: string }>(`
		UPDATE messages SET read = 1, state = 'acked'
		WHERE id = $id AND state IN ('queued', 'claimed')
	`);

	// Claim: expire stale claims (scoped to agent), then atomically claim
	const expireClaimsStmt = db.prepare<void, { $timeout_sec: number; $to_agent: string }>(`
		UPDATE messages
		SET state = 'queued', claimed_at = NULL
		WHERE state = 'claimed'
		  AND to_agent = $to_agent
		  AND claimed_at < datetime('now', '-' || $timeout_sec || ' seconds')
	`);

	const promoteRetryableStmt = db.prepare<void, { $to_agent: string }>(`
		UPDATE messages
		SET state = 'queued', next_retry_at = NULL
		WHERE state = 'failed'
		  AND to_agent = $to_agent
		  AND next_retry_at IS NOT NULL
		  AND next_retry_at <= datetime('now')
	`);

	const claimStmt = db.prepare<MessageRow, { $to_agent: string }>(`
		UPDATE messages
		SET state = 'claimed', claimed_at = datetime('now')
		WHERE id IN (
			SELECT id FROM messages
			WHERE to_agent = $to_agent
			  AND state = 'queued'
			  AND (next_retry_at IS NULL OR next_retry_at <= datetime('now'))
			ORDER BY created_at ASC
			LIMIT ${MAX_POLL_BATCH}
		)
		RETURNING *
	`);

	const claimByMissionStmt = db.prepare<MessageRow, { $to_agent: string; $mission_id: string }>(`
		UPDATE messages
		SET state = 'claimed', claimed_at = datetime('now')
		WHERE id IN (
			SELECT id FROM messages
			WHERE to_agent = $to_agent
			  AND state = 'queued'
			  AND (next_retry_at IS NULL OR next_retry_at <= datetime('now'))
			  AND (mission_id = $mission_id OR mission_id IS NULL)
			ORDER BY created_at ASC
			LIMIT ${MAX_POLL_BATCH}
		)
		RETURNING *
	`);

	// Guarded ack: only transitions claimed messages (defense-in-depth)
	const ackStmt = db.prepare<void, { $id: string }>(`
		UPDATE messages SET state = 'acked', read = 1
		WHERE id = $id AND state = 'claimed'
	`);

	const nackDeadLetterStmt = db.prepare<
		void,
		{ $id: string; $reason: string | null; $attempt: number }
	>(`
		UPDATE messages
		SET state = 'dead_letter', attempt = $attempt, fail_reason = $reason,
		    claimed_at = NULL, next_retry_at = NULL
		WHERE id = $id AND state = 'claimed'
	`);

	const nackRetryStmt = db.prepare<
		void,
		{
			$id: string;
			$reason: string | null;
			$attempt: number;
			$delay_sec: number;
		}
	>(`
		UPDATE messages
		SET state = 'failed', attempt = $attempt, fail_reason = $reason,
		    claimed_at = NULL,
		    next_retry_at = datetime('now', '+' || $delay_sec || ' seconds')
		WHERE id = $id AND state = 'claimed'
	`);

	const getDlqStmt = db.prepare<MessageRow, { $limit: number }>(`
		SELECT * FROM messages
		WHERE state = 'dead_letter'
		ORDER BY created_at DESC
		LIMIT $limit
	`);

	const getDlqByAgentStmt = db.prepare<MessageRow, { $agent: string; $limit: number }>(`
		SELECT * FROM messages
		WHERE state = 'dead_letter' AND to_agent = $agent
		ORDER BY created_at DESC
		LIMIT $limit
	`);

	const replayDlqStmt = db.prepare<void, { $id: string }>(`
		UPDATE messages
		SET state = 'queued', attempt = 0, fail_reason = NULL, next_retry_at = NULL, claimed_at = NULL, read = 0
		WHERE id = $id AND state = 'dead_letter'
	`);

	// Wrap multiple acks in a transaction — state guard in stmt skips non-claimed
	const ackBatchTransaction = db.transaction((ids: string[]) => {
		for (const id of ids) {
			ackStmt.run({ $id: id });
		}
	});

	// Wrap multiple DLQ replays in a transaction — state guard in stmt skips non-DLQ
	const replayDlqBatchTransaction = db.transaction((ids: string[]) => {
		for (const id of ids) {
			replayDlqStmt.run({ $id: id });
		}
	});

	// Wrap claim steps in a transaction for atomicity
	const claimTransaction = db.transaction(
		(agentName: string, timeoutSec: number, missionId?: string): MessageRow[] => {
			// Step 1: Expire stale claims for this agent's messages
			expireClaimsStmt.run({
				$timeout_sec: timeoutSec,
				$to_agent: agentName,
			});

			// Step 2: Promote retryable failed messages for this agent
			promoteRetryableStmt.run({ $to_agent: agentName });

			// Step 3: Atomically claim all available messages (optionally scoped to mission)
			if (missionId !== undefined) {
				return claimByMissionStmt.all({ $to_agent: agentName, $mission_id: missionId });
			}
			return claimStmt.all({ $to_agent: agentName });
		},
	);

	// Wrap multiple inserts in a transaction for atomicity
	const insertBatchTransaction = db.transaction(
		(
			msgs: Array<{
				id: string;
				from: string;
				to: string;
				subject: string;
				body: string;
				type: string;
				priority: string;
				threadId: string | null;
				payload: string | null;
				missionId: string | null;
				createdAt: string;
			}>,
		) => {
			for (const msg of msgs) {
				insertStmt.run({
					$id: msg.id,
					$from_agent: msg.from,
					$to_agent: msg.to,
					$subject: msg.subject,
					$body: msg.body,
					$type: msg.type,
					$priority: msg.priority,
					$thread_id: msg.threadId,
					$payload: msg.payload,
					$read: 0,
					$created_at: msg.createdAt,
					$state: "queued",
					$mission_id: msg.missionId,
				});
			}
		},
	);

	// Debounce tracking prepared statements
	const recordMailCheckStmt = db.prepare<void, { $agent: string; $now: number }>(
		"INSERT OR REPLACE INTO mail_check_state (agent, last_checked_at) VALUES ($agent, $now)",
	);

	const getMailCheckStmt = db.prepare<{ last_checked_at: number } | null, { $agent: string }>(
		"SELECT last_checked_at FROM mail_check_state WHERE agent = $agent",
	);

	// Cache for dynamically-built prepared statements (filter queries, purge variants).
	// Bounded by the number of distinct filter/purge query shapes — in practice <20
	// since the set of callers (getAll, purge, purgeDlq) generates a finite number
	// of WHERE clause combinations.
	const stmtCache = new Map<string, ReturnType<typeof db.prepare>>();

	// Dynamic filter queries are built at call time since the WHERE clause varies
	function buildFilterQuery(filters?: {
		from?: string;
		to?: string;
		unread?: boolean;
		state?: MailDeliveryState;
		limit?: number;
	}): MailMessage[] {
		const conditions: string[] = [];
		const params: Record<string, string | number> = {};

		if (filters?.from !== undefined) {
			conditions.push("from_agent = $from_agent");
			params.$from_agent = filters.from;
		}
		if (filters?.to !== undefined) {
			conditions.push("to_agent = $to_agent");
			params.$to_agent = filters.to;
		}
		if (filters?.unread !== undefined) {
			conditions.push("read = $read");
			params.$read = filters.unread ? 0 : 1;
		}
		if (filters?.state !== undefined) {
			conditions.push("state = $state");
			params.$state = filters.state;
		}

		const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		// Default limit prevents unbounded result sets when no filters are specified
		const effectiveLimit = filters?.limit ?? 1000;
		const limitClause = " LIMIT $limit";
		params.$limit = effectiveLimit;
		const query = `SELECT * FROM messages ${whereClause} ORDER BY created_at DESC${limitClause}`;
		let stmt = stmtCache.get(query);
		if (!stmt) {
			stmt = db.prepare(query);
			stmtCache.set(query, stmt);
		}
		const rows = (
			stmt as ReturnType<typeof db.prepare<MessageRow, Record<string, string | number>>>
		).all(params);
		return rows.map(rowToMessage);
	}

	return {
		insert(message): MailMessage {
			const id = message.id || `msg-${randomId()}`;
			const createdAt = new Date().toISOString();
			const payload = message.payload ?? null;
			const missionId = message.missionId ?? null;

			try {
				insertStmt.run({
					$id: id,
					$from_agent: message.from,
					$to_agent: message.to,
					$subject: message.subject,
					$body: message.body,
					$type: message.type,
					$priority: message.priority,
					$thread_id: message.threadId,
					$payload: payload,
					$read: 0,
					$created_at: createdAt,
					$state: "queued",
					$mission_id: missionId,
				});
			} catch (err) {
				throw new MailError(`Failed to insert message: ${id}`, {
					messageId: id,
					cause: err instanceof Error ? err : undefined,
				});
			}

			return {
				...message,
				id,
				payload,
				missionId,
				read: false,
				createdAt,
				state: "queued",
				claimedAt: null,
				attempt: 0,
				nextRetryAt: null,
				failReason: null,
			};
		},

		insertBatch(messages): MailMessage[] {
			const prepared = messages.map((msg) => ({
				id: msg.id || `msg-${randomId()}`,
				from: msg.from,
				to: msg.to,
				subject: msg.subject,
				body: msg.body,
				type: msg.type,
				priority: msg.priority,
				threadId: msg.threadId,
				payload: msg.payload ?? null,
				missionId: msg.missionId ?? null,
				createdAt: new Date().toISOString(),
			}));

			try {
				insertBatchTransaction(prepared);
			} catch (err) {
				throw new MailError("Failed to insert message batch", {
					cause: err instanceof Error ? err : undefined,
				});
			}

			return prepared.map((msg) => ({
				...msg,
				read: false,
				state: "queued" as const,
				claimedAt: null,
				attempt: 0,
				nextRetryAt: null,
				failReason: null,
			}));
		},

		getUnread(agentName: string, missionId?: string): MailMessage[] {
			if (missionId !== undefined) {
				const rows = getUnreadByMissionStmt.all({
					$to_agent: agentName,
					$mission_id: missionId,
				});
				return rows.map(rowToMessage);
			}
			const rows = getUnreadStmt.all({ $to_agent: agentName });
			return rows.map(rowToMessage);
		},

		getAll(filters): MailMessage[] {
			return buildFilterQuery(filters);
		},

		getById(id: string): MailMessage | null {
			const row = getByIdStmt.get({ $id: id });
			return row ? rowToMessage(row) : null;
		},

		getByThread(threadId: string): MailMessage[] {
			const rows = getByThreadStmt.all({ $thread_id: threadId });
			return rows.map(rowToMessage);
		},

		markRead(id: string): void {
			markReadStmt.run({ $id: id });
		},

		claim(agentName: string, leaseTimeoutSec?: number, missionId?: string): MailMessage[] {
			const timeout = leaseTimeoutSec ?? DEFAULT_LEASE_TIMEOUT_SEC;
			const rows = claimTransaction(agentName, timeout, missionId);
			return rows.map(rowToMessage);
		},

		ack(id: string, agentName?: string): void {
			// Wrap in transaction to prevent race between read and write
			db.transaction(() => {
				const msg = getByIdStmt.get({ $id: id });
				if (!msg) {
					throw new MailError(`Message not found: ${id}`, {
						messageId: id,
					});
				}
				if (msg.state !== "claimed") {
					throw new MailError(`Cannot ack message in state '${msg.state}': ${id}`, {
						messageId: id,
					});
				}
				if (agentName !== undefined && msg.to_agent !== agentName) {
					throw new MailError(
						`Agent '${agentName}' cannot ack message owned by '${msg.to_agent}': ${id}`,
						{ messageId: id },
					);
				}
				ackStmt.run({ $id: id });
			})();
		},

		ackBatch(ids: string[]): void {
			if (ids.length === 0) return;
			ackBatchTransaction(ids);
		},

		nack(id, options): { deadLettered: boolean } {
			// Wrap in transaction to prevent race between read and write
			return db.transaction(() => {
				const msg = getByIdStmt.get({ $id: id });
				if (!msg) {
					throw new MailError(`Message not found: ${id}`, {
						messageId: id,
					});
				}
				if (msg.state !== "claimed") {
					throw new MailError(`Cannot nack message in state '${msg.state}': ${id}`, {
						messageId: id,
					});
				}

				const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
				const backoffBaseSec = options?.backoffBaseSec ?? DEFAULT_BACKOFF_BASE_SEC;
				const backoffMaxSec = options?.backoffMaxSec ?? DEFAULT_BACKOFF_MAX_SEC;
				const reason = options?.reason ?? null;
				const newAttempt = msg.attempt + 1;

				if (newAttempt >= maxAttempts) {
					nackDeadLetterStmt.run({
						$id: id,
						$reason: reason,
						$attempt: newAttempt,
					});
					return { deadLettered: true };
				}

				// Exponential backoff: base * 2^attempt, capped at max
				const delaySec = Math.min(backoffBaseSec * 2 ** newAttempt, backoffMaxSec);
				nackRetryStmt.run({
					$id: id,
					$reason: reason,
					$attempt: newAttempt,
					$delay_sec: delaySec,
				});
				return { deadLettered: false };
			})();
		},

		getDlq(filters): MailMessage[] {
			// Default to 100; callers needing all records pass an explicit limit
			const limit = filters?.limit ?? 100;
			if (filters?.agent) {
				const rows = getDlqByAgentStmt.all({
					$agent: filters.agent,
					$limit: limit,
				});
				return rows.map(rowToMessage);
			}
			const rows = getDlqStmt.all({ $limit: limit });
			return rows.map(rowToMessage);
		},

		replayDlq(id: string): void {
			// Wrap in transaction to prevent TOCTOU race between read and write
			db.transaction(() => {
				const msg = getByIdStmt.get({ $id: id });
				if (!msg) {
					throw new MailError(`Message not found: ${id}`, { messageId: id });
				}
				if (msg.state !== "dead_letter") {
					throw new MailError(`Cannot replay message in state '${msg.state}': ${id}`, {
						messageId: id,
					});
				}
				replayDlqStmt.run({ $id: id });
			})();
		},

		replayDlqBatch(ids: string[]): number {
			if (ids.length === 0) return 0;
			replayDlqBatchTransaction(ids);
			return ids.length;
		},

		purgeDlq(options): number {
			const conditions: string[] = ["state = 'dead_letter'"];
			const params: Record<string, string> = {};

			if (options?.olderThanMs !== undefined) {
				const cutoff = new Date(Date.now() - options.olderThanMs).toISOString();
				conditions.push("created_at < $cutoff");
				params.$cutoff = cutoff;
			}
			if (options?.agent !== undefined) {
				conditions.push("to_agent = $agent");
				params.$agent = options.agent;
			}

			const sql = `DELETE FROM messages WHERE ${conditions.join(" AND ")} RETURNING id`;
			let stmt = stmtCache.get(sql);
			if (!stmt) {
				stmt = db.prepare(sql);
				stmtCache.set(sql, stmt);
			}
			const deleted = (
				stmt as ReturnType<typeof db.prepare<{ id: string }, Record<string, string>>>
			).all(params);
			return deleted.length;
		},

		purge(options: { all?: boolean; olderThanMs?: number; agent?: string }): number {
			if (options.all) {
				const sql = "DELETE FROM messages RETURNING id";
				let stmt = stmtCache.get(sql);
				if (!stmt) {
					stmt = db.prepare(sql);
					stmtCache.set(sql, stmt);
				}
				return (stmt as ReturnType<typeof db.prepare<{ id: string }, []>>).all().length;
			}

			const conditions: string[] = [];
			const params: Record<string, string> = {};

			if (options.olderThanMs !== undefined) {
				const cutoff = new Date(Date.now() - options.olderThanMs).toISOString();
				conditions.push("created_at < $cutoff");
				params.$cutoff = cutoff;
			}

			if (options.agent !== undefined) {
				conditions.push("(from_agent = $agent OR to_agent = $agent)");
				params.$agent = options.agent;
			}

			if (conditions.length === 0) {
				return 0;
			}

			const sql = `DELETE FROM messages WHERE ${conditions.join(" AND ")} RETURNING id`;
			let stmt = stmtCache.get(sql);
			if (!stmt) {
				stmt = db.prepare(sql);
				stmtCache.set(sql, stmt);
			}
			const deleted = (
				stmt as ReturnType<typeof db.prepare<{ id: string }, Record<string, string>>>
			).all(params);
			return deleted.length;
		},

		recordMailCheck(agent: string): void {
			recordMailCheckStmt.run({ $agent: agent, $now: Date.now() });
		},

		isMailCheckDebounced(agent: string, debounceMs: number): boolean {
			const row = getMailCheckStmt.get({ $agent: agent });
			if (!row) return false;
			return Date.now() - row.last_checked_at < debounceMs;
		},

		close(): void {
			// Checkpoint WAL to ensure all written data is visible to other processes
			// that may open the database after this connection closes.
			try {
				db.exec("PRAGMA wal_checkpoint(PASSIVE)");
			} catch {
				// Best effort — checkpoint failure is non-fatal
			}
			db.close();
		},
	};
}
