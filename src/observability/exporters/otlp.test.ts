import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExportSpan, SpanEvent, SpanResource } from "../types.ts";
import {
	buildPayload,
	buildResourceAttributes,
	createOtlpExporter,
	groupByResource,
	isoToNanos,
	mapAttribute,
	mapSpan,
	traceIdFromRunId,
} from "./otlp.ts";

// Reset module-level auth warning flag between tests
// (can't easily reset, so tests that check it run separately)

const originalFetch = globalThis.fetch;

type MockFetch = typeof globalThis.fetch;

function makeMockFetch(status: number, body: unknown = {}): MockFetch {
	return (async (_url: unknown, _opts?: unknown): Promise<Response> => {
		return new Response(JSON.stringify(body), { status });
	}) as MockFetch;
}

function makeTestResource(overrides: Partial<SpanResource> = {}): SpanResource {
	return {
		agentName: "test-agent",
		runId: "run-123",
		sessionId: "sess-456",
		taskId: "task-789",
		missionId: "mission-abc",
		capability: "builder",
		...overrides,
	};
}

function makeTestSpan(overrides: Partial<ExportSpan> = {}): ExportSpan {
	return {
		spanId: "abcd1234efgh5678",
		parentSpanId: null,
		traceId: "trace-id-placeholder",
		name: "test-span",
		kind: "tool",
		startTime: "2024-01-01T00:00:00.000Z",
		endTime: "2024-01-01T00:00:01.000Z",
		durationMs: 1000,
		status: "ok",
		attributes: { "key.str": "value", "key.num": 42, "key.bool": true },
		events: [],
		resource: makeTestResource(),
		...overrides,
	};
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	delete process.env.TEST_OTLP_TOKEN;
});

describe("isoToNanos", () => {
	test("converts ISO string to nanosecond epoch", () => {
		const result = isoToNanos("2024-01-01T00:00:00.000Z");
		const expectedMs = Date.parse("2024-01-01T00:00:00.000Z");
		expect(result).toBe((BigInt(expectedMs) * 1_000_000n).toString());
	});

	test("returns '0' for null", () => {
		expect(isoToNanos(null)).toBe("0");
	});

	test("returns '0' for invalid string", () => {
		expect(isoToNanos("not-a-date")).toBe("0");
	});
});

describe("traceIdFromRunId", () => {
	test("produces 32-char hex string", () => {
		const result = traceIdFromRunId("run-123");
		expect(result).toMatch(/^[0-9a-f]{32}$/);
	});

	test("is deterministic for same input", () => {
		expect(traceIdFromRunId("run-abc")).toBe(traceIdFromRunId("run-abc"));
	});

	test("produces different output for different input", () => {
		expect(traceIdFromRunId("run-abc")).not.toBe(traceIdFromRunId("run-xyz"));
	});

	test("handles null runId with 32-char result", () => {
		const result = traceIdFromRunId(null);
		expect(result).toHaveLength(32);
		expect(result).toMatch(/^[0-9a-f]{32}$/);
	});
});

describe("mapAttribute", () => {
	test("maps string value", () => {
		expect(mapAttribute("k", "v")).toEqual({ key: "k", value: { stringValue: "v" } });
	});

	test("maps integer number as intValue", () => {
		expect(mapAttribute("k", 42)).toEqual({ key: "k", value: { intValue: "42" } });
	});

	test("maps float number as stringValue", () => {
		expect(mapAttribute("k", 3.14)).toEqual({ key: "k", value: { stringValue: "3.14" } });
	});

	test("maps boolean value", () => {
		expect(mapAttribute("k", true)).toEqual({ key: "k", value: { boolValue: true } });
		expect(mapAttribute("k", false)).toEqual({ key: "k", value: { boolValue: false } });
	});
});

