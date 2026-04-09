/**
 * Reusable HTML partial functions for dashboard pages.
 * All functions return Raw instances safe for use in html tagged templates.
 */

import type { AgentSession } from "../../agents/types.ts";
import type { DashboardData } from "../../dashboard/data.ts";
import type { MailMessage } from "../../mail/types.ts";
import { renderAgentsPanel } from "../pages/agents.ts";
import { renderEventsPanel } from "../pages/events.ts";
import { renderMailPanel } from "../pages/mail.ts";
import { renderMergePanel } from "../pages/merge.ts";
import { renderMissionPanel } from "../pages/missions.ts";
import {
	renderHeadroomPanel,
	renderMetricsPanel,
	renderResiliencePanel,
} from "../pages/project.ts";
import { html, Raw } from "./layout.ts";

/** Renders a colored state badge. */
export function statusBadge(state: string): Raw {
	return html`<span class="badge badge-${state}">${state}</span>`;
}

/** Renders a <time> element; client JS updates the displayed text. */
export function timeAgo(isoDate: string): Raw {
	return html`<time class="timestamp" datetime="${isoDate}">${isoDate}</time>`;
}

/** Renders a generic table with thead + tbody. */
export function dataTable(headers: string[], rows: string[][]): Raw {
	const thCells = headers.map((h) => html`<th>${h}</th>`.value).join("");
	const bodyRows = rows
		.map((row) => {
			const cells = row.map((cell) => html`<td>${cell}</td>`.value).join("");
			return `<tr>${cells}</tr>`;
		})
		.join("\n");

	return html`<table class="table">
	<thead><tr>${new Raw(thCells)}</tr></thead>
	<tbody>${new Raw(bodyRows)}</tbody>
</table>`;
}

/** Renders a metric card with label, value, and optional subtitle. */
export function metricCard(label: string, value: string | number, subtitle?: string): Raw {
	const subtitleHtml = subtitle ? `\n\t<div class="metric-subtitle">${subtitle}</div>` : "";
	return html`<div class="metric">
	<div class="metric-value">${String(value)}</div>
	<div class="metric-label">${label}</div>${new Raw(subtitleHtml)}
</div>`;
}

/** Renders an empty state message. */
export function emptyState(message: string): Raw {
	return html`<div class="empty-state">${message}</div>`;
}

/** Renders an agent tree node (unclosed li — caller appends children ul before closing). */
export function agentTreeNode(agent: AgentSession, cycleWarning?: boolean): Raw {
	const truncatedTask = agent.taskId.length > 60 ? `${agent.taskId.slice(0, 57)}...` : agent.taskId;
	const warningSpan = cycleWarning
		? html`<span class="agent-tree-warning" title="Cycle detected in parent graph">(warning cycle)</span>`
		: new Raw("");
	return html`<li class="agent-tree-node" id="agent-${agent.agentName}">
	<div class="agent-tree-content">
		<span class="status-dot status-${agent.state}"></span>
		<span class="agent-tree-name"><a href="#agent-${agent.agentName}">${agent.agentName}</a></span>
		${statusBadge(agent.capability)}
		${statusBadge(agent.state)}
		<span class="agent-tree-meta">${truncatedTask}</span>
		<span class="agent-tree-meta">${timeAgo(agent.lastActivity)}</span>
		${warningSpan}
	</div>`;
}

/** Renders a mail message table row. */
export function mailRow(mail: MailMessage): Raw {
	const truncatedSubject =
		mail.subject.length > 60 ? `${mail.subject.slice(0, 57)}...` : mail.subject;
	return html`<tr>
	<td>${statusBadge(mail.priority)}</td>
	<td>${mail.from}</td>
	<td>${mail.to}</td>
	<td>${truncatedSubject}</td>
	<td>${statusBadge(mail.type)}</td>
	<td>${timeAgo(mail.createdAt)}</td>
</tr>`;
}

/** Renders a success alert, optionally with a link. */
export function alertSuccess(message: string, linkHref?: string, linkText?: string): Raw {
	if (linkHref && linkText) {
		return html`<div class="alert alert-success">${message} <a href="${linkHref}">${linkText}</a></div>`;
	}
	return html`<div class="alert alert-success">${message}</div>`;
}

/** Renders a danger alert, optionally with a detail block. */
export function alertError(message: string, detail?: string): Raw {
	if (detail) {
		return html`<div class="alert alert-danger">${message}<pre>${detail}</pre></div>`;
	}
	return html`<div class="alert alert-danger">${message}</div>`;
}

export type PanelRenderer = (data: DashboardData) => string;

export const PANEL_RENDERERS: Record<string, PanelRenderer> = {
	agents: renderAgentsPanel,
	mail: renderMailPanel,
	merge: renderMergePanel,
	metrics: renderMetricsPanel,
	events: renderEventsPanel,
	mission: renderMissionPanel,
	headroom: renderHeadroomPanel,
	resilience: renderResiliencePanel,
};
