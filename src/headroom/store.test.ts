import { describe, expect, test } from "bun:test";
import { createHeadroomStore } from "./store.ts";
import type { HeadroomSnapshot } from "./types.ts";

function makeSnapshot(overrides?: Partial<HeadroomSnapshot>): HeadroomSnapshot {
	return {
		runtime: "claude",
		state: "exact",
		capturedAt: "2026-01-01T00:00:00Z",
		requestsRemaining: 100,
		requestsLimit: 1000,
		tokensRemaining: 50000,
		tokensLimit: 100000,
		windowResetsAt: "2026-01-01T01:00:00Z",
		message: "90% remaining",
		...overrides,
	};
}

describe("HeadroomStore", () => {
	test("upsert + get roundtrip", () => {
		const store = createHeadroomStore(":memory:");
		const snapshot = makeSnapshot();
		store.upsert(snapshot);
		const result = store.get("claude");
		expect(result).toEqual(snapshot);
		store.close();
	});

	test("upsert overwrites existing entry", () => {
		const store = createHeadroomStore(":memory:");
		store.upsert(makeSnapshot({ requestsRemaining: 100 }));
		store.upsert(makeSnapshot({ requestsRemaining: 50, message: "50% remaining" }));
		const result = store.get("claude");
		expect(result?.requestsRemaining).toBe(50);
		expect(result?.message).toBe("50% remaining");
		store.close();
	});

	test("getAll returns all runtimes", () => {
		const store = createHeadroomStore(":memory:");
		store.upsert(makeSnapshot({ runtime: "claude" }));
		store.upsert(makeSnapshot({ runtime: "codex" }));
		store.upsert(makeSnapshot({ runtime: "gemini" }));
		const all = store.getAll();
		expect(all).toHaveLength(3);
		const runtimes = all.map((s) => s.runtime).sort();
		expect(runtimes).toEqual(["claude", "codex", "gemini"]);
		store.close();
	});

	test("get returns null for unknown runtime", () => {
		const store = createHeadroomStore(":memory:");
		const result = store.get("nonexistent");
		expect(result).toBeNull();
		store.close();
	});

	test("pruneOlderThan removes old entries, keeps recent", () => {
		const store = createHeadroomStore(":memory:");
		store.upsert(makeSnapshot({ runtime: "old", capturedAt: "2025-01-01T00:00:00Z" }));
		store.upsert(makeSnapshot({ runtime: "new", capturedAt: "2026-06-01T00:00:00Z" }));
		const count = store.pruneOlderThan("2026-01-01T00:00:00Z");
		expect(count).toBe(1);
		expect(store.get("old")).toBeNull();
		expect(store.get("new")).not.toBeNull();
		store.close();
	});

	test("close does not throw", () => {
		const store = createHeadroomStore(":memory:");
		expect(() => store.close()).not.toThrow();
	});

	test("null field roundtrip", () => {
		const store = createHeadroomStore(":memory:");
		const snapshot = makeSnapshot({
			requestsRemaining: null,
			tokensLimit: null,
			windowResetsAt: null,
		});
		store.upsert(snapshot);
		const result = store.get("claude");
		expect(result?.requestsRemaining).toBeNull();
		expect(result?.tokensLimit).toBeNull();
		expect(result?.windowResetsAt).toBeNull();
		store.close();
	});
});
