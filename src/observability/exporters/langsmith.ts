/**
 * LangSmith REST v1 exporter — sends ExportSpan batches to LangSmith via raw fetch().
 * No langsmith-sdk dependency; uses /api/v1/runs/batch endpoint.
 */

import type { Exporter, ExporterConfig, ExportResult, ExportSpan, SpanKind } from "../types.js";

const DEFAULT_ENDPOINT = "https://api.smith.langchain.com";
const DEFAULT_TIMEOUT_MS = 10_000;

/** LangSmith run_type values accepted by the batch endpoint. */
type LangSmithRunType = "chain" | "llm" | "tool";

function spanKindToRunType(kind: SpanKind): LangSmithRunType {
	if (kind === "turn") return "llm";
	if (kind === "tool") return "tool";
	return "chain";
}

interface LangSmithRun {
	id: string;
	trace_id: string;
	parent_run_id: string | null;
	name: string;
	run_type: LangSmithRunType;
	start_time: string;
	end_time: string | null;
	status: "success" | "error";
	extra: { metadata: Record<string, string | number | boolean | null> };
	tags: string[];
	session_name: string | null;
}

function spanToRun(span: ExportSpan): LangSmithRun {
	const { resource, attributes } = span;

	const tags: string[] = [];
	if (resource.agentName) tags.push(resource.agentName);
	if (resource.capability !== null) tags.push(resource.capability);
	if (resource.taskId !== null) tags.push(resource.taskId);

	return {
		id: span.spanId,
		trace_id: span.traceId,
		parent_run_id: span.parentSpanId,
		name: span.name,
		run_type: spanKindToRunType(span.kind),
		start_time: span.startTime,
		end_time: span.endTime,
		status: span.status === "error" ? "error" : "success",
		extra: {
			metadata: {
				agentName: resource.agentName,
				runId: resource.runId,
				sessionId: resource.sessionId,
				taskId: resource.taskId,
				missionId: resource.missionId,
				capability: resource.capability,
				...attributes,
			},
		},
		tags,
		session_name: resource.runId,
	};
}

/**
 * Create a LangSmith exporter that POSTs span batches to /api/v1/runs/batch.
 */
export function createLangSmithExporter(config: ExporterConfig): Exporter {
	const endpoint = config.endpoint || DEFAULT_ENDPOINT;
	const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let authWarningShown = false;

	function warnOnce(msg: string): void {
		if (!authWarningShown) {
			authWarningShown = true;
			console.warn(`[langsmith] ${msg}`);
		}
	}

	return {
		name: "langsmith",

		async export(spans: ExportSpan[]): Promise<ExportResult> {
			if (spans.length === 0) {
				return { success: true, exportedCount: 0, failedCount: 0 };
			}

			const apiKey = process.env[config.authTokenEnv];
			if (!apiKey) {
				warnOnce(`auth token env var "${config.authTokenEnv}" is not set — skipping export`);
				return {
					success: false,
					exportedCount: 0,
					failedCount: spans.length,
					error: "missing auth token",
				};
			}

			const runs = spans.map(spanToRun);
			const body = JSON.stringify({ post: runs, patch: [] });

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);

			try {
				const res = await fetch(`${endpoint}/api/v1/runs/batch`, {
					method: "POST",
					signal: controller.signal,
					headers: {
						"content-type": "application/json",
						"x-api-key": apiKey,
						...config.headers,
					},
					body,
				});

				if (res.status === 401 || res.status === 403) {
					warnOnce(`authentication failed (HTTP ${res.status}) — check your API key`);
					return {
						success: false,
						exportedCount: 0,
						failedCount: spans.length,
						error: `HTTP ${res.status}`,
					};
				}

				if (res.status === 422) {
					console.warn(`[langsmith] bad data rejected by server (HTTP 422)`);
					return {
						success: false,
						exportedCount: 0,
						failedCount: spans.length,
						error: "HTTP 422 unprocessable",
					};
				}

				if (res.status >= 500) {
					return {
						success: false,
						exportedCount: 0,
						failedCount: spans.length,
						error: `HTTP ${res.status}`,
					};
				}

				return { success: true, exportedCount: spans.length, failedCount: 0 };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { success: false, exportedCount: 0, failedCount: spans.length, error: msg };
			} finally {
				clearTimeout(timer);
			}
		},

		async shutdown(): Promise<void> {
			// No persistent connections to close.
		},
	};
}
