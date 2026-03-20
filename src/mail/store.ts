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
		> & { payload?: string | null },
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
			> & { payload?: string | null }
		>,
	): MailMessage[];

	getUnread(agentName: string): MailMessage[];
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
	claim(agentName: string, leaseTimeoutSec?: number): MailMessage[];

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

	/** Purge dead-letter messages. Returns the number deleted. */
	purgeDlq(options?: { olderThanMs?: number; agent?: string }): number;

	/** Delete messages matching the given criteria. Returns the number of messages deleted. */
	purge(options: { all?: boolean; olderThanMs?: number; agent?: string }): number;
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
}

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
  fail_reason TEXT
)`;

/**
 * Migrate an existing messages table to the current schema.
 *
 * Handles migration paths:
 * 1. Tables without CHECK constraints → recreate with constraints
 * 2. Tables without payload column → add payload column
 * 3. Tables with old CHECK constraints (missing protocol types) → recreate with new types
 * 4. Tables without delivery state columns → recreate with state/claimed_at/attempt/next_retry_at/fail_reason
 *
 * SQLite does not support ALTER TABLE ADD CONSTRAINT, so constraint changes
 * require recreating the table.
 */
function migrateSchema(db: Database): void {
	const row = db
		.prepare<{ sql: string }, []>(
			"SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'",
		)
		.get();
	if (!row) {
		// Table doesn't exist yet; CREATE TABLE IF NOT EXISTS will handle it
		return;
	}

	const hasCheckConstraints = row.sql.includes("CHECK");
	const hasPayloadColumn = row.sql.includes("payload");
	const hasCurrentTypeSet = MAIL_MESSAGE_TYPES.every((type) => row.sql.includes(`'${type}'`));
	const hasStateColumn = row.sql.includes("state");
	const hasCurrentStateSet = MAIL_DELIVERY_STATES.every((s) => row.sql.includes(`'${s}'`));

	// If schema is fully up to date, nothing to do
	if (
		hasCheckConstraints &&
		hasPayloadColumn &&
		hasCurrentTypeSet &&
		hasStateColumn &&
		hasCurrentStateSet
	) {
		return;
	}

	// Need to recreate the table for state columns, missing CHECK constraints, or type update
	const validTypes = MAIL_MESSAGE_TYPES.map((t) => `'${t}'`).join(",");
	const validStates = MAIL_DELIVERY_STATES.map((s) => `'${s}'`).join(",");
	const oldHasPayload = row.sql.includes("payload");
	const oldHasState = row.sql.includes("state");
	const payloadSelect = oldHasPayload ? "payload" : "NULL";

	db.exec("BEGIN TRANSACTION");
	try {
		db.exec("ALTER TABLE messages RENAME TO messages_old");
		db.exec(`
CREATE TABLE messages (
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
)`);

		if (oldHasState) {
			// Already had state columns — copy as-is
			db.exec(`
INSERT INTO messages (id, from_agent, to_agent, subject, body, type, priority, thread_id, payload, read, created_at, state, claimed_at, attempt, next_retry_at, fail_reason)
SELECT id, from_agent, to_agent, subject, body,
  CASE WHEN type IN (${validTypes}) THEN type ELSE 'status' END,
  CASE WHEN priority IN ('low','normal','high','urgent') THEN priority ELSE 'normal' END,
  thread_id, ${payloadSelect}, read, created_at,
  CASE WHEN state IN (${validStates}) THEN state ELSE 'queued' END,
  claimed_at, COALESCE(attempt, 0), next_retry_at, fail_reason
FROM messages_old`);
		} else {
			// No state columns — map read=1 to acked, read=0 to queued
			db.exec(`
INSERT INTO messages (id, from_agent, to_agent, subject, body, type, priority, thread_id, payload, read, created_at, state, claimed_at, attempt, next_retry_at, fail_reason)
SELECT id, from_agent, to_agent, subject, body,
  CASE WHEN type IN (${validTypes}) THEN type ELSE 'status' END,
  CASE WHEN priority IN ('low','normal','high','urgent') THEN priority ELSE 'normal' END,
  thread_id, ${payloadSelect}, read, created_at,
  CASE WHEN read = 1 THEN 'acked' ELSE 'queued' END,
  NULL, 0, NULL, NULL
FROM messages_old`);
		}

		db.exec("DROP TABLE messages_old");
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_state ON messages(to_agent, state, next_retry_at)`;

