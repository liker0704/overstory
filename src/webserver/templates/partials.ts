/**
 * Reusable HTML partial functions for dashboard pages.
 * All functions return Raw instances safe for use in html tagged templates.
 */

import type { AgentSession } from "../../agents/types.ts";
import type { MailMessage } from "../../mail/types.ts";
import { Raw, esc, html } from "./layout.ts";

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

/** Renders a metric card with label and value. */
export function metricCard(label: string, value: string | number): Raw {
	return html`<div class="metric">
	<div class="metric-value">${String(value)}</div>
	<div class="metric-label">${label}</div>
</div>`;
}

/** Renders an empty state message. */
export function emptyState(message: string): Raw {
	return html`<div class="empty-state">${message}</div>`;
}

/** Renders an agent table row. */
export function agentRow(agent: AgentSession): Raw {
	const truncatedTask = agent.taskId.length > 60 ? `${agent.taskId.slice(0, 57)}...` : agent.taskId;
	return html`<tr>
	<td><span class="status-dot status-${agent.state}"></span></td>
	<td>${agent.agentName}</td>
	<td>${agent.capability}</td>
	<td>${statusBadge(agent.state)}</td>
	<td>${truncatedTask}</td>
	<td>${timeAgo(agent.startedAt)}</td>
</tr>`;
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
