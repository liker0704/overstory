/**
 * CLI command: ov rate-limits [--live] [--interval <ms>] [--runtime <name>] [--json]
 *
 * Shows rate-limit headroom from headroom.db.
 * Data source: headroom.db via createHeadroomStore().
 * Use --live to poll and refresh on an interval.
 */

import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createHeadroomStore } from "../headroom/store.ts";
import type { HeadroomSnapshot } from "../headroom/types.ts";
import { jsonOutput } from "../json.ts";
import { color } from "../logging/color.ts";
import { renderHeader, separator } from "../logging/theme.ts";

/** Right-pad a string to the given width. */
function padRight(str: string, width: number): string {
	return str.length >= width ? str : str + " ".repeat(width - str.length);
}

/** Left-pad a string to the given width. */
function padLeft(str: string, width: number): string {
	return str.length >= width ? str : " ".repeat(width - str.length) + str;
}

/** Returns colored percent string, or dim dash if null. */
function formatPercent(remaining: number | null, limit: number | null): string {
	if (remaining === null || limit === null || limit === 0) {
		return color.dim("—");
	}
	const pct = Math.round((remaining / limit) * 100);
	const str = `${pct}%`;
	if (pct > 50) return color.green(str);
	if (pct > 20) return color.yellow(str);
	return color.red(str);
}

/** Returns "remaining / limit" with locale formatting, or dim dash if both null. */
function formatQuota(remaining: number | null, limit: number | null): string {
	if (remaining === null && limit === null) {
		return color.dim("—");
	}
	const r = remaining !== null ? remaining.toLocaleString("en-US") : "?";
	const l = limit !== null ? limit.toLocaleString("en-US") : "?";
	return `${r} / ${l}`;
}

