/**
 * Dashboard panel renderers and layout helpers.
 *
 * Extracted from src/commands/dashboard.ts to keep the command file
 * focused on CLI wiring and the poll loop.
 */

import { resolve } from "node:path";
import type { HeadroomSnapshot } from "../headroom/types.ts";
import { accent, brand, color, visibleLength } from "../logging/color.ts";
import {
	buildAgentColorMap,
	formatDuration,
	formatEventLine,
	formatRelativeTime,
	mergeStatusColor,
	numericPriorityColor,
	priorityColor,
} from "../logging/format.ts";
import { stateColor, stateIcon } from "../logging/theme.ts";
import type { MissionRoleStates } from "../missions/runtime-context.ts";
import type { Mission, OverstoryConfig } from "../types.ts";
import { isProcessAlive } from "../worktree/tmux.ts";
import type { DashboardData } from "./data.ts";

const pkgPath = resolve(import.meta.dir, "../../package.json");
const PKG_VERSION: string = JSON.parse(await Bun.file(pkgPath).text()).version ?? "unknown";

/**
 * Terminal control codes (cursor movement, screen clearing).
 * These are not colors, so they stay separate from the color module.
 */
export const CURSOR = {
	clear: "\x1b[2J\x1b[H", // Clear screen and home cursor
	cursorTo: (row: number, col: number) => `\x1b[${row};${col}H`,
	hideCursor: "\x1b[?25l",
	showCursor: "\x1b[?25h",
} as const;

/**
 * Box drawing characters for panel borders (plain -- not used for rendering,
 * kept for backward compat with tests and horizontalLine helper).
 */
const BOX = {
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	horizontal: "─",
	vertical: "│",
	tee: "├",
	teeRight: "┤",
	cross: "┼",
};

/**
 * Dimmed version of BOX characters -- for subdued borders that do not
 * compete visually with panel content.
 */
export const dimBox = {
	topLeft: color.dim("┌"),
	topRight: color.dim("┐"),
	bottomLeft: color.dim("└"),
	bottomRight: color.dim("┘"),
	horizontal: color.dim("─"),
	vertical: color.dim("│"),
	tee: color.dim("├"),
	teeRight: color.dim("┤"),
	cross: color.dim("┼"),
} as const;

/**
 * Truncate a string to fit within maxLen characters, adding ellipsis if needed.
 */
export function truncate(str: string, maxLen: number): string {
	if (maxLen <= 0) return "";
	if (str.length <= maxLen) return str;
	return `${str.slice(0, maxLen - 1)}…`;
}

/**
 * Pad or truncate a string to exactly the given width.
 */
export function pad(str: string, width: number): string {
	if (width <= 0) return "";
	if (str.length >= width) return str.slice(0, width);
	return str + " ".repeat(width - str.length);
}

/**
 * Draw a horizontal line with left/right connectors using plain BOX chars.
 * Exported for backward compat in tests.
 */
export function horizontalLine(
	width: number,
	left: string,
	_middle: string,
	right: string,
): string {
	return left + BOX.horizontal.repeat(Math.max(0, width - 2)) + right;
}

/**
 * Draw a horizontal line using dimmed border characters.
 * ANSI-aware: uses visibleLength() for padding calculations.
 */
function dimHorizontalLine(width: number, left: string, right: string): string {
	const fillCount = Math.max(0, width - visibleLength(left) - visibleLength(right));
	return left + dimBox.horizontal.repeat(fillCount) + right;
}

/**
 * Compute agent panel height from screen height and agent count.
 * min 8 rows, max floor(height * 0.35), grows with agent count (+4 for chrome).
 */
export function computeAgentPanelHeight(height: number, agentCount: number): number {
	return Math.max(8, Math.min(Math.floor(height * 0.35), agentCount + 4));
}

/**
 * Resolve the runtime name for a given capability from config.
 * Mirrors the lookup chain in runtimes/registry.ts getRuntime():
 *   capabilities[cap] > runtime.default > "claude"
 */
