import { afterEach, describe, expect, test } from "bun:test";
import { createExportPipeline } from "./pipeline.js";
import type { Exporter, ExportResult, ExportSpan } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpan(id: string): ExportSpan {
	return {
		spanId: id,
		parentSpanId: null,
		traceId: "trace-1",
		name: "test-span",
		kind: "tool",
		startTime: new Date().toISOString(),
		endTime: null,
		durationMs: null,
		status: "ok",
		attributes: {},
		events: [],
		resource: {
			agentName: "test-agent",
			runId: null,
			sessionId: null,
			taskId: null,
			missionId: null,
			capability: null,
		},
	};
}

function makeExporter(
	name: string,
	exportFn?: (spans: ExportSpan[]) => Promise<ExportResult>,
): Exporter & { received: ExportSpan[][]; shutdownCalled: boolean } {
	const received: ExportSpan[][] = [];
	let shutdownCalled = false;
	return {
		name,
		received,
		get shutdownCalled() {
			return shutdownCalled;
		},
		async export(spans: ExportSpan[]): Promise<ExportResult> {
			received.push(spans);
			if (exportFn) return exportFn(spans);
			return { success: true, exportedCount: spans.length, failedCount: 0 };
		},
		async shutdown(): Promise<void> {
			shutdownCalled = true;
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExportPipeline", () => {
	let pipeline: ReturnType<typeof createExportPipeline>;

	afterEach(async () => {
		// Ensure timers are cleaned up between tests
		await pipeline.shutdown();
	});

	// -------------------------------------------------------------------------
	// enqueue() safety
	// -------------------------------------------------------------------------

	test("enqueue() never throws with valid spans", () => {
		const exporter = makeExporter("a");
		pipeline = createExportPipeline([exporter]);
		expect(() => pipeline.enqueue([makeSpan("s1"), makeSpan("s2")])).not.toThrow();
	});

	test("enqueue() never throws with empty array", () => {
		const exporter = makeExporter("a");
		pipeline = createExportPipeline([exporter]);
		expect(() => pipeline.enqueue([])).not.toThrow();
	});

	test("enqueue() never throws even when called with invalid-looking data", () => {
		const exporter = makeExporter("a");
		pipeline = createExportPipeline([exporter]);
		// Cast to any to simulate bad caller data
		// biome-ignore lint/suspicious/noExplicitAny: intentional invalid data test
		expect(() => pipeline.enqueue(null as any)).not.toThrow();
	});

	// -------------------------------------------------------------------------
	// Queue drop behavior
	// -------------------------------------------------------------------------

	test("drops oldest spans when queue exceeds maxQueueSize", async () => {
		const exporter = makeExporter("a");
		pipeline = createExportPipeline([exporter], {
			maxQueueSize: 3,
			flushIntervalMs: 60_000, // no automatic flush during test
			batchSize: 10,
		});

		// Enqueue 5 spans into a queue that holds 3
		for (let i = 0; i < 5; i++) {
			pipeline.enqueue([makeSpan(`s${i}`)]);
		}

		const stats = pipeline.getStats();
		expect(stats.queueSize).toBe(3);
		expect(stats.totalDropped).toBe(2);
	});

	test("totalDropped accumulates across multiple overflow events", () => {
		const exporter = makeExporter("a");
		pipeline = createExportPipeline([exporter], {
			maxQueueSize: 2,
			flushIntervalMs: 60_000,
		});

		pipeline.enqueue([makeSpan("s1"), makeSpan("s2"), makeSpan("s3"), makeSpan("s4")]);
		expect(pipeline.getStats().totalDropped).toBe(2);
	});

	// -------------------------------------------------------------------------
	// Flush behavior
	// -------------------------------------------------------------------------

	test("flush() sends spans to all exporters in parallel", async () => {
		const a = makeExporter("a");
		const b = makeExporter("b");
		pipeline = createExportPipeline([a, b], { flushIntervalMs: 60_000, batchSize: 100 });

		pipeline.enqueue([makeSpan("s1"), makeSpan("s2")]);
		await pipeline.flush();

		expect(a.received.flat()).toHaveLength(2);
		expect(b.received.flat()).toHaveLength(2);
	});

	test("individual exporter failure does not block other exporters", async () => {
		const failing = makeExporter("failing", async () => {
			throw new Error("network error");
		});
		const working = makeExporter("working");
		pipeline = createExportPipeline([failing, working], {
			flushIntervalMs: 60_000,
			retryAttempts: 0,
		});

		pipeline.enqueue([makeSpan("s1")]);
		await pipeline.flush();

		expect(working.received.flat()).toHaveLength(1);
	});

	test("flush() resolves even when all exporters fail", async () => {
		const failing = makeExporter("failing", async () => {
			throw new Error("always fails");
		});
		pipeline = createExportPipeline([failing], {
			flushIntervalMs: 60_000,
			retryAttempts: 0,
		});

		pipeline.enqueue([makeSpan("s1")]);
		await expect(pipeline.flush()).resolves.toBeUndefined();
	});

	// -------------------------------------------------------------------------
	// Retry behavior
	// -------------------------------------------------------------------------

	test("retries on failure and succeeds on second attempt", async () => {
		let attempts = 0;
		const flaky = makeExporter("flaky", async (spans) => {
			attempts++;
			if (attempts === 1) {
				return { success: false, exportedCount: 0, failedCount: spans.length, error: "transient" };
			}
			return { success: true, exportedCount: spans.length, failedCount: 0 };
		});
		pipeline = createExportPipeline([flaky], {
			flushIntervalMs: 60_000,
			retryAttempts: 2,
			retryDelayMs: 10,
		});

		pipeline.enqueue([makeSpan("s1")]);
		await pipeline.flush();

		expect(attempts).toBe(2);
		expect(pipeline.getStats().totalExported).toBe(1);
		expect(pipeline.getStats().totalErrors).toBe(0);
	});

	test("after exhausting retries spans are counted as errors", async () => {
		const alwaysFail = makeExporter("alwaysFail", async (spans) => ({
			success: false,
			exportedCount: 0,
			failedCount: spans.length,
			error: "permanent",
		}));
		pipeline = createExportPipeline([alwaysFail], {
			flushIntervalMs: 60_000,
			retryAttempts: 1,
			retryDelayMs: 10,
		});

		pipeline.enqueue([makeSpan("s1")]);
		await pipeline.flush();

		const stats = pipeline.getStats();
		expect(stats.totalErrors).toBe(1);
		expect(stats.totalExported).toBe(0);
	});

	// -------------------------------------------------------------------------
	// Shutdown behavior
	// -------------------------------------------------------------------------

	test("shutdown() flushes remaining spans before closing exporters", async () => {
		const received: ExportSpan[] = [];
		let shutdownAfterExport = false;
		const exporter: Exporter = {
			name: "ordered",
			async export(spans) {
				received.push(...spans);
				return { success: true, exportedCount: spans.length, failedCount: 0 };
			},
			async shutdown() {
				shutdownAfterExport = received.length > 0;
			},
		};
		pipeline = createExportPipeline([exporter], { flushIntervalMs: 60_000 });

		pipeline.enqueue([makeSpan("s1"), makeSpan("s2")]);
		await pipeline.shutdown();

		expect(received).toHaveLength(2);
		expect(shutdownAfterExport).toBe(true);
	});

	test("shutdown() calls shutdown on all exporters", async () => {
		const a = makeExporter("a");
		const b = makeExporter("b");
		pipeline = createExportPipeline([a, b], { flushIntervalMs: 60_000 });
		await pipeline.shutdown();

		expect(a.shutdownCalled).toBe(true);
		expect(b.shutdownCalled).toBe(true);
	});

	test("enqueue() after shutdown is a no-op", async () => {
		const exporter = makeExporter("a");
		pipeline = createExportPipeline([exporter], { flushIntervalMs: 60_000 });
		await pipeline.shutdown();

		pipeline.enqueue([makeSpan("s1")]);
		expect(pipeline.getStats().queueSize).toBe(0);
	});

	// -------------------------------------------------------------------------
	// Stats accuracy
	// -------------------------------------------------------------------------

	test("stats accurately track totalExported and queueSize after flush", async () => {
		const exporter = makeExporter("a");
		pipeline = createExportPipeline([exporter], {
			flushIntervalMs: 60_000,
			batchSize: 10,
		});

		pipeline.enqueue([makeSpan("s1"), makeSpan("s2"), makeSpan("s3")]);
		expect(pipeline.getStats().queueSize).toBe(3);

		await pipeline.flush();

		const stats = pipeline.getStats();
		expect(stats.queueSize).toBe(0);
		expect(stats.totalExported).toBe(3);
	});

	test("exporterStats tracks per-exporter counts", async () => {
		const a = makeExporter("exp-a");
		const b = makeExporter("exp-b", async () => ({
			success: false,
			exportedCount: 0,
			failedCount: 1,
			error: "fail",
		}));
		pipeline = createExportPipeline([a, b], {
			flushIntervalMs: 60_000,
			retryAttempts: 0,
		});

		pipeline.enqueue([makeSpan("s1")]);
		await pipeline.flush();

		const stats = pipeline.getStats();
		expect(stats.exporterStats["exp-a"]?.exported).toBe(1);
		expect(stats.exporterStats["exp-a"]?.errors).toBe(0);
		expect(stats.exporterStats["exp-b"]?.exported).toBe(0);
		expect(stats.exporterStats["exp-b"]?.errors).toBe(1);
	});
});
