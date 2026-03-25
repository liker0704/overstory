import { homedir } from "node:os";
import { join } from "node:path";
import { parseYaml } from "../config-yaml.ts";
import { OverstoryError } from "../errors.ts";
import { isProcessRunning } from "../process/util.ts";
import { createServer } from "./server.ts";
import type { WebConfig } from "./types.ts";

const PID_FILE_PATH = join(homedir(), ".overstory", "webserver.pid");
const CONFIG_PATH = join(homedir(), ".overstory", "webserver.yaml");

async function readPidFile(pidFilePath: string): Promise<number | null> {
	const file = Bun.file(pidFilePath);
	const exists = await file.exists();
	if (!exists) {
		return null;
	}

	try {
		const text = await file.text();
		const pid = Number.parseInt(text.trim(), 10);
		if (Number.isNaN(pid) || pid <= 0) {
			return null;
		}
		return pid;
	} catch {
		return null;
	}
}

async function writePidFile(pidFilePath: string, pid: number): Promise<void> {
	await Bun.write(pidFilePath, `${pid}\n`);
}

async function removePidFile(pidFilePath: string): Promise<void> {
	const { unlink } = await import("node:fs/promises");
	try {
		await unlink(pidFilePath);
	} catch {
		// File may already be gone — not an error
	}
}

async function resolveOverstoryBin(): Promise<string> {
	try {
		const proc = Bun.spawn(["which", "ov"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode === 0) {
			const binPath = (await new Response(proc.stdout).text()).trim();
			if (binPath.length > 0) {
				return binPath;
			}
		}
	} catch {
		// which not available or ov not on PATH
	}

	const scriptPath = process.argv[1];
	if (scriptPath) {
		return scriptPath;
	}

	throw new OverstoryError("Cannot resolve overstory binary path", "WEBSERVER_ERROR");
}

export async function loadWebConfig(): Promise<WebConfig> {
	const defaults: WebConfig = {
		port: 3000,
		host: "127.0.0.1",
		pollIntervalMs: 30000,
		connectionTtlMs: 300000,
		discoveryPaths: [],
	};

	const file = Bun.file(CONFIG_PATH);
	if (!(await file.exists())) {
		return defaults;
	}

	try {
		const text = await file.text();
		const parsed = parseYaml(text);
		const config = { ...defaults };
		if (typeof parsed.port === "number") config.port = parsed.port;
		if (typeof parsed.host === "string") config.host = parsed.host;
		if (typeof parsed.pollIntervalMs === "number") config.pollIntervalMs = parsed.pollIntervalMs;
		if (typeof parsed.connectionTtlMs === "number") config.connectionTtlMs = parsed.connectionTtlMs;
		if (Array.isArray(parsed.discoveryPaths)) {
			config.discoveryPaths = (parsed.discoveryPaths as unknown[]).filter(
				(p): p is string => typeof p === "string",
			);
		}
		return config;
	} catch {
		return defaults;
	}
}

export async function startBackground(config: WebConfig): Promise<{ pid: number }> {
	const existingPid = await readPidFile(PID_FILE_PATH);
	if (existingPid !== null && isProcessRunning(existingPid)) {
		throw new OverstoryError(
			`Webserver already running (PID: ${existingPid})`,
			"WEBSERVER_ALREADY_RUNNING",
		);
	}

	if (existingPid !== null) {
		await removePidFile(PID_FILE_PATH);
	}

	const overstoryBin = await resolveOverstoryBin();

	const child = Bun.spawn(
		["bun", "run", overstoryBin, "webserver", "start", "--port", String(config.port)],
		{
			detached: true,
			stdout: "pipe",
			stderr: "pipe",
		},
	);

	child.unref();

	const pollDeadline = Date.now() + 2000;
	while (Date.now() < pollDeadline) {
		await new Promise<void>((r) => setTimeout(r, 100));
		if (!isProcessRunning(child.pid)) {
			const errText = await new Response(child.stderr).text();
			const reason = errText.trim() || "process exited immediately";
			throw new OverstoryError(`Webserver failed to start: ${reason}`, "WEBSERVER_ERROR");
		}
	}

	await writePidFile(PID_FILE_PATH, child.pid);

	return { pid: child.pid };
}

export async function startForeground(config: WebConfig, registryPath: string): Promise<void> {
	const server = createServer(config, registryPath);
	await writePidFile(PID_FILE_PATH, process.pid);

	await new Promise<void>((resolve) => {
		const shutdown = () => {
			server.stop();
			removePidFile(PID_FILE_PATH).catch(() => {});
			resolve();
		};
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
	});
}

export async function stopDaemon(): Promise<boolean> {
	const pid = await readPidFile(PID_FILE_PATH);
	if (pid === null) return false;

	if (!isProcessRunning(pid)) {
		await removePidFile(PID_FILE_PATH);
		return false;
	}

	process.kill(pid, "SIGTERM");
	await removePidFile(PID_FILE_PATH);
	return true;
}

export async function getDaemonStatus(): Promise<{
	running: boolean;
	pid?: number;
	port?: number;
}> {
	const pid = await readPidFile(PID_FILE_PATH);
	if (pid === null) return { running: false };

	if (!isProcessRunning(pid)) return { running: false };

	const config = await loadWebConfig();
	return { running: true, pid, port: config.port };
}
