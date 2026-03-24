import { createLangfuseExporter } from "./exporters/langfuse.ts";
import { createLangSmithExporter } from "./exporters/langsmith.ts";
import { createOtlpExporter } from "./exporters/otlp.ts";
import type { Exporter, ExporterConfig } from "./types.ts";

/** Create registry pre-populated with all built-in exporter factories. */
export function createExporterRegistry(): Map<string, (config: ExporterConfig) => Exporter> {
	const registry = new Map<string, (config: ExporterConfig) => Exporter>();
	registry.set("otlp", createOtlpExporter);
	registry.set("langfuse", createLangfuseExporter);
	registry.set("langsmith", createLangSmithExporter);
	return registry;
}

/** Build exporter instances from config array. Filters enabled, looks up factory, instantiates. */
export function buildExporters(
	configs: ExporterConfig[],
	registry?: Map<string, (config: ExporterConfig) => Exporter>,
): Exporter[] {
	const reg = registry ?? createExporterRegistry();
	const exporters: Exporter[] = [];
	for (const config of configs) {
		if (!config.enabled) continue;
		const factory = reg.get(config.type);
		if (!factory) {
			console.warn(`[registry] unknown exporter type: "${config.type}"`);
			continue;
		}
		exporters.push(factory(config));
	}
	return exporters;
}
