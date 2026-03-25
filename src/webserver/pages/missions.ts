import { homedir } from "node:os";
import { join } from "node:path";
import type { DashboardData } from "../../dashboard/data.ts";
import { loadDashboardData } from "../../dashboard/data.ts";
import { createMailStore } from "../../mail/store.ts";
import { createMissionStore } from "../../missions/store.ts";
import { acquireStores, releaseStores } from "../connections.ts";
import { loadRegistry } from "../registry.ts";
import { html, layout, Raw } from "../templates/layout.ts";
import { emptyState, statusBadge, timeAgo } from "../templates/partials.ts";

export function renderMissionPanel(data: DashboardData): string {
	const missions = data.missions;

	if (missions.length === 0) {
		return emptyState("No missions found.").value;
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

	return html`${graphSection}<table class="table">
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
</table>`.value;
}

export async function handleMissionsPage(
	_req: Request,
	params: Record<string, string>,
): Promise<Response> {
	const registryPath = join(homedir(), ".overstory", "projects.json");
	const registry = await loadRegistry(registryPath);
	const slug = params.slug ?? "";
	const project = registry.projects.find((p) => p.slug === slug);

	if (!project) {
		const body = layout("Not Found", html`<h1>Project not found</h1>`);
		return new Response(body, { status: 404, headers: { "Content-Type": "text/html" } });
	}

	const projectPath = project.path;
	const stores = await acquireStores(projectPath);

	try {
		const data = await loadDashboardData(projectPath, stores);

		const panelHtml = renderMissionPanel(data);
		const content = html`<div class="section-card">
	<h2>Start New Mission</h2>
	<form hx-post="/project/${slug}/mission/start" hx-target="#mission-result" hx-swap="innerHTML" hx-indicator="#mission-spinner">
		<div class="form-group">
			<label for="mission-slug">Slug (optional)</label>
			<input type="text" name="slug" id="mission-slug" placeholder="auth-rewrite" pattern="[a-z0-9-]+" />
		</div>
		<div class="form-group">
			<label for="objective">Objective</label>
			<textarea name="objective" id="objective" rows="4" placeholder="What to accomplish..."></textarea>
		</div>
		<button type="submit" class="btn btn-primary">Start Mission</button>
		<span id="mission-spinner" class="htmx-indicator">Starting...</span>
		<div id="mission-result"></div>
	</form>
</div>
<div id="sse-mission" sse-swap="mission">${new Raw(panelHtml)}</div>`;

		const body = layout("Missions", content, { activeNav: "Missions", slug });
		return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
	} finally {
		releaseStores(projectPath);
	}
}

export async function handleMissionDetailPage(
	_req: Request,
	params: Record<string, string>,
): Promise<Response> {
	const registryPath = join(homedir(), ".overstory", "projects.json");
	const registry = await loadRegistry(registryPath);
	const slug = params.slug ?? "";
	const project = registry.projects.find((p) => p.slug === slug);

	if (!project) {
		const body = layout("Not Found", html`<h1>Project not found</h1>`, { activeNav: "Missions", slug });
		return new Response(body, { status: 404, headers: { "Content-Type": "text/html" } });
	}

	const projectPath = project.path;
	const missionStore = createMissionStore(join(projectPath, ".overstory", "sessions.db"));

	try {
		const missionId = params.id ?? "";
		const mission = missionStore.getById(missionId);

		if (!mission) {
			const body = layout("Not Found", html`<h1>Mission not found</h1>`, { activeNav: "Missions", slug });
			return new Response(body, { status: 404, headers: { "Content-Type": "text/html" } });
		}

		// Action buttons based on state
		let actionButtons = html``;
		if (mission.state === "active") {
			actionButtons = html`<form hx-post="/project/${slug}/mission/pause" hx-target="#action-result" hx-swap="innerHTML" style="display:inline">
	<input type="hidden" name="id" value="${mission.id}" />
	<button type="submit" class="btn btn-warning" hx-confirm="Pause this mission?">Pause</button>
</form>
<form hx-post="/project/${slug}/mission/stop" hx-target="#action-result" hx-swap="innerHTML" style="display:inline">
	<input type="hidden" name="id" value="${mission.id}" />
	<button type="submit" class="btn btn-danger" hx-confirm="Stop this mission?">Stop</button>
</form>`;
		} else if (mission.state === "suspended") {
			actionButtons = html`<form hx-post="/project/${slug}/mission/resume" hx-target="#action-result" hx-swap="innerHTML" style="display:inline">
	<input type="hidden" name="id" value="${mission.id}" />
	<button type="submit" class="btn btn-primary">Resume</button>
</form>
<form hx-post="/project/${slug}/mission/stop" hx-target="#action-result" hx-swap="innerHTML" style="display:inline">
	<input type="hidden" name="id" value="${mission.id}" />
	<button type="submit" class="btn btn-danger" hx-confirm="Stop this mission?">Stop</button>
</form>`;
		} else if (mission.state === "frozen") {
			actionButtons = html`<form hx-post="/project/${slug}/mission/stop" hx-target="#action-result" hx-swap="innerHTML" style="display:inline">
	<input type="hidden" name="id" value="${mission.id}" />
	<button type="submit" class="btn btn-danger" hx-confirm="Stop this mission?">Stop</button>
</form>`;
		}

		// Frozen: pending input section
		let frozenSection = html``;
		if (mission.state === "frozen") {
			const mailStore = createMailStore(join(projectPath, ".overstory", "mail.db"));
			try {
				const messages = mailStore.getAll({ to: "operator", limit: 10 });
				const questionMsg = messages.find((m) => m.type === "question");
				const questionHtml = questionMsg
					? html`<h3>Pending Question</h3><p><strong>${questionMsg.subject}</strong></p><p>${questionMsg.body}</p>`
					: html``;
				frozenSection = html`<div class="section-card">
	${questionHtml}
	<form hx-post="/project/${slug}/mission/answer" hx-target="#answer-result" hx-swap="innerHTML">
		<input type="hidden" name="id" value="${mission.id}" />
		<div class="form-group">
			<textarea name="text" rows="6" required placeholder="Your answer..."></textarea>
		</div>
		<button type="submit" class="btn btn-primary">Send Answer</button>
	</form>
	<div id="answer-result"></div>
</div>`;
			} finally {
				mailStore.close();
			}
		}

		// Roles section
		const coordinatorBadge = mission.coordinatorSessionId
			? html`<span class="badge badge-active">coordinator</span>`
			: html`<span class="badge badge-missing">coordinator</span>`;
		const analystBadge = mission.analystSessionId
			? html`<span class="badge badge-active">analyst</span>`
			: html`<span class="badge badge-missing">analyst</span>`;
		const execBadge = mission.executionDirectorSessionId
			? html`<span class="badge badge-active">exec-director</span>`
			: html`<span class="badge badge-missing">exec-director</span>`;

		const content = html`<div class="section-card">
	<dl>
		<dt>ID</dt><dd>${mission.id}</dd>
		<dt>Slug</dt><dd>${mission.slug}</dd>
		<dt>State</dt><dd>${statusBadge(mission.state)}</dd>
		<dt>Phase</dt><dd>${mission.phase}</dd>
		<dt>Objective</dt><dd>${mission.objective}</dd>
		<dt>Created</dt><dd>${timeAgo(mission.createdAt)}</dd>
		<dt>Completed</dt><dd>${mission.completedAt ? timeAgo(mission.completedAt) : new Raw("—")}</dd>
	</dl>
	${actionButtons}
	<div id="action-result"></div>
</div>
${frozenSection}
<div class="section-card">
	<h3>Roles</h3>
	${coordinatorBadge}${analystBadge}${execBadge}
</div>`;

		const body = layout(`Mission: ${mission.slug || mission.id}`, content, { activeNav: "Missions", slug });
		return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
	} finally {
		missionStore.close();
	}
}
