import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailError } from "../errors.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import { MAIL_MESSAGE_TYPES, type MailMessage } from "../types.ts";
import { createMailStore, type MailStore } from "./store.ts";

describe("createMailStore", () => {
	let tempDir: string;
	let store: MailStore;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-mail-test-"));
		store = createMailStore(join(tempDir, "mail.db"));
	});

	afterEach(async () => {
		store.close();
		await cleanupTempDir(tempDir);
	});

	describe("insert", () => {
		test("inserts a message and returns it with generated id and timestamp", () => {
			const msg = store.insert({
				id: "",
				from: "agent-a",
				to: "orchestrator",
				subject: "status update",
				body: "All tests passing",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			expect(msg.id).toMatch(/^msg-[a-z0-9]{12}$/);
			expect(msg.from).toBe("agent-a");
			expect(msg.to).toBe("orchestrator");
			expect(msg.subject).toBe("status update");
			expect(msg.body).toBe("All tests passing");
			expect(msg.type).toBe("status");
			expect(msg.priority).toBe("normal");
			expect(msg.threadId).toBeNull();
			expect(msg.read).toBe(false);
			expect(msg.createdAt).toBeTruthy();
		});

		test("uses provided id if non-empty", () => {
			const msg = store.insert({
				id: "custom-id-123",
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "test body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			expect(msg.id).toBe("custom-id-123");
		});

		test("throws MailError on duplicate id", () => {
			store.insert({
				id: "dupe-id",
				from: "agent-a",
				to: "orchestrator",
				subject: "first",
				body: "first message",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			expect(() =>
				store.insert({
					id: "dupe-id",
					from: "agent-b",
					to: "orchestrator",
					subject: "second",
					body: "second message",
					type: "status",
					priority: "normal",
					threadId: null,
				}),
			).toThrow(MailError);
		});
	});

	describe("getById", () => {
		test("returns message by id", () => {
			store.insert({
				id: "msg-test-001",
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			const msg = store.getById("msg-test-001");
			expect(msg).not.toBeNull();
			expect(msg?.id).toBe("msg-test-001");
			expect(msg?.from).toBe("agent-a");
		});

		test("returns null for non-existent id", () => {
			const msg = store.getById("nonexistent");
			expect(msg).toBeNull();
		});
	});

	describe("getUnread", () => {
		test("returns unread messages for a specific agent", () => {
			store.insert({
				id: "",
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.insert({
				id: "",
				from: "agent-b",
				to: "orchestrator",
				subject: "msg2",
				body: "body2",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.insert({
				id: "",
				from: "agent-a",
				to: "agent-c",
				subject: "msg3",
				body: "body3",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			const unread = store.getUnread("orchestrator");
			expect(unread).toHaveLength(2);
			expect(unread[0]?.subject).toBe("msg1");
			expect(unread[1]?.subject).toBe("msg2");
		});

		test("returns empty array when no unread messages", () => {
			const unread = store.getUnread("orchestrator");
			expect(unread).toHaveLength(0);
		});

		test("does not return already-read messages", () => {
			const msg = store.insert({
				id: "",
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.markRead(msg.id);

			const unread = store.getUnread("orchestrator");
			expect(unread).toHaveLength(0);
		});

		test("returns messages in chronological order (ASC)", () => {
			store.insert({
				id: "msg-first",
				from: "agent-a",
				to: "orchestrator",
				subject: "first",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.insert({
				id: "msg-second",
				from: "agent-b",
				to: "orchestrator",
				subject: "second",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			const unread = store.getUnread("orchestrator");
			expect(unread[0]?.id).toBe("msg-first");
			expect(unread[1]?.id).toBe("msg-second");
		});
	});

	describe("markRead", () => {
		test("marks a message as read", () => {
			const msg = store.insert({
				id: "msg-to-read",
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			store.markRead(msg.id);

			const fetched = store.getById(msg.id);
			expect(fetched?.read).toBe(true);
		});

		test("is idempotent (marking already-read message does not error)", () => {
			const msg = store.insert({
				id: "msg-idempotent",
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			store.markRead(msg.id);
			store.markRead(msg.id);

			const fetched = store.getById(msg.id);
			expect(fetched?.read).toBe(true);
		});
	});

	describe("getAll", () => {
		test("returns all messages without filters", () => {
			store.insert({
				id: "",
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.insert({
				id: "",
				from: "agent-b",
				to: "agent-c",
				subject: "msg2",
				body: "body2",
				type: "question",
				priority: "high",
				threadId: null,
			});

			const all = store.getAll();
			expect(all).toHaveLength(2);
		});

		test("filters by from", () => {
			store.insert({
				id: "",
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.insert({
				id: "",
				from: "agent-b",
				to: "orchestrator",
				subject: "msg2",
				body: "body2",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			const filtered = store.getAll({ from: "agent-a" });
			expect(filtered).toHaveLength(1);
			expect(filtered[0]?.from).toBe("agent-a");
		});

		test("filters by to", () => {
			store.insert({
				id: "",
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.insert({
				id: "",
				from: "agent-a",
				to: "agent-b",
				subject: "msg2",
				body: "body2",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			const filtered = store.getAll({ to: "agent-b" });
			expect(filtered).toHaveLength(1);
			expect(filtered[0]?.to).toBe("agent-b");
		});

		test("filters by unread", () => {
			const msg1 = store.insert({
				id: "",
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.insert({
				id: "",
				from: "agent-b",
				to: "orchestrator",
				subject: "msg2",
				body: "body2",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.markRead(msg1.id);

			const unreadOnly = store.getAll({ unread: true });
			expect(unreadOnly).toHaveLength(1);
			expect(unreadOnly[0]?.subject).toBe("msg2");

			const readOnly = store.getAll({ unread: false });
			expect(readOnly).toHaveLength(1);
			expect(readOnly[0]?.subject).toBe("msg1");
		});

		test("respects limit option", () => {
			for (let i = 1; i <= 5; i++) {
				store.insert({
					id: "",
					from: "agent-a",
					to: "orchestrator",
					subject: `msg${i}`,
					body: `body${i}`,
					type: "status",
					priority: "normal",
					threadId: null,
				});
			}

			const limited = store.getAll({ limit: 3 });
			expect(limited).toHaveLength(3);
		});

		test("limit combined with filter", () => {
			for (let i = 1; i <= 4; i++) {
				store.insert({
					id: "",
					from: "agent-a",
					to: "orchestrator",
					subject: `a-msg${i}`,
					body: `body`,
					type: "status",
					priority: "normal",
					threadId: null,
				});
			}
			store.insert({
				id: "",
				from: "agent-b",
				to: "orchestrator",
				subject: "b-msg",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			const limited = store.getAll({ from: "agent-a", limit: 2 });
			expect(limited).toHaveLength(2);
			expect(limited.every((m) => m.from === "agent-a")).toBe(true);
		});

		test("combines multiple filters", () => {
			store.insert({
				id: "",
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.insert({
				id: "",
				from: "agent-a",
				to: "agent-b",
				subject: "msg2",
				body: "body2",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.insert({
				id: "",
				from: "agent-b",
				to: "orchestrator",
				subject: "msg3",
				body: "body3",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			const filtered = store.getAll({ from: "agent-a", to: "orchestrator" });
			expect(filtered).toHaveLength(1);
			expect(filtered[0]?.subject).toBe("msg1");
		});
	});

	describe("getByThread", () => {
		test("returns messages in the same thread", () => {
			store.insert({
				id: "msg-thread-1",
				from: "agent-a",
				to: "orchestrator",
				subject: "question",
				body: "first message",
				type: "question",
				priority: "normal",
				threadId: "thread-123",
			});
			store.insert({
				id: "msg-thread-2",
				from: "orchestrator",
				to: "agent-a",
				subject: "Re: question",
				body: "reply",
				type: "status",
				priority: "normal",
				threadId: "thread-123",
			});
			store.insert({
				id: "msg-other",
				from: "agent-b",
				to: "orchestrator",
				subject: "unrelated",
				body: "different thread",
				type: "status",
				priority: "normal",
				threadId: "thread-456",
			});

			const thread = store.getByThread("thread-123");
			expect(thread).toHaveLength(2);
			expect(thread[0]?.id).toBe("msg-thread-1");
			expect(thread[1]?.id).toBe("msg-thread-2");
		});

		test("returns empty array for non-existent thread", () => {
			const thread = store.getByThread("nonexistent");
			expect(thread).toHaveLength(0);
		});
	});

	describe("WAL mode and concurrent access", () => {
		test("second store instance can read while first is writing", () => {
			const store2 = createMailStore(join(tempDir, "mail.db"));

			store.insert({
				id: "msg-concurrent",
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "concurrent",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			const msg = store2.getById("msg-concurrent");
			expect(msg).not.toBeNull();
			expect(msg?.body).toBe("concurrent");

			store2.close();
		});
	});

	describe("CHECK constraints", () => {
		test("rejects invalid type at DB level", () => {
			expect(() =>
				store.insert({
					id: "msg-bad-type",
					from: "agent-a",
					to: "orchestrator",
					subject: "test",
					body: "body",
					type: "invalid_type" as MailMessage["type"],
					priority: "normal",
					threadId: null,
				}),
			).toThrow();
		});

		test("rejects invalid priority at DB level", () => {
			expect(() =>
				store.insert({
					id: "msg-bad-prio",
					from: "agent-a",
					to: "orchestrator",
					subject: "test",
					body: "body",
					type: "status",
					priority: "invalid_prio" as MailMessage["priority"],
					threadId: null,
				}),
			).toThrow();
		});

		test("accepts all valid type values including protocol types", () => {
			const types: MailMessage["type"][] = [...MAIL_MESSAGE_TYPES];
			for (const type of types) {
				const msg = store.insert({
					id: "",
					from: "agent-a",
					to: "orchestrator",
					subject: `type-${type}`,
					body: "body",
					type,
					priority: "normal",
					threadId: null,
				});
				expect(msg.type).toBe(type);
			}
		});

		test("accepts all valid priority values", () => {
			const priorities: MailMessage["priority"][] = ["low", "normal", "high", "urgent"];
			for (const priority of priorities) {
				const msg = store.insert({
					id: "",
					from: "agent-a",
					to: "orchestrator",
					subject: `prio-${priority}`,
					body: "body",
					type: "status",
					priority,
					threadId: null,
				});
				expect(msg.priority).toBe(priority);
			}
		});

		test("migrates existing table to add payload column and protocol types", () => {
			const legacyPath = join(tempDir, "legacy-mail.db");
			const legacyDb = new Database(legacyPath);
			legacyDb.exec(`
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'status' CHECK(type IN ('status','question','result','error','worker_done','merge_ready','merged','merge_failed','escalation','health_check','dispatch','assign')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  thread_id TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_inbox ON messages(to_agent, read);
CREATE INDEX idx_thread ON messages(thread_id);
`);
			legacyDb.close();

			const store2 = createMailStore(legacyPath);
			const msg = store2.insert({
				id: "msg-after-migration",
				from: "agent-a",
				to: "orchestrator",
				subject: "migration test",
				body: "body",
				type: "execution_handoff",
				priority: "normal",
				threadId: null,
				payload: JSON.stringify({ missionId: "mission-1", handoffs: [] }),
			});
			expect(msg.id).toBe("msg-after-migration");
			expect(msg.type).toBe("execution_handoff");
			expect(store2.getById("msg-after-migration")?.payload).toContain("mission-1");

			// Invalid values should still be rejected
			expect(() =>
				store2.insert({
					id: "msg-bad-after",
					from: "agent-a",
					to: "orchestrator",
					subject: "test",
					body: "body",
					type: "bogus" as MailMessage["type"],
					priority: "normal",
					threadId: null,
				}),
			).toThrow();

			store2.close();
		});
	});

	describe("payload column", () => {
		test("stores null payload by default when not provided", () => {
			const msg = store.insert({
				id: "msg-no-payload",
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			const fetched = store.getById(msg.id);
			expect(fetched?.payload).toBeNull();
		});

		test("stores JSON payload string", () => {
			const payload = JSON.stringify({
				taskId: "beads-abc",
				branch: "agent/builder-1",
				exitCode: 0,
				filesModified: ["src/foo.ts"],
			});
			const msg = store.insert({
				id: "msg-with-payload",
				from: "builder-1",
				to: "lead-1",
				subject: "Task complete",
				body: "Implementation finished",
				type: "worker_done",
				priority: "normal",
				threadId: null,
				payload,
			});

			const fetched = store.getById(msg.id);
			expect(fetched?.payload).toBe(payload);
			expect(fetched?.type).toBe("worker_done");
		});

		test("returns payload in getUnread results", () => {
			const payload = JSON.stringify({ severity: "critical", taskId: null, context: "OOM" });
			store.insert({
				id: "msg-escalation",
				from: "builder-1",
				to: "orchestrator",
				subject: "Escalation",
				body: "Out of memory",
				type: "escalation",
				priority: "urgent",
				threadId: null,
				payload,
			});

			const unread = store.getUnread("orchestrator");
			expect(unread).toHaveLength(1);
			expect(unread[0]?.payload).toBe(payload);
		});

		test("returns payload in getAll results", () => {
			const payload = JSON.stringify({
				branch: "agent/b1",
				taskId: "beads-xyz",
				tier: "clean-merge",
			});
			store.insert({
				id: "msg-merged",
				from: "merger-1",
				to: "lead-1",
				subject: "Merged",
				body: "Branch merged",
				type: "merged",
				priority: "normal",
				threadId: null,
				payload,
			});

			const all = store.getAll();
			expect(all).toHaveLength(1);
			expect(all[0]?.payload).toBe(payload);
		});
	});

	describe("delivery state defaults", () => {
		test("new messages have state=queued and delivery fields", () => {
			const msg = store.insert({
				id: "msg-state-test",
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			expect(msg.state).toBe("queued");
			expect(msg.claimedAt).toBeNull();
			expect(msg.attempt).toBe(0);
			expect(msg.nextRetryAt).toBeNull();
			expect(msg.failReason).toBeNull();

			const fetched = store.getById(msg.id);
			expect(fetched?.state).toBe("queued");
		});

		test("markRead sets state to acked", () => {
			const msg = store.insert({
				id: "msg-markread-state",
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			store.markRead(msg.id);
			const fetched = store.getById(msg.id);
			expect(fetched?.state).toBe("acked");
			expect(fetched?.read).toBe(true);
		});
	});

	describe("claim", () => {
		test("returns unread messages and marks them as claimed", () => {
			store.insert({
				id: "msg-claim-1",
				from: "agent-a",
				to: "orchestrator",
				subject: "task 1",
				body: "body",
				type: "worker_done",
				priority: "normal",
				threadId: null,
			});
			store.insert({
				id: "msg-claim-2",
				from: "agent-b",
				to: "orchestrator",
				subject: "task 2",
				body: "body",
				type: "worker_done",
				priority: "normal",
				threadId: null,
			});

			const claimed = store.claim("orchestrator");
			expect(claimed).toHaveLength(2);
			expect(claimed[0]?.state).toBe("claimed");
			expect(claimed[1]?.state).toBe("claimed");
			expect(claimed[0]?.claimedAt).not.toBeNull();

			// Second claim returns empty — messages are already claimed
			const secondClaim = store.claim("orchestrator");
			expect(secondClaim).toHaveLength(0);
		});

		test("does not return messages for other agents", () => {
			store.insert({
				id: "msg-other-agent",
				from: "agent-a",
				to: "agent-b",
				subject: "not for me",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			const claimed = store.claim("orchestrator");
			expect(claimed).toHaveLength(0);
		});

		test("expires stale claims after lease timeout", () => {
			store.insert({
				id: "msg-stale",
				from: "agent-a",
				to: "orchestrator",
				subject: "will expire",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			// Claim with default timeout
			const first = store.claim("orchestrator");
			expect(first).toHaveLength(1);

			// Manually set claimed_at to 5 minutes ago to simulate timeout
			const db = new Database(join(tempDir, "mail.db"));
			db.exec(
				"UPDATE messages SET claimed_at = datetime('now', '-300 seconds') WHERE id = 'msg-stale'",
			);
			db.close();

			// Claim again with 60s timeout — the stale claim should be expired
			const second = store.claim("orchestrator", 60);
			expect(second).toHaveLength(1);
			expect(second[0]?.id).toBe("msg-stale");
		});

		test("does not return failed messages with future retry time", () => {
			store.insert({
				id: "msg-retry-later",
				from: "agent-a",
				to: "orchestrator",
				subject: "retry me",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			// Claim and nack to set a future retry
			store.claim("orchestrator");
			store.nack("msg-retry-later", { reason: "temp failure", backoffBaseSec: 3600 });

			// Claim should not return the message (retry time is in the future)
			const claimed = store.claim("orchestrator");
			expect(claimed).toHaveLength(0);
		});

		test("two agents claiming concurrently get disjoint sets", () => {
			store.insert({
				id: "msg-for-a",
				from: "sender",
				to: "agent-a",
				subject: "for a",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.insert({
				id: "msg-for-b",
				from: "sender",
				to: "agent-b",
				subject: "for b",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			const claimedA = store.claim("agent-a");
			const claimedB = store.claim("agent-b");

			expect(claimedA).toHaveLength(1);
			expect(claimedA[0]?.id).toBe("msg-for-a");
			expect(claimedB).toHaveLength(1);
			expect(claimedB[0]?.id).toBe("msg-for-b");
		});

		test("promotes failed messages with elapsed retry timer", () => {
			store.insert({
				id: "msg-promote",
				from: "agent-a",
				to: "orchestrator",
				subject: "will retry",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			// Claim and nack to put into failed state with retry
			store.claim("orchestrator");
			store.nack("msg-promote", { reason: "temp" });

			// Should not be claimable yet (retry in the future)
			const empty = store.claim("orchestrator");
			expect(empty).toHaveLength(0);

			// Manually set next_retry_at to the past
			const db = new Database(join(tempDir, "mail.db"));
			db.exec(
				"UPDATE messages SET next_retry_at = datetime('now', '-10 seconds') WHERE id = 'msg-promote'",
			);
			db.close();

			// Now claim should promote and return it
			const promoted = store.claim("orchestrator");
			expect(promoted).toHaveLength(1);
			expect(promoted[0]?.id).toBe("msg-promote");
			expect(promoted[0]?.state).toBe("claimed");
		});
	});

	describe("ack", () => {
		test("marks claimed message as acked and read", () => {
			store.insert({
				id: "msg-ack-test",
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			store.claim("orchestrator");
			store.ack("msg-ack-test");

			const msg = store.getById("msg-ack-test");
			expect(msg?.state).toBe("acked");
			expect(msg?.read).toBe(true);
		});

		test("throws on non-existent message", () => {
			expect(() => store.ack("nonexistent")).toThrow(MailError);
		});

		test("throws on message not in claimed state", () => {
			store.insert({
				id: "msg-not-claimed",
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			// Message is queued, not claimed
			expect(() => store.ack("msg-not-claimed")).toThrow(MailError);
		});

		test("throws when agentName does not match message recipient", () => {
			store.insert({
				id: "msg-ownership",
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			store.claim("orchestrator");
			expect(() => store.ack("msg-ownership", "wrong-agent")).toThrow(MailError);

			// But correct agent can ack
			store.ack("msg-ownership", "orchestrator");
			const msg = store.getById("msg-ownership");
			expect(msg?.state).toBe("acked");
		});
	});

	describe("ackBatch", () => {
		test("acks multiple messages in a single transaction", () => {
			store.insert({
				id: "msg-batch-ack-1",
				from: "agent-a",
				to: "orchestrator",
				subject: "batch 1",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.insert({
				id: "msg-batch-ack-2",
				from: "agent-b",
				to: "orchestrator",
				subject: "batch 2",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			store.claim("orchestrator");
			store.ackBatch(["msg-batch-ack-1", "msg-batch-ack-2"]);

			const m1 = store.getById("msg-batch-ack-1");
			const m2 = store.getById("msg-batch-ack-2");
			expect(m1?.state).toBe("acked");
			expect(m2?.state).toBe("acked");
		});

		test("empty batch is a no-op", () => {
			store.ackBatch([]);
		});
	});

	describe("nack", () => {
		test("increments attempt and sets retry timer", () => {
			store.insert({
				id: "msg-nack-test",
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			store.claim("orchestrator");
			const result = store.nack("msg-nack-test", { reason: "transient error" });
			expect(result.deadLettered).toBe(false);

			const msg = store.getById("msg-nack-test");
			expect(msg?.state).toBe("failed");
			expect(msg?.attempt).toBe(1);
			expect(msg?.failReason).toBe("transient error");
			expect(msg?.nextRetryAt).not.toBeNull();
			expect(msg?.claimedAt).toBeNull();
		});

		test("dead-letters after max attempts", () => {
			store.insert({
				id: "msg-dlq-test",
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			// Claim and nack 3 times (maxAttempts=3)
			store.claim("orchestrator");
			store.nack("msg-dlq-test", { maxAttempts: 3 });

			// Manually set back to claimed for second nack
			const db = new Database(join(tempDir, "mail.db"));
			db.exec("UPDATE messages SET state = 'claimed' WHERE id = 'msg-dlq-test'");

			store.nack("msg-dlq-test", { maxAttempts: 3 });
			db.exec("UPDATE messages SET state = 'claimed' WHERE id = 'msg-dlq-test'");

			const result = store.nack("msg-dlq-test", { maxAttempts: 3 });
			expect(result.deadLettered).toBe(true);
			db.close();

			const msg = store.getById("msg-dlq-test");
			expect(msg?.state).toBe("dead_letter");
			expect(msg?.attempt).toBe(3);
		});

		test("throws on non-claimed message", () => {
			store.insert({
				id: "msg-nack-bad",
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			expect(() => store.nack("msg-nack-bad")).toThrow(MailError);
		});
	});

	describe("getDlq", () => {
		test("returns dead-lettered messages", () => {
			store.insert({
				id: "msg-dlq-1",
				from: "agent-a",
				to: "orchestrator",
				subject: "dlq 1",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			// Force into dead_letter state
			store.claim("orchestrator");
			store.nack("msg-dlq-1", { maxAttempts: 1 });

			const dlq = store.getDlq();
			expect(dlq).toHaveLength(1);
			expect(dlq[0]?.id).toBe("msg-dlq-1");
			expect(dlq[0]?.state).toBe("dead_letter");
		});

		test("filters by agent", () => {
			store.insert({
				id: "msg-dlq-a",
				from: "agent-a",
				to: "orchestrator",
				subject: "for orch",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.insert({
				id: "msg-dlq-b",
				from: "agent-a",
				to: "agent-b",
				subject: "for b",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			// Dead-letter both
			store.claim("orchestrator");
			store.nack("msg-dlq-a", { maxAttempts: 1 });
			store.claim("agent-b");
			store.nack("msg-dlq-b", { maxAttempts: 1 });

			const dlq = store.getDlq({ agent: "orchestrator" });
			expect(dlq).toHaveLength(1);
			expect(dlq[0]?.id).toBe("msg-dlq-a");
		});

		test("respects limit", () => {
			for (let i = 0; i < 5; i++) {
				store.insert({
					id: `msg-dlq-limit-${i}`,
					from: "agent-a",
					to: "orchestrator",
					subject: `dlq ${i}`,
					body: "body",
					type: "status",
					priority: "normal",
					threadId: null,
				});
			}
			// Dead-letter all
			store.claim("orchestrator");
			for (let i = 0; i < 5; i++) {
				// Need to set back to claimed each time since nack moves out of claimed
				const db = new Database(join(tempDir, "mail.db"));
				db.exec(`UPDATE messages SET state = 'claimed' WHERE id = 'msg-dlq-limit-${i}'`);
				db.close();
				store.nack(`msg-dlq-limit-${i}`, { maxAttempts: 1 });
			}

			const dlq = store.getDlq({ limit: 3 });
			expect(dlq).toHaveLength(3);
		});
	});

	describe("replayDlq", () => {
		test("resets dead-lettered message to queued state", () => {
			store.insert({
				id: "msg-replay",
				from: "agent-a",
				to: "orchestrator",
				subject: "replay me",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			store.claim("orchestrator");
			store.nack("msg-replay", { maxAttempts: 1, reason: "failed" });

			const beforeReplay = store.getById("msg-replay");
			expect(beforeReplay?.state).toBe("dead_letter");

			store.replayDlq("msg-replay");

			const afterReplay = store.getById("msg-replay");
			expect(afterReplay?.state).toBe("queued");
			expect(afterReplay?.attempt).toBe(0);
			expect(afterReplay?.failReason).toBeNull();
			expect(afterReplay?.read).toBe(false);
		});

		test("throws on non-existent message", () => {
			expect(() => store.replayDlq("nonexistent")).toThrow(MailError);
		});

		test("throws on message not in dead_letter state", () => {
			store.insert({
				id: "msg-not-dlq",
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			expect(() => store.replayDlq("msg-not-dlq")).toThrow(MailError);
		});
	});

	describe("purgeDlq", () => {
		test("deletes dead-lettered messages", () => {
			store.insert({
				id: "msg-purge-dlq",
				from: "agent-a",
				to: "orchestrator",
				subject: "purge me",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			store.claim("orchestrator");
			store.nack("msg-purge-dlq", { maxAttempts: 1 });

			const count = store.purgeDlq();
			expect(count).toBe(1);
			expect(store.getDlq()).toHaveLength(0);
		});

		test("does not delete non-dead-lettered messages", () => {
			store.insert({
				id: "msg-normal",
				from: "agent-a",
				to: "orchestrator",
				subject: "keep me",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			const count = store.purgeDlq();
			expect(count).toBe(0);
			expect(store.getById("msg-normal")).not.toBeNull();
		});
	});

	describe("insertBatch", () => {
		test("inserts multiple messages atomically", () => {
			const messages = [
				{
					id: "msg-batch-1",
					from: "agent-a",
					to: "agent-b",
					subject: "batch 1",
					body: "body 1",
					type: "status" as const,
					priority: "normal" as const,
					threadId: null,
				},
				{
					id: "msg-batch-2",
					from: "agent-a",
					to: "agent-c",
					subject: "batch 2",
					body: "body 2",
					type: "status" as const,
					priority: "normal" as const,
					threadId: null,
				},
			];

			const result = store.insertBatch(messages);
			expect(result).toHaveLength(2);
			expect(result[0]?.state).toBe("queued");
			expect(result[1]?.state).toBe("queued");

			expect(store.getById("msg-batch-1")).not.toBeNull();
			expect(store.getById("msg-batch-2")).not.toBeNull();
		});

		test("rolls back on duplicate id", () => {
			store.insert({
				id: "msg-existing",
				from: "agent-a",
				to: "orchestrator",
				subject: "existing",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			expect(() =>
				store.insertBatch([
					{
						id: "msg-new-ok",
						from: "agent-a",
						to: "agent-b",
						subject: "new",
						body: "body",
						type: "status" as const,
						priority: "normal" as const,
						threadId: null,
					},
					{
						id: "msg-existing", // duplicate!
						from: "agent-a",
						to: "agent-c",
						subject: "dupe",
						body: "body",
						type: "status" as const,
						priority: "normal" as const,
						threadId: null,
					},
				]),
			).toThrow(MailError);

			// msg-new-ok should NOT exist since the batch was rolled back
			expect(store.getById("msg-new-ok")).toBeNull();
		});

		test("empty batch is a no-op", () => {
			const result = store.insertBatch([]);
			expect(result).toHaveLength(0);
		});
	});

	describe("getAll with state filter", () => {
		test("filters by delivery state", () => {
			store.insert({
				id: "msg-state-filter-1",
				from: "agent-a",
				to: "orchestrator",
				subject: "queued",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.insert({
				id: "msg-state-filter-2",
				from: "agent-a",
				to: "orchestrator",
				subject: "will be acked",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			store.markRead("msg-state-filter-2");

			const queued = store.getAll({ state: "queued" });
			expect(queued).toHaveLength(1);
			expect(queued[0]?.id).toBe("msg-state-filter-1");

			const acked = store.getAll({ state: "acked" });
			expect(acked).toHaveLength(1);
			expect(acked[0]?.id).toBe("msg-state-filter-2");
		});
	});

	describe("migration from pre-v2 schema", () => {
		test("migrates old schema adding state columns and mapping read status", () => {
			const legacyPath = join(tempDir, "legacy-v1-mail.db");
			const legacyDb = new Database(legacyPath);
			const validTypes = MAIL_MESSAGE_TYPES.map((t) => `'${t}'`).join(",");
			legacyDb.exec(`
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_inbox ON messages(to_agent, read);
CREATE INDEX idx_thread ON messages(thread_id);
`);
			// Insert some old data
			legacyDb.exec(`
INSERT INTO messages (id, from_agent, to_agent, subject, body, type, priority, read, created_at)
VALUES ('old-unread', 'agent-a', 'orchestrator', 'unread msg', 'body', 'status', 'normal', 0, '2026-01-01T00:00:00.000Z');
INSERT INTO messages (id, from_agent, to_agent, subject, body, type, priority, read, created_at)
VALUES ('old-read', 'agent-b', 'orchestrator', 'read msg', 'body', 'status', 'normal', 1, '2026-01-01T00:00:00.000Z');
`);
			legacyDb.close();

			// Open with new store — should migrate
			const store2 = createMailStore(legacyPath);

			const unread = store2.getById("old-unread");
			expect(unread?.state).toBe("queued");
			expect(unread?.attempt).toBe(0);

			const read = store2.getById("old-read");
			expect(read?.state).toBe("acked");

			// New features should work
			store2.insert({
				id: "new-msg",
				from: "agent-a",
				to: "orchestrator",
				subject: "new",
				body: "body",
				type: "status",
				priority: "normal",
				threadId: null,
			});
			const claimed = store2.claim("orchestrator");
			expect(claimed.length).toBeGreaterThanOrEqual(1);

			store2.close();
		});
	});
});
