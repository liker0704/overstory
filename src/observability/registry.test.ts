import { describe, expect, it, spyOn } from "bun:test";
import { buildExporters, createExporterRegistry } from "./registry.ts";
import type { Exporter, ExporterConfig, ExportResult, ExportSpan } from "./types.ts";

function makeConfig(type: ExporterConfig["type"], enabled: boolean): ExporterConfig {
	return { type, enabled, endpoint: "http://localhost", authTokenEnv: "TEST_TOKEN" };
}

function makeMockExporter(name: string): Exporter {
	return {
		name,
		async export(_spans: ExportSpan[]): Promise<ExportResult> {
			return { success: true, exportedCount: 0, failedCount: 0 };
		},
		async shutdown(): Promise<void> {},
	};
}

function makeMockRegistry(): Map<string, (config: ExporterConfig) => Exporter> {
	const registry = new Map<string, (config: ExporterConfig) => Exporter>();
	registry.set("otlp", () => makeMockExporter("otlp"));
	registry.set("langfuse", () => makeMockExporter("langfuse"));
	registry.set("langsmith", () => makeMockExporter("langsmith"));
	return registry;
}

describe("createExporterRegistry", () => {
	it("returns a Map with 3 entries (otlp, langfuse, langsmith)", () => {
		const registry = createExporterRegistry();
		expect(registry.size).toBe(3);
		expect(registry.has("otlp")).toBe(true);
		expect(registry.has("langfuse")).toBe(true);
		expect(registry.has("langsmith")).toBe(true);
	});
});

describe("buildExporters", () => {
	it("returns empty array for empty input", () => {
		const result = buildExporters([], makeMockRegistry());
		expect(result).toEqual([]);
	});

	it("filters out disabled configs", () => {
		const configs: ExporterConfig[] = [makeConfig("otlp", false), makeConfig("langfuse", false)];
		const result = buildExporters(configs, makeMockRegistry());
		expect(result).toHaveLength(0);
	});

	it("creates exporter for single enabled config", () => {
		const configs: ExporterConfig[] = [makeConfig("otlp", true)];
		const result = buildExporters(configs, makeMockRegistry());
		expect(result).toHaveLength(1);
		expect(result[0]?.name).toBe("otlp");
	});

	it("creates multiple exporters for multiple enabled configs", () => {
		const configs: ExporterConfig[] = [
			makeConfig("otlp", true),
			makeConfig("langfuse", true),
			makeConfig("langsmith", true),
		];
		const result = buildExporters(configs, makeMockRegistry());
		expect(result).toHaveLength(3);
	});

	it("skips unknown types with console.warn", () => {
		const warnSpy = spyOn(console, "warn");
		const configs: ExporterConfig[] = [
			{ ...makeConfig("otlp", true), type: "unknown" as ExporterConfig["type"] },
		];
		const result = buildExporters(configs, makeMockRegistry());
		expect(result).toHaveLength(0);
		expect(warnSpy).toHaveBeenCalledWith('[registry] unknown exporter type: "unknown"');
		warnSpy.mockRestore();
	});

	it("skips disabled but processes enabled in mixed list", () => {
		const configs: ExporterConfig[] = [
			makeConfig("otlp", false),
			makeConfig("langfuse", true),
			makeConfig("langsmith", false),
		];
		const result = buildExporters(configs, makeMockRegistry());
		expect(result).toHaveLength(1);
		expect(result[0]?.name).toBe("langfuse");
	});
});
