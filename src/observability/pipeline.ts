/**
 * Async export pipeline that queues spans and flushes them to registered exporters.
 *
 * Export failures never block or crash the agent pipeline. The queue is bounded;
 * when full, the oldest spans are dropped to make room for new ones.
 */

import type { Exporter, ExportSpan } from "./types.js";

export interface PipelineStats {
	queueSize: number;
	totalExported: number;
	totalDropped: number;
	totalErrors: number;
	exporterStats: Record<string, { exported: number; errors: number }>;
}

export interface PipelineOptions {
	/** Maximum number of spans to hold in memory. Default 1000; drops oldest when full. */
	maxQueueSize?: number;
	/** Interval between automatic flushes in ms. Default 10000 (10s). */
	flushIntervalMs?: number;
	/** Maximum spans sent to exporters per flush cycle. Default 100. */
	batchSize?: number;
	/** Number of retry attempts on export failure. Default 2. */
	retryAttempts?: number;
	/** Delay between retry attempts in ms. Default 1000. */
	retryDelayMs?: number;
}

export interface ExportPipeline {
	/** Enqueue spans for export. Synchronous, never throws. Drops oldest if queue is full. */
	enqueue(spans: ExportSpan[]): void;
	/** Force-flush all queued spans to exporters immediately. */
	flush(): Promise<void>;
	/** Flush remaining spans, then shut down all exporters. */
	shutdown(): Promise<void>;
	/** Current queue and cumulative export statistics. */
	getStats(): PipelineStats;
}

const DEFAULT_MAX_QUEUE_SIZE = 1000;
const DEFAULT_FLUSH_INTERVAL_MS = 10_000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_RETRY_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 1000;

/** Sleep for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Export a batch to a single exporter with retry logic.
 * Returns the ExportResult from the last attempt (success or failure).
 */
async function exportWithRetry(
	exporter: Exporter,
	batch: ExportSpan[],
	retryAttempts: number,
	retryDelayMs: number,
): Promise<{ exported: number; errors: number }> {
	let lastError: string | undefined;

	for (let attempt = 0; attempt <= retryAttempts; attempt++) {
		try {
			const result = await exporter.export(batch);
			if (result.success) {
				return { exported: result.exportedCount, errors: 0 };
			}
			lastError = result.error ?? "export returned success=false";
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}

		if (attempt < retryAttempts) {
			await sleep(retryDelayMs);
		}
	}

	console.warn(
		`[pipeline] exporter "${exporter.name}" failed after ${retryAttempts + 1} attempt(s): ${lastError}`,
	);
	return { exported: 0, errors: batch.length };
}

/**
 * Create an async export pipeline that queues spans and flushes them to all
 * registered exporters in the background.
 */
export function createExportPipeline(
	exporters: Exporter[],
	opts?: PipelineOptions,
): ExportPipeline {
	const maxQueueSize = opts?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
	const flushIntervalMs = opts?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
	const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE;
	const retryAttempts = opts?.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
	const retryDelayMs = opts?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

	const queue: ExportSpan[] = [];
	let totalExported = 0;
	let totalDropped = 0;
	let totalErrors = 0;
	let isShuttingDown = false;

	const exporterStats: Record<string, { exported: number; errors: number }> = {};
	for (const exporter of exporters) {
		exporterStats[exporter.name] = { exported: 0, errors: 0 };
	}

	/** Flush up to batchSize spans from the queue to all exporters. */
	async function flushBatch(): Promise<void> {
		if (queue.length === 0) return;

		const batch = queue.splice(0, batchSize);

		await Promise.allSettled(
			exporters.map(async (exporter) => {
				const stats = exporterStats[exporter.name];
				try {
					const result = await exportWithRetry(exporter, batch, retryAttempts, retryDelayMs);
					if (stats !== undefined) {
						stats.exported += result.exported;
						stats.errors += result.errors;
					}
					totalExported += result.exported;
					totalErrors += result.errors;
				} catch (err) {
					// Should not happen — exportWithRetry catches everything, but be safe
					console.warn(`[pipeline] unexpected error from exporter "${exporter.name}": ${err}`);
					if (stats !== undefined) {
						stats.errors += batch.length;
					}
					totalErrors += batch.length;
				}
			}),
		);
	}

	/** Flush ALL queued spans (may take multiple batches). */
	async function flushAll(): Promise<void> {
		while (queue.length > 0) {
			await flushBatch();
		}
	}

	// Start the periodic flush timer.
	const timer = setInterval(() => {
		flushBatch().catch((err) => {
			console.warn(`[pipeline] periodic flush error: ${err}`);
		});
	}, flushIntervalMs);

	// Prevent the timer from keeping the process alive.
	if (typeof timer === "object" && timer !== null && "unref" in timer) {
		(timer as { unref(): void }).unref();
	}

	return {
		enqueue(spans: ExportSpan[]): void {
			if (isShuttingDown) return;

			try {
				for (const span of spans) {
					if (queue.length >= maxQueueSize) {
						// Drop the oldest span to make room.
						queue.shift();
						totalDropped++;
						console.warn(`[pipeline] queue full (${maxQueueSize}); dropped 1 span`);
					}
					queue.push(span);
				}
			} catch {
				// enqueue() must never throw
			}
		},

		async flush(): Promise<void> {
			try {
				await flushAll();
			} catch (err) {
				console.warn(`[pipeline] flush error: ${err}`);
			}
		},

		async shutdown(): Promise<void> {
			isShuttingDown = true;
			clearInterval(timer);

			try {
				await flushAll();
			} catch (err) {
				console.warn(`[pipeline] shutdown flush error: ${err}`);
			}

			await Promise.allSettled(
				exporters.map(async (exporter) => {
					try {
						await exporter.shutdown();
					} catch (err) {
						console.warn(`[pipeline] exporter "${exporter.name}" shutdown error: ${err}`);
					}
				}),
			);
		},

		getStats(): PipelineStats {
			return {
				queueSize: queue.length,
				totalExported,
				totalDropped,
				totalErrors,
				exporterStats: Object.fromEntries(
					Object.entries(exporterStats).map(([name, s]) => [
						name,
						{ exported: s.exported, errors: s.errors },
					]),
				),
			};
		},
	};
}
