import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ExporterConfig, ExportSpan } from "../types.ts";
import { createLangfuseExporter } from "./langfuse.ts";

const TEST_ENDPOINT = "https://cloud.langfuse.com";
const TEST_AUTH_ENV = "LANGFUSE_TEST_KEY";
const TEST_AUTH_VALUE = "pk-test:sk-test";

function makeConfig(overrides: Partial<ExporterConfig> = {}): ExporterConfig {
	return {
		type: "langfuse",
		enabled: true,
		endpoint: TEST_ENDPOINT,
		authTokenEnv: TEST_AUTH_ENV,
		batchSize: 100,
		timeoutMs: 5000,
		...overrides,
	};
}

function makeSpan(overrides: Partial<ExportSpan> = {}): ExportSpan {
	return {
		spanId: "span-1",
		parentSpanId: null,
		traceId: "trace-1",
		name: "test-span",
		kind: "tool",
		startTime: "2024-01-01T00:00:00.000Z",
		endTime: "2024-01-01T00:00:01.000Z",
		durationMs: 1000,
		status: "ok",
		attributes: {},
		events: [],
		resource: {
			agentName: "test-agent",
			runId: "run-1",
			sessionId: "session-1",
			taskId: "task-1",
			missionId: "mission-1",
			capability: "builder",
		},
		...overrides,
	};
}

type MockFetchCall = {
	url: string;
	options: RequestInit;
};

function makeMockFetch(
	statusOrHandler: number | ((call: MockFetchCall) => Response | Promise<Response>),
	body?: unknown,
): { fn: typeof fetch; calls: MockFetchCall[] } {
	const calls: MockFetchCall[] = [];
	const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const call: MockFetchCall = { url: String(input), options: init ?? {} };
		calls.push(call);

		if (typeof statusOrHandler === "function") {
			return statusOrHandler(call);
		}

		const status = statusOrHandler;
		const responseBody = body !== undefined ? JSON.stringify(body) : "";
		return new Response(responseBody, { status });
	};
	return { fn: fn as typeof fetch, calls };
}