describe("mapSpan", () => {
	test("produces valid OTLP span structure", () => {
		const span = makeTestSpan();
		const result = mapSpan(span);

		expect(result.name).toBe("test-span");
		expect(result.kind).toBe(1); // INTERNAL for 'tool'
		expect(result.status).toEqual({ code: 1 }); // ok = 1
		expect(result.parentSpanId).toBe("");
		expect(result.startTimeUnixNano).not.toBe("0");
		expect(result.endTimeUnixNano).not.toBe("0");
	});

	test("maps mail kind to CLIENT (3)", () => {
		const span = makeTestSpan({ kind: "mail" });
		expect(mapSpan(span).kind).toBe(3);
	});

	test("maps spawn kind to CLIENT (3)", () => {
		const span = makeTestSpan({ kind: "spawn" });
		expect(mapSpan(span).kind).toBe(3);
	});

	test("maps session kind to INTERNAL (1)", () => {
		const span = makeTestSpan({ kind: "session" });
		expect(mapSpan(span).kind).toBe(1);
	});

	test("maps error status to code 2", () => {
		const span = makeTestSpan({ status: "error" });
		expect(mapSpan(span).status).toEqual({ code: 2 });
	});

	test("maps unset status to code 0", () => {
		const span = makeTestSpan({ status: "unset" });
		expect(mapSpan(span).status).toEqual({ code: 0 });
	});

	test("maps attributes correctly", () => {
		const span = makeTestSpan({ attributes: { str: "val", num: 5, flag: false } });
		const result = mapSpan(span);
		expect(result.attributes).toContainEqual({ key: "str", value: { stringValue: "val" } });
		expect(result.attributes).toContainEqual({ key: "num", value: { intValue: "5" } });
		expect(result.attributes).toContainEqual({ key: "flag", value: { boolValue: false } });
	});

	test("maps events", () => {
		const events: SpanEvent[] = [
			{ name: "ev1", timestamp: "2024-01-01T00:00:00.500Z", attributes: { x: "y" } },
		];
		const span = makeTestSpan({ events });
		const result = mapSpan(span);
		expect(result.events).toHaveLength(1);
		expect(result.events[0]?.name).toBe("ev1");
		expect(result.events[0]?.timeUnixNano).not.toBe("0");
	});

	test("null parentSpanId becomes empty string", () => {
		const span = makeTestSpan({ parentSpanId: null });
		expect(mapSpan(span).parentSpanId).toBe("");
	});

	test("non-null parentSpanId is preserved", () => {
		const span = makeTestSpan({ parentSpanId: "parent123" });
		expect(mapSpan(span).parentSpanId).toBe("parent123");
	});
});

describe("buildResourceAttributes", () => {
	test("maps all 5 correlation keys", () => {
		const resource = makeTestResource();
		const attrs = buildResourceAttributes(resource);

		const keys = attrs.map((a) => a.key);
		expect(keys).toContain("service.name");
		expect(keys).toContain("service.instance.id");
		expect(keys).toContain("overstory.session.id");
		expect(keys).toContain("overstory.task.id");
		expect(keys).toContain("overstory.mission.id");
	});

	test("omits null values", () => {
		const resource = makeTestResource({
			runId: null,
			sessionId: null,
			taskId: null,
			missionId: null,
		});
		const attrs = buildResourceAttributes(resource);
		const keys = attrs.map((a) => a.key);

		expect(keys).toContain("service.name");
		expect(keys).not.toContain("service.instance.id");
		expect(keys).not.toContain("overstory.session.id");
		expect(keys).not.toContain("overstory.task.id");
		expect(keys).not.toContain("overstory.mission.id");
	});

	test("service.name uses agentName", () => {
		const resource = makeTestResource({ agentName: "my-agent" });
		const attrs = buildResourceAttributes(resource);
		const nameAttr = attrs.find((a) => a.key === "service.name");
		expect(nameAttr?.value).toEqual({ stringValue: "my-agent" });
	});
});

describe("groupByResource", () => {
	test("groups spans by agentName+runId", () => {
		const spans = [
			makeTestSpan({ resource: makeTestResource({ agentName: "a", runId: "r1" }) }),
			makeTestSpan({ resource: makeTestResource({ agentName: "a", runId: "r1" }) }),
			makeTestSpan({ resource: makeTestResource({ agentName: "b", runId: "r2" }) }),
		];
		const groups = groupByResource(spans);
		expect(groups.size).toBe(2);
	});

	test("spans with same agentName but different runId go to different groups", () => {
		const spans = [
			makeTestSpan({ resource: makeTestResource({ agentName: "a", runId: "r1" }) }),
			makeTestSpan({ resource: makeTestResource({ agentName: "a", runId: "r2" }) }),
		];
		const groups = groupByResource(spans);
		expect(groups.size).toBe(2);
	});
});

