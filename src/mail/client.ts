/**
 * Mail client for inter-agent messaging.
 *
 * Wraps the low-level MailStore with higher-level operations:
 * send, check, checkInject (hook format), list, markRead, reply.
 * Synchronous by design (bun:sqlite is sync, ~1-5ms per query).
 *
 * v2: check/checkInject now use claim+ack internally for crash-safe delivery.
 * New methods: claim, ack, nack, sendBroadcast, getDlq, replayDlq.
 */

import { MailError } from "../errors.ts";
import type { MailDeliveryState, MailMessage, MailPayloadMap, MailProtocolType } from "../types.ts";
import { canonicalizeMailAgentName, expandMailAgentNames } from "./identity.ts";
import type { MailStore } from "./store.ts";

export interface MailClient {
	/** Send a new message. Returns the assigned message ID. */
	send(msg: {
		from: string;
		to: string;
		subject: string;
		body: string;
		type?: MailMessage["type"];
		priority?: MailMessage["priority"];
		threadId?: string;
		payload?: string;
		missionId?: string;
	}): string;

	/** Send a typed protocol message with structured payload. Returns the message ID. */
	sendProtocol<T extends MailProtocolType>(msg: {
		from: string;
		to: string;
		subject: string;
		body: string;
		type: T;
		priority?: MailMessage["priority"];
		threadId?: string;
		payload: MailPayloadMap[T];
		missionId?: string;
	}): string;

	/** Send to multiple recipients atomically. Returns message IDs. */
	sendBroadcast(msg: {
		from: string;
		to: string[];
		subject: string;
		body: string;
		type?: MailMessage["type"];
		priority?: MailMessage["priority"];
		threadId?: string;
		payload?: string;
		missionId?: string;
	}): string[];

	/** Get unread messages for an agent. Uses claim+ack for crash-safe delivery. */
	check(agentName: string, missionId?: string): MailMessage[];

	/** Get unread messages formatted for hook injection (human-readable string). */
	checkInject(agentName: string, missionId?: string): string;

	/** Claim messages with lease. Returns claimed messages without acking. */
	claim(agentName: string, leaseTimeoutSec?: number, missionId?: string): MailMessage[];

	/** Acknowledge a claimed message as successfully processed. */
	ack(id: string): void;

	/** Negative-acknowledge a claimed message. Retries or dead-letters. */
	nack(
		id: string,
		reason?: string,
		options?: {
			maxAttempts?: number;
			backoffBaseSec?: number;
			backoffMaxSec?: number;
		},
	): { deadLettered: boolean };

	/** Query dead-letter queue. */
	getDlq(filters?: { agent?: string; limit?: number }): MailMessage[];

	/** Replay a dead-lettered message back to the queue. */
	replayDlq(id: string): void;

	/** Replay multiple dead-lettered messages in a single transaction. Returns count replayed. */
	replayDlqBatch(ids: string[]): number;

	/** List messages with optional filters. */
	list(filters?: {
		from?: string;
		to?: string;
		unread?: boolean;
		state?: MailDeliveryState;
	}): MailMessage[];

	/** Mark a message as read by ID. Returns whether the message was already read. */
	markRead(id: string): { alreadyRead: boolean };

	/** Reply to a message. Returns the full reply message. */
	reply(messageId: string, body: string, from: string): MailMessage;

	/** Close the underlying store. */
	close(): void;
}

/**
 * Parse a JSON payload from a mail message, returning the typed object.
 * Returns null if the message has no payload or if parsing fails.
 */
export function parsePayload<T extends MailProtocolType>(
	message: MailMessage,
	_expectedType: T,
): MailPayloadMap[T] | null {
	if (message.payload === null) {
		return null;
	}
	try {
		return JSON.parse(message.payload) as MailPayloadMap[T];
	} catch {
		return null;
	}
}

/** Protocol types that represent structured coordination messages. */
const PROTOCOL_TYPES = new Set<string>([
	"worker_done",
	"merge_ready",
	"merged",
	"merge_failed",
	"escalation",
	"health_check",
	"dispatch",
	"assign",
	"rate_limited",
	"mission_finding",
	"analyst_resolution",
	"execution_guidance",
	"analyst_recommendation",
	"execution_handoff",
	"mission_resolution",
	"plan_review_request",
	"plan_critic_verdict",
	"plan_review_consolidated",
	"plan_revision_complete",
	"decision_gate",
]);

