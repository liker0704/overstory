// === Observability Export Types ===

/** Span classification for distributed tracing. */
export type SpanKind = "session" | "turn" | "tool" | "mail" | "spawn" | "mission" | "custom";

/** All valid span kind strings as a runtime array. */
export const SPAN_KINDS: readonly SpanKind[] = [
	"session",
	"turn",
	"tool",
	"mail",
	"spawn",
	"mission",
	"custom",
] as const;

/** Span completion status. */
export type SpanStatus = "ok" | "error" | "unset";

/** All valid span status strings as a runtime array. */
export const SPAN_STATUSES: readonly SpanStatus[] = ["ok", "error", "unset"] as const;

/** A discrete event recorded within a span. */
export interface SpanEvent {
	name: string;
	timestamp: string;
	attributes: Record<string, string | number | boolean>;
}

/** Resource context attached to every span. */
export interface SpanResource {
	agentName: string;
	runId: string | null;
	sessionId: string | null;
	taskId: string | null;
	missionId: string | null;
	capability: string | null;
}

/** A completed or in-progress span ready for export. */
export interface ExportSpan {
	spanId: string;
	parentSpanId: string | null;
	traceId: string;
	name: string;
	kind: SpanKind;
	startTime: string;
	endTime: string | null;
	durationMs: number | null;
	status: SpanStatus;
	attributes: Record<string, string | number | boolean>;
	events: SpanEvent[];
	resource: SpanResource;
}

/** Result returned by an exporter after processing a batch of spans. */
export interface ExportResult {
	success: boolean;
	exportedCount: number;
	failedCount: number;
	error?: string;
}

/** Interface that all span exporters must implement. */
export interface Exporter {
	readonly name: string;
	export(spans: ExportSpan[]): Promise<ExportResult>;
	shutdown(): Promise<void>;
}

/** Per-exporter configuration. */
export interface ExporterConfig {
	type: "otlp" | "langfuse" | "langsmith";
	enabled: boolean;
	endpoint: string;
	authTokenEnv: string;
	headers?: Record<string, string>;
	batchSize?: number;
	flushIntervalMs?: number;
	maxQueueSize?: number;
	timeoutMs?: number;
}

/** Top-level observability configuration block. */
export interface ObservabilityConfig {
	enabled: boolean;
	exporters: ExporterConfig[];
}
