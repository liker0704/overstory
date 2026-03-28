import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHeadroomStore } from "../headroom/store.ts";
import type { HeadroomSnapshot, HeadroomStore } from "../headroom/types.ts";
import { embedTexts } from "./semantic.ts";

// === Helpers ===

function makeHeaders(overrides: Record<string, string | null> = {}): Headers {
	const defaults: Record<string, string> = {
		"x-ratelimit-remaining-requests": "800",
		"x-ratelimit-limit-requests": "1000",
		"x-ratelimit-remaining-tokens": "90000",
		"x-ratelimit-limit-tokens": "100000",
		"x-ratelimit-reset-requests": "2026-03-28T01:00:00Z",
	};
	const h = new Headers();
	for (const [k, v] of Object.entries(defaults)) {
		const override = overrides[k];
		if (override !== null) {
			h.set(k, override ?? v);
		}
	}
	for (const [k, v] of Object.entries(overrides)) {
		if (v !== null && !(k in defaults)) {
			h.set(k, v);
		}
	}
	return h;
}

function makeOpenAIResponse(
	embeddings: number[][],
	headers: Headers = makeHeaders(),
	status = 200,
): Response {
	const body = {
		data: embeddings.map((embedding, index) => ({ embedding, index })),
	};
	return new Response(JSON.stringify(body), { status, headers });
}

// === Tests ===

