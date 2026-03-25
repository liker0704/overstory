import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { printHint, printSuccess } from "../logging/color.ts";
import {
	getDaemonStatus,
	loadWebConfig,
	startBackground,
	startForeground,
	stopDaemon,
} from "../webserver/daemon.ts";
import { loadRegistry, refreshRegistry, registerProject } from "../webserver/registry.ts";

const REGISTRY_PATH = join(homedir(), ".overstory", "projects.json");

async function startWebserver(opts: { port?: number; background?: boolean }): Promise<void> {
	const config = await loadWebConfig();
	if (opts.port !== undefined) {
		config.port = opts.port;
	}

	if (opts.background) {
		const { pid } = await startBackground(config);
		printSuccess(`Webserver started (PID: ${pid})`);
	} else {
		printHint(`Starting webserver at ${config.host}:${config.port}`);
		await startForeground(config, REGISTRY_PATH);
	}
}

async function stopWebserver(opts: { json?: boolean }): Promise<void> {
	const stopped = await stopDaemon();
	if (opts.json) {
		jsonOutput("webserver stop", { stopped });
	} else if (stopped) {
		printSuccess("Webserver stopped");
	} else {
		printHint("Webserver is not running");
	}
}

async function statusWebserver(opts: { json?: boolean }): Promise<void> {
	const status = await getDaemonStatus();
	const registry = await loadRegistry(REGISTRY_PATH);
	const projectCount = registry.projects.length;

	if (opts.json) {
		jsonOutput("webserver status", { ...status, projectCount });
	} else if (status.running) {
		process.stdout.write(`Webserver: running\n`);
		process.stdout.write(`  PID:      ${status.pid}\n`);
		process.stdout.write(`  Port:     ${status.port}\n`);
		process.stdout.write(`  Projects: ${projectCount}\n`);
	} else {
		process.stdout.write(`Webserver: stopped\n`);
		process.stdout.write(`  Projects: ${projectCount}\n`);
	}
}

async function registerWebserverProject(path: string): Promise<void> {
	const absPath = resolve(path);
	const entry = await registerProject(REGISTRY_PATH, absPath);
	printSuccess(`Registered project: ${entry.slug}`, entry.path);
}

async function discoverWebserverProjects(opts: { scanPath?: string[] }): Promise<void> {
	let scanPaths = opts.scanPath;

	if (!scanPaths || scanPaths.length === 0) {
		const registry = await loadRegistry(REGISTRY_PATH);
		scanPaths = registry.discoveryPaths;
	}

	if (!scanPaths || scanPaths.length === 0) {
		printHint("No scan paths configured. Use --scan-path <dir> or register paths via config.");
		return;
	}

	const registry = await refreshRegistry(REGISTRY_PATH, scanPaths);
	printSuccess(`Discovered ${registry.projects.length} projects`);
}

export function createWebserverCommand(): Command {
	const cmd = new Command("webserver").description("Manage the overstory HTTP webserver");

	cmd
		.command("start")
		.description("Start the HTTP webserver")
		.option("--port <port>", "Port to listen on", Number.parseInt)
		.option("--background", "Run as a background daemon")
		.action(async (opts: { port?: number; background?: boolean }) => {
			await startWebserver(opts);
		});

	cmd
		.command("stop")
		.description("Stop the background webserver daemon")
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			await stopWebserver(opts);
		});

	cmd
		.command("status")
		.description("Show webserver status")
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			await statusWebserver(opts);
		});

	cmd
		.command("register")
		.description("Register a project with the webserver")
		.argument("<path>", "Path to the overstory project")
		.action(async (path: string) => {
			await registerWebserverProject(path);
		});

	cmd
		.command("discover")
		.description("Scan directories and refresh the project registry")
		.option("--scan-path <dir...>", "Directories to scan for overstory projects")
		.action(async (opts: { scanPath?: string[] }) => {
			await discoverWebserverProjects(opts);
		});

	return cmd;
}

/**
 * Entry point for `ov webserver <subcommand>`.
 */
export async function webserverCommand(args: string[]): Promise<void> {
	const cmd = createWebserverCommand();
	cmd.exitOverride();

	if (args.length === 0) {
		process.stdout.write(cmd.helpInformation());
		return;
	}

	try {
		await cmd.parseAsync(args, { from: "user" });
	} catch (err: unknown) {
		if (err && typeof err === "object" && "code" in err) {
			const code = (err as { code: string }).code;
			if (code === "commander.helpDisplayed" || code === "commander.version") {
				return;
			}
			if (code === "commander.unknownCommand") {
				const message = err instanceof Error ? err.message : String(err);
				throw new ValidationError(message, { field: "subcommand" });
			}
		}
		throw err;
	}
}