/** Returns human-readable time until window resets, or dim dash if null. */
function formatResetIn(windowResetsAt: string | null): string {
	if (windowResetsAt === null) return color.dim("—");
	const diffMs = new Date(windowResetsAt).getTime() - Date.now();
	if (diffMs <= 0) return "now";
	const diffSec = Math.floor(diffMs / 1000);
	const minutes = Math.floor(diffSec / 60);
	const seconds = diffSec % 60;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

/** Returns human-readable age of snapshot. */
function formatAge(capturedAt: string): string {
	const diffMs = Date.now() - new Date(capturedAt).getTime();
	const diffSec = Math.floor(diffMs / 1000);
	if (diffSec < 60) return `${diffSec}s ago`;
	const minutes = Math.floor(diffSec / 60);
	return `${minutes}m ago`;
}

/** Returns colored state badge. */
function stateBadge(state: string): string {
	if (state === "exact") return color.green("exact");
	if (state === "estimated") return color.yellow("est.");
	return color.dim("n/a");
}

/** Render the rate-limits table to stdout. */
export function printRateLimits(snapshots: HeadroomSnapshot[]): void {
	const w = process.stdout.write.bind(process.stdout);

	w(`${renderHeader("Rate Limits")}\n`);

	if (snapshots.length === 0) {
		w(`${color.dim("No headroom data available...")}\n`);
		return;
	}

	w(
		`${padRight("Runtime", 14)}${padRight("State", 8)}` +
			`${padLeft("Req %", 8)}${padLeft("Requests", 18)}` +
			`${padLeft("Tok %", 8)}${padLeft("Tokens", 18)}` +
			`${padLeft("Resets", 10)}${padLeft("Age", 8)}\n`,
	);
	w(`${color.dim(separator())}\n`);

	for (const s of snapshots) {
		const isUnavailable = s.state === "unavailable";
		const reqPct = isUnavailable
			? color.dim("—")
			: formatPercent(s.requestsRemaining, s.requestsLimit);
		const reqQuota = isUnavailable
			? color.dim("—")
			: formatQuota(s.requestsRemaining, s.requestsLimit);
		const tokPct = isUnavailable ? color.dim("—") : formatPercent(s.tokensRemaining, s.tokensLimit);
		const tokQuota = isUnavailable ? color.dim("—") : formatQuota(s.tokensRemaining, s.tokensLimit);
		const resets = isUnavailable ? color.dim("—") : formatResetIn(s.windowResetsAt);
		const age = formatAge(s.capturedAt);
		const badge = stateBadge(s.state);

		w(
			`${padRight(s.runtime, 14)}${padRight(badge, 8)}` +
				`${padLeft(reqPct, 8)}${padLeft(reqQuota, 18)}` +
				`${padLeft(tokPct, 8)}${padLeft(tokQuota, 18)}` +
				`${padLeft(resets, 10)}${padLeft(age, 8)}\n`,
		);
	}

	const withMessages = snapshots.filter((s) => s.message);
	if (withMessages.length > 0) {
		w("\n");
		for (const s of withMessages) {
			w(`${color.dim(s.runtime + ":")} ${s.message}\n`);
		}
	}
}

/** Build JSON output for the rate-limits command. */
export function buildJsonOutput(snapshots: HeadroomSnapshot[]): Record<string, unknown> {
	return {
		snapshots: snapshots.map((s) => ({
			...s,
			requestsPercentRemaining:
				s.requestsRemaining !== null && s.requestsLimit !== null && s.requestsLimit > 0
					? Math.round((s.requestsRemaining / s.requestsLimit) * 100)
					: null,
			tokensPercentRemaining:
				s.tokensRemaining !== null && s.tokensLimit !== null && s.tokensLimit > 0
					? Math.round((s.tokensRemaining / s.tokensLimit) * 100)
					: null,
		})),
	};
}

interface RateLimitsOpts {
	live?: boolean;
	interval?: string;
	runtime?: string;
	json?: boolean;
}

async function executeRateLimits(opts: RateLimitsOpts): Promise<void> {
	const json = opts.json ?? false;
	const live = opts.live ?? false;
	const runtimeFilter = opts.runtime;
	const intervalStr = opts.interval;

	let intervalMs = 2000;
	if (intervalStr !== undefined) {
		const parsed = Number.parseInt(intervalStr, 10);
		if (Number.isNaN(parsed) || parsed < 500) {
			throw new ValidationError("--interval must be >= 500 ms", {
				field: "interval",
				value: intervalStr,
			});
		}
		intervalMs = parsed;
	}

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const overstoryDir = join(config.project.root, ".overstory");
	const headroomDbPath = join(overstoryDir, "headroom.db");

	const dbFile = Bun.file(headroomDbPath);
	if (!(await dbFile.exists())) {
		if (json) {
			jsonOutput("rate-limits", { snapshots: [] });
		} else {
			process.stdout.write(color.dim("No headroom data available...") + "\n");
		}
		return;
	}

	if (live) {
		const intervalSec = Math.round(intervalMs / 1000);

		const tick = () => {
			const store = createHeadroomStore(headroomDbPath);
			try {
				let snapshots = store.getAll();
				if (runtimeFilter) {
					snapshots = snapshots.filter((s) => s.runtime === runtimeFilter);
				}
				if (json) {
					process.stdout.write("\x1b[2J\x1b[H");
					jsonOutput("rate-limits", buildJsonOutput(snapshots));
				} else {
					process.stdout.write("\x1b[2J\x1b[H");
					printRateLimits(snapshots);
					process.stdout.write(
						`\n${color.dim(`Refreshing every ${intervalSec}s — Ctrl+C to exit`)}\n`,
					);
				}
			} finally {
				store.close();
			}
		};

		tick();
		const timer = setInterval(tick, intervalMs);

		const cleanup = () => {
			clearInterval(timer);
			process.exit(0);
		};
		process.on("SIGINT", cleanup);
		process.on("SIGTERM", cleanup);
		return;
	}

	// One-shot mode
	const store = createHeadroomStore(headroomDbPath);
	try {
		let snapshots = store.getAll();
		if (runtimeFilter) {
			snapshots = snapshots.filter((s) => s.runtime === runtimeFilter);
		}
		if (json) {
			jsonOutput("rate-limits", buildJsonOutput(snapshots));
		} else {
			printRateLimits(snapshots);
		}
	} finally {
		store.close();
	}
}

export function createRateLimitsCommand(): Command {
	return new Command("rate-limits")
		.description("Show rate-limit headroom from headroom.db")
		.option("--live", "Continuously refresh on an interval")
		.option("--interval <ms>", "Refresh interval in milliseconds (default: 2000, min: 500)")
		.option("--runtime <name>", "Filter by runtime name")
		.option("--json", "Output as JSON")
		.action(async (opts: RateLimitsOpts) => {
			await executeRateLimits(opts);
		});
}

export async function rateLimitsCommand(args: string[]): Promise<void> {
	const cmd = createRateLimitsCommand();
	cmd.exitOverride();
	try {
		await cmd.parseAsync(args, { from: "user" });
	} catch (err: unknown) {
		if (err && typeof err === "object" && "code" in err) {
			const code = (err as { code: string }).code;
			if (code === "commander.helpDisplayed" || code === "commander.version") {
				return;
			}
			if (code.startsWith("commander.")) {
				const message = err instanceof Error ? err.message : String(err);
				throw new ValidationError(message, { field: "args" });
			}
		}
		throw err;
	}
}