function resolveRuntimeName(
	capability: string,
	runtimeConfig?: OverstoryConfig["runtime"],
): string {
	return runtimeConfig?.capabilities?.[capability] ?? runtimeConfig?.default ?? "claude";
}

/**
 * Render the header bar (line 1).
 */
function renderHeader(width: number, interval: number, currentRunId?: string | null): string {
	const left = brand.bold(`ov dashboard v${PKG_VERSION}`);
	const now = new Date().toLocaleTimeString();
	const scope = currentRunId ? ` [run: ${accent(currentRunId.slice(0, 8))}]` : " [all runs]";
	const right = `${now}${scope} | refresh: ${interval}ms`;
	const padding = width - visibleLength(left) - right.length;
	const line = left + " ".repeat(Math.max(0, padding)) + right;
	const separator = horizontalLine(width, BOX.topLeft, BOX.horizontal, BOX.topRight);
	return `${line}\n${separator}`;
}

/**
 * Render the agent panel (left 60%, dynamic height).
 */
export function renderAgentPanel(
	data: DashboardData,
	fullWidth: number,
	panelHeight: number,
	startRow: number,
): string {
	const leftWidth = fullWidth;
	let output = "";

	// Panel header
	const headerLine = `${dimBox.vertical} ${brand.bold("Agents")} (${data.status.agents.length})`;
	const headerPadding = " ".repeat(
		Math.max(0, leftWidth - visibleLength(headerLine) - visibleLength(dimBox.vertical)),
	);
	output += `${CURSOR.cursorTo(startRow, 1)}${headerLine}${headerPadding}${dimBox.vertical}\n`;

	// Column headers
	const colStr = `${dimBox.vertical} St Name            Capability    Runtime   State      Status                    Duration  Live `;
	const colPadding = " ".repeat(
		Math.max(0, leftWidth - visibleLength(colStr) - visibleLength(dimBox.vertical)),
	);
	output += `${CURSOR.cursorTo(startRow + 1, 1)}${colStr}${colPadding}${dimBox.vertical}\n`;

	// Separator
	const separator = dimHorizontalLine(leftWidth, dimBox.tee, dimBox.teeRight);
	output += `${CURSOR.cursorTo(startRow + 2, 1)}${separator}\n`;

	// Sort agents: active first, then completed, then zombie
	const agents = [...data.status.agents].sort((a, b) => {
		const activeStates = ["working", "booting", "waiting", "stalled"];
		const aActive = activeStates.includes(a.state);
		const bActive = activeStates.includes(b.state);
		if (aActive && !bActive) return -1;
		if (!aActive && bActive) return 1;
		return 0;
	});

	const now = Date.now();
	const maxRows = panelHeight - 4; // header + col headers + separator + border
	const visibleAgents = agents.slice(0, maxRows);

	const openBreakerCaps = new Set((data.resilience?.openBreakers ?? []).map((b) => b.capability));

	for (let i = 0; i < visibleAgents.length; i++) {
		const agent = visibleAgents[i];
		if (!agent) continue;

		const icon = stateIcon(agent.state);
		const stateColorFn = stateColor(agent.state);
		const name = accent(pad(truncate(agent.agentName, 15), 15));
		const capability = pad(truncate(agent.capability, 12), 12);
		const runtimeName = resolveRuntimeName(agent.capability, data.runtimeConfig);
		const runtime = pad(truncate(runtimeName, 8), 8);
		const state = pad(agent.state, 10);
		const statusText = agent.statusLine ?? agent.taskId;
		const statusCol = agent.statusLine
			? color.dim(pad(truncate(statusText, 25), 25))
			: accent(pad(truncate(statusText, 25), 25));
		const endTime =
			agent.state === "completed" || agent.state === "zombie"
				? new Date(agent.lastActivity).getTime()
				: now;
		const duration = formatDuration(endTime - new Date(agent.startedAt).getTime());
		const durationPadded = pad(duration, 9);
		const isHeadless = agent.tmuxSession === "" && agent.pid !== null;
		const alive = isHeadless
			? agent.pid !== null && isProcessAlive(agent.pid)
			: data.status.tmuxSessions.some((s) => s.name === agent.tmuxSession);
		const aliveDot = alive ? color.green(">") : color.red("x");
		const breakerMarker = openBreakerCaps.has(agent.capability) ? color.red(" ⚡") : "";

		const lineContent = `${dimBox.vertical} ${stateColorFn(icon)}  ${name} ${capability} ${color.dim(runtime)} ${stateColorFn(state)} ${statusCol} ${durationPadded} ${aliveDot}${breakerMarker}   `;
		const linePadding = " ".repeat(
			Math.max(0, leftWidth - visibleLength(lineContent) - visibleLength(dimBox.vertical)),
		);
		output += `${CURSOR.cursorTo(startRow + 3 + i, 1)}${lineContent}${linePadding}${dimBox.vertical}\n`;
	}

	// Fill remaining rows with empty lines
	for (let i = visibleAgents.length; i < maxRows; i++) {
		const emptyLine = `${dimBox.vertical}${" ".repeat(Math.max(0, leftWidth - 2))}${dimBox.vertical}`;
		output += `${CURSOR.cursorTo(startRow + 3 + i, 1)}${emptyLine}\n`;
	}

	// Bottom border (joins the right column)
	const bottomBorder = dimHorizontalLine(leftWidth, dimBox.tee, dimBox.teeRight);
	output += `${CURSOR.cursorTo(startRow + 3 + maxRows, 1)}${bottomBorder}\n`;

	return output;
}

