import { homedir } from "node:os";
import { join } from "node:path";
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

		const content = html`<div class="metrics-row">${metricsHtml}</div>
<section>
	<h2>Active Mission</h2>
	${activeMission ? html`<p>${activeMission}</p>` : emptyState("No active mission.")}
</section>
<section>
	<h2>Agents</h2>
	${agentTable}
</section>
<div hx-ext="sse" sse-connect="${`/project/${slug}/sse`}"></div>`;

		const htmlString = layout(`Overstory — ${slug}`, content, { activeNav: "Overview", slug });
		return new Response(htmlString, {
			status: 200,
			headers: { "Content-Type": "text/html" },
		});
	} finally {
		releaseStores(projectPath);
	}
}
