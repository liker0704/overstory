/**
 * Pure rendering functions for the profiler waterfall page.
 * No data loading, no handlers — just HTML generation.
 */

import type { ProfilerSpan, ProfilerTrace, RunInfo, TraceSummary } from "../../profiler/types.ts";
import { esc, html, Raw } from "../templates/layout.ts";
import { metricCard } from "../templates/partials.ts";

// ---------------------------------------------------------------------------
// CSS (inline const, same pattern as AGENT_TREE_CSS in agents.ts)
// ---------------------------------------------------------------------------

export const PROFILER_CSS = `
/* ===== Profiler Waterfall ===== */
.wf-container {
	display: flex;
	flex-direction: column;
	gap: 16px;
}

.wf-summary {
	display: grid;
	grid-template-columns: repeat(4, 1fr);
	gap: 12px;
}

@media (max-width: 800px) {
	.wf-summary { grid-template-columns: repeat(2, 1fr); }
}

.wf-toolbar {
	display: flex;
	align-items: center;
	gap: 12px;
}

.wf-toolbar select {
	background: var(--bg-card);
	color: var(--text);
	border: 1px solid var(--border);
	border-radius: var(--radius-sm);
	padding: 4px 8px;
	font-family: var(--font);
	font-size: 12px;
}

.wf-timeline {
	position: relative;
	overflow-x: auto;
}

.wf-axis {
	display: flex;
	justify-content: space-between;
	border-bottom: 1px solid var(--border);
	padding: 4px 0;
	color: var(--text-muted);
	font-size: 10px;
	margin-bottom: 4px;
	position: sticky;
	top: 0;
	background: var(--bg);
	z-index: 1;
}

.wf-rows {
	display: flex;
	flex-direction: column;
}

.wf-row {
	position: relative;
	height: 32px;
	cursor: pointer;
	transition: background 0.1s;
}

.wf-row:hover {
	background: rgba(255,255,255,0.03);
}

.wf-row-active {
	background: var(--bg-card);
}

.wf-bar {
	position: absolute;
	top: 2px;
	height: 28px;
	border-radius: 4px;
	min-width: 20px;
	font-size: 11px;
	line-height: 28px;
	padding: 0 8px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: rgba(255,255,255,0.95);
	font-weight: 500;
}

.wf-bar-session { background: var(--blue); opacity: 0.7; }
.wf-bar-tool { background: var(--cyan); opacity: 0.8; }
.wf-bar-turn { background: var(--purple); opacity: 0.7; }
.wf-bar-spawn { background: var(--green); opacity: 0.7; }
.wf-bar-mail { background: var(--amber); opacity: 0.7; }
.wf-bar-mission { background: var(--purple); opacity: 0.5; }
.wf-bar-custom { background: var(--text-muted); opacity: 0.5; }
.wf-bar-error { background: var(--red); opacity: 0.8; }

.wf-bar-state-working { background: var(--blue); opacity: 0.85; }
.wf-bar-state-waiting { background: var(--amber); opacity: 0.75; }
.wf-bar-state-completed { background: var(--text-muted); opacity: 0.6; }
.wf-bar-state-booting { background: var(--green); opacity: 0.7; }
.wf-bar-state-stalled { background: var(--amber); opacity: 0.9; }
.wf-bar-state-zombie { background: var(--red); opacity: 0.85; }

.wf-bar-segmented { background: var(--bg-card); border: 1px solid var(--border); overflow: hidden; }

.wf-seg {
	position: absolute;
	top: 0;
	height: 100%;
	border-radius: 0;
}

.wf-bar-label {
	position: relative;
	z-index: 1;
}

.wf-legend {
	display: flex;
	gap: 16px;
	padding: 8px 0;
	font-size: 11px;
	color: var(--text-muted);
}

.wf-legend-item {
	display: flex;
	align-items: center;
	gap: 4px;
}

.wf-legend-dot {
	display: inline-block;
	width: 10px;
	height: 10px;
	border-radius: 2px;
}

.wf-marker {
	position: absolute;
	top: 8px;
	width: 10px;
	height: 10px;
	transform: rotate(45deg);
	border-radius: 2px;
	margin-left: -5px;
}

.wf-detail {
	background: var(--bg-card);
	border: 1px solid var(--border);
	border-radius: var(--radius);
	padding: 16px;
	margin-top: 12px;
}

.wf-detail-grid {
	display: grid;
	grid-template-columns: 120px 1fr;
	gap: 4px 12px;
	font-size: 12px;
}

.wf-detail-key {
	color: var(--text-muted);
	text-transform: uppercase;
	font-size: 10px;
	letter-spacing: 0.05em;
}

.wf-detail-val {
	color: var(--text);
	word-break: break-all;
}

.wf-cap-table {
	margin-top: 12px;
}

.wf-cap-table td, .wf-cap-table th {
	padding: 4px 12px;
	font-size: 11px;
}
`;

