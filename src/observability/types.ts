export type SpanKind = "session" | "turn" | "tool" | "mail" | "spawn" | "mission" | "custom";
export type SpanStatus = "ok" | "error" | "unset";

export interface SpanEvent {
	name: string;
	timestamp: string;
	attributes: Record<string, string | number | boolean>;
}

export interface SpanResource {
	agentName: string;
	runId: string | null;
	sessionId: string | null;
	taskId: string | null;
	missionId: string | null;
	capability: string | null;
}

export interface ExportSpan {
	spanId: string;
	parentSpanId: string | null;
	traceId: string;
	name: string;
	kind: SpanKind;
	startTime: string; // ISO 8601
	endTime: string | null;
	durationMs: number | null;
	status: SpanStatus;
	attributes: Record<string, string | number | boolean>;
	events: SpanEvent[];
	resource: SpanResource;
}

export interface ExportResult {
	success: boolean;
	exportedCount: number;
	failedCount: number;
	error?: string;
}

export interface ExporterConfig {
	type: "otlp" | "langfuse" | "langsmith";
	enabled: boolean;
	endpoint: string;
	authTokenEnv: string;
	headers?: Record<string, string>;
	batchSize?: number; // Default 100
	flushIntervalMs?: number;
	maxQueueSize?: number;
	timeoutMs?: number; // Default 5000
}

export interface Exporter {
	readonly name: string;
	export(spans: ExportSpan[]): Promise<ExportResult>;
	shutdown(): Promise<void>;
}
