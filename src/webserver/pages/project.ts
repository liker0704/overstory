import { homedir } from "node:os";
import { join } from "node:path";
import type { DashboardData } from "../../dashboard/data.ts";
import { loadDashboardData } from "../../dashboard/data.ts";
import { acquireStores, releaseStores } from "../connections.ts";
import { loadRegistry } from "../registry.ts";
import { html, layout, Raw } from "../templates/layout.ts";
import { emptyState, metricCard, statusBadge } from "../templates/partials.ts";

const REGISTRY_PATH = join(homedir(), ".overstory", "projects.json");

async function resolveProjectPath(
	slug: string,
): Promise<{ projectPath: string } | { notFound: true }> {
	const registry = await loadRegistry(REGISTRY_PATH);
	const project = registry.projects.find((p) => p.slug === slug);
	if (!project) return { notFound: true };
	return { projectPath: project.path };
}

export function renderMetricsPanel(data: DashboardData): string {
	const { agents } = data.status;
	const agentCount = agents.length;
	const mailCount = data.recentMail.length;
	const mergeCount = data.mergeQueue.length;
	const activeMission = data.mission ? data.mission.slug : null;

	const metricsHtml = new Raw(
		[
			metricCard("Agents", agentCount).value,
			metricCard("Recent Mail", mailCount).value,
			metricCard("Merge Queue", mergeCount).value,
		].join("\n"),
	);

	const agentStateRows =
		agents.length === 0
			? emptyState("No agents running.")
			: new Raw(
					agents
						.map(
							(a) => html`<tr><td>${a.agentName}</td><td>${statusBadge(a.state)}</td></tr>`.value,
						)
						.join("\n"),
				);

	const agentTable =
		agents.length === 0
			? agentStateRows
			: html`<table class="table">
	<thead><tr><th>Agent</th><th>State</th></tr></thead>
	<tbody>${agentStateRows}</tbody>
</table>`;

	return html`<div class="metrics-row">${metricsHtml}</div>
<section>
	<h2>Active Mission</h2>
	${activeMission ? html`<p>${activeMission}</p>` : emptyState("No active mission.")}
</section>
<section>
	<h2>Agents</h2>
	${agentTable}
</section>`.value;
}

export function renderHeadroomPanel(data: DashboardData): string {
	if (!data.headroom || data.headroom.length === 0) return "";
	const snapshots = data.headroom;
	const items = new Raw(
		snapshots
			.map(
				(s) =>
					html`<div class="metric"><div class="metric-label">${s.runtime}</div><div class="metric-value">${s.message}</div></div>`
						.value,
			)
			.join("\n"),
	);
	return html`<div class="metrics-row">${items}</div>`.value;
}

export function renderResiliencePanel(data: DashboardData): string {
	if (!data.resilience) return "";
	const { openBreakers, activeRetryCount } = data.resilience;
	const breakerItems = new Raw(
		openBreakers
			.map(
				(b) =>
					html`<div class="metric"><div class="metric-label">${b.capability}</div><div class="metric-value">${String(b.failureCount)} failures</div></div>`
						.value,
			)
			.join("\n"),
	);
	return html`<div class="metrics-row">${breakerItems}<div class="metric"><div class="metric-label">Active Retries</div><div class="metric-value">${String(activeRetryCount)}</div></div></div>`
		.value;
}

export async function handleProjectPage(
	_req: Request,
	params: Record<string, string>,
): Promise<Response> {
	const slug = params.slug ?? "";
	const resolved = await resolveProjectPath(slug);

	if ("notFound" in resolved) {
		const body = layout("Not Found", html`<h1>Project not found</h1>`, { slug });
		return new Response(body, {
			status: 404,
			headers: { "Content-Type": "text/html" },
		});
	}

	const { projectPath } = resolved;
	const stores = await acquireStores(projectPath);
	try {
		const data = await loadDashboardData(projectPath, stores);

		const metricsPanel = renderMetricsPanel(data);
		const headroomPanel = renderHeadroomPanel(data);
		const resiliencePanel = renderResiliencePanel(data);

		const content = html`<div hx-ext="sse" sse-connect="${`/project/${slug}/sse`}">
	<div id="sse-metrics" sse-swap="metrics">${new Raw(metricsPanel)}</div>
	<div id="sse-headroom" sse-swap="headroom">${new Raw(headroomPanel)}</div>
	<div id="sse-resilience" sse-swap="resilience">${new Raw(resiliencePanel)}</div>
</div>`;

		const htmlString = layout(`Overstory — ${slug}`, content, { activeNav: "Overview", slug });
		return new Response(htmlString, {
			status: 200,
			headers: { "Content-Type": "text/html" },
		});
	} finally {
		releaseStores(projectPath);
	}
}
