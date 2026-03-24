import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ExportSpan, SpanKind } from "../types.js";
import { createLangSmithExporter } from "./langsmith.js";

// ---- helpers ----------------------------------------------------------------

function makeSpan(overrides: Partial<ExportSpan> = {}): ExportSpan {
	return {
		spanId: "span-1",
		parentSpanId: null,
		traceId: "trace-1",
		name: "test-span",
		kind: "session",
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
			missionId: null,
			capability: "builder",
		},
		...overrides,
	};
}

const DEFAULT_ENV_VAR = "LANGSMITH_API_KEY";

// ---- fetch mock setup -------------------------------------------------------

let mockFetch: ReturnType<typeof mock>;

beforeEach(() => {
	mockFetch = mock(async (_url: string, _opts?: RequestInit) => {
		return new Response(null, { status: 200 });
	});
	global.fetch = mockFetch as unknown as typeof fetch;
	process.env[DEFAULT_ENV_VAR] = "test-api-key";
});

afterEach(() => {
	delete process.env[DEFAULT_ENV_VAR];
});

function makeConfig(overrides: { endpoint?: string; authTokenEnv?: string } = {}) {
	return {
		type: "langsmith" as const,
		enabled: true,
		endpoint: "https://api.smith.langchain.com",
		authTokenEnv: DEFAULT_ENV_VAR,
		...overrides,
	};
}

// ---- tests ------------------------------------------------------------------