/**
 * Render the tasks panel (upper-right quadrant).
 */
export function renderTasksPanel(
	data: DashboardData,
	startCol: number,
	panelWidth: number,
	panelHeight: number,
	startRow: number,
): string {
	let output = "";

	// Header
	const headerLine = `${dimBox.vertical} ${brand.bold("Tasks")} (${data.tasks.length})`;
	const headerPadding = " ".repeat(
		Math.max(0, panelWidth - visibleLength(headerLine) - visibleLength(dimBox.vertical)),
	);
	output += `${CURSOR.cursorTo(startRow, startCol)}${headerLine}${headerPadding}${dimBox.vertical}\n`;

	// Separator
	const separator = dimHorizontalLine(panelWidth, dimBox.tee, dimBox.teeRight);
	output += `${CURSOR.cursorTo(startRow + 1, startCol)}${separator}\n`;

	const maxRows = panelHeight - 2; // header + separator
	const visibleTasks = data.tasks.slice(0, maxRows);

	if (visibleTasks.length === 0) {
		const emptyMsg = color.dim("No tracker data");
		const emptyLine = `${dimBox.vertical} ${emptyMsg}`;
		const emptyPadding = " ".repeat(
			Math.max(0, panelWidth - visibleLength(emptyLine) - visibleLength(dimBox.vertical)),
		);
		output += `${CURSOR.cursorTo(startRow + 2, startCol)}${emptyLine}${emptyPadding}${dimBox.vertical}\n`;
		// Fill remaining rows
		for (let i = 1; i < maxRows; i++) {
			const blankLine = `${dimBox.vertical}${" ".repeat(Math.max(0, panelWidth - 2))}${dimBox.vertical}`;
			output += `${CURSOR.cursorTo(startRow + 2 + i, startCol)}${blankLine}\n`;
		}
		return output;
	}

	for (let i = 0; i < visibleTasks.length; i++) {
		const task = visibleTasks[i];
		if (!task) continue;

		const idStr = accent(pad(truncate(task.id, 14), 14));
		const priorityStr = numericPriorityColor(task.priority)(`P${task.priority}`);
		const statusStr = pad(task.status, 12);
		const titleMaxLen = Math.max(4, panelWidth - 44);
		const titleStr = truncate(task.title, titleMaxLen);

		const lineContent = `${dimBox.vertical} ${idStr} ${titleStr} ${priorityStr} ${statusStr}`;
		const linePadding = " ".repeat(
			Math.max(0, panelWidth - visibleLength(lineContent) - visibleLength(dimBox.vertical)),
		);
		output += `${CURSOR.cursorTo(startRow + 2 + i, startCol)}${lineContent}${linePadding}${dimBox.vertical}\n`;
	}

	// Fill remaining rows
	for (let i = visibleTasks.length; i < maxRows; i++) {
		const blankLine = `${dimBox.vertical}${" ".repeat(Math.max(0, panelWidth - 2))}${dimBox.vertical}`;
		output += `${CURSOR.cursorTo(startRow + 2 + i, startCol)}${blankLine}\n`;
	}

	return output;
}