/**
 * Format messages for hook injection.
 *
 * Produces a human-readable block that gets injected into the agent's
 * context via the UserPromptSubmit hook.
 */
function formatForInjection(messages: MailMessage[]): string {
	if (messages.length === 0) {
		return "";
	}

	const lines: string[] = [
		`You have ${messages.length} new message${messages.length === 1 ? "" : "s"}:`,
		"",
	];

	for (const msg of messages) {
		const priorityTag = msg.priority !== "normal" ? ` [${msg.priority.toUpperCase()}]` : "";
		lines.push(`--- From: ${msg.from}${priorityTag} (${msg.type}) ---`);
		lines.push(`Subject: ${msg.subject}`);
		lines.push(msg.body);
		if (msg.payload !== null && PROTOCOL_TYPES.has(msg.type)) {
			lines.push(`Payload: ${msg.payload}`);
		}
		lines.push(`[Reply with: ov mail reply ${msg.id} --body "..."]`);
		lines.push("");
	}

	return lines.join("\n");
}

function sortMessagesAscending(messages: MailMessage[]): MailMessage[] {
	return [...messages].sort((left, right) => {
		const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
		if (byCreatedAt !== 0) {
			return byCreatedAt;
		}
		return left.id.localeCompare(right.id);
	});
}

function sortMessagesDescending(messages: MailMessage[]): MailMessage[] {
	return [...messages].sort((left, right) => {
		const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
		if (byCreatedAt !== 0) {
			return byCreatedAt;
		}
		return right.id.localeCompare(left.id);
	});
}

function collectMessagesForMailbox(
	store: MailStore,
	agentName: string,
	leaseTimeoutSec?: number,
	missionId?: string,
): MailMessage[] {
	const messages: MailMessage[] = [];
	for (const mailboxName of expandMailAgentNames(agentName)) {
		messages.push(...store.claim(mailboxName, leaseTimeoutSec, missionId));
	}
	return sortMessagesAscending(messages);
}

function listMessagesForMailbox(
	store: MailStore,
	filters?: {
		from?: string;
		to?: string;
		unread?: boolean;
		state?: MailDeliveryState;
	},
): MailMessage[] {
	if (!filters?.from && !filters?.to) {
		return store.getAll(filters);
	}

	const fromNames = filters.from ? expandMailAgentNames(filters.from) : [undefined];
	const toNames = filters.to ? expandMailAgentNames(filters.to) : [undefined];
	const seen = new Set<string>();
	const messages: MailMessage[] = [];

	for (const fromName of fromNames) {
		for (const toName of toNames) {
			const batch = store.getAll({
				from: fromName,
				to: toName,
				unread: filters.unread,
				state: filters.state,
			});
			for (const message of batch) {
				if (seen.has(message.id)) {
					continue;
				}
				seen.add(message.id);
				messages.push(message);
			}
		}
	}

	return sortMessagesDescending(messages);
}

function listDlqMessagesForMailbox(
	store: MailStore,
	filters?: { agent?: string; limit?: number },
): MailMessage[] {
	if (!filters?.agent) {
		return store.getDlq(filters);
	}

	const seen = new Set<string>();
	const messages: MailMessage[] = [];
	for (const mailboxName of expandMailAgentNames(filters.agent)) {
		const batch = store.getDlq({ agent: mailboxName, limit: filters.limit });
		for (const message of batch) {
			if (seen.has(message.id)) {
				continue;
			}
			seen.add(message.id);
			messages.push(message);
		}
	}

	const sorted = sortMessagesDescending(messages);
	return sorted.slice(0, filters.limit ?? sorted.length);
}

/**
 * Create a MailClient wrapping the given MailStore.
 *
 * @param store - The underlying MailStore for persistence
 * @returns A MailClient with send, check, checkInject, list, markRead, reply, claim, ack, nack
 */