// ---------------------------------------------------------------------------
// Public render functions
// ---------------------------------------------------------------------------

export function renderProfilerPage(
	trace: ProfilerTrace | null,
	runs: RunInfo[],
	currentRunId: string,
	slug: string,
): Raw {
	const summaryHtml = trace ? renderSummaryCards(trace.summary) : "";
	const selectorHtml = renderRunSelector(runs, currentRunId, slug);
	const waterfallHtml = trace ? renderWaterfall(trace, slug) : renderEmptyWaterfall();

	return html`<style>${new Raw(PROFILER_CSS)}</style>
<div class="wf-container">
	${new Raw(summaryHtml)}
	${new Raw(selectorHtml)}
	<div id="waterfall-content" hx-ext="sse" sse-connect="/project/${slug}/profiler/sse?run=${currentRunId}">
		<div id="sse-waterfall" sse-swap="waterfall">
			${new Raw(waterfallHtml)}
		</div>
	</div>
	<div id="span-detail"></div>
</div>`;
}

export function renderWaterfall(trace: ProfilerTrace, slug: string): string {
	const axisHtml = renderTimeAxis(trace.totalDurationMs);
	const agentSpans = trace.flatSpans
		.filter((s) => s.kind === "session")
		.sort((a, b) => a.startTimeMs - b.startTimeMs);

	// Assign spans to swim lanes: reuse a lane when its previous occupant has ended
	const lanes = assignSwimLanes(agentSpans);
	const laneCount = lanes.length > 0 ? Math.max(...lanes) + 1 : 0;

	const rowsHtml: string[] = [];
	for (let i = 0; i < laneCount; i++) {
		const spansInLane = agentSpans.filter((_, idx) => lanes[idx] === i);
		const barsHtml = spansInLane
			.map((span) => renderAgentBar(span, trace, slug))
			.join("");
		rowsHtml.push(`<div class="wf-row">${barsHtml}</div>`);
	}

	const legendHtml = `<div class="wf-legend">
	<span class="wf-legend-item"><span class="wf-legend-dot wf-bar-state-booting"></span> booting</span>
	<span class="wf-legend-item"><span class="wf-legend-dot wf-bar-state-working"></span> working</span>
	<span class="wf-legend-item"><span class="wf-legend-dot wf-bar-state-waiting"></span> waiting</span>
	<span class="wf-legend-item"><span class="wf-legend-dot wf-bar-state-completed"></span> completed</span>
</div>`;

	return `<div class="wf-timeline">
	${axisHtml}
	<div class="wf-rows">${rowsHtml.join("\n")}</div>
	${legendHtml}
</div>`;
}

/** Assign each span to a swim lane, reusing lanes when previous occupant finished. */
function assignSwimLanes(spans: ProfilerSpan[]): number[] {
	const now = Date.now();
	// laneEndTimes[i] = when lane i becomes free
	const laneEndTimes: number[] = [];
	const assignments: number[] = [];

	for (const span of spans) {
		const effectiveEnd = span.endTimeMs ?? now;
		// Find first lane that is free before this span starts
		let assigned = -1;
		for (let i = 0; i < laneEndTimes.length; i++) {
			const endTime = laneEndTimes[i];
			if (endTime !== undefined && endTime <= span.startTimeMs) {
				assigned = i;
				break;
			}
		}
		if (assigned === -1) {
			assigned = laneEndTimes.length;
			laneEndTimes.push(effectiveEnd);
		} else {
			laneEndTimes[assigned] = effectiveEnd;
		}
		assignments.push(assigned);
	}

	return assignments;
}

