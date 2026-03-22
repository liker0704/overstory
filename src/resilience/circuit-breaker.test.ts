import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canDispatch, getState, recordFailure, recordSuccess } from "./circuit-breaker.ts";
import { createResilienceStore, type ResilienceStore } from "./store.ts";
import type { CircuitBreakerConfig } from "./types.ts";

const DEFAULT_CONFIG: CircuitBreakerConfig = {
	failureThreshold: 3,
	windowMs: 60_000,
	cooldownMs: 10_000,
	halfOpenMaxProbes: 2,
};

describe("circuit-breaker", () => {
	let store: ResilienceStore;
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "ov-cb-test-"));
		store = createResilienceStore(join(tmpDir, "resilience.db"));
	});

	afterEach(async () => {
		store.close();
		await rm(tmpDir, { recursive: true, force: true });
	});

	test("1. getState returns default closed state for unknown capability", () => {
		const state = getState(store, "unknown-cap");
		expect(state.capability).toBe("unknown-cap");
		expect(state.state).toBe("closed");
		expect(state.failureCount).toBe(0);
		expect(state.lastFailureAt).toBeNull();
		expect(state.openedAt).toBeNull();
		expect(state.halfOpenAt).toBeNull();
	});

	test("2. recordFailure in closed state below threshold stays closed", () => {
		// threshold=3, no prior failures → 0 + 1 = 1 < 3, stays closed
		const state = recordFailure(store, "builder", DEFAULT_CONFIG);
		expect(state.state).toBe("closed");
		expect(state.failureCount).toBe(1);
		expect(state.lastFailureAt).not.toBeNull();
	});

	test("3. recordFailure in closed state at threshold trips to open", () => {
		const cap = "builder";
		const now = new Date().toISOString();
		// Seed failureThreshold-1 failures so next failure trips the breaker
		for (let i = 0; i < DEFAULT_CONFIG.failureThreshold - 1; i++) {
			store.recordRetry({
				taskId: `seed-task-${i}`,
				attempt: 0,
				outcome: "failure",
				capability: cap,
				startedAt: now,
				failedAt: now,
				errorClass: "recoverable",
			});
		}

		const state = recordFailure(store, cap, DEFAULT_CONFIG);
		expect(state.state).toBe("open");
		expect(state.openedAt).not.toBeNull();
		expect(state.failureCount).toBe(1);
	});

	test("4. recordFailure in half_open reopens breaker", () => {
		const cap = "reviewer";
		// Set breaker to half_open
		store.upsertBreaker(
			{
				capability: cap,
				state: "half_open",
				failureCount: 3,
				lastFailureAt: "2026-01-01T00:00:00.000Z",
				openedAt: "2026-01-01T00:00:00.000Z",
				halfOpenAt: "2026-01-01T00:01:00.000Z",
			},
			"closed",
		);

		const state = recordFailure(store, cap, DEFAULT_CONFIG);
		expect(state.state).toBe("open");
		expect(state.halfOpenAt).toBeNull();
		expect(state.openedAt).not.toBeNull();
	});

	test("5. recordFailure in open state stays open with bumped count", () => {
		const cap = "merger";
		store.upsertBreaker(
			{
				capability: cap,
				state: "open",
				failureCount: 5,
				lastFailureAt: "2026-01-01T00:00:00.000Z",
				openedAt: "2026-01-01T00:00:00.000Z",
				halfOpenAt: null,
			},
			"closed",
		);

		const state = recordFailure(store, cap, DEFAULT_CONFIG);
		expect(state.state).toBe("open");
		expect(state.failureCount).toBe(6);
	});

	test("6. recordSuccess in half_open closes breaker and resets counters", () => {
		const cap = "scout";
		store.upsertBreaker(
			{
				capability: cap,
				state: "half_open",
				failureCount: 4,
				lastFailureAt: "2026-01-01T00:00:00.000Z",
				openedAt: "2026-01-01T00:00:00.000Z",
				halfOpenAt: "2026-01-01T00:01:00.000Z",
			},
			"closed",
		);

		const state = recordSuccess(store, cap);
		expect(state.state).toBe("closed");
		expect(state.failureCount).toBe(0);
		expect(state.lastFailureAt).toBeNull();
		expect(state.openedAt).toBeNull();
		expect(state.halfOpenAt).toBeNull();
	});

	test("7. recordSuccess in closed state is no-op", () => {
		const cap = "lead";
		// No prior state — default closed
		const state = recordSuccess(store, cap);
		expect(state.state).toBe("closed");
		expect(state.failureCount).toBe(0);
	});

	test("8. canDispatch returns true when closed", () => {
		expect(canDispatch(store, "builder", DEFAULT_CONFIG)).toBe(true);
	});

	test("9. canDispatch returns false when open within cooldown", () => {
		const cap = "builder";
		// Set breaker to open with openedAt just now
		store.upsertBreaker(
			{
				capability: cap,
				state: "open",
				failureCount: 3,
				lastFailureAt: new Date().toISOString(),
				openedAt: new Date().toISOString(),
				halfOpenAt: null,
			},
			"closed",
		);

		expect(canDispatch(store, cap, DEFAULT_CONFIG)).toBe(false);
	});

	test("10. canDispatch transitions open→half_open when cooldown elapsed", () => {
		const cap = "builder";
		// openedAt far in the past (beyond cooldownMs)
		const pastTime = new Date(Date.now() - DEFAULT_CONFIG.cooldownMs * 2).toISOString();
		store.upsertBreaker(
			{
				capability: cap,
				state: "open",
				failureCount: 3,
				lastFailureAt: pastTime,
				openedAt: pastTime,
				halfOpenAt: null,
			},
			"closed",
		);

		const result = canDispatch(store, cap, DEFAULT_CONFIG);
		expect(result).toBe(true);

		const state = getState(store, cap);
		expect(state.state).toBe("half_open");
		expect(state.halfOpenAt).not.toBeNull();
	});

	test("11. canDispatch in half_open respects halfOpenMaxProbes", () => {
		const cap = "reviewer";
		store.upsertBreaker(
			{
				capability: cap,
				state: "half_open",
				failureCount: 3,
				lastFailureAt: "2026-01-01T00:00:00.000Z",
				openedAt: "2026-01-01T00:00:00.000Z",
				halfOpenAt: "2026-01-01T00:01:00.000Z",
			},
			"closed",
		);

		// Insert halfOpenMaxProbes pending retries for this capability
		for (let i = 0; i < DEFAULT_CONFIG.halfOpenMaxProbes; i++) {
			store.recordRetry({
				taskId: `probe-task-${i}`,
				attempt: 0,
				outcome: "pending",
				capability: cap,
				startedAt: new Date().toISOString(),
				failedAt: null,
				errorClass: "unknown",
			});
		}

		// At capacity: should return false
		expect(canDispatch(store, cap, DEFAULT_CONFIG)).toBe(false);

		// With one fewer pending: should return true
		const cap2 = "reviewer-2";
		store.upsertBreaker(
			{
				capability: cap2,
				state: "half_open",
				failureCount: 3,
				lastFailureAt: "2026-01-01T00:00:00.000Z",
				openedAt: "2026-01-01T00:00:00.000Z",
				halfOpenAt: "2026-01-01T00:01:00.000Z",
			},
			"closed",
		);
		// Only 1 pending for cap2 (below halfOpenMaxProbes=2)
		store.recordRetry({
			taskId: "probe-cap2-0",
			attempt: 0,
			outcome: "pending",
			capability: cap2,
			startedAt: new Date().toISOString(),
			failedAt: null,
			errorClass: "unknown",
		});
		expect(canDispatch(store, cap2, DEFAULT_CONFIG)).toBe(true);
	});
});
