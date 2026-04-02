/**
 * CLI command: ov config
 *
 * Interactive config editor for .overstory/config.yaml.
 * Subcommands: list, get, set, reset.
 */

import { join } from "node:path";
import { Command } from "commander";
import { loadConfig, DEFAULT_CONFIG } from "../config.ts";
import { parseYaml, serializeConfigToYaml } from "../config-yaml.ts";
import { jsonOutput } from "../json.ts";

/**
 * Coerce a CLI string value to the appropriate JS type.
 * "true"/"false" → boolean, numeric strings → number, else string.
 */
function coerceValue(value: string): unknown {
	if (value === "true") return true;
	if (value === "false") return false;
	const num = Number(value);
	if (!Number.isNaN(num) && value.trim() !== "") return num;
	return value;
}

/**
 * Get a nested value from an object by dot-separated key path.
 * Returns undefined if any segment is missing.
 */
function getNestedValue(obj: Record<string, unknown>, keyPath: string): unknown {
	const keys = keyPath.split(".");
	let current: unknown = obj;
	for (const key of keys) {
		if (current === null || current === undefined || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

/**
 * Set a nested value in an object by dot-separated key path.
 * Creates intermediate objects if they don't exist.
 */
function setNestedValue(
	obj: Record<string, unknown>,
	keyPath: string,
	value: unknown,
): void {
	const keys = keyPath.split(".");
	let current: Record<string, unknown> = obj;
	for (let i = 0; i < keys.length - 1; i++) {
		const key = keys[i]!;
		if (current[key] === undefined || typeof current[key] !== "object") {
			current[key] = {};
		}
		current = current[key] as Record<string, unknown>;
	}
	const lastKey = keys[keys.length - 1];
	if (lastKey) {
		current[lastKey] = value;
	}
}

export function createConfigCommand(): Command {
	const cmd = new Command("config").description("View and modify overstory configuration");

	// ov config list
	cmd
		.command("list")
		.description("Show all current settings (merged config)")
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			if (opts.json) {
				jsonOutput("config_list", config as unknown as Record<string, unknown>);
			} else {
				// Serialize back to YAML for readable output
				const yaml = serializeConfigToYaml(config as unknown as Record<string, unknown>);
				process.stdout.write(yaml);
			}
		});

	// ov config get <key>
	cmd
		.command("get <key>")
		.description("Get a specific config value (e.g., taskTracker.backend)")
		.option("--json", "Output as JSON")
		.action(async (key: string, opts: { json?: boolean }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const value = getNestedValue(config as unknown as Record<string, unknown>, key);

			if (value === undefined) {
				process.stderr.write(`Key not found: ${key}\n`);
				process.exitCode = 1;
				return;
			}

			if (opts.json) {
				jsonOutput("config_get", { key, value });
			} else if (typeof value === "object" && value !== null) {
				const yaml = serializeConfigToYaml({ [key.split(".").pop()!]: value } as Record<
					string,
					unknown
				>);
				process.stdout.write(yaml);
			} else {
				process.stdout.write(`${String(value)}\n`);
			}
		});

	// ov config set <key> <value>
	cmd
		.command("set <key> <value>")
		.description("Set a config value (e.g., taskTracker.backend github)")
		.option("--local", "Write to config.local.yaml instead of config.yaml")
		.option("--json", "Output as JSON")
		.action(async (key: string, value: string, opts: { local?: boolean; json?: boolean }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			const configFile = opts.local
				? join(overstoryDir, "config.local.yaml")
				: join(overstoryDir, "config.yaml");

			// Read existing file (or empty)
			let parsed: Record<string, unknown> = {};
			const file = Bun.file(configFile);
			if (await file.exists()) {
				const text = await file.text();
				parsed = parseYaml(text);
			}

			const coerced = coerceValue(value);
			setNestedValue(parsed, key, coerced);

			const yaml = serializeConfigToYaml(parsed);
			await Bun.write(configFile, yaml);

			if (opts.json) {
				jsonOutput("config_set", { key, value: coerced, file: configFile });
			} else {
				const target = opts.local ? "config.local.yaml" : "config.yaml";
				process.stdout.write(`Set ${key} = ${String(coerced)} (in ${target})\n`);
			}
		});

	// ov config reset
	cmd
		.command("reset")
		.description("Reset config.yaml to defaults")
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			const configFile = join(overstoryDir, "config.yaml");

			// Preserve project-specific fields
			const defaults = {
				...DEFAULT_CONFIG,
				project: {
					...DEFAULT_CONFIG.project,
					name: config.project.name,
					root: config.project.root,
					canonicalBranch: config.project.canonicalBranch,
				},
			};

			const yaml = serializeConfigToYaml(defaults as unknown as Record<string, unknown>);
			await Bun.write(configFile, yaml);

			if (opts.json) {
				jsonOutput("config_reset", { file: configFile });
			} else {
				process.stdout.write(`Config reset to defaults (preserved project name/root/branch)\n`);
			}
		});

	return cmd;
}