export function renderSummaryCards(summary: TraceSummary): string {
	const duration = formatDuration(summary.totalDurationMs);
	const cost = summary.totalCostUsd !== null ? `$${summary.totalCostUsd.toFixed(2)}` : "—";
	const { input, output, cacheRead, cacheCreation } = summary.tokens;
	const totalTokens = input + output + cacheRead + cacheCreation;
	const tokenStr = totalTokens > 0 ? formatNumber(totalTokens) : "0";
	const tokenBreakdown = [
		`in: ${formatNumber(input)}`,
		`out: ${formatNumber(output)}`,
		`cache read: ${formatNumber(cacheRead)}`,
		`cache write: ${formatNumber(cacheCreation)}`,
	].join(" · ");

	return `<div class="wf-summary">
	${metricCard("Duration", duration).value}
	${metricCard("Cost", cost).value}
	${metricCard("Agents", String(summary.agentCount)).value}
	${metricCard("Tokens", tokenStr, tokenBreakdown).value}
</div>`;
}

export function renderSpanDetail(span: ProfilerSpan): string {
	const duration = span.durationMs !== null ? formatDuration(span.durationMs) : "in progress";
	const startTime = new Date(span.startTimeMs).toISOString();
	const endTime = span.endTimeMs ? new Date(span.endTimeMs).toISOString() : "—";

	const attrRows = Object.entries(span.attributes)
		.map(
			([k, v]) =>
				`<div class="wf-detail-key">${esc(k)}</div><div class="wf-detail-val">${esc(String(v))}</div>`,
		)
		.join("\n");

	return `<div class="wf-detail">
	<div class="wf-detail-grid">
		<div class="wf-detail-key">Name</div><div class="wf-detail-val">${esc(span.name)}</div>
		<div class="wf-detail-key">Kind</div><div class="wf-detail-val">${esc(span.kind)}</div>
		<div class="wf-detail-key">Status</div><div class="wf-detail-val">${esc(span.status)}</div>
		<div class="wf-detail-key">Agent</div><div class="wf-detail-val">${esc(span.agentName)}</div>
		<div class="wf-detail-key">Duration</div><div class="wf-detail-val">${esc(duration)}</div>
		<div class="wf-detail-key">Start</div><div class="wf-detail-val">${esc(startTime)}</div>
		<div class="wf-detail-key">End</div><div class="wf-detail-val">${esc(endTime)}</div>
		<div class="wf-detail-key">Span ID</div><div class="wf-detail-val"><code>${esc(span.spanId)}</code></div>
		<div class="wf-detail-key">Parent ID</div><div class="wf-detail-val"><code>${esc(span.parentSpanId ?? "—")}</code></div>
		${attrRows}
	</div>
</div>`;
}