describe("embedTexts", () => {
	let originalFetch: typeof globalThis.fetch;
	let originalEnv: string | undefined;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		originalEnv = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "test-key";
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		process.env.OPENAI_API_KEY = originalEnv;
	});

	describe("single provider string (backward compat)", () => {
		test("returns embeddings on success", async () => {
			const vec = [0.1, 0.2, 0.3];
			globalThis.fetch = mock(() => Promise.resolve(makeOpenAIResponse([vec]))) as unknown as typeof fetch;
			const result = await embedTexts(["hello"], "openai", "text-embedding-3-small");
			expect(result).not.toBeNull();
			expect(result?.length).toBe(1);
			const first = result?.[0];
			if (!first) throw new Error("expected first vector");
			const got = Array.from(first);
			expect(got.length).toBe(vec.length);
			for (let i = 0; i < vec.length; i++) {
				const gotVal = got[i];
				const expectedVal = vec[i];
				if (gotVal === undefined || expectedVal === undefined)
					throw new Error("index out of range");
				expect(gotVal).toBeCloseTo(expectedVal, 5);
			}
		});

		test("returns null on API failure", async () => {
			globalThis.fetch = mock(() =>
				Promise.resolve(new Response("err", { status: 429, headers: new Headers() })),
			) as unknown as typeof fetch;
			const result = await embedTexts(["hello"], "openai", "text-embedding-3-small");
			expect(result).toBeNull();
		});

		test("returns empty array for empty texts", async () => {
			const result = await embedTexts([], "openai", "text-embedding-3-small");
			expect(result).toEqual([]);
		});
	});

	describe("provider array fallback", () => {
		test("returns result from first provider on success", async () => {
			const vec = [1, 2, 3];
			globalThis.fetch = mock(() => Promise.resolve(makeOpenAIResponse([vec]))) as unknown as typeof fetch;
			const result = await embedTexts(["hello"], ["openai", "ollama"], "text-embedding-3-small");
			expect(result).not.toBeNull();
			expect(result?.[0]).not.toBeUndefined();
		});

		test("falls back to next provider when first returns null", async () => {
			let callCount = 0;
			globalThis.fetch = mock((url: string | URL | Request) => {
				callCount++;
				const urlStr = url.toString();
				if (urlStr.includes("openai")) {
					return Promise.resolve(new Response("err", { status: 500, headers: new Headers() }));
				}
				// Ollama response
				const body = { embeddings: [[0.9, 0.8]] };
				return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
			}) as unknown as typeof fetch;

			const result = await embedTexts(["hello"], ["openai", "ollama"], "text-embedding-3-small");
			expect(result).not.toBeNull();
			expect(callCount).toBe(2);
		});

		test("returns null when all providers fail", async () => {
			globalThis.fetch = mock(() =>
				Promise.resolve(new Response("err", { status: 500, headers: new Headers() })),
			) as unknown as typeof fetch;
			const result = await embedTexts(["hello"], ["openai", "ollama"], "text-embedding-3-small");
			expect(result).toBeNull();
		});
	});

	describe("header parsing", () => {
		test("parses all 5 rate-limit headers correctly", async () => {
			const headers = makeHeaders();
			globalThis.fetch = mock(() => Promise.resolve(makeOpenAIResponse([[0.1, 0.2]], headers))) as unknown as typeof fetch;

			let captured: HeadroomSnapshot | null = null;
			const store = createHeadroomStore(":memory:");

			await embedTexts(["hello"], "openai", "text-embedding-3-small", {
				headroomStore: store,
				onThrottleFallback: () => {},
			});

			captured = store.get("openai-embeddings");
			store.close();

			expect(captured).not.toBeNull();
			expect(captured?.runtime).toBe("openai-embeddings");
			expect(captured?.state).toBe("exact");
			expect(captured?.requestsRemaining).toBe(800);
			expect(captured?.requestsLimit).toBe(1000);
			expect(captured?.tokensRemaining).toBe(90000);
			expect(captured?.tokensLimit).toBe(100000);
			expect(captured?.windowResetsAt).toBe("2026-03-28T01:00:00Z");
		});

		test("missing headers produce null fields", async () => {
			const headers = new Headers(); // no rate-limit headers
			globalThis.fetch = mock(() => Promise.resolve(makeOpenAIResponse([[0.1]], headers))) as unknown as typeof fetch;

			const store = createHeadroomStore(":memory:");
			await embedTexts(["hello"], "openai", "text-embedding-3-small", {
				headroomStore: store,
			});

			const snapshot = store.get("openai-embeddings");
			store.close();

			expect(snapshot).not.toBeNull();
			expect(snapshot?.requestsRemaining).toBeNull();
			expect(snapshot?.requestsLimit).toBeNull();
			expect(snapshot?.tokensRemaining).toBeNull();
			expect(snapshot?.tokensLimit).toBeNull();
			expect(snapshot?.windowResetsAt).toBeNull();
		});

		test("non-numeric headers produce null for integer fields", async () => {
			const headers = makeHeaders({
				"x-ratelimit-remaining-requests": "not-a-number",
				"x-ratelimit-limit-requests": "also-nope",
			});
			globalThis.fetch = mock(() => Promise.resolve(makeOpenAIResponse([[0.1]], headers))) as unknown as typeof fetch;

			const store = createHeadroomStore(":memory:");
			await embedTexts(["hello"], "openai", "text-embedding-3-small", {
				headroomStore: store,
			});

			const snapshot = store.get("openai-embeddings");
			store.close();

			expect(snapshot?.requestsRemaining).toBeNull();
			expect(snapshot?.requestsLimit).toBeNull();
		});
	});

	describe("onHeaders callback", () => {
		test("called with correct HeadroomSnapshot after success", async () => {
			const headers = makeHeaders();
			globalThis.fetch = mock(() => Promise.resolve(makeOpenAIResponse([[0.5]], headers))) as unknown as typeof fetch;

			const snapshots: HeadroomSnapshot[] = [];
			const store = createHeadroomStore(":memory:");

			// Spy on upsert
			const originalUpsert = store.upsert.bind(store);
			store.upsert = (s: HeadroomSnapshot) => {
				snapshots.push(s);
				originalUpsert(s);
			};

			await embedTexts(["hi"], "openai", "text-embedding-3-small", {
				headroomStore: store,
			});
			store.close();

			expect(snapshots.length).toBe(1);
			const snap = snapshots[0];
			if (!snap) throw new Error("expected snapshot");
			expect(snap.runtime).toBe("openai-embeddings");
			expect(snap.state).toBe("exact");
			expect(snap.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			expect(snap.requestsRemaining).toBe(800);
		});

		test("not called on API failure", async () => {
			globalThis.fetch = mock(() =>
				Promise.resolve(new Response("err", { status: 500, headers: new Headers() })),
			) as unknown as typeof fetch;

			const store = createHeadroomStore(":memory:");
			await embedTexts(["hi"], "openai", "text-embedding-3-small", {
				headroomStore: store,
			});

			const snapshot = store.get("openai-embeddings");
			store.close();
			expect(snapshot).toBeNull();
		});
	});

	describe("pre-flight headroom check", () => {
		function makeStore(pct: number): HeadroomStore {
			const store = createHeadroomStore(":memory:");
			const snapshot: HeadroomSnapshot = {
				runtime: "openai-embeddings",
				state: "exact",
				capturedAt: new Date().toISOString(),
				requestsRemaining: pct,
				requestsLimit: 100,
				tokensRemaining: null,
				tokensLimit: null,
				windowResetsAt: null,
				message: `${pct}% remaining`,
			};
			store.upsert(snapshot);
			return store;
		}

		test("skips OpenAI when headroom below threshold", async () => {
			let fetchCalled = false;
			globalThis.fetch = mock((url: string | URL | Request) => {
				const urlStr = url.toString();
				if (urlStr.includes("openai")) {
					fetchCalled = true;
					return Promise.resolve(makeOpenAIResponse([[1, 2]]));
				}
				return Promise.resolve(new Response("err", { status: 500 }));
			});

			const store = makeStore(10); // 10% — below default 20% threshold
			const fallbacks: Array<{ from: string; to: string }> = [];

			await embedTexts(["hello"], ["openai", "ollama"], "model", {
				headroomStore: store,
				warnThresholdPercent: 20,
				onThrottleFallback: (from, to) => fallbacks.push({ from, to }),
			});
			store.close();

			expect(fetchCalled).toBe(false);
			expect(fallbacks.length).toBe(1);
			expect(fallbacks[0]?.from).toBe("openai");
			expect(fallbacks[0]?.to).toBe("ollama");
		});

		test("uses OpenAI when headroom above threshold", async () => {
			let openaiCalled = false;
			globalThis.fetch = mock((url: string | URL | Request) => {
				const urlStr = url.toString();
				if (urlStr.includes("openai")) {
					openaiCalled = true;
					return Promise.resolve(makeOpenAIResponse([[1, 2]]));
				}
				return Promise.resolve(new Response("err", { status: 500 }));
			});

			const store = makeStore(80); // 80% — well above threshold
			await embedTexts(["hello"], ["openai", "ollama"], "model", {
				headroomStore: store,
				warnThresholdPercent: 20,
			});
			store.close();

			expect(openaiCalled).toBe(true);
		});

		test("no pre-flight check when headroomStore not provided", async () => {
			let openaiCalled = false;
			globalThis.fetch = mock(() => {
				openaiCalled = true;
				return Promise.resolve(makeOpenAIResponse([[1, 2]]));
			});

			// No headroomStore — even with low headroom on the store, OpenAI should be called
			await embedTexts(["hello"], ["openai"], "model");

			expect(openaiCalled).toBe(true);
		});
	});
});