/**
 * Render the feed panel (lower-right quadrant).
 */
export function renderFeedPanel(
	data: DashboardData,
	startCol: number,
	panelWidth: number,
	panelHeight: number,
	startRow: number,
): string {
	let output = "";

	// Header
	const headerLine = `${dimBox.vertical} ${brand.bold("Feed")} (live)`;
	const headerPadding = " ".repeat(
		Math.max(0, panelWidth - visibleLength(headerLine) - visibleLength(dimBox.vertical)),
	);
	output += `${CURSOR.cursorTo(startRow, startCol)}${headerLine}${headerPadding}${dimBox.vertical}\n`;

	// Separator
	const separator = dimHorizontalLine(panelWidth, dimBox.tee, dimBox.teeRight);
	output += `${CURSOR.cursorTo(startRow + 1, startCol)}${separator}\n`;

	const maxRows = panelHeight - 2; // header + separator

	if (data.recentEvents.length === 0) {
		const emptyMsg = color.dim("No recent events");
		const emptyLine = `${dimBox.vertical} ${emptyMsg}`;
		const emptyPadding = " ".repeat(
			Math.max(0, panelWidth - visibleLength(emptyLine) - visibleLength(dimBox.vertical)),
		);
		output += `${CURSOR.cursorTo(startRow + 2, startCol)}${emptyLine}${emptyPadding}${dimBox.vertical}\n`;
		for (let i = 1; i < maxRows; i++) {
			const blankLine = `${dimBox.vertical}${" ".repeat(Math.max(0, panelWidth - 2))}${dimBox.vertical}`;
			output += `${CURSOR.cursorTo(startRow + 2 + i, startCol)}${blankLine}\n`;
		}
		return output;
	}

	const colorMap =
		data.feedColorMap.size > 0 ? data.feedColorMap : buildAgentColorMap(data.recentEvents);
	const visibleEvents = data.recentEvents.slice(0, maxRows);

	for (let i = 0; i < visibleEvents.length; i++) {
		const event = visibleEvents[i];
		if (!event) continue;

		const formatted = formatEventLine(event, colorMap);
		// ANSI-safe truncation: trim to panelWidth - 4 (border + space each side)
		const maxLineLen = panelWidth - 4;
		let displayLine = formatted;
		if (visibleLength(displayLine) > maxLineLen) {
			// Truncate by stripping to visible characters
			let count = 0;
			let end = 0;
			// biome-ignore lint/suspicious/noControlCharactersInRegex: needed for ANSI
			const ANSI = /\x1b\[[0-9;]*m/g;
			let lastIndex = 0;
			let match = ANSI.exec(displayLine);
			while (match !== null) {
				const plainSegLen = match.index - lastIndex;
				if (count + plainSegLen >= maxLineLen - 1) {
					end = lastIndex + (maxLineLen - 1 - count);
					count = maxLineLen - 1;
					break;
				}
				count += plainSegLen;
				lastIndex = match.index + match[0].length;
				end = lastIndex;
				match = ANSI.exec(displayLine);
			}
			if (count < maxLineLen - 1) {
				end = displayLine.length;
			}
			displayLine = `${displayLine.slice(0, end)}…`;
		}

		const lineContent = `${dimBox.vertical} ${displayLine}`;
		const contentLen = visibleLength(lineContent) + visibleLength(dimBox.vertical);
		const linePadding = " ".repeat(Math.max(0, panelWidth - contentLen));
		output += `${CURSOR.cursorTo(startRow + 2 + i, startCol)}${lineContent}${linePadding}${dimBox.vertical}\n`;
	}

	// Fill remaining rows
	for (let i = visibleEvents.length; i < maxRows; i++) {
		const blankLine = `${dimBox.vertical}${" ".repeat(Math.max(0, panelWidth - 2))}${dimBox.vertical}`;
		output += `${CURSOR.cursorTo(startRow + 2 + i, startCol)}${blankLine}\n`;
	}

	return output;
}

/**
 * Render the mail panel (bottom-left 50%).
 */
function renderMailPanel(
	data: DashboardData,
	panelWidth: number,
	panelHeight: number,
	startRow: number,
): string {
	let output = "";

	const unreadCount = data.status.unreadMailCount;
	const headerLine = `${dimBox.vertical} ${brand.bold("Mail")} (${unreadCount} unread)`;
	const headerPadding = " ".repeat(
		Math.max(0, panelWidth - visibleLength(headerLine) - visibleLength(dimBox.vertical)),
	);
	output += `${CURSOR.cursorTo(startRow, 1)}${headerLine}${headerPadding}${dimBox.vertical}\n`;

	const separator = dimHorizontalLine(panelWidth, dimBox.tee, dimBox.cross);
	output += `${CURSOR.cursorTo(startRow + 1, 1)}${separator}\n`;

	const maxRows = panelHeight - 3; // header + separator + border
	const messages = data.recentMail.slice(0, maxRows);

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg) continue;

		const priorityColorFn = priorityColor(msg.priority);
		const priority = msg.priority === "normal" ? "" : `[${msg.priority}] `;
		const from = accent(truncate(msg.from, 12));
		const to = accent(truncate(msg.to, 12));
		const subject = truncate(msg.subject, panelWidth - 40);
		const time = formatRelativeTime(msg.createdAt);

		const coloredPriority = priority ? priorityColorFn(priority) : "";
		const lineContent = `${dimBox.vertical} ${coloredPriority}${from} → ${to}: ${subject} (${time})`;
		const padding = " ".repeat(
			Math.max(0, panelWidth - visibleLength(lineContent) - visibleLength(dimBox.vertical)),
		);
		output += `${CURSOR.cursorTo(startRow + 2 + i, 1)}${lineContent}${padding}${dimBox.vertical}\n`;
	}

	// Fill remaining rows with empty lines
	for (let i = messages.length; i < maxRows; i++) {
		const emptyLine = `${dimBox.vertical}${" ".repeat(Math.max(0, panelWidth - 2))}${dimBox.vertical}`;
		output += `${CURSOR.cursorTo(startRow + 2 + i, 1)}${emptyLine}\n`;
	}

	return output;
}

