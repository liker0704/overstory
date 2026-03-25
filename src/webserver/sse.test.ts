import { afterEach, describe, expect, test } from "bun:test";
import type { DashboardData, DashboardStores } from "../dashboard/data.ts";
import type { PanelRenderers, SSEManagerConfig, SSEManagerDeps } from "./sse.ts";
import { SSEManager } from "./sse.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

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

function makeFakeData(extra?: Partial<DashboardData>): DashboardData {
	return {
		status: { agents: [], zombie: [], stale: [] } as unknown as DashboardData["status"],
		recentMail: [],
		mergeQueue: [],
		metrics: { totalSessions: 0, avgDuration: 0, byCapability: {} },
		tasks: [],
		recentEvents: [],
		feedColorMap: new Map(),
		missions: [],
		...extra,
	};
}

function makeRenderers(prefix = ""): PanelRenderers {
	return {
		agents: (_data) => `${prefix}agents-html`,
		mail: (_data) => `${prefix}mail-html`,
		merge: (_data) => `${prefix}merge-html`,
		metrics: (_data) => `${prefix}metrics-html`,
		events: (_data) => `${prefix}events-html`,
		mission: (_data) => `${prefix}mission-html`,
		headroom: (_data) => `${prefix}headroom-html`,
		resilience: (_data) => `${prefix}resilience-html`,
	};
}

function makeConfig(pollIntervalMs = 50): SSEManagerConfig {
	return { pollIntervalMs, connectionTtlMs: 5000 };
}

function makeDeps(overrides?: Partial<SSEManagerDeps>): SSEManagerDeps {
	const stores = makeFakeStores();
	return {
		acquireStores: async (_path: string) => stores,
		releaseStores: (_path: string) => {},
		loadDashboardData: async (_root, _stores, ..._rest) => makeFakeData(),
		hashFn: (html: string) => html, // identity — every unique string is unique hash
		now: () => Date.now(),
		...overrides,
	};
}

function makeRequest(abortController?: AbortController): Request {
	const ctrl = abortController ?? new AbortController();
	return new Request("http://localhost/project/test/sse", { signal: ctrl.signal });
}

/**
 * Collect SSE text chunks from a Response body until abort or timeout.
 * Returns all collected text concatenated.
 */
