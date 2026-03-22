import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculateBackoff, decideReroute, handleTaskFailure, shouldRetry } from "./engine.ts";
import { createResilienceStore, type ResilienceStore } from "./store.ts";
import type { ResilienceConfig } from "./types.ts";

const DEFAULT_CONFIG: ResilienceConfig = {
	retry: {
		maxAttempts: 3,
		backoffBaseMs: 1_000,
		backoffMaxMs: 30_000,
		backoffMultiplier: 2,
		globalMaxConcurrent: 5,
	},
	circuitBreaker: {
		failureThreshold: 3,
		windowMs: 60_000,
		cooldownMs: 10_000,
		halfOpenMaxProbes: 2,
	},
	reroute: {
		enabled: true,
		maxReroutes: 2,
		fallbackCapability: "fallback-builder",
	},
};

describe("engine", () => {
	let store: ResilienceStore;
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "ov-engine-test-"));
		store = createResilienceStore(join(tmpDir, "resilience.db"));
	});

	afterEach(async () => {
		store.close();
		await rm(tmpDir, { recursive: true, force: true });
	});

	test("1. calculateBackoff produces correct values", () => {
		// attempt=0: min(1000 * 2^0, 30000) = 1000
		expect(calculateBackoff(0, 1_000, 2, 30_000)).toBe(1_000);
		// attempt=1: min(1000 * 2^1, 30000) = 2000
		expect(calculateBackoff(1, 1_000, 2, 30_000)).toBe(2_000);
		// attempt=2: min(1000 * 2^2, 30000) = 4000
		expect(calculateBackoff(2, 1_000, 2, 30_000)).toBe(4_000);
		// attempt=5: min(1000 * 2^5, 30000) = min(32000, 30000) = 30000 (capped)
		expect(calculateBackoff(5, 1_000, 2, 30_000)).toBe(30_000);
	});

	test("2. shouldRetry returns false when max attempts exceeded", () => {
		const taskId = "task-maxed";
		// Insert maxAttempts records
		for (let i = 0; i < DEFAULT_CONFIG.retry.maxAttempts; i++) {
			store.recordRetry({
				taskId,
				attempt: i,
				outcome: "failure",
				capability: "builder",
				startedAt: new Date().toISOString(),
				failedAt: new Date().toISOString(),
				errorClass: "recoverable",
			});
		}

		const result = shouldRetry(taskId, store, DEFAULT_CONFIG);
		expect(result.retry).toBe(false);
		expect(result.reason).toBe("max_attempts_exceeded");
	});

	test("3. shouldRetry returns false with global_concurrency_limit reason when at capacity", () => {
		const taskId = "task-new";
		// Fill globalMaxConcurrent pending retries
		for (let i = 0; i < DEFAULT_CONFIG.retry.globalMaxConcurrent; i++) {
			store.recordRetry({
				taskId: `other-task-${i}`,
				attempt: 0,
				outcome: "pending",
				capability: "builder",
				startedAt: new Date().toISOString(),
				failedAt: null,
				errorClass: "unknown",
			});
		}

		const result = shouldRetry(taskId, store, DEFAULT_CONFIG);
		expect(result.retry).toBe(false);
		expect(result.reason).toBe("global_concurrency_limit");
		expect(result.delay).toBe(DEFAULT_CONFIG.retry.backoffMaxMs);
	});

	test("4. shouldRetry returns true with correct delay for valid retry", () => {
		const taskId = "task-fresh";
		const result = shouldRetry(taskId, store, DEFAULT_CONFIG);
		expect(result.retry).toBe(true);
		// attempt=0: 1000 * 2^0 = 1000
		expect(result.delay).toBe(1_000);
		expect(result.attempt).toBe(0);
	});

	test("5. decideReroute returns recommend_reroute for structural failure", () => {
		const taskId = "task-structural";
		const result = decideReroute(taskId, "structural", store, DEFAULT_CONFIG);
		expect(result.action).toBe("recommend_reroute");
		expect(result.reason).toBe("structural_failure");
		expect(result.targetCapability).toBe("fallback-builder");
	});

	test("6. decideReroute returns retry for recoverable failure", () => {
		const taskId = "task-recoverable";
		const result = decideReroute(taskId, "recoverable", store, DEFAULT_CONFIG);
		expect(result.action).toBe("retry");
		expect(result.reason).toBe("recoverable_failure");
	});

	test("7. decideReroute returns abandon when max retries exceeded", () => {
		const taskId = "task-exhausted";
		for (let i = 0; i < DEFAULT_CONFIG.retry.maxAttempts; i++) {
			store.recordRetry({
				taskId,
				attempt: i,
				outcome: "failure",
				capability: "builder",
				startedAt: new Date().toISOString(),
				failedAt: new Date().toISOString(),
				errorClass: "recoverable",
			});
		}

		const result = decideReroute(taskId, "recoverable", store, DEFAULT_CONFIG);
		expect(result.action).toBe("abandon");
		expect(result.reason).toBe("max_retries_exceeded");
	});

	test("8. decideReroute returns abandon when max reroutes exceeded", () => {
		const taskId = "task-reroute-maxed";
		// Insert maxReroutes structural failures
		for (let i = 0; i < DEFAULT_CONFIG.reroute.maxReroutes; i++) {
			store.recordRetry({
				taskId,
				attempt: i,
				outcome: "failure",
				capability: "builder",
				startedAt: new Date().toISOString(),
				failedAt: new Date().toISOString(),
				errorClass: "structural",
			});
		}

		const result = decideReroute(taskId, "structural", store, DEFAULT_CONFIG);
		expect(result.action).toBe("abandon");
	});

	test("9. handleTaskFailure records failure and retry, returns decision", () => {
		const taskId = "task-fail-1";
		const cap = "builder";
		const result = handleTaskFailure(taskId, cap, "recoverable", store, DEFAULT_CONFIG);

		expect(result.action).toBe("retry");
		expect(result.reason).toBe("recoverable_failure");

		// Verify retry was recorded
		const retries = store.getRetries(taskId);
		expect(retries).toHaveLength(1);
		expect(retries[0]?.outcome).toBe("failure");
		expect(retries[0]?.errorClass).toBe("recoverable");
	});

	test("10. handleTaskFailure returns recommend_reroute when breaker blocks", () => {
		const cap = "builder";
		// Trip the breaker by seeding enough failures and calling handleTaskFailure repeatedly
		const config: ResilienceConfig = {
			...DEFAULT_CONFIG,
			circuitBreaker: { ...DEFAULT_CONFIG.circuitBreaker, failureThreshold: 1, cooldownMs: 60_000 },
		};

		// One failure trips the breaker (threshold=1)
		const taskId = "task-blocked";
		const result = handleTaskFailure(taskId, cap, "recoverable", store, config);

		// After first failure with threshold=1, breaker trips open → canDispatch=false (cooldown not elapsed)
		// Should return recommend_reroute since reroute.enabled=true
		expect(result.action).toBe("recommend_reroute");
		expect(result.reason).toBe("circuit_breaker_open");
		expect(result.targetCapability).toBe("fallback-builder");
	});

	test("11. handleTaskFailure attaches probeTaskId for probe failures", () => {
		const cap = "builder";
		const taskId = "probe-task";

		// Set the breaker to half_open
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

		const result = handleTaskFailure(taskId, cap, "recoverable", store, DEFAULT_CONFIG);

		// wasHalfOpen=true, breakerState.state="open" → isProbe=true → probeTaskId set
		expect(result.probeTaskId).toBe(taskId);
	});
});