/**
 * Render the merge queue panel (bottom-right 50%).
 */
function renderMergeQueuePanel(
	data: DashboardData,
	panelWidth: number,
	panelHeight: number,
	startRow: number,
	startCol: number,
): string {
	let output = "";

	const headerLine = `${dimBox.vertical} ${brand.bold("Merge Queue")} (${data.mergeQueue.length})`;
	const headerPadding = " ".repeat(
		Math.max(0, panelWidth - visibleLength(headerLine) - visibleLength(dimBox.vertical)),
	);
	output += `${CURSOR.cursorTo(startRow, startCol)}${headerLine}${headerPadding}${dimBox.vertical}\n`;

	const separator = dimHorizontalLine(panelWidth, dimBox.cross, dimBox.teeRight);
	output += `${CURSOR.cursorTo(startRow + 1, startCol)}${separator}\n`;

	const maxRows = panelHeight - 3; // header + separator + border
	const entries = data.mergeQueue.slice(0, maxRows);

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;

		const statusColorFn = mergeStatusColor(entry.status);
		const status = pad(entry.status, 10);
		const agent = accent(truncate(entry.agentName, 15));
		const branch = truncate(entry.branchName, panelWidth - 30);

		const lineContent = `${dimBox.vertical} ${statusColorFn(status)} ${agent} ${branch}`;
		const padding = " ".repeat(
			Math.max(0, panelWidth - visibleLength(lineContent) - visibleLength(dimBox.vertical)),
		);
		output += `${CURSOR.cursorTo(startRow + 2 + i, startCol)}${lineContent}${padding}${dimBox.vertical}\n`;
	}

	// Fill remaining rows with empty lines
	for (let i = entries.length; i < maxRows; i++) {
		const emptyLine = `${dimBox.vertical}${" ".repeat(Math.max(0, panelWidth - 2))}${dimBox.vertical}`;
		output += `${CURSOR.cursorTo(startRow + 2 + i, startCol)}${emptyLine}\n`;
	}

	return output;
}