export function createMailClient(store: MailStore): MailClient {
	return {
		send(msg): string {
			const message = store.insert({
				id: "",
				from: canonicalizeMailAgentName(msg.from),
				to: canonicalizeMailAgentName(msg.to),
				subject: msg.subject,
				body: msg.body,
				type: msg.type ?? "status",
				priority: msg.priority ?? "normal",
				threadId: msg.threadId ?? null,
				payload: msg.payload ?? null,
				missionId: msg.missionId ?? null,
			});
			return message.id;
		},

		sendProtocol(msg): string {
			const message = store.insert({
				id: "",
				from: canonicalizeMailAgentName(msg.from),
				to: canonicalizeMailAgentName(msg.to),
				subject: msg.subject,
				body: msg.body,
				type: msg.type,
				priority: msg.priority ?? "normal",
				threadId: msg.threadId ?? null,
				payload: JSON.stringify(msg.payload),
				missionId: msg.missionId ?? null,
			});
			return message.id;
		},

		sendBroadcast(msg): string[] {
			const messages = msg.to.map((recipient) => ({
				id: "",
				from: canonicalizeMailAgentName(msg.from),
				to: canonicalizeMailAgentName(recipient),
				subject: msg.subject,
				body: msg.body,
				type: msg.type ?? ("status" as const),
				priority: msg.priority ?? ("normal" as const),
				threadId: msg.threadId ?? null,
				payload: msg.payload ?? null,
				missionId: msg.missionId ?? null,
			}));

			const inserted = store.insertBatch(messages);
			return inserted.map((m) => m.id);
		},

		check(agentName, missionId): MailMessage[] {
			// v2: claim+ackBatch for at-most-once delivery.
			// Messages are immediately acked after claim — if the caller crashes
			// after this returns but before processing, messages are lost.
			// For at-least-once semantics, use claim() + ack() per-message instead.
			const messages = collectMessagesForMailbox(store, agentName, undefined, missionId);
			store.ackBatch(messages.map((m) => m.id));
			return messages;
		},

		checkInject(agentName, missionId): string {
			// v2: claim+ackBatch for at-most-once delivery (see check() comment)
			const messages = collectMessagesForMailbox(store, agentName, undefined, missionId);
			store.ackBatch(messages.map((m) => m.id));
			return formatForInjection(messages);
		},

		claim(agentName, leaseTimeoutSec, missionId): MailMessage[] {
			return collectMessagesForMailbox(store, agentName, leaseTimeoutSec, missionId);
		},

		ack(id): void {
			store.ack(id);
		},

		nack(id, reason, options): { deadLettered: boolean } {
			return store.nack(id, { reason, ...options });
		},

		getDlq(filters): MailMessage[] {
			return listDlqMessagesForMailbox(store, filters);
		},

		replayDlq(id): void {
			store.replayDlq(id);
		},

		replayDlqBatch(ids): number {
			return store.replayDlqBatch(ids);
		},

		list(filters): MailMessage[] {
			return listMessagesForMailbox(store, filters);
		},

		markRead(id): { alreadyRead: boolean } {
			const msg = store.getById(id);
			if (!msg) {
				throw new MailError(`Message not found: ${id}`, {
					messageId: id,
				});
			}
			// markRead() only updates queued/claimed messages (state guard in SQL).
			// If the message is already acked/dead_letter/failed, it's a no-op —
			// derive alreadyRead from the current state rather than a separate read.
			store.markRead(id);
			return { alreadyRead: msg.read };
		},

		reply(messageId, body, from): MailMessage {
			const original = store.getById(messageId);
			if (!original) {
				throw new MailError(`Message not found: ${messageId}`, {
					messageId,
				});
			}

			const threadId = original.threadId ?? original.id;
			const canonicalFrom = canonicalizeMailAgentName(from);
			const originalFrom = canonicalizeMailAgentName(original.from);
			const originalTo = canonicalizeMailAgentName(original.to);

			// Determine the correct recipient: reply goes to "the other side"
			// If the replier is the original sender, reply goes to the original recipient.
			// If the replier is the original recipient (or anyone else), reply goes to the original sender.
			const to = canonicalFrom === originalFrom ? originalTo : originalFrom;

			return store.insert({
				id: "",
				from: canonicalFrom,
				to,
				subject: `Re: ${original.subject}`,
				body,
				type: original.type,
				priority: original.priority,
				threadId,
				payload: null,
			});
		},

		close(): void {
			store.close();
		},
	};
}
