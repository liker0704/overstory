/**
 * CLI command: ov dashboard [--interval <ms>] [--all]
 *
 * Rich terminal dashboard using raw ANSI escape codes (zero runtime deps).
 * Polls existing data sources and renders multi-panel layout with agent status,
 * mail activity, merge queue, metrics, tasks, and recent event feed.
 *
 * Layout:
 *   Row 1-2:   Header
 *   Row 3-N:   Agents (60% width, dynamic height) | Tasks (upper-right 40%) + Feed (lower-right 40%)
 *   Row N+1:   Mail (50%) | Merge Queue (50%)
 *   Row M:     Metrics
 *
 * By default, all panels are scoped to the current run (current-run.txt).
 * Use --all to show data across all runs.
 */

import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import {
	closeDashboardStores,
	type DashboardStores,
	EventBuffer,
	filterAgentsByRun,
	loadDashboardData,
	openDashboardStores,
	readCurrentRunId,
} from "../dashboard/data.ts";
import {
	CURSOR,
	computeAgentPanelHeight,
	dimBox,
	horizontalLine,
	pad,
	renderAgentPanel,
	renderDashboard,
	renderFeedPanel,
	renderMissionStrip,
	renderTasksPanel,
	truncate,
} from "../dashboard/render.ts";
import { ValidationError } from "../errors.ts";

export type { DashboardStores };
export {
	closeDashboardStores,
	computeAgentPanelHeight,
	dimBox,
	EventBuffer,
	filterAgentsByRun,
	horizontalLine,
	openDashboardStores,
	pad,
	renderAgentPanel,
	renderFeedPanel,
	renderMissionStrip,
	renderTasksPanel,
	truncate,
};

interface DashboardOpts {
	interval?: string;
	all?: boolean;
}

async function executeDashboard(opts: DashboardOpts): Promise<void> {
	const intervalStr = opts.interval;
	const interval = intervalStr ? Number.parseInt(intervalStr, 10) : 2000;
	const showAll = opts.all ?? false;

	if (Number.isNaN(interval) || interval < 500) {
		throw new ValidationError("--interval must be a number >= 500 (milliseconds)", {
			field: "interval",
			value: intervalStr,
		});
	}

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const root = config.project.root;

	// Read current run ID unless --all flag is set
	let runId: string | null | undefined;
	if (!showAll) {
		const overstoryDir = join(root, ".overstory");
		runId = await readCurrentRunId(overstoryDir);
	}

	// Open stores once for the entire poll loop lifetime
	const stores = openDashboardStores(root);

	// Create rolling event buffer (persisted across poll ticks)
	const eventBuffer = new EventBuffer(100);

	// Compute health thresholds once from config (reused across poll ticks)
	const thresholds = {
		staleMs: config.watchdog.staleThresholdMs,
		zombieMs: config.watchdog.zombieThresholdMs,
	};

	// Hide cursor
	process.stdout.write(CURSOR.hideCursor);

	// Clean exit on Ctrl+C
	let running = true;
	process.on("SIGINT", () => {
		running = false;
		closeDashboardStores(stores);
		process.stdout.write(CURSOR.showCursor);
		process.stdout.write(CURSOR.clear);
		process.exitCode = 0;
	});

	// Poll loop -- errors are caught per-tick so transient DB failures never crash the dashboard.
	let lastGoodData: Awaited<ReturnType<typeof loadDashboardData>> | null = null;
	let lastErrorMsg: string | null = null;
	while (running) {
		try {
			const data = await loadDashboardData(
				root,
				stores,
				runId,
				thresholds,
				eventBuffer,
				config.runtime,
			);
			lastGoodData = data;
			lastErrorMsg = null;
			renderDashboard(data, interval);
		} catch (err) {
			// Render last good frame so the TUI stays alive, then show the error inline.
			if (lastGoodData) {
				renderDashboard(lastGoodData, interval);
			}
			lastErrorMsg = err instanceof Error ? err.message : String(err);
			const w = process.stdout.columns ?? 100;
			const h = process.stdout.rows ?? 30;
			const errLine = `${CURSOR.cursorTo(h, 1)}\x1b[31m⚠ DB error (retrying):\x1b[0m ${truncate(lastErrorMsg, w - 30)}`;
			process.stdout.write(errLine);
		}
		await Bun.sleep(interval);
	}
}

export function createDashboardCommand(): Command {
	return new Command("dashboard")
		.description("Live TUI dashboard for agent monitoring (Ctrl+C to stop)")
		.option("--interval <ms>", "Poll interval in milliseconds (default: 2000, min: 500)")
		.option("--all", "Show data from all runs (default: current run only)")
		.action(async (opts: DashboardOpts) => {
			await executeDashboard(opts);
		});
}

export async function dashboardCommand(args: string[]): Promise<void> {
	const cmd = createDashboardCommand();
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