/**
 * Render the metrics panel (bottom strip).
 */
function renderMetricsPanel(
	data: DashboardData,
	width: number,
	_height: number,
	startRow: number,
): string {
	let output = "";

	const separator = dimHorizontalLine(width, dimBox.tee, dimBox.teeRight);
	output += `${CURSOR.cursorTo(startRow, 1)}${separator}\n`;

	const totalSessions = data.metrics.totalSessions;
	const avgDur = formatDuration(data.metrics.avgDuration);
	const byCapability = Object.entries(data.metrics.byCapability)
		.map(([cap, count]) => `${cap}:${count}`)
		.join(", ");

	const metricsLine = `${dimBox.vertical} ${brand.bold("Metrics")}  Total: ${totalSessions} | Avg: ${avgDur} | ${byCapability}`;
	const metricsPadding = " ".repeat(
		Math.max(0, width - visibleLength(metricsLine) - visibleLength(dimBox.vertical)),
	);
	output += `${CURSOR.cursorTo(startRow + 1, 1)}${metricsLine}${metricsPadding}${dimBox.vertical}\n`;

	const bottomBorder = dimHorizontalLine(width, dimBox.bottomLeft, dimBox.bottomRight);
	output += `${CURSOR.cursorTo(startRow + 2, 1)}${bottomBorder}\n`;

	return output;
}

function missionStateColor(state: string): (s: string) => string {
	switch (state) {
		case "active":
			return color.green;
		case "frozen":
			return color.yellow;
		case "completed":
			return color.cyan;
		case "failed":
			return color.red;
		case "stopped":
			return color.dim;
		default:
			return (s: string) => s;
	}
}

/**
 * Render a compact headroom strip (2-3 rows: header + content + separator).
 */