describe("buildPayload", () => {
	test("groups spans into ResourceSpans by resource", () => {
		const spans = [
			makeTestSpan({ resource: makeTestResource({ agentName: "a", runId: "r1" }) }),
			makeTestSpan({ resource: makeTestResource({ agentName: "b", runId: "r2" }) }),
		];
		const payload = buildPayload(spans);
		expect(payload.resourceSpans).toHaveLength(2);
	});

	test("each ResourceSpans has correct scope", () => {
		const payload = buildPayload([makeTestSpan()]);
		const scopeSpans = payload.resourceSpans[0]?.scopeSpans[0];
		expect(scopeSpans?.scope.name).toBe("overstory");
		expect(scopeSpans?.scope.version).toBe("0.9.1");
	});

	test("produces valid ResourceSpans structure", () => {
		const payload = buildPayload([makeTestSpan()]);
		const rs = payload.resourceSpans[0];
		expect(rs).toBeDefined();
		expect(rs?.resource.attributes).toBeArray();
		expect(rs?.scopeSpans).toHaveLength(1);
		expect(rs?.scopeSpans[0]?.spans).toHaveLength(1);
	});
});

describe("createOtlpExporter — export success", () => {
	test("returns success with exportedCount on 200", async () => {
		globalThis.fetch = makeMockFetch(200);
		process.env.TEST_OTLP_TOKEN = "tok-abc";

		const exporter = createOtlpExporter({
			type: "otlp",
			enabled: true,
			endpoint: "http://localhost:4318",
			authTokenEnv: "TEST_OTLP_TOKEN",
		});

		const result = await exporter.export([makeTestSpan()]);
		expect(result.success).toBe(true);
		expect(result.exportedCount).toBe(1);
		expect(result.failedCount).toBe(0);
	});

	test("sends POST to /v1/traces", async () => {
		let capturedUrl = "";
		globalThis.fetch = (async (url: unknown, _opts?: unknown) => {
			capturedUrl = String(url);
			return new Response("{}", { status: 200 });
		}) as MockFetch;
		process.env.TEST_OTLP_TOKEN = "tok-abc";

		const exporter = createOtlpExporter({
			type: "otlp",
			enabled: true,
			endpoint: "http://localhost:4318",
			authTokenEnv: "TEST_OTLP_TOKEN",
		});

		await exporter.export([makeTestSpan()]);
		expect(capturedUrl).toBe("http://localhost:4318/v1/traces");
	});

	test("strips trailing slash from endpoint", async () => {
		let capturedUrl = "";
		globalThis.fetch = (async (url: unknown, _opts?: unknown) => {
			capturedUrl = String(url);
			return new Response("{}", { status: 200 });
		}) as MockFetch;
		process.env.TEST_OTLP_TOKEN = "tok-abc";

		const exporter = createOtlpExporter({
			type: "otlp",
			enabled: true,
			endpoint: "http://localhost:4318/",
			authTokenEnv: "TEST_OTLP_TOKEN",
		});

		await exporter.export([makeTestSpan()]);
		expect(capturedUrl).toBe("http://localhost:4318/v1/traces");
	});
});

describe("createOtlpExporter — export 4xx", () => {
	test("returns failure on 400", async () => {
		globalThis.fetch = makeMockFetch(400);
		process.env.TEST_OTLP_TOKEN = "tok-abc";

		const exporter = createOtlpExporter({
			type: "otlp",
			enabled: true,
			endpoint: "http://localhost:4318",
			authTokenEnv: "TEST_OTLP_TOKEN",
		});

		const result = await exporter.export([makeTestSpan()]);
		expect(result.success).toBe(false);
		expect(result.failedCount).toBe(1);
		expect(result.error).toMatch(/400/);
	});
});

describe("createOtlpExporter — export 5xx", () => {
	test("returns failure on 500", async () => {
		globalThis.fetch = makeMockFetch(500);
		process.env.TEST_OTLP_TOKEN = "tok-abc";

		const exporter = createOtlpExporter({
			type: "otlp",
			enabled: true,
			endpoint: "http://localhost:4318",
			authTokenEnv: "TEST_OTLP_TOKEN",
		});

		const result = await exporter.export([makeTestSpan()]);
		expect(result.success).toBe(false);
		expect(result.failedCount).toBe(1);
		expect(result.error).toMatch(/500/);
	});
});

describe("createOtlpExporter — network error", () => {
	test("returns failure when fetch throws", async () => {
		globalThis.fetch = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as MockFetch;
		process.env.TEST_OTLP_TOKEN = "tok-abc";

		const exporter = createOtlpExporter({
			type: "otlp",
			enabled: true,
			endpoint: "http://localhost:4318",
			authTokenEnv: "TEST_OTLP_TOKEN",
		});

		const result = await exporter.export([makeTestSpan()]);
		expect(result.success).toBe(false);
		expect(result.error).toContain("ECONNREFUSED");
	});
});