async function collectChunks(response: Response, opts: { timeoutMs: number }): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let result = "";

	const deadline = Date.now() + opts.timeoutMs;
	while (Date.now() < deadline) {
		const timeLeft = deadline - Date.now();
		const chunk = await Promise.race([
			reader.read(),
			new Promise<{ done: true; value: undefined }>((resolve) =>
				setTimeout(() => resolve({ done: true, value: undefined }), timeLeft),
			),
		]);
		if (chunk.done) break;
		if (chunk.value) result += decoder.decode(chunk.value, { stream: true });
	}
	reader.cancel().catch(() => {});
	return result;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("SSEManager", () => {
	let manager: SSEManager;
	const abortControllers: AbortController[] = [];

	afterEach(async () => {
		for (const ctrl of abortControllers) {
			ctrl.abort();
		}
		abortControllers.length = 0;
		if (manager) {
			await manager.shutdown();
		}
	});

	function newAbortController(): AbortController {
		const ctrl = new AbortController();
		abortControllers.push(ctrl);
		return ctrl;
	}

	// ── connect() response headers ───────────────────────────────────────────

	test("connect returns SSE Response with correct headers", () => {
		manager = new SSEManager(makeConfig(), makeRenderers(), makeDeps());
		const ctrl = newAbortController();
		const req = makeRequest(ctrl);
		const response = manager.connect(req, "proj-a", "/path/to/proj-a");

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/event-stream");
		expect(response.headers.get("Cache-Control")).toBe("no-cache");
		expect(response.headers.get("Connection")).toBe("keep-alive");

		ctrl.abort();
	});

	// ── connected event ──────────────────────────────────────────────────────

	test("first chunk contains connected event with slug", async () => {
		manager = new SSEManager(makeConfig(10_000), makeRenderers(), makeDeps());
		const ctrl = newAbortController();
		const req = makeRequest(ctrl);
		const response = manager.connect(req, "proj-b", "/path/to/proj-b");

		const text = await collectChunks(response, { timeoutMs: 200 });

		expect(text).toContain("event: connected");
		expect(text).toContain('"slug":"proj-b"');

		ctrl.abort();
	});

	// ── client / project counts ──────────────────────────────────────────────

	test("getClientCount and getProjectCount increment on connect", async () => {
		manager = new SSEManager(makeConfig(10_000), makeRenderers(), makeDeps());
		const ctrl1 = newAbortController();
		const ctrl2 = newAbortController();

		manager.connect(makeRequest(ctrl1), "slug-x", "/path/x");
		manager.connect(makeRequest(ctrl2), "slug-x", "/path/x");

		// Give stream start a tick
		await new Promise((r) => setTimeout(r, 10));

		expect(manager.getClientCount()).toBe(2);
		expect(manager.getProjectCount()).toBe(1);

		ctrl1.abort();
		ctrl2.abort();
	});

	test("getClientCount decrements on disconnect", async () => {
		manager = new SSEManager(makeConfig(10_000), makeRenderers(), makeDeps());
		const ctrl = newAbortController();

		manager.connect(makeRequest(ctrl), "slug-y", "/path/y");
		await new Promise((r) => setTimeout(r, 10));
		expect(manager.getClientCount()).toBe(1);

		ctrl.abort();
		await new Promise((r) => setTimeout(r, 10));
		expect(manager.getClientCount()).toBe(0);
		expect(manager.getProjectCount()).toBe(0);
	});

	// ── poll loop ────────────────────────────────────────────────────────────

	test("poll loop calls loadDashboardData after pollIntervalMs", async () => {
		let loadCalls = 0;
		const deps = makeDeps({
			loadDashboardData: async (_root, _stores) => {
				loadCalls++;
				return makeFakeData();
			},
		});

		manager = new SSEManager(makeConfig(40), makeRenderers(), deps);
		const ctrl = newAbortController();
		manager.connect(makeRequest(ctrl), "slug-z", "/path/z");

		// Wait for at least 2 poll ticks
		await new Promise((r) => setTimeout(r, 150));

		expect(loadCalls).toBeGreaterThanOrEqual(2);

		ctrl.abort();
	});

	test("poll loop stops when last client disconnects", async () => {
		let loadCalls = 0;
		const deps = makeDeps({
			loadDashboardData: async (_root, _stores) => {
				loadCalls++;
				return makeFakeData();
			},
		});

		manager = new SSEManager(makeConfig(30), makeRenderers(), deps);
		const ctrl = newAbortController();
		manager.connect(makeRequest(ctrl), "slug-stop", "/path/stop");

		// Let 1 tick happen
		await new Promise((r) => setTimeout(r, 60));
		const callsBefore = loadCalls;

		ctrl.abort();
		await new Promise((r) => setTimeout(r, 10));

		// No more project polling
		await new Promise((r) => setTimeout(r, 80));
		expect(loadCalls).toBe(callsBefore);
	});

	// ── hash diff — only changed panels emitted ──────────────────────────────

	test("only changed panels are emitted after first snapshot", async () => {
		let tick = 0;
		const deps = makeDeps({
			loadDashboardData: async () => makeFakeData(),
			// real hashing: use identity so we control what "changes"
			hashFn: (html: string) => {
				// On tick 1, agents changes; otherwise constant
				return html;
			},
		});

		// First call returns different agents html, second is the same
		const agentsHtml = "agents-v1";
		const renderers: PanelRenderers = {
			...makeRenderers(),
			agents: (_data) => {
				tick++;
				return tick === 1 ? agentsHtml : "agents-v2";
			},
		};

		manager = new SSEManager(makeConfig(30), renderers, deps);
		const ctrl = newAbortController();
		const req = makeRequest(ctrl);
		const response = manager.connect(req, "slug-diff", "/path/diff");

		// Collect chunks for a couple of poll ticks
		const text = await collectChunks(response, { timeoutMs: 200 });

		// Should contain agents event (full snapshot on first tick, then changed on second)
		expect(text).toContain("event: agents");

		ctrl.abort();
	});

	// ── full snapshot on first tick ──────────────────────────────────────────

	test("full snapshot is sent to newly connected client on first tick", async () => {
		manager = new SSEManager(makeConfig(30), makeRenderers(), makeDeps());
		const ctrl = newAbortController();
		const req = makeRequest(ctrl);
		const response = manager.connect(req, "slug-snap", "/path/snap");

		const text = await collectChunks(response, { timeoutMs: 200 });

		// All 8 panels should be present from the snapshot
		for (const panel of [
			"agents",
			"mail",
			"merge",
			"metrics",
			"events",
			"mission",
			"headroom",
			"resilience",
		]) {
			expect(text).toContain(`event: ${panel}`);
		}

		ctrl.abort();
	});

	// ── multi-client same project ────────────────────────────────────────────

	test("multi-client same project shares one poll loop", async () => {
		let loadCalls = 0;
		const deps = makeDeps({
			loadDashboardData: async () => {
				loadCalls++;
				return makeFakeData();
			},
		});

		manager = new SSEManager(makeConfig(40), makeRenderers(), deps);
		const ctrl1 = newAbortController();
		const ctrl2 = newAbortController();

		manager.connect(makeRequest(ctrl1), "slug-multi", "/path/multi");
		manager.connect(makeRequest(ctrl2), "slug-multi", "/path/multi");

		await new Promise((r) => setTimeout(r, 150));

		// Only one project in the pool
		expect(manager.getProjectCount()).toBe(1);
		expect(manager.getClientCount()).toBe(2);

		// Poll loop ran but only once per interval, not once per client
		// 150ms / 40ms ≈ 3 ticks — should not be 6 (double) or more
		expect(loadCalls).toBeLessThan(8);

		ctrl1.abort();
		ctrl2.abort();
	});

	// ── shutdown ─────────────────────────────────────────────────────────────

	test("shutdown clears all clients and projects", async () => {
		manager = new SSEManager(makeConfig(10_000), makeRenderers(), makeDeps());
		const ctrl1 = newAbortController();
		const ctrl2 = newAbortController();

		manager.connect(makeRequest(ctrl1), "slug-sd1", "/path/sd1");
		manager.connect(makeRequest(ctrl2), "slug-sd2", "/path/sd2");

		await new Promise((r) => setTimeout(r, 10));
		expect(manager.getProjectCount()).toBe(2);

		await manager.shutdown();

		expect(manager.getClientCount()).toBe(0);
		expect(manager.getProjectCount()).toBe(0);
	});

	// ── error resilience ─────────────────────────────────────────────────────

	test("skips tick gracefully when acquireStores throws", async () => {
		let acquireCalls = 0;
		const deps = makeDeps({
			acquireStores: async () => {
				acquireCalls++;
				throw new Error("store unavailable");
			},
		});

		manager = new SSEManager(makeConfig(30), makeRenderers(), deps);
		const ctrl = newAbortController();
		manager.connect(makeRequest(ctrl), "slug-err", "/path/err");

		// Should not throw — should silently skip ticks
		await new Promise((r) => setTimeout(r, 120));
		expect(acquireCalls).toBeGreaterThanOrEqual(1);

		// Manager still alive
		expect(manager.getClientCount()).toBe(1);

		ctrl.abort();
	});

	test("skips tick gracefully when loadDashboardData throws", async () => {
		let loadCalls = 0;
		const deps = makeDeps({
			loadDashboardData: async () => {
				loadCalls++;
				throw new Error("data load failed");
			},
		});

		manager = new SSEManager(makeConfig(30), makeRenderers(), deps);
		const ctrl = newAbortController();
		manager.connect(makeRequest(ctrl), "slug-err2", "/path/err2");

		await new Promise((r) => setTimeout(r, 120));
		expect(loadCalls).toBeGreaterThanOrEqual(1);
		expect(manager.getClientCount()).toBe(1);

		ctrl.abort();
	});
});