export function renderHeadroomStrip(
	headroom: HeadroomSnapshot[],
	width: number,
	startRow: number,
): string {
	let output = "";
	const headerLine = `${dimBox.vertical} ${brand.bold("Quota Headroom")}`;
	const headerPadding = " ".repeat(
		Math.max(0, width - visibleLength(headerLine) - visibleLength(dimBox.vertical)),
	);
	output += `${CURSOR.cursorTo(startRow, 1)}${headerLine}${headerPadding}${dimBox.vertical}\n`;

	if (headroom.length === 0) {
		const emptyMsg = color.dim("No headroom data");
		const emptyLine = `${dimBox.vertical} ${emptyMsg}`;
		const emptyPadding = " ".repeat(
			Math.max(0, width - visibleLength(emptyLine) - visibleLength(dimBox.vertical)),
		);
		output += `${CURSOR.cursorTo(startRow + 1, 1)}${emptyLine}${emptyPadding}${dimBox.vertical}\n`;
	} else {
		const parts: string[] = [];
		for (const snap of headroom) {
			if (snap.state === "unavailable") {
				parts.push(`${snap.runtime}: ${color.dim("unavailable")}`);
			} else {
				let pctStr = "?%";
				let colorFn = color.dim;
				if (
					snap.requestsRemaining !== null &&
					snap.requestsLimit !== null &&
					snap.requestsLimit > 0
				) {
					const pct = Math.round((snap.requestsRemaining / snap.requestsLimit) * 100);
					pctStr = `${pct}%`;
					if (pct > 50) colorFn = color.green;
					else if (pct > 20) colorFn = color.yellow;
					else colorFn = color.red;
				}
				parts.push(`${snap.runtime}: ${colorFn(pctStr)} requests remaining (${snap.state})`);
			}
		}
		const contentLine = `${dimBox.vertical} ${parts.join("  |  ")}`;
		const contentPadding = " ".repeat(
			Math.max(0, width - visibleLength(contentLine) - visibleLength(dimBox.vertical)),
		);
		output += `${CURSOR.cursorTo(startRow + 1, 1)}${contentLine}${contentPadding}${dimBox.vertical}\n`;
	}

	const sep = dimHorizontalLine(width, dimBox.tee, dimBox.teeRight);
	output += `${CURSOR.cursorTo(startRow + 2, 1)}${sep}\n`;
	return output;
}

/**
 * Render a compact mission strip (2 rows: content line + separator).
 */
export function renderMissionStrip(
	mission: Mission,
	missionRoles: MissionRoleStates | null | undefined,
	width: number,
	startRow: number,
): string {
	const stateColorFn = missionStateColor(mission.state);
	const stateStr = stateColorFn(`${mission.state}/${mission.phase}`);
	const pendingStr = mission.pendingUserInput
		? ` ${color.yellow(`⏳ ${mission.pendingInputKind ?? "input"}`)}`
		: "";
	const pausedStr =
		mission.pausedWorkstreamIds.length > 0
			? ` ${color.yellow(`paused:${mission.pausedWorkstreamIds.length}`)}`
			: "";
	const rolesStr = missionRoles
		? ` ${color.dim(`roles c:${missionRoles.coordinator} a:${missionRoles.analyst} e:${missionRoles.executionDirector}`)}`
		: "";
	const contentLine =
		`${dimBox.vertical} Mission: ${accent(mission.slug)} [${stateStr}]` +
		`${pendingStr}${pausedStr}${rolesStr}`;
	const contentPadding = " ".repeat(
		Math.max(0, width - visibleLength(contentLine) - visibleLength(dimBox.vertical)),
	);
	const sep = dimHorizontalLine(width, dimBox.tee, dimBox.teeRight);

	return (
		`${CURSOR.cursorTo(startRow, 1)}${contentLine}${contentPadding}${dimBox.vertical}\n` +
		`${CURSOR.cursorTo(startRow + 1, 1)}${sep}\n`
	);
}

/**
 * Render a multi-mission strip showing the primary mission in full and additional
 * missions in compact single-row format.
 */