describe("createOtlpExporter — timeout", () => {
	test("returns failure with timeout message on AbortError", async () => {
		globalThis.fetch = (async (_url: unknown, opts?: unknown) => {
			// Simulate immediate abort
			const options = opts as RequestInit | undefined;
			if (options?.signal) {
				await new Promise<void>((_resolve, reject) => {
					const signal = options.signal as AbortSignal;
					if (signal.aborted) {
						reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
					} else {
						signal.addEventListener("abort", () => {
							reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
						});
					}
				});
			}
			return new Response("{}", { status: 200 });
		}) as MockFetch;
		process.env.TEST_OTLP_TOKEN = "tok-abc";

		const exporter = createOtlpExporter({
			type: "otlp",
			enabled: true,
			endpoint: "http://localhost:4318",
			authTokenEnv: "TEST_OTLP_TOKEN",
			timeoutMs: 1, // 1ms timeout → will abort immediately
		});

		const result = await exporter.export([makeTestSpan()]);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/timed out/i);
	});
});

describe("createOtlpExporter — missing auth token", () => {
	beforeEach(() => {
		delete process.env.TEST_OTLP_TOKEN;
	});

	test("returns failure when auth token env var is not set", async () => {
		globalThis.fetch = makeMockFetch(200);

		const exporter = createOtlpExporter({
			type: "otlp",
			enabled: true,
			endpoint: "http://localhost:4318",
			authTokenEnv: "TEST_OTLP_TOKEN",
		});

		const result = await exporter.export([makeTestSpan()]);
		expect(result.success).toBe(false);
		expect(result.error).toContain("TEST_OTLP_TOKEN");
	});
});

describe("createOtlpExporter — empty spans", () => {
	test("returns immediate success for empty array", async () => {
		let fetchCalled = false;
		globalThis.fetch = (async () => {
			fetchCalled = true;
			return new Response("{}", { status: 200 });
		}) as unknown as MockFetch;

		const exporter = createOtlpExporter({
			type: "otlp",
			enabled: true,
			endpoint: "http://localhost:4318",
			authTokenEnv: "TEST_OTLP_TOKEN",
		});

		const result = await exporter.export([]);
		expect(result.success).toBe(true);
		expect(result.exportedCount).toBe(0);
		expect(fetchCalled).toBe(false);
	});
});

describe("createOtlpExporter — auth header", () => {
	test("sends Bearer token from env var", async () => {
		let capturedHeaders: Record<string, string> = {};
		globalThis.fetch = (async (_url: unknown, opts?: unknown) => {
			const options = opts as RequestInit | undefined;
			capturedHeaders = Object.fromEntries(new Headers(options?.headers as HeadersInit).entries());
			return new Response("{}", { status: 200 });
		}) as MockFetch;
		process.env.TEST_OTLP_TOKEN = "my-secret-token";

		const exporter = createOtlpExporter({
			type: "otlp",
			enabled: true,
			endpoint: "http://localhost:4318",
			authTokenEnv: "TEST_OTLP_TOKEN",
		});

		await exporter.export([makeTestSpan()]);
		expect(capturedHeaders.authorization).toBe("Bearer my-secret-token");
	});
});

describe("createOtlpExporter — custom headers", () => {
	test("merges config.headers into request", async () => {
		let capturedHeaders: Record<string, string> = {};
		globalThis.fetch = (async (_url: unknown, opts?: unknown) => {
			const options = opts as RequestInit | undefined;
			capturedHeaders = Object.fromEntries(new Headers(options?.headers as HeadersInit).entries());
			return new Response("{}", { status: 200 });
		}) as MockFetch;
		process.env.TEST_OTLP_TOKEN = "tok";

		const exporter = createOtlpExporter({
			type: "otlp",
			enabled: true,
			endpoint: "http://localhost:4318",
			authTokenEnv: "TEST_OTLP_TOKEN",
			headers: { "x-custom-header": "custom-value" },
		});

		await exporter.export([makeTestSpan()]);
		expect(capturedHeaders["x-custom-header"]).toBe("custom-value");
	});
});

describe("shutdown", () => {
	test("resolves without error", async () => {
		const exporter = createOtlpExporter({
			type: "otlp",
			enabled: true,
			endpoint: "http://localhost:4318",
			authTokenEnv: "TEST_OTLP_TOKEN",
		});

		await expect(exporter.shutdown()).resolves.toBeUndefined();
	});
});
