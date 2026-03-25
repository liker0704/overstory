import { homedir } from "node:os";
import { join } from "node:path";
import { loadDashboardData } from "../../dashboard/data.ts";
import { acquireStores, releaseStores } from "../connections.ts";
import { loadRegistry } from "../registry.ts";
import { Raw, html, layout } from "../templates/layout.ts";
import { emptyState, mailRow } from "../templates/partials.ts";

export async function handleMailPage(
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
		const messages = data.recentMail;
		const unreadCount = data.status.unreadMailCount;

		const header = html`<div class="page-header">
	<h2>Mail <span class="badge badge-unread">${String(unreadCount)} unread</span></h2>
</div>`;

		if (messages.length === 0) {
			const body = layout("Mail", html`${header}${emptyState("No mail messages.")}`, {
				activeNav: "Mail",
				slug,
			});
			return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
		}

		const rowsHtml = messages.map((m) => mailRow(m).value).join("\n");

		const content = html`${header}<table class="table">
	<thead><tr>
		<th>Priority</th>
		<th>From</th>
		<th>To</th>
		<th>Subject</th>
		<th>Type</th>
		<th>Time</th>
	</tr></thead>
	<tbody>${new Raw(rowsHtml)}</tbody>
</table>`;

		const body = layout("Mail", content, { activeNav: "Mail", slug });
		return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
	} finally {
		releaseStores(projectPath);
	}
}
