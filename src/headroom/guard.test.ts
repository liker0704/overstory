import { describe, expect, test } from "bun:test";
import { checkHeadroomForSpawn, type SpawnGuardPolicy } from "./guard.ts";
import { createHeadroomStore } from "./store.ts";
import type { HeadroomSnapshot } from "./types.ts";

function makeSnapshot(overrides: Partial<HeadroomSnapshot> = {}): HeadroomSnapshot {
	return {
		runtime: "claude",
		state: "exact",
		capturedAt: new Date().toISOString(),
		requestsRemaining: 80,
		requestsLimit: 100,
		tokensRemaining: null,
		tokensLimit: null,
		windowResetsAt: null,
		message: "test snapshot",
		...overrides,
	};
}

const defaultPolicy: SpawnGuardPolicy = {
	pauseThresholdPercent: 10,
	blockSpawnsOnPause: true,
};

describe("checkHeadroomForSpawn", () => {
	test("headroom above threshold → allowed", () => {
		const store = createHeadroomStore(":memory:");
		store.upsert(makeSnapshot({ requestsRemaining: 80, requestsLimit: 100 }));
		const result = checkHeadroomForSpawn(store, "builder", "claude", defaultPolicy);
		expect(result.allowed).toBe(true);
		store.close();
	});

	test("headroom below threshold, persistent capability → allowed", () => {
		const store = createHeadroomStore(":memory:");
		store.upsert(makeSnapshot({ requestsRemaining: 5, requestsLimit: 100 }));
		const result = checkHeadroomForSpawn(store, "coordinator", "claude", defaultPolicy);
		expect(result.allowed).toBe(true);
		store.close();
	});

	test("headroom below threshold, non-persistent → blocked", () => {
		const store = createHeadroomStore(":memory:");
		store.upsert(makeSnapshot({ requestsRemaining: 5, requestsLimit: 100 }));
		const result = checkHeadroomForSpawn(store, "builder", "claude", defaultPolicy);
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("critically low");
		store.close();
	});

	test("no headroom data → allowed", () => {
		const store = createHeadroomStore(":memory:");
		const result = checkHeadroomForSpawn(store, "builder", "claude", defaultPolicy);
		expect(result.allowed).toBe(true);
		store.close();
	});

	test("blockSpawnsOnPause disabled → always allowed", () => {
		const store = createHeadroomStore(":memory:");
		store.upsert(makeSnapshot({ requestsRemaining: 1, requestsLimit: 100 }));
		const policy: SpawnGuardPolicy = { pauseThresholdPercent: 10, blockSpawnsOnPause: false };
		const result = checkHeadroomForSpawn(store, "builder", "claude", policy);
		expect(result.allowed).toBe(true);
		store.close();
	});

	test("snapshot state unavailable → allowed", () => {
		const store = createHeadroomStore(":memory:");
		store.upsert(makeSnapshot({ state: "unavailable", requestsRemaining: 1, requestsLimit: 100 }));
		const result = checkHeadroomForSpawn(store, "builder", "claude", defaultPolicy);
		expect(result.allowed).toBe(true);
		store.close();
	});

	test("null requestsRemaining → allowed", () => {
		const store = createHeadroomStore(":memory:");
		store.upsert(makeSnapshot({ requestsRemaining: null, requestsLimit: 100 }));
		const result = checkHeadroomForSpawn(store, "builder", "claude", defaultPolicy);
		expect(result.allowed).toBe(true);
		store.close();
	});
});
