import type {
	ExporterConfig,
	ExportResult,
	ExportSpan,
	SpanEvent,
	SpanKind,
	SpanResource,
} from "../types.ts";

const PACKAGE_VERSION = "0.9.1";

let authWarningShown = false;

// Internal OTLP types — not exported
interface OtlpAttributeValue {
	stringValue?: string;
	intValue?: string;
	boolValue?: boolean;
}

interface OtlpAttribute {
	key: string;
	value: OtlpAttributeValue;
}

interface OtlpEvent {
	name: string;
	timeUnixNano: string;
	attributes: OtlpAttribute[];
}

interface OtlpStatus {
	code: number;
}

interface OtlpSpan {
	traceId: string;
	spanId: string;
	parentSpanId: string;
	name: string;
	kind: number;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	status: OtlpStatus;
	attributes: OtlpAttribute[];
	events: OtlpEvent[];
}

interface OtlpScopeSpans {
	scope: { name: string; version: string };
	spans: OtlpSpan[];
}

interface OtlpResource {
	attributes: OtlpAttribute[];
}

interface OtlpResourceSpans {
	resource: OtlpResource;
	scopeSpans: OtlpScopeSpans[];
}

interface OtlpPayload {
	resourceSpans: OtlpResourceSpans[];
}

export function isoToNanos(iso: string | null): string {
	if (iso === null) return "0";
	try {
		const ms = Date.parse(iso);
		if (Number.isNaN(ms)) return "0";
		return (BigInt(ms) * 1_000_000n).toString();
	} catch {
		return "0";
	}
}

export function traceIdFromRunId(runId: string | null): string {
	if (!runId) {
		// Return a deterministic 32-char hex string of zeros for null runId
		return "0".repeat(32);
	}
	// Deterministic hash from runId string using simple polynomial hash
	let h1 = 0x9e3779b9;
	let h2 = 0x6c62272e;
	for (let i = 0; i < runId.length; i++) {
		const c = runId.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x85ebca77);
		h1 ^= h1 >>> 13;
		h2 = Math.imul(h2 ^ c, 0xc2b2ae3d);
		h2 ^= h2 >>> 15;
	}
	h1 ^= h2;
	h2 ^= h1;
	h1 = Math.imul(h1 ^ (h1 >>> 16), 0x45d9f3b);
	h1 = Math.imul(h1 ^ (h1 >>> 16), 0x45d9f3b);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 0x45d9f3b);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 0x45d9f3b);

	const toHex8 = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
	// Produce 32-char hex from 4 blocks of 8
	return toHex8(h1) + toHex8(h2) + toHex8(h1 ^ h2) + toHex8(Math.imul(h1, h2) >>> 0);
}

export function mapAttribute(key: string, value: string | number | boolean): OtlpAttribute {
	if (typeof value === "boolean") {
		return { key, value: { boolValue: value } };
	}
	if (typeof value === "number") {
		if (Number.isInteger(value)) {
			return { key, value: { intValue: value.toString() } };
		}
		return { key, value: { stringValue: value.toString() } };
	}
	return { key, value: { stringValue: value } };
}

function spanKindToOtlp(kind: SpanKind): number {
	// 1=INTERNAL, 3=CLIENT
	if (kind === "mail" || kind === "spawn") return 3;
	return 1;
}

function statusToCode(status: string): number {
	if (status === "ok") return 1;
	if (status === "error") return 2;
	return 0; // unset
}

function mapEvent(event: SpanEvent): OtlpEvent {
	return {
		name: event.name,
		timeUnixNano: isoToNanos(event.timestamp),
		attributes: Object.entries(event.attributes).map(([k, v]) => mapAttribute(k, v)),
	};
}

export function mapSpan(span: ExportSpan): OtlpSpan {
	return {
		traceId: traceIdFromRunId(span.resource.runId),
		spanId: span.spanId,
		parentSpanId: span.parentSpanId ?? "",
		name: span.name,
		kind: spanKindToOtlp(span.kind),
		startTimeUnixNano: isoToNanos(span.startTime),
		endTimeUnixNano: isoToNanos(span.endTime),
		status: { code: statusToCode(span.status) },
		attributes: Object.entries(span.attributes).map(([k, v]) => mapAttribute(k, v)),
		events: span.events.map(mapEvent),
	};
}

