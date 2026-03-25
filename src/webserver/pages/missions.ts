import { homedir } from "node:os";
import { join } from "node:path";
import { loadDashboardData } from "../../dashboard/data.ts";
import { acquireStores, releaseStores } from "../connections.ts";
import { loadRegistry } from "../registry.ts";
import { Raw, html, layout } from "../templates/layout.ts";
import { emptyState, statusBadge, timeAgo } from "../templates/partials.ts";

export async function handleMissionsPage(
	req: Request,
	params: Record<string, string>,
): Promise<Response> {
	const registryPath = join(homedir(), ".overstory", "projects.json");
	const registry = await loadRegistry(registryPath);
	const slug = params["slug"] ?? "";
	const project = registry.projects.find((p) => p.slug === slug);

	if (!project) {
		const body = layout("Not Found", html`<h1>Project not found</h1>`);
		return new Response(body, { status: 404, headers: { "Content-Type": "text/html" } });
	}

	const projectPath = project.path;
	const stores = await acquireStores(projectPath);

	try {
		const data = await loadDashboardData(projectPath, stores);
		const missions = data.missions;

		if (missions.length === 0) {
			const body = layout("Missions", emptyState("No missions found."), {
				activeNav: "Missions",
				slug,
			});
			return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
		}

		const rows = missions
			.map((m) => {
				const truncatedObj =
					m.objective && m.objective.length > 80
						? `${m.objective.slice(0, 77)}...`
						: (m.objective ?? "—");
				const workstreamCount = m.pausedWorkstreamIds.length;
				const coordinatorBadge = m.coordinatorSessionId
					? html`<span class="badge badge-active">coordinator</span>`
					: html`<span class="badge badge-missing">coordinator</span>`;
				const analystBadge = m.analystSessionId
					? html`<span class="badge badge-active">analyst</span>`
					: html`<span class="badge badge-missing">analyst</span>`;
				const execBadge = m.executionDirectorSessionId
					? html`<span class="badge badge-active">exec-director</span>`
					: html`<span class="badge badge-missing">exec-director</span>`;

				return html`<tr>
	<td>${m.id}</td>
	<td>${statusBadge(m.state)}</td>
	<td>${m.phase ?? "—"}</td>
	<td>${truncatedObj}</td>
	<td>${timeAgo(m.createdAt)}</td>
	<td>${String(workstreamCount)}</td>
	<td>${coordinatorBadge}${analystBadge}${execBadge}</td>
</tr>`;
			})
			.map((r) => r.value)
			.join("\n");

		const ge = data.graphExecution;
		const graphSection = ge
			? html`<section class="graph-execution">
	<h2>Graph Execution</h2>
	<div class="metrics-row">
		<div class="metric"><div class="metric-label">Cell Type</div><div class="metric-value">${ge.cellType}</div></div>
		<div class="metric"><div class="metric-label">Current Node</div><div class="metric-value">${ge.currentNodeId}</div></div>
		<div class="metric"><div class="metric-label">Transitions</div><div class="metric-value">${String(ge.transitionCount)}</div></div>
	</div>
</section>`
			: html``;

		const content = html`${graphSection}<table class="table">
	<thead><tr>
		<th>ID</th>
		<th>State</th>
		<th>Phase</th>
		<th>Objective</th>
		<th>Created</th>
		<th>Workstreams</th>
		<th>Roles</th>
	</tr></thead>
	<tbody>${new Raw(rows)}</tbody>
</table>`;

		const body = layout("Missions", content, { activeNav: "Missions", slug });
		return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
	} finally {
		releaseStores(projectPath);
	}
}
