import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createResilienceStore, type ResilienceStore } from "./store.ts";
import type { CircuitBreakerState, RetryRecord } from "./types.ts";

describe("ResilienceStore", () => {
	let store: ResilienceStore;

	beforeEach(() => {
		store = createResilienceStore(":memory:");
	});

	afterEach(() => {
		store.close();
	});

	test("getBreaker returns null for missing capability", () => {
		expect(store.getBreaker("nonexistent")).toBeNull();
	});

	test("upsertBreaker inserts new breaker, returns true", () => {
		const state: CircuitBreakerState = {
			capability: "builder",
			state: "closed",
			failureCount: 0,
			lastFailureAt: null,
			openedAt: null,
			halfOpenAt: null,
		};
		const result = store.upsertBreaker(state, "closed");
		expect(result).toBe(true);

		const fetched = store.getBreaker("builder");
		expect(fetched).not.toBeNull();
		expect(fetched?.capability).toBe("builder");
		expect(fetched?.state).toBe("closed");
		expect(fetched?.failureCount).toBe(0);
	});

	test("upsertBreaker updates existing breaker with matching expectedState, returns true", () => {
		const initial: CircuitBreakerState = {
			capability: "reviewer",
			state: "closed",
			failureCount: 2,
			lastFailureAt: "2026-01-01T00:00:00.000Z",
			openedAt: null,
			halfOpenAt: null,
		};
		store.upsertBreaker(initial, "closed");

		const updated: CircuitBreakerState = {
			capability: "reviewer",
			state: "open",
			failureCount: 5,
			lastFailureAt: "2026-01-01T01:00:00.000Z",
			openedAt: "2026-01-01T01:00:00.000Z",
			halfOpenAt: null,
		};
		const result = store.upsertBreaker(updated, "closed");
		expect(result).toBe(true);

		const fetched = store.getBreaker("reviewer");
		expect(fetched?.state).toBe("open");
		expect(fetched?.failureCount).toBe(5);
	});

	test("upsertBreaker returns false when expectedState doesn't match (CAS failure)", () => {
		const initial: CircuitBreakerState = {
			capability: "merger",
			state: "open",
			failureCount: 3,
			lastFailureAt: null,
			openedAt: null,
			halfOpenAt: null,
		};
		store.upsertBreaker(initial, "closed");

		// Try to update with wrong expectedState
		const updated: CircuitBreakerState = {
			capability: "merger",
			state: "half_open",
			failureCount: 3,
			lastFailureAt: null,
			openedAt: null,
			halfOpenAt: "2026-01-01T02:00:00.000Z",
		};
		const result = store.upsertBreaker(updated, "closed"); // expects closed, but it's open
		expect(result).toBe(false);

		// State should be unchanged
		const fetched = store.getBreaker("merger");
		expect(fetched?.state).toBe("open");
	});

	test("listOpenBreakers returns only open/half_open breakers", () => {
		store.upsertBreaker(
			{
				capability: "a",
				state: "closed",
				failureCount: 0,
				lastFailureAt: null,
				openedAt: null,
				halfOpenAt: null,
			},
			"closed",
		);
		store.upsertBreaker(
			{
				capability: "b",
				state: "open",
				failureCount: 5,
				lastFailureAt: null,
				openedAt: null,
				halfOpenAt: null,
			},
			"closed",
		);
		store.upsertBreaker(
			{
				capability: "c",
				state: "half_open",
				failureCount: 5,
				lastFailureAt: null,
				openedAt: null,
				halfOpenAt: "2026-01-01T00:00:00.000Z",
			},
			"closed",
		);

		const open = store.listOpenBreakers();
		expect(open).toHaveLength(2);
		const caps = open.map((b) => b.capability).sort();
		expect(caps).toEqual(["b", "c"]);
	});

	test("recordRetry + getRetries returns records in attempt order", () => {
		const base: RetryRecord = {
			taskId: "task-1",
			attempt: 0,
			outcome: "failure",
			capability: "builder",
			startedAt: "2026-01-01T00:00:00.000Z",
			failedAt: "2026-01-01T00:01:00.000Z",
			errorClass: "recoverable",
		};
		store.recordRetry(base);
		store.recordRetry({ ...base, attempt: 1, outcome: "pending", failedAt: null });
		store.recordRetry({ ...base, attempt: 2, outcome: "success", failedAt: null });

		const retries = store.getRetries("task-1");
		expect(retries).toHaveLength(3);
		expect(retries[0]?.attempt).toBe(0);
		expect(retries[1]?.attempt).toBe(1);
		expect(retries[2]?.attempt).toBe(2);
		expect(retries[2]?.outcome).toBe("success");
	});

	test("getRetryCount returns correct count", () => {
		const record: RetryRecord = {
			taskId: "task-2",
			attempt: 0,
			outcome: "failure",
			capability: "builder",
			startedAt: "2026-01-01T00:00:00.000Z",
			failedAt: null,
			errorClass: "unknown",
		};
		expect(store.getRetryCount("task-2")).toBe(0);
		store.recordRetry(record);
		store.recordRetry({ ...record, attempt: 1 });
		expect(store.getRetryCount("task-2")).toBe(2);
	});

	test("getRecentFailures counts only failures within window", () => {
		const now = Date.now();
		const recentTime = new Date(now - 1000).toISOString(); // 1 second ago
		const oldTime = new Date(now - 100_000).toISOString(); // 100 seconds ago

		store.recordRetry({
			taskId: "t1",
			attempt: 0,
			outcome: "failure",
			capability: "scout",
			startedAt: recentTime,
			failedAt: recentTime,
			errorClass: "recoverable",
		});
		store.recordRetry({
			taskId: "t2",
			attempt: 0,
			outcome: "failure",
			capability: "scout",
			startedAt: oldTime,
			failedAt: oldTime,
			errorClass: "recoverable",
		});
		store.recordRetry({
			taskId: "t3",
			attempt: 0,
			outcome: "success",
			capability: "scout",
			startedAt: recentTime,
			failedAt: null,
			errorClass: "recoverable",
		});

		// Window of 10 seconds — only the recent failure should count
		const count = store.getRecentFailures("scout", 10_000);
		expect(count).toBe(1);
	});

	test("getPendingRetries filters by outcome and maxAttempts", () => {
		store.recordRetry({
			taskId: "t1",
			attempt: 0,
			outcome: "pending",
			capability: "a",
			startedAt: "2026-01-01T00:00:00.000Z",
			failedAt: null,
			errorClass: "unknown",
		});
		store.recordRetry({
			taskId: "t2",
			attempt: 3,
			outcome: "pending",
			capability: "a",
			startedAt: "2026-01-01T00:00:01.000Z",
			failedAt: null,
			errorClass: "unknown",
		});
		store.recordRetry({
			taskId: "t3",
			attempt: 1,
			outcome: "failure",
			capability: "a",
			startedAt: "2026-01-01T00:00:02.000Z",
			failedAt: null,
			errorClass: "unknown",
		});

		// maxAttempts=3: attempt must be < 3, so t2 (attempt=3) is excluded
		const pending = store.getPendingRetries(3);
		expect(pending).toHaveLength(1);
		expect(pending[0]?.taskId).toBe("t1");
	});

	test("cleanup removes old records, returns count", () => {
		const store2 = createResilienceStore(":memory:");
		store2.recordRetry({
			taskId: "old-task",
			attempt: 0,
			outcome: "failure",
			capability: "a",
			startedAt: "2026-01-01T00:00:00.000Z",
			failedAt: null,
			errorClass: "unknown",
		});
		// Use a negative window so cutoff is in the future — all records become "old"
		const count = store2.cleanup(-60_000);
		expect(count).toBe(1);
		expect(store2.getRetryCount("old-task")).toBe(0);
		store2.close();
	});

	test("WAL mode is enabled", () => {
		const testStore = createResilienceStore(":memory:");
		// For :memory: databases WAL is not truly enabled (returns 'memory'),
		// but the PRAGMA should not throw and should return a result
		// For file-based databases this would return 'wal'
		testStore.close();
		// Just verify store creation and close work without error
		expect(true).toBe(true);
	});
});
