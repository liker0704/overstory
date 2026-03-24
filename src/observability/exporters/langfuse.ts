import type { Exporter, ExporterConfig, ExportResult, ExportSpan } from "../types.ts";

interface LangfuseBatchItem {
	id: string;
	type: string;
	body: Record<string, unknown>;
	timestamp: string;
}

// Module-level flags for one-time warnings
let authWarningShown = false;
let authFailureWarningShown = false;

function resetWarnings(): void {
	authWarningShown = false;
	authFailureWarningShown = false;
}

function buildBatchItems(spans: ExportSpan[]): LangfuseBatchItem[] {
	const items: LangfuseBatchItem[] = [];
	const seenTraceIds = new Set<string>();

	for (const span of spans) {
		// Deduplicate trace-create per traceId
		if (!seenTraceIds.has(span.traceId)) {
			seenTraceIds.add(span.traceId);
			items.push({
				id: crypto.randomUUID(),
				type: "trace-create",
				body: {
					id: span.traceId,
					name: span.resource.agentName,
					metadata: {
						agentName: span.resource.agentName,
						runId: span.resource.runId,
						sessionId: span.resource.sessionId,
						taskId: span.resource.taskId,
						missionId: span.resource.missionId,
						capability: span.resource.capability,
					},
				},
				timestamp: new Date().toISOString(),
			});
		}

		if (span.kind === "turn") {
			// Map turn spans to generation-create
			const body: Record<string, unknown> = {
				id: span.spanId,
				traceId: span.traceId,
				name: span.name,
				startTime: span.startTime,
				metadata: span.attributes,
			};

			if (span.parentSpanId !== null) {
				body.parentObservationId = span.parentSpanId;
			}
			if (span.endTime !== null) {
				body.endTime = span.endTime;
				body.completionStartTime = span.startTime;
			}
			if (span.status === "error") {
				body.level = "ERROR";
			}

			const inputTokens = span.attributes["llm.input_tokens"];
			if (inputTokens !== undefined) {
				body.promptTokens = inputTokens;
			}
			const outputTokens = span.attributes["llm.output_tokens"];
			if (outputTokens !== undefined) {
				body.completionTokens = outputTokens;
			}
			const model = span.attributes["llm.model"];
			if (model !== undefined) {
				body.model = model;
			}

			items.push({
				id: crypto.randomUUID(),
				type: "generation-create",
				body,
				timestamp: new Date().toISOString(),
			});
		} else {
			// Map other spans to span-create + optional span-update
			const body: Record<string, unknown> = {
				id: span.spanId,
				traceId: span.traceId,
				name: span.name,
				startTime: span.startTime,
				metadata: span.attributes,
			};

			if (span.parentSpanId !== null) {
				body.parentObservationId = span.parentSpanId;
			}
			if (span.status === "error") {
				body.level = "ERROR";
			}

			items.push({
				id: crypto.randomUUID(),
				type: "span-create",
				body,
				timestamp: new Date().toISOString(),
			});

			if (span.endTime !== null) {
				items.push({
					id: crypto.randomUUID(),
					type: "span-update",
					body: {
						spanId: span.spanId,
						traceId: span.traceId,
						endTime: span.endTime,
					},
					timestamp: new Date().toISOString(),
				});
			}
		}
	}

	return items;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < arr.length; i += size) {
		chunks.push(arr.slice(i, i + size));
	}
	return chunks;
}

async function postBatch(
	endpoint: string,
	authHeader: string,
	batchItems: LangfuseBatchItem[],
	timeoutMs: number,
): Promise<{ exported: number; failed: number; authFailed?: boolean; error?: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(`${endpoint}/api/public/ingestion`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: authHeader,
			},
			body: JSON.stringify({ batch: batchItems }),
			signal: controller.signal,
		});

		if (response.status === 200) {
			return { exported: batchItems.length, failed: 0 };
		}

		if (response.status === 401 || response.status === 403) {
			return { exported: 0, failed: batchItems.length, authFailed: true };
		}

		if (response.status === 207) {
			try {
				const body = (await response.json()) as {
					successes?: unknown[];
					errors?: unknown[];
				};
				const exported = body.successes?.length ?? 0;
				const failed = body.errors?.length ?? 0;
				const unaccounted = batchItems.length - exported - failed;
				return { exported, failed: failed + (unaccounted > 0 ? unaccounted : 0) };
			} catch {
				return { exported: 0, failed: batchItems.length, error: "Failed to parse 207 response" };
			}
		}

		return {
			exported: 0,
			failed: batchItems.length,
			error: `HTTP ${response.status} ${response.statusText}`,
		};
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			return { exported: 0, failed: batchItems.length, error: "timeout" };
		}
		const message = err instanceof Error ? err.message : String(err);
		return { exported: 0, failed: batchItems.length, error: message };
	} finally {
		clearTimeout(timer);
	}
}

export function createLangfuseExporter(config: ExporterConfig): Exporter {
	// Reset per-exporter warnings (allows fresh instances to warn again in tests)
	resetWarnings();

	return {
		name: "langfuse",

		async export(spans: ExportSpan[]): Promise<ExportResult> {
			if (spans.length === 0) {
				return { success: true, exportedCount: 0, failedCount: 0 };
			}

			// Resolve auth token
			const rawToken = process.env[config.authTokenEnv];
			if (!rawToken) {
				if (!authWarningShown) {
					authWarningShown = true;
					console.warn(
						`[langfuse] Auth env var '${config.authTokenEnv}' is not set — export skipped`,
					);
				}
				return {
					success: false,
					exportedCount: 0,
					failedCount: spans.length,
					error: "missing auth token",
				};
			}

			const colonIdx = rawToken.indexOf(":");
			if (colonIdx === -1) {
				if (!authWarningShown) {
					authWarningShown = true;
					console.warn(
						`[langfuse] Auth env var '${config.authTokenEnv}' must be 'publicKey:secretKey' — export skipped`,
					);
				}
				return {
					success: false,
					exportedCount: 0,
					failedCount: spans.length,
					error: "invalid auth format",
				};
			}

			const publicKey = rawToken.slice(0, colonIdx);
			const secretKey = rawToken.slice(colonIdx + 1);
			const authHeader = `Basic ${btoa(`${publicKey}:${secretKey}`)}`;

			const batchItems = buildBatchItems(spans);
			const batchSize = config.batchSize ?? 100;
			const timeoutMs = config.timeoutMs ?? 5000;
			const chunks = chunkArray(batchItems, batchSize);

			let totalExported = 0;
			let totalFailed = 0;
			let lastError: string | undefined;

			for (const chunk of chunks) {
				const result = await postBatch(config.endpoint, authHeader, chunk, timeoutMs);

				if (result.authFailed) {
					if (!authFailureWarningShown) {
						authFailureWarningShown = true;
						console.warn("[langfuse] Authentication failed (401/403) — check your credentials");
					}
					totalFailed += result.failed;
				} else {
					totalExported += result.exported;
					totalFailed += result.failed;
					if (result.error) {
						lastError = result.error;
					}
				}
			}

			const success = totalFailed === 0;
			return {
				success,
				exportedCount: totalExported,
				failedCount: totalFailed,
				...(lastError !== undefined ? { error: lastError } : {}),
			};
		},

		async shutdown(): Promise<void> {
			// No persistent connections — no-op
		},
	};
}