export function renderRunSelector(runs: RunInfo[], currentRunId: string, slug: string): string {
	if (runs.length === 0) return "";

	const options = runs
		.map((r) => {
			const selected = r.id === currentRunId ? " selected" : "";
			const label = `${r.id} (${r.status}${r.coordinatorName ? ` · ${r.coordinatorName}` : ""})`;
			return `<option value="${esc(r.id)}"${selected}>${esc(label)}</option>`;
		})
		.join("\n");

	return `<div class="wf-toolbar">
	<label style="color:var(--text-secondary);font-size:11px;">Run:</label>
	<select onchange="window.location.href='/project/${esc(slug)}/profiler?run='+this.value">
		${options}
	</select>
</div>`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function renderAgentBar(span: ProfilerSpan, trace: ProfilerTrace, slug: string): string {
	const capability = span.attributes["ov.agent.capability"] ?? "";
	const shortName = span.agentName.replace(
		/^(coordinator|mission-analyst|scout|lead|builder|architect|execution-director)-/,
		"",
	);
	const capLabel = capability ? ` (${capability})` : "";

	const traceDur = trace.totalDurationMs || 1;
	const leftPct = ((span.startTimeMs - trace.startTimeMs) / traceDur) * 100;
	const effectiveEnd = span.endTimeMs ?? Date.now();
	const spanDur = effectiveEnd - span.startTimeMs;
	const widthPct = (spanDur / traceDur) * 100;

	const toolCount = span.attributes["ov.agent.tool_count"];
	const toolSuffix = typeof toolCount === "number" && toolCount > 0 ? ` · ${toolCount} tools` : "";
	const durationLabel = formatDurationShort(spanDur) + toolSuffix;
	const barLabel = `${shortName}${capLabel} — ${durationLabel}`;

	// Render state segments if available
	let segmentsHtml = "";
	if (span.stateSegments && span.stateSegments.length > 1) {
		for (const seg of span.stateSegments) {
			const segLeft = ((seg.startMs - span.startTimeMs) / (spanDur || 1)) * 100;
			const segWidth = ((seg.endMs - seg.startMs) / (spanDur || 1)) * 100;
			segmentsHtml += `<div class="wf-seg wf-bar-state-${esc(seg.state)}" style="left:${segLeft.toFixed(1)}%;width:${segWidth.toFixed(1)}%"></div>`;
		}
	}

	const state = String(span.attributes["ov.agent.state"] ?? "completed");
	const barClass = span.stateSegments && span.stateSegments.length > 1 ? "wf-bar-segmented" : `wf-bar-state-${state}`;

	return `<div class="${barClass} wf-bar" style="left:${leftPct.toFixed(2)}%;width:${Math.max(widthPct, 0.5).toFixed(2)}%" title="${esc(String(span.agentName))}" hx-get="/project/${esc(slug)}/profiler/span/${esc(span.spanId)}?run=${esc(trace.runId)}" hx-target="#span-detail" hx-swap="innerHTML">${segmentsHtml}<span class="wf-bar-label">${esc(barLabel)}</span></div>`;
}

function renderSpanRow(span: ProfilerSpan, trace: ProfilerTrace, slug: string): string {
	const indent = span.depth * 16;
	const label = span.kind === "session" ? span.agentName : span.name.replace(/^(tool|turn):/, "");

	const traceDur = trace.totalDurationMs || 1;
	const leftPct = ((span.startTimeMs - trace.startTimeMs) / traceDur) * 100;
	const spanDur = (span.endTimeMs ?? span.startTimeMs) - span.startTimeMs;
	const widthPct = (spanDur / traceDur) * 100;

	const barClass = span.status === "error" ? "wf-bar-error" : `wf-bar-${span.kind}`;
	const spanHasDuration = spanDur > 0 || (span.durationMs !== null && span.durationMs > 0);

	// Instant events (durationMs=0, no time span) render as a diamond marker
	if (!spanHasDuration) {
		const collapsedCount =
			typeof span.attributes["ov.collapsed_count"] === "number"
				? span.attributes["ov.collapsed_count"]
				: 1;
		const countLabel = collapsedCount > 1 ? ` x${collapsedCount}` : "";
		return `<div class="wf-row" hx-get="/project/${esc(slug)}/profiler/span/${esc(span.spanId)}?run=${esc(trace.runId)}" hx-target="#span-detail" hx-swap="innerHTML">
	<div class="wf-label" style="padding-left:${indent + 8}px" title="${esc(span.name)}">${esc(label)}${esc(countLabel)}</div>
	<div class="wf-track">
		<div class="${barClass} wf-marker" style="left:${leftPct.toFixed(2)}%"></div>
	</div>
</div>`;
	}

	const effectiveDur = span.durationMs ?? spanDur;
	const durationLabel = formatDurationShort(effectiveDur);

	return `<div class="wf-row" hx-get="/project/${esc(slug)}/profiler/span/${esc(span.spanId)}?run=${esc(trace.runId)}" hx-target="#span-detail" hx-swap="innerHTML">
	<div class="wf-label" style="padding-left:${indent + 8}px" title="${esc(span.name)}">${esc(label)}</div>
	<div class="wf-track">
		<div class="${barClass} wf-bar" style="left:${leftPct.toFixed(2)}%;width:${Math.max(widthPct, 0.5).toFixed(2)}%">${esc(durationLabel)}</div>
	</div>
</div>`;
}

function renderTimeAxis(totalDurationMs: number): string {
	if (totalDurationMs <= 0) return '<div class="wf-axis"><span>0s</span></div>';

	const tickCount = 5;
	const ticks: string[] = [];
	for (let i = 0; i <= tickCount; i++) {
		const ms = (totalDurationMs / tickCount) * i;
		ticks.push(`<span>${formatDurationShort(ms)}</span>`);
	}

	return `<div class="wf-axis">
	<div style="flex:1;display:flex;justify-content:space-between">${ticks.join("")}</div>
</div>`;
}

function renderEmptyWaterfall(): string {
	return '<div class="empty-state">No trace data for this run.</div>';
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const mins = Math.floor(ms / 60_000);
	const secs = Math.floor((ms % 60_000) / 1000);
	return `${mins}m ${secs}s`;
}

function formatDurationShort(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60_000).toFixed(1)}m`;
}

function formatNumber(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}