/** Generate a random 12-character alphanumeric ID. */
function randomId(): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	const bytes = new Uint8Array(12);
	crypto.getRandomValues(bytes);
	let result = "";
	for (let i = 0; i < 12; i++) {
		const byte = bytes[i];
		if (byte !== undefined) {
			result += chars[byte % chars.length];
		}
	}
	return result;
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

	// Migrate existing tables to current schema (no-op if table is new or already migrated)
	migrateSchema(db);

	// Create schema (if table doesn't exist yet, creates with CHECK constraints)
	db.exec(CREATE_TABLE);
	db.exec(CREATE_INDEXES);

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
		}
	>(`
		INSERT INTO messages
			(id, from_agent, to_agent, subject, body, type, priority, thread_id, payload, read, created_at, state)
		VALUES
			($id, $from_agent, $to_agent, $subject, $body, $type, $priority, $thread_id, $payload, $read, $created_at, $state)
	`);

	const getByIdStmt = db.prepare<MessageRow, { $id: string }>(`
		SELECT * FROM messages WHERE id = $id
	`);

	const getUnreadStmt = db.prepare<MessageRow, { $to_agent: string }>(`
		SELECT * FROM messages
		WHERE to_agent = $to_agent
		  AND state = 'queued'
		  AND (next_retry_at IS NULL OR next_retry_at <= datetime('now'))
		ORDER BY created_at ASC
	`);

	const getByThreadStmt = db.prepare<MessageRow, { $thread_id: string }>(`
		SELECT * FROM messages WHERE thread_id = $thread_id ORDER BY created_at ASC
	`);

	const markReadStmt = db.prepare<void, { $id: string }>(`
		UPDATE messages SET read = 1, state = 'acked' WHERE id = $id
	`);

	// Claim: expire stale claims (scoped to agent), then atomically claim
	const expireClaimsStmt = db.prepare<void, { $timeout_sec: number; $to_agent: string }>(`
		UPDATE messages
		SET state = 'queued', claimed_at = NULL
		WHERE state = 'claimed'
		  AND to_agent = $to_agent
		  AND claimed_at < datetime('now', '-' || $timeout_sec || ' seconds')
	`);

	const promoteRetryableStmt = db.prepare<void, []>(`
		UPDATE messages
		SET state = 'queued', next_retry_at = NULL
		WHERE state = 'failed'
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
		)
		RETURNING *
	`);

	const ackStmt = db.prepare<void, { $id: string }>(`
		UPDATE messages SET state = 'acked', read = 1 WHERE id = $id
	`);

	const nackDeadLetterStmt = db.prepare<
		void,
		{ $id: string; $reason: string | null; $attempt: number }
	>(`
		UPDATE messages
		SET state = 'dead_letter', attempt = $attempt, fail_reason = $reason,
		    claimed_at = NULL, next_retry_at = NULL
		WHERE id = $id
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
		WHERE id = $id
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

	// Wrap multiple acks in a transaction for batch processing
	const ackBatchTransaction = db.transaction((ids: string[]) => {
		for (const id of ids) {
			ackStmt.run({ $id: id });
		}
	});

	// Wrap claim steps in a transaction for atomicity
	const claimTransaction = db.transaction((agentName: string, timeoutSec: number): MessageRow[] => {
		// Step 1: Expire stale claims for this agent's messages
		expireClaimsStmt.run({
			$timeout_sec: timeoutSec,
			$to_agent: agentName,
		});

		// Step 2: Promote retryable failed messages
		promoteRetryableStmt.run();

		// Step 3: Atomically claim all available messages
		return claimStmt.all({ $to_agent: agentName });
	});

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
				});
			}
		},
	);

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
		const limitClause = filters?.limit !== undefined ? ` LIMIT $limit` : "";
		if (filters?.limit !== undefined) {
			params.$limit = filters.limit;
		}
		const query = `SELECT * FROM messages ${whereClause} ORDER BY created_at DESC${limitClause}`;
		const stmt = db.prepare<MessageRow, Record<string, string | number>>(query);
		const rows = stmt.all(params);
		return rows.map(rowToMessage);
	}

	return {
		insert(message): MailMessage {
			const id = message.id || `msg-${randomId()}`;
			const createdAt = new Date().toISOString();
			const payload = message.payload ?? null;

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

		getUnread(agentName: string): MailMessage[] {
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

		claim(agentName: string, leaseTimeoutSec?: number): MailMessage[] {
			const timeout = leaseTimeoutSec ?? DEFAULT_LEASE_TIMEOUT_SEC;
			const rows = claimTransaction(agentName, timeout);
			return rows.map(rowToMessage);
		},

		ack(id: string, agentName?: string): void {
			const msg = getByIdStmt.get({ $id: id });
			if (!msg) {
				throw new MailError(`Message not found: ${id}`, { messageId: id });
			}
			if (msg.state !== "claimed") {
				throw new MailError(`Cannot ack message in state '${msg.state}': ${id}`, { messageId: id });
			}
			if (agentName !== undefined && msg.to_agent !== agentName) {
				throw new MailError(
					`Agent '${agentName}' cannot ack message owned by '${msg.to_agent}': ${id}`,
					{ messageId: id },
				);
			}
			ackStmt.run({ $id: id });
		},

		ackBatch(ids: string[]): void {
			if (ids.length === 0) return;
			ackBatchTransaction(ids);
		},

		nack(id, options): { deadLettered: boolean } {
			const msg = getByIdStmt.get({ $id: id });
			if (!msg) {
				throw new MailError(`Message not found: ${id}`, { messageId: id });
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

			// Compute exponential backoff: base * 2^attempt, capped at max
			const delaySec = Math.min(backoffBaseSec * 2 ** msg.attempt, backoffMaxSec);
			nackRetryStmt.run({
				$id: id,
				$reason: reason,
				$attempt: newAttempt,
				$delay_sec: delaySec,
			});
			return { deadLettered: false };
		},

		getDlq(filters): MailMessage[] {
			const limit = filters?.limit ?? -1;
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

			const whereClause = conditions.join(" AND ");
			const deleted = db
				.prepare<{ id: string }, Record<string, string>>(
					`DELETE FROM messages WHERE ${whereClause} RETURNING id`,
				)
				.all(params);
			return deleted.length;
		},

		purge(options: { all?: boolean; olderThanMs?: number; agent?: string }): number {
			if (options.all) {
				const deleted = db.prepare<{ id: string }, []>("DELETE FROM messages RETURNING id").all();
				return deleted.length;
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

			const whereClause = conditions.join(" AND ");
			const deleted = db
				.prepare<{ id: string }, Record<string, string>>(
					`DELETE FROM messages WHERE ${whereClause} RETURNING id`,
				)
				.all(params);
			return deleted.length;
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
