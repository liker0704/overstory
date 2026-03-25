import { homedir } from "node:os";
import { join } from "node:path";
import type { DashboardData } from "../../dashboard/data.ts";
import { loadDashboardData } from "../../dashboard/data.ts";
import { acquireStores, releaseStores } from "../connections.ts";
import { loadRegistry } from "../registry.ts";
import { html, layout, Raw } from "../templates/layout.ts";
import { agentRow, emptyState } from "../templates/partials.ts";

const REGISTRY_PATH = join(homedir(), ".overstory", "projects.json");

async function resolveProjectPath(
	slug: string,
): Promise<{ projectPath: string } | { notFound: true }> {
	const registry = await loadRegistry(REGISTRY_PATH);
	const project = registry.projects.find((p) => p.slug === slug);
	if (!project) return { notFound: true };
	return { projectPath: project.path };
}

export function renderAgentsPanel(data: DashboardData): string {
	const agents = [...data.status.agents].sort((a, b) => {
		const aActive = a.state === "booting" || a.state === "working" ? 0 : 1;
		const bActive = b.state === "booting" || b.state === "working" ? 0 : 1;
		if (aActive !== bActive) return aActive - bActive;
		return b.lastActivity.localeCompare(a.lastActivity);
	});

	if (agents.length === 0) {
		return emptyState("No agents found.").value;
	}

	const rows = new Raw(agents.map((a) => agentRow(a).value).join("\n"));
	return html`<table class="table">
	<thead>
		<tr>
			<th></th>
			<th>Name</th>
			<th>Capability</th>
			<th>State</th>
			<th>Task</th>
			<th>Started</th>
		</tr>
	</thead>
	<tbody>${rows}</tbody>
</table>`.value;
}

export async function handleAgentsPage(
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
		const panelHtml = renderAgentsPanel(data);
		const content = html`<div id="sse-agents" sse-swap="agents">${new Raw(panelHtml)}</div>`;

		const htmlString = layout(`Overstory — ${slug} — Agents`, content, {
			activeNav: "Agents",
			slug,
		});
		return new Response(htmlString, {
			status: 200,
			headers: { "Content-Type": "text/html" },
		});
	} finally {
		releaseStores(projectPath);
	}
}
