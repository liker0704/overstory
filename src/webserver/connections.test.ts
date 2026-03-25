import { describe, expect, test } from "bun:test";
import type { DashboardStores } from "../dashboard/data.ts";
import { createConnectionPool } from "./connections.ts";

function makeFakeStores(): DashboardStores {
	return {
		sessionStore: { close: () => {} } as unknown as DashboardStores["sessionStore"],
		mailStore: null,
		mergeQueue: null,
		metricsStore: null,
		eventStore: null,
		headroomStore: null,
	};
}

describe("createConnectionPool", () => {
	test("promise reuse - two concurrent acquireStores same path return same promise", async () => {
		const pool = createConnectionPool({
			openStores: (_path) => makeFakeStores(),
			closeStores: () => {},
		});

		const p1 = pool.acquireStores("/proj/a");
		const p2 = pool.acquireStores("/proj/a");

		expect(p1).toBe(p2);

		pool.releaseStores("/proj/a");
		pool.releaseStores("/proj/a");
		await pool.closeAllPools();
	});

	test("ref-counting - acquire twice release once keeps entry in pool", async () => {
		const pool = createConnectionPool({
			openStores: (_path) => makeFakeStores(),
			closeStores: () => {},
		});

		await pool.acquireStores("/proj/b");
		await pool.acquireStores("/proj/b");

		expect(pool.getPoolSize()).toBe(1);

		pool.releaseStores("/proj/b", 100_000); // long TTL, should not close
		expect(pool.getPoolSize()).toBe(1);

		await pool.closeAllPools();
	});

	test("poison recovery - failed open is evicted, next call retries", async () => {
		let callCount = 0;
		const pool = createConnectionPool({
			openStores: (_path) => {
				callCount++;
				if (callCount === 1) throw new Error("open failed");
				return makeFakeStores();
			},
			closeStores: () => {},
		});

		await expect(pool.acquireStores("/proj/c")).rejects.toThrow("open failed");

		// Give the .catch() poison handler a tick to run
		await new Promise((r) => setTimeout(r, 10));

		expect(pool.getPoolSize()).toBe(0);

		// Second call should succeed
		const stores = await pool.acquireStores("/proj/c");
		expect(stores).toBeTruthy();
		expect(callCount).toBe(2);

		await pool.closeAllPools();
	});

	test("closeAllPools clears everything", async () => {
		const pool = createConnectionPool({
			openStores: (_path) => makeFakeStores(),
			closeStores: () => {},
		});

		await pool.acquireStores("/proj/d");
		await pool.acquireStores("/proj/e");
		expect(pool.getPoolSize()).toBe(2);

		await pool.closeAllPools();
		expect(pool.getPoolSize()).toBe(0);
	});

	test("idle TTL - cleanup runs after expiry", async () => {
		let closed = 0;
		const pool = createConnectionPool({
			openStores: (_path) => makeFakeStores(),
			closeStores: () => {
				closed++;
			},
		});

		await pool.acquireStores("/proj/f");
		expect(pool.getPoolSize()).toBe(1);

		pool.releaseStores("/proj/f", 50); // 50ms TTL

		// Still present immediately
		expect(pool.getPoolSize()).toBe(1);

		// Wait for idle cleanup
		await new Promise((r) => setTimeout(r, 120));

		expect(pool.getPoolSize()).toBe(0);
		expect(closed).toBe(1);
	});
});
