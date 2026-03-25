import { homedir } from "node:os";
import { join } from "node:path";
import { loadDashboardData } from "../../dashboard/data.ts";
import { acquireStores, releaseStores } from "../connections.ts";
import { loadRegistry } from "../registry.ts";
import { Raw, html, layout } from "../templates/layout.ts";
import { emptyState, statusBadge, timeAgo } from "../templates/partials.ts";

export async function handleEventsPage(
	_req: Request,
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
		const events = data.recentEvents.slice(0, 50);

		if (events.length === 0) {
			const body = layout("Events", emptyState("No events recorded."), {
				activeNav: "Events",
				slug,
			});
			return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
		}

		const rowsHtml = events
			.map((e) => {
				const rawDetails = e.toolName ?? e.data ?? "";
				const details =
					typeof rawDetails === "string" && rawDetails.length > 60
						? `${rawDetails.slice(0, 57)}...`
						: String(rawDetails ?? "");
				return html`<tr>
	<td>${timeAgo(e.createdAt)}</td>
	<td>${e.agentName ?? "—"}</td>
	<td>${statusBadge(e.eventType)}</td>
	<td>${details}</td>
</tr>`.value;
			})
			.join("\n");

		const content = html`<table class="table">
	<thead><tr>
		<th>Time</th>
		<th>Agent</th>
		<th>Event Type</th>
		<th>Details</th>
	</tr></thead>
	<tbody>${new Raw(rowsHtml)}</tbody>
</table>`;

		const body = layout("Events", content, { activeNav: "Events", slug });
		return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
	} finally {
		releaseStores(projectPath);
	}
}