describe("createLangfuseExporter", () => {
	let savedFetch: typeof globalThis.fetch;
	let savedEnv: string | undefined;

	beforeEach(() => {
		savedFetch = globalThis.fetch;
		savedEnv = process.env[TEST_AUTH_ENV];
		process.env[TEST_AUTH_ENV] = TEST_AUTH_VALUE;
	});

	afterEach(() => {
		globalThis.fetch = savedFetch;
		if (savedEnv === undefined) {
			delete process.env[TEST_AUTH_ENV];
		} else {
			process.env[TEST_AUTH_ENV] = savedEnv;
		}
	});

	it("exports spans successfully", async () => {
		const { fn, calls } = makeMockFetch(200);
		globalThis.fetch = fn;

		const exporter = createLangfuseExporter(makeConfig());
		const span = makeSpan({ kind: "tool", endTime: null });
		const result = await exporter.export([span]);

		expect(result.success).toBe(true);
		expect(result.failedCount).toBe(0);
		expect(calls.length).toBe(1);

		const call = calls[0];
		expect(call).toBeDefined();
		expect(call!.url).toBe(`${TEST_ENDPOINT}/api/public/ingestion`);

		const body = JSON.parse(call!.options.body as string) as { batch: unknown[] };
		expect(body.batch).toBeDefined();
		expect(Array.isArray(body.batch)).toBe(true);

		const authHeader = (call!.options.headers as Record<string, string>)["Authorization"];
		expect(authHeader).toBe(`Basic ${btoa("pk-test:sk-test")}`);
	});

	it("maps turn spans to generation-create", async () => {
		const { fn, calls } = makeMockFetch(200);
		globalThis.fetch = fn;

		const exporter = createLangfuseExporter(makeConfig());
		const span = makeSpan({
			kind: "turn",
			attributes: {
				"llm.input_tokens": 100,
				"llm.output_tokens": 50,
				"llm.model": "claude-3",
			},
		});
		await exporter.export([span]);

		const body = JSON.parse(calls[0]!.options.body as string) as {
			batch: Array<{ type: string; body: Record<string, unknown> }>;
		};
		const genItem = body.batch.find((item) => item.type === "generation-create");
		expect(genItem).toBeDefined();
		expect(genItem!.body.promptTokens).toBe(100);
		expect(genItem!.body.completionTokens).toBe(50);
		expect(genItem!.body.model).toBe("claude-3");
		expect(genItem!.body.completionStartTime).toBeDefined();
	});

	it("maps non-turn spans to span-create + span-update", async () => {
		const { fn, calls } = makeMockFetch(200);
		globalThis.fetch = fn;

		const exporter = createLangfuseExporter(makeConfig());
		const span = makeSpan({ kind: "tool", endTime: "2024-01-01T00:00:01.000Z" });
		await exporter.export([span]);

		const body = JSON.parse(calls[0]!.options.body as string) as { batch: Array<{ type: string }> };
		const types = body.batch.map((item) => item.type);
		expect(types).toContain("span-create");
		expect(types).toContain("span-update");
	});

	it("creates trace-create per unique traceId", async () => {
		const { fn, calls } = makeMockFetch(200);
		globalThis.fetch = fn;

		const exporter = createLangfuseExporter(makeConfig());
		const spans = [
			makeSpan({ spanId: "s1", traceId: "trace-A" }),
			makeSpan({ spanId: "s2", traceId: "trace-A" }), // same trace
			makeSpan({ spanId: "s3", traceId: "trace-B" }),
		];
		await exporter.export(spans);

		const body = JSON.parse(calls[0]!.options.body as string) as {
			batch: Array<{ type: string; body: { id?: string } }>;
		};
		const traceCreates = body.batch.filter((item) => item.type === "trace-create");
		expect(traceCreates.length).toBe(2);
		const ids = traceCreates.map((t) => t.body.id);
		expect(ids).toContain("trace-A");
		expect(ids).toContain("trace-B");
	});

	it("handles missing auth token", async () => {
		const { fn, calls } = makeMockFetch(200);
		globalThis.fetch = fn;
		delete process.env[TEST_AUTH_ENV];

		const exporter = createLangfuseExporter(makeConfig());
		const result = await exporter.export([makeSpan()]);

		expect(result.success).toBe(false);
		expect(result.failedCount).toBe(1);
		expect(result.error).toBe("missing auth token");
		expect(calls.length).toBe(0);
	});

	it("handles invalid auth format", async () => {
		const { fn, calls } = makeMockFetch(200);
		globalThis.fetch = fn;
		process.env[TEST_AUTH_ENV] = "no-colon-here";

		const exporter = createLangfuseExporter(makeConfig());
		const result = await exporter.export([makeSpan()]);

		expect(result.success).toBe(false);
		expect(result.failedCount).toBe(1);
		expect(result.error).toBe("invalid auth format");
		expect(calls.length).toBe(0);
	});

	it("handles 401 auth failure", async () => {
		const { fn } = makeMockFetch(401);
		globalThis.fetch = fn;

		const warnMessages: string[] = [];
		const origWarn = console.warn;
		console.warn = (...args: unknown[]) => warnMessages.push(String(args[0]));

		const exporter = createLangfuseExporter(makeConfig());
		const result = await exporter.export([makeSpan()]);

		console.warn = origWarn;

		expect(result.success).toBe(false);
		expect(result.failedCount).toBeGreaterThan(0);
		expect(warnMessages.some((m) => m.includes("401"))).toBe(true);
	});

	it("handles 207 partial success", async () => {
		const mockBody = { successes: [{ id: "s1" }], errors: [{ id: "s2" }] };
		const { fn } = makeMockFetch(207, mockBody);
		globalThis.fetch = fn;

		const exporter = createLangfuseExporter(makeConfig());
		const result = await exporter.export([makeSpan({ kind: "tool", endTime: null })]);

		// 1 span → trace-create + span-create = 2 batch items
		// successes: 1, errors: 1 → remaining unaccounted: 0
		expect(result.exportedCount).toBe(1);
		expect(result.failedCount).toBe(1);
	});

	it("handles network error", async () => {
		globalThis.fetch = (async () => {
			throw new Error("Network failure");
		}) as unknown as typeof fetch;

		const exporter = createLangfuseExporter(makeConfig());
		const result = await exporter.export([makeSpan()]);

		expect(result.success).toBe(false);
		expect(result.failedCount).toBeGreaterThan(0);
	});

	it("handles timeout", async () => {
		globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
			// Simulate AbortError when the signal fires
			const signal = init?.signal as AbortSignal | undefined;
			await new Promise<void>((_, reject) => {
				if (signal) {
					signal.addEventListener("abort", () => {
						const err = new Error("The operation was aborted");
						err.name = "AbortError";
						reject(err);
					});
				}
			});
			return new Response("", { status: 200 });
		}) as typeof fetch;

		const exporter = createLangfuseExporter(makeConfig({ timeoutMs: 10 }));
		const result = await exporter.export([makeSpan()]);

		expect(result.success).toBe(false);
		expect(result.error).toBe("timeout");
	});

	it("respects batchSize config", async () => {
		const { fn, calls } = makeMockFetch(200);
		globalThis.fetch = fn;

		const exporter = createLangfuseExporter(makeConfig({ batchSize: 2 }));
		// 3 spans with different traceIds → 3 trace-creates + 3 span-creates = 6 items → 3 batches of 2
		const spans = [
			makeSpan({ spanId: "s1", traceId: "t1", endTime: null }),
			makeSpan({ spanId: "s2", traceId: "t2", endTime: null }),
			makeSpan({ spanId: "s3", traceId: "t3", endTime: null }),
		];
		await exporter.export(spans);

		expect(calls.length).toBeGreaterThan(1);
	});

	it("sets ERROR level for error status spans", async () => {
		const { fn, calls } = makeMockFetch(200);
		globalThis.fetch = fn;

		const exporter = createLangfuseExporter(makeConfig());
		const span = makeSpan({ status: "error", kind: "tool", endTime: null });
		await exporter.export([span]);

		const body = JSON.parse(calls[0]!.options.body as string) as {
			batch: Array<{ type: string; body: Record<string, unknown> }>;
		};
		const spanCreate = body.batch.find((item) => item.type === "span-create");
		expect(spanCreate).toBeDefined();
		expect(spanCreate!.body.level).toBe("ERROR");
	});

	it("includes correlation keys in trace metadata", async () => {
		const { fn, calls } = makeMockFetch(200);
		globalThis.fetch = fn;

		const exporter = createLangfuseExporter(makeConfig());
		const span = makeSpan({
			resource: {
				agentName: "my-agent",
				runId: "run-42",
				sessionId: "sess-99",
				taskId: "task-007",
				missionId: "mission-alpha",
				capability: "analyst",
			},
		});
		await exporter.export([span]);

		const body = JSON.parse(calls[0]!.options.body as string) as {
			batch: Array<{ type: string; body: { metadata?: Record<string, unknown> } }>;
		};
		const traceCreate = body.batch.find((item) => item.type === "trace-create");
		expect(traceCreate).toBeDefined();
		const meta = traceCreate!.body.metadata;
		expect(meta?.agentName).toBe("my-agent");
		expect(meta?.runId).toBe("run-42");
		expect(meta?.taskId).toBe("task-007");
		expect(meta?.missionId).toBe("mission-alpha");
		expect(meta?.capability).toBe("analyst");
	});

	it("empty spans array returns success", async () => {
		const { fn, calls } = makeMockFetch(200);
		globalThis.fetch = fn;

		const exporter = createLangfuseExporter(makeConfig());
		const result = await exporter.export([]);

		expect(result.success).toBe(true);
		expect(result.exportedCount).toBe(0);
		expect(result.failedCount).toBe(0);
		expect(calls.length).toBe(0);
	});
});
