import { homedir } from "node:os";
import { join } from "node:path";
import { loadDashboardData } from "../../dashboard/data.ts";
import { acquireStores, releaseStores } from "../connections.ts";
import { loadRegistry } from "../registry.ts";
import { Raw, html, layout } from "../templates/layout.ts";
import { emptyState, metricCard, statusBadge } from "../templates/partials.ts";

export async function handleMergePage(
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
		const queue = data.mergeQueue;

		const pending = queue.filter((e) => e.status === "pending").length;
		const completed = queue.filter((e) => e.status === "completed").length;
		const failed = queue.filter((e) => e.status === "failed").length;

		const metrics = html`<div class="metrics-row">
	${metricCard("Pending", pending)}
	${metricCard("Completed", completed)}
	${metricCard("Failed", failed)}
</div>`;

		if (queue.length === 0) {
			const body = layout("Merge Queue", html`${metrics}${emptyState("Merge queue is empty.")}`, {
				activeNav: "Merge",
				slug,
			});
			return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
		}

		const rowsHtml = queue
			.map(
				(e) =>
					html`<tr>
	<td>${e.branchName}</td>
	<td>${e.agentName}</td>
	<td>${statusBadge(e.status)}</td>
</tr>`.value,
			)
			.join("\n");

		const content = html`${metrics}<table class="table">
	<thead><tr>
		<th>Branch</th>
		<th>Agent</th>
		<th>Status</th>
	</tr></thead>
	<tbody>${new Raw(rowsHtml)}</tbody>
</table>`;

		const body = layout("Merge Queue", content, { activeNav: "Merge", slug });
		return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
	} finally {
		releaseStores(projectPath);
	}
}
