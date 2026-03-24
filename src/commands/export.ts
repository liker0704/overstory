import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { printError, printHint, printSuccess } from "../logging/color.ts";
import { buildExporters } from "../observability/registry.ts";
import type { ExportSpan } from "../types.ts";

export function createExportCommand(): Command {
	const cmd = new Command("export").description("Observability export pipeline management");

	cmd
		.command("status")
		.description("Show pipeline stats, enabled exporters, queue size")
		.action(async () => {
			try {
				const config = await loadConfig(process.cwd());
				const obs = config.observability;
				if (!obs?.enabled) {
					console.log("Observability: disabled");
					printHint("Set observability.enabled: true in config.yaml to enable.");
					return;
				}
				console.log("Observability: enabled");
				const exporters = obs.exporters ?? [];
				if (exporters.length === 0) {
					console.log("Exporters: none configured");
				} else {
					console.log(`Exporters (${exporters.length}):`);
					for (const exp of exporters) {
						const status = exp.enabled ? "enabled" : "disabled";
						const endpoint = exp.endpoint ?? "(default)";
						console.log(`  ${exp.type}  [${status}]  endpoint: ${endpoint}`);
					}
				}
			} catch (err) {
				printError("Failed to load config", err instanceof Error ? err.message : String(err));
				process.exit(1);
			}
		});

	cmd
		.command("flush")
		.description("Force flush the export pipeline")
		.action(() => {
			printHint("Pipeline flush is managed by the watchdog daemon.");
		});

	cmd
		.command("test")
		.description("Send a test span to verify exporter connectivity")
		.action(async () => {
			try {
				const config = await loadConfig(process.cwd());
				const obs = config.observability;
				if (!obs?.enabled) {
					printError(
						"Observability is disabled",
						"Set observability.enabled: true in config.yaml.",
					);
					process.exit(1);
					return;
				}
				const exporterConfigs = obs.exporters ?? [];
				const exporters = buildExporters(exporterConfigs);
				if (exporters.length === 0) {
					printError("No exporters configured or enabled", "Add exporters to config.yaml.");
					process.exit(1);
					return;
				}

				const now = new Date().toISOString();
				const testSpan: ExportSpan = {
					spanId: crypto.randomUUID().replace(/-/g, "").slice(0, 16),
					parentSpanId: null,
					traceId: crypto.randomUUID().replace(/-/g, ""),
					name: "ov.export.test",
					kind: "custom",
					startTime: now,
					endTime: now,
					durationMs: 0,
					status: "ok",
					attributes: { "test.source": "ov export test" },
					events: [],
					resource: {
						agentName: "cli",
						runId: null,
						sessionId: null,
						taskId: null,
						missionId: null,
						capability: null,
					},
				};

				let allOk = true;
				for (const exporter of exporters) {
					try {
						const result = await exporter.export([testSpan]);
						if (result.success) {
							printSuccess(`${exporter.name}: ok`);
						} else {
							printError(`${exporter.name}: failed`, result.error);
							allOk = false;
						}
					} catch (err) {
						printError(`${exporter.name}: error`, err instanceof Error ? err.message : String(err));
						allOk = false;
					} finally {
						await exporter.shutdown().catch(() => {});
					}
				}

				if (!allOk) {
					process.exit(1);
				}
			} catch (err) {
				printError("Failed to run export test", err instanceof Error ? err.message : String(err));
				process.exit(1);
			}
		});

	return cmd;
}
