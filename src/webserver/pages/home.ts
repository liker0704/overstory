import { homedir } from "node:os";
import { join } from "node:path";
import { loadRegistry } from "../registry.ts";
import { html, layout, Raw } from "../templates/layout.ts";
import { emptyState, timeAgo } from "../templates/partials.ts";

const REGISTRY_PATH = join(homedir(), ".overstory", "projects.json");

export async function handleHomePage(
	_req: Request,
	_params: Record<string, string>,
): Promise<Response> {
	const registry = await loadRegistry(REGISTRY_PATH);
	const { projects } = registry;

	let content: Raw;
	if (projects.length === 0) {
		content = emptyState("No projects registered. Run ov webserver discover to find projects.");
	} else {
		const cards = new Raw(
			projects
				.map(
					(p) =>
						html`<div class="project-card">
	<h2><a href="/project/${p.slug}">${p.name}</a></h2>
	<dl>
		<dt>Slug</dt><dd>${p.slug}</dd>
		<dt>Path</dt><dd>${p.path}</dd>
		<dt>Last seen</dt><dd>${timeAgo(p.lastSeenAt)}</dd>
	</dl>
</div>`.value,
				)
				.join("\n"),
		);
		content = html`<div class="project-list">${cards}</div>`;
	}

	const htmlString = layout("Overstory — Projects", content);
	return new Response(htmlString, {
		status: 200,
		headers: { "Content-Type": "text/html" },
	});
}