describe("createLangSmithExporter", () => {
	test("empty spans returns success with 0 counts", async () => {
		const exporter = createLangSmithExporter(makeConfig());
		const result = await exporter.export([]);

		expect(result.success).toBe(true);
		expect(result.exportedCount).toBe(0);
		expect(result.failedCount).toBe(0);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	test("correct run mapping from ExportSpan", async () => {
		const exporter = createLangSmithExporter(makeConfig());
		const span = makeSpan({ kind: "session" });

		await exporter.export([span]);

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(opts.body as string) as { post: unknown[] };

		expect(body.post).toHaveLength(1);
		const run = body.post[0] as Record<string, unknown>;

		expect(run.id).toBe("span-1");
		expect(run.trace_id).toBe("trace-1");
		expect(run.parent_run_id).toBeNull();
		expect(run.name).toBe("test-span");
		expect(run.run_type).toBe("chain");
		expect(run.start_time).toBe("2024-01-01T00:00:00.000Z");
		expect(run.end_time).toBe("2024-01-01T00:00:01.000Z");
		expect(run.status).toBe("success");
		expect(run.session_name).toBe("run-1");
	});

	test("turn spans map to 'llm' run_type", async () => {
		const exporter = createLangSmithExporter(makeConfig());
		await exporter.export([makeSpan({ kind: "turn" as SpanKind })]);

		const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(opts.body as string) as { post: { run_type: string }[] };
		expect(body.post[0]?.run_type).toBe("llm");
	});

	test("tool spans map to 'tool' run_type", async () => {
		const exporter = createLangSmithExporter(makeConfig());
		await exporter.export([makeSpan({ kind: "tool" as SpanKind })]);

		const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(opts.body as string) as { post: { run_type: string }[] };
		expect(body.post[0]?.run_type).toBe("tool");
	});

	test("mail/spawn/mission/custom all map to 'chain'", async () => {
		const exporter = createLangSmithExporter(makeConfig());
		for (const kind of ["mail", "spawn", "mission", "custom"] as SpanKind[]) {
			mockFetch = mock(async () => new Response(null, { status: 200 }));
			global.fetch = mockFetch as unknown as typeof fetch;
			await exporter.export([makeSpan({ kind })]);

			const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
			const body = JSON.parse(opts.body as string) as { post: { run_type: string }[] };
			expect(body.post[0]?.run_type).toBe("chain");
		}
	});

	test("auth token missing returns failure", async () => {
		delete process.env[DEFAULT_ENV_VAR];
		const exporter = createLangSmithExporter(makeConfig());
		const result = await exporter.export([makeSpan()]);

		expect(result.success).toBe(false);
		expect(result.failedCount).toBe(1);
		expect(result.exportedCount).toBe(0);
		expect(result.error).toContain("missing auth token");
		expect(mockFetch).not.toHaveBeenCalled();
	});

	test("401 response returns failure without throwing", async () => {
		mockFetch = mock(async () => new Response(null, { status: 401 }));
		global.fetch = mockFetch as unknown as typeof fetch;

		const exporter = createLangSmithExporter(makeConfig());
		const result = await exporter.export([makeSpan()]);

		expect(result.success).toBe(false);
		expect(result.failedCount).toBe(1);
		expect(result.error).toContain("401");
	});

	test("403 response returns failure without throwing", async () => {
		mockFetch = mock(async () => new Response(null, { status: 403 }));
		global.fetch = mockFetch as unknown as typeof fetch;

		const exporter = createLangSmithExporter(makeConfig());
		const result = await exporter.export([makeSpan()]);

		expect(result.success).toBe(false);
		expect(result.failedCount).toBe(1);
		expect(result.error).toContain("403");
	});

	test("422 response returns failure", async () => {
		mockFetch = mock(async () => new Response(null, { status: 422 }));
		global.fetch = mockFetch as unknown as typeof fetch;

		const exporter = createLangSmithExporter(makeConfig());
		const result = await exporter.export([makeSpan()]);

		expect(result.success).toBe(false);
		expect(result.failedCount).toBe(1);
		expect(result.error).toContain("422");
	});

	test("5xx response returns failure", async () => {
		mockFetch = mock(async () => new Response(null, { status: 500 }));
		global.fetch = mockFetch as unknown as typeof fetch;

		const exporter = createLangSmithExporter(makeConfig());
		const result = await exporter.export([makeSpan()]);

		expect(result.success).toBe(false);
		expect(result.failedCount).toBe(1);
		expect(result.error).toContain("500");
	});

	test("network error returns failure", async () => {
		mockFetch = mock(async () => {
			throw new Error("network failure");
		});
		global.fetch = mockFetch as unknown as typeof fetch;

		const exporter = createLangSmithExporter(makeConfig());
		const result = await exporter.export([makeSpan()]);

		expect(result.success).toBe(false);
		expect(result.failedCount).toBe(1);
		expect(result.error).toContain("network failure");
	});

	test("tags built from non-null resource fields", async () => {
		const exporter = createLangSmithExporter(makeConfig());
		const span = makeSpan({
			resource: {
				agentName: "my-agent",
				runId: "run-x",
				sessionId: "sess-1",
				taskId: "task-abc",
				missionId: null,
				capability: "builder",
			},
		});

		await exporter.export([span]);

		const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(opts.body as string) as { post: { tags: string[] }[] };
		const tags = body.post[0]?.tags ?? [];

		expect(tags).toContain("my-agent");
		expect(tags).toContain("task-abc");
		expect(tags).toContain("builder");
		// missionId is null so it should not appear
		expect(tags).not.toContain(null);
	});

	test("correlation keys (resource + attributes) visible in extra.metadata", async () => {
		const exporter = createLangSmithExporter(makeConfig());
		const span = makeSpan({
			attributes: { model: "claude-opus", tokens: 123 },
			resource: {
				agentName: "agent-a",
				runId: "run-99",
				sessionId: "sess-99",
				taskId: "task-99",
				missionId: "mission-1",
				capability: "reviewer",
			},
		});

		await exporter.export([span]);

		const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(opts.body as string) as {
			post: { extra: { metadata: Record<string, unknown> } }[];
		};
		const meta = body.post[0]?.extra?.metadata ?? {};

		// resource fields
		expect(meta.agentName).toBe("agent-a");
		expect(meta.runId).toBe("run-99");
		expect(meta.sessionId).toBe("sess-99");
		expect(meta.taskId).toBe("task-99");
		expect(meta.missionId).toBe("mission-1");
		expect(meta.capability).toBe("reviewer");
		// span attributes
		expect(meta.model).toBe("claude-opus");
		expect(meta.tokens).toBe(123);
	});

	test("shutdown() resolves without error", async () => {
		const exporter = createLangSmithExporter(makeConfig());
		await expect(exporter.shutdown()).resolves.toBeUndefined();
	});

	test("error span status maps to 'error' run status", async () => {
		const exporter = createLangSmithExporter(makeConfig());
		await exporter.export([makeSpan({ status: "error" })]);

		const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(opts.body as string) as { post: { status: string }[] };
		expect(body.post[0]?.status).toBe("error");
	});

	test("sends x-api-key header with token value", async () => {
		const exporter = createLangSmithExporter(makeConfig());
		await exporter.export([makeSpan()]);

		const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
		const headers = opts.headers as Record<string, string>;
		expect(headers["x-api-key"]).toBe("test-api-key");
	});
});