export function buildResourceAttributes(resource: SpanResource): OtlpAttribute[] {
	const attrs: OtlpAttribute[] = [
		{ key: "service.name", value: { stringValue: resource.agentName } },
	];
	if (resource.runId !== null) {
		attrs.push({ key: "service.instance.id", value: { stringValue: resource.runId } });
	}
	if (resource.sessionId !== null) {
		attrs.push({ key: "overstory.session.id", value: { stringValue: resource.sessionId } });
	}
	if (resource.taskId !== null) {
		attrs.push({ key: "overstory.task.id", value: { stringValue: resource.taskId } });
	}
	if (resource.missionId !== null) {
		attrs.push({ key: "overstory.mission.id", value: { stringValue: resource.missionId } });
	}
	return attrs;
}

type ResourceKey = string;

export function groupByResource(spans: ExportSpan[]): Map<ResourceKey, ExportSpan[]> {
	const groups = new Map<ResourceKey, ExportSpan[]>();
	for (const span of spans) {
		const key = `${span.resource.agentName}::${span.resource.runId ?? ""}`;
		const group = groups.get(key);
		if (group) {
			group.push(span);
		} else {
			groups.set(key, [span]);
		}
	}
	return groups;
}

export function buildPayload(spans: ExportSpan[]): OtlpPayload {
	const groups = groupByResource(spans);
	const resourceSpans: OtlpResourceSpans[] = [];

	for (const [, groupSpans] of groups) {
		const first = groupSpans[0];
		if (!first) continue;
		resourceSpans.push({
			resource: {
				attributes: buildResourceAttributes(first.resource),
			},
			scopeSpans: [
				{
					scope: { name: "overstory", version: PACKAGE_VERSION },
					spans: groupSpans.map(mapSpan),
				},
			],
		});
	}

	return { resourceSpans };
}

export function createOtlpExporter(config: ExporterConfig) {
	const endpoint = config.endpoint.replace(/\/+$/, "");
	const timeoutMs = config.timeoutMs ?? 5000;

	return {
		name: "otlp" as const,

		async export(spans: ExportSpan[]): Promise<ExportResult> {
			if (spans.length === 0) {
				return { success: true, exportedCount: 0, failedCount: 0 };
			}

			const token = process.env[config.authTokenEnv];
			if (!token) {
				if (!authWarningShown) {
					authWarningShown = true;
					console.warn(
						`[otlp] Auth token env var "${config.authTokenEnv}" is not set — spans will not be exported`,
					);
				}
				return {
					success: false,
					exportedCount: 0,
					failedCount: spans.length,
					error: `Auth token env var "${config.authTokenEnv}" is not set`,
				};
			}

			const payload = buildPayload(spans);
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				...config.headers,
			};

			const controller = new AbortController();
			const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

			try {
				const response = await fetch(`${endpoint}/v1/traces`, {
					method: "POST",
					headers,
					body: JSON.stringify(payload),
					signal: controller.signal,
				});

				clearTimeout(timeoutHandle);

				if (response.ok) {
					return { success: true, exportedCount: spans.length, failedCount: 0 };
				}

				if (response.status >= 400 && response.status < 500) {
					return {
						success: false,
						exportedCount: 0,
						failedCount: spans.length,
						error: `HTTP ${response.status}: bad request, dropping spans`,
					};
				}

				return {
					success: false,
					exportedCount: 0,
					failedCount: spans.length,
					error: `HTTP ${response.status}: server error`,
				};
			} catch (err: unknown) {
				clearTimeout(timeoutHandle);
				const message =
					err instanceof Error
						? err.name === "AbortError"
							? `Request timed out after ${timeoutMs}ms`
							: err.message
						: String(err);
				return {
					success: false,
					exportedCount: 0,
					failedCount: spans.length,
					error: message,
				};
			}
		},

		async shutdown(): Promise<void> {
			// No persistent resources to clean up
		},
	};
}