export function renderMissionsStrip(
	missions: Mission[],
	missionRolesMap: Record<string, MissionRoleStates | null> | null | undefined,
	width: number,
	startRow: number,
): { content: string; height: number } {
	if (missions.length === 0) {
		return { content: "", height: 0 };
	}

	let content = "";
	let currentRow = startRow;

	// First mission: full 2-row format via existing renderMissionStrip
	const first = missions[0]!;
	const firstRoles = missionRolesMap?.[first.id] ?? null;
	content += renderMissionStrip(first, firstRoles, width, currentRow);
	currentRow += 2;

	// Additional missions: compact 1-row each (up to 4 more)
	const additional = missions.slice(1, 5);
	for (const m of additional) {
		const stateColorFn = missionStateColor(m.state);
		const stateStr = stateColorFn(`${m.state}/${m.phase}`);
		const contentLine = `${dimBox.vertical}   ${accent(m.slug)} [${stateStr}]`;
		const contentPadding = " ".repeat(
			Math.max(0, width - visibleLength(contentLine) - visibleLength(dimBox.vertical)),
		);
		content += `${CURSOR.cursorTo(currentRow, 1)}${contentLine}${contentPadding}${dimBox.vertical}\n`;
		currentRow++;
	}

	// Overflow indicator
	if (missions.length > 5) {
		const overflowLine = `${dimBox.vertical}   ${color.dim(`+${missions.length - 5} more`)}`;
		const overflowPadding = " ".repeat(
			Math.max(0, width - visibleLength(overflowLine) - visibleLength(dimBox.vertical)),
		);
		content += `${CURSOR.cursorTo(currentRow, 1)}${overflowLine}${overflowPadding}${dimBox.vertical}\n`;
		currentRow++;
	}

	// Only add separator if we rendered extra rows beyond the first mission
	// (renderMissionStrip already emits its own trailing separator)
	if (additional.length > 0 || missions.length > 5) {
		const sep = dimHorizontalLine(width, dimBox.tee, dimBox.teeRight);
		content += `${CURSOR.cursorTo(currentRow, 1)}${sep}\n`;
		currentRow++;
	}

	const height = currentRow - startRow;
	return { content, height };
}

/**
 * Render the full dashboard frame to stdout.
 */
export function renderDashboard(data: DashboardData, interval: number): void {
	const width = process.stdout.columns ?? 100;
	const height = process.stdout.rows ?? 30;

	let output = CURSOR.clear;

	// Header (rows 1-2)
	output += renderHeader(width, interval, data.currentRunId);

	// Mission strip (rows 3+ if active missions exist)
	let agentPanelStart = 3;
	if (data.missions && data.missions.length > 0) {
		const rolesMap = data.status.missionRolesMap ?? {};
		const { content: stripContent, height: stripHeight } = renderMissionsStrip(
			data.missions,
			rolesMap,
			width,
			3,
		);
		output += stripContent;
		agentPanelStart = 3 + stripHeight;
	}

	// Headroom strip (2-3 rows if headroom data exists)
	if (data.headroom && data.headroom.length > 0) {
		output += renderHeadroomStrip(data.headroom, width, agentPanelStart);
		agentPanelStart += 3;
	}

	// Agent panel: full width, capped at 35% of height
	const agentCount = data.status.agents.length;
	const agentPanelHeight = computeAgentPanelHeight(height, agentCount);
	output += renderAgentPanel(data, width, agentPanelHeight, agentPanelStart);

	// Middle zone: Feed (left 60%) | Tasks (right 40%)
	const middleStart = agentPanelStart + agentPanelHeight + 1;
	const compactPanelHeight = 5; // fixed for mail/merge panels
	const metricsHeight = 3; // separator + data + border
	const middleHeight = Math.max(6, height - middleStart - compactPanelHeight - metricsHeight);

	const feedWidth = Math.floor(width * 0.6);
	output += renderFeedPanel(data, 1, feedWidth, middleHeight, middleStart);

	const taskWidth = width - feedWidth;
	const taskStartCol = feedWidth + 1;
	output += renderTasksPanel(data, taskStartCol, taskWidth, middleHeight, middleStart);

	// Compact panels: Mail (left 50%) | Merge Queue (right 50%) -- fixed 5 rows
	const compactStart = middleStart + middleHeight;
	const mailWidth = Math.floor(width * 0.5);
	output += renderMailPanel(data, mailWidth, compactPanelHeight, compactStart);

	const mergeStartCol = mailWidth + 1;
	const mergeWidth = width - mailWidth;
	output += renderMergeQueuePanel(
		data,
		mergeWidth,
		compactPanelHeight,
		compactStart,
		mergeStartCol,
	);

	// Metrics footer
	const metricsStart = compactStart + compactPanelHeight;
	output += renderMetricsPanel(data, width, height, metricsStart);

	process.stdout.write(output);
}
