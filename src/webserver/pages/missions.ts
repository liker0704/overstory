import { homedir } from "node:os";
import { join } from "node:path";
import type { DashboardData } from "../../dashboard/data.ts";
import { loadDashboardData } from "../../dashboard/data.ts";
import { createMailStore } from "../../mail/store.ts";
import { createMissionStore } from "../../missions/store.ts";
import { MISSION_PHASES } from "../../missions/types.ts";
import { acquireStores, releaseStores } from "../connections.ts";
import { loadRegistry } from "../registry.ts";
import { html, layout, Raw } from "../templates/layout.ts";
import { emptyState, statusBadge, timeAgo } from "../templates/partials.ts";

function renderPhaseStepper(currentPhase: string): Raw {
	const currentIdx = MISSION_PHASES.indexOf(currentPhase as (typeof MISSION_PHASES)[number]);
	const steps = MISSION_PHASES.map((phase, i) => {
		let circleClass = "mission-stepper-circle";
		let label: string = phase;
		if (i < currentIdx) {
			circleClass += " mission-stepper-done";
			label = "✓";
		} else if (i === currentIdx) {
			circleClass += " mission-stepper-active";
		} else {
			circleClass += " mission-stepper-future";
		}
		const connectorClass =
			i < currentIdx
				? "mission-stepper-connector mission-stepper-connector-done"
				: "mission-stepper-connector";
		const connector = i < MISSION_PHASES.length - 1 ? `<div class="${connectorClass}"></div>` : "";
		return `<div class="mission-stepper-step">
			<div class="${circleClass}">${label}</div>
			<div class="mission-stepper-label">${phase}</div>
			${connector}
		</div>`;
	}).join("\n");

	const style = `<style>
.mission-stepper {
	display: flex;
	align-items: flex-start;
	justify-content: center;
	flex-wrap: wrap;
	gap: 0;
	padding: 1rem 0;
}
.mission-stepper-step {
	display: flex;
	flex-direction: column;
	align-items: center;
	position: relative;
}
.mission-stepper-circle {
	width: 2rem;
	height: 2rem;
	border-radius: 50%;
	display: flex;
	align-items: center;
	justify-content: center;
	font-size: 0.75rem;
	font-weight: 600;
	background: #374151;
	color: #9ca3af;
	border: 2px solid #4b5563;
	z-index: 1;
}
.mission-stepper-circle.mission-stepper-done {
	background: #16a34a;
	color: #fff;
	border-color: #22c55e;
}
.mission-stepper-circle.mission-stepper-active {
	background: #2563eb;
	color: #fff;
	border-color: #3b82f6;
	animation: mission-stepper-pulse 1.8s ease-in-out infinite;
}
.mission-stepper-circle.mission-stepper-future {
	background: #1f2937;
	color: #6b7280;
	border-color: #4b5563;
}
.mission-stepper-label {
	font-size: 0.65rem;
	color: #9ca3af;
	margin-top: 0.25rem;
	text-align: center;
	white-space: nowrap;
}
.mission-stepper-connector {
	position: absolute;
	top: 1rem;
	left: calc(50% + 1rem);
	width: calc(4rem - 1px);
	height: 2px;
	background: #4b5563;
	border-top: 2px dashed #4b5563;
}
.mission-stepper-connector.mission-stepper-connector-done {
	background: #22c55e;
	border-top: 2px solid #22c55e;
}
@keyframes mission-stepper-pulse {
	0%, 100% { box-shadow: 0 0 0 0 rgba(59,130,246,0.5); }
	50% { box-shadow: 0 0 0 6px rgba(59,130,246,0); }
}
@media (max-width: 600px) {
	.mission-stepper {
		flex-direction: column;
		align-items: flex-start;
		padding-left: 1rem;
	}
	.mission-stepper-step {
		flex-direction: row;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
	}
	.mission-stepper-connector {
		display: none;
	}
}
</style>`;

	return new Raw(`${style}<div class="mission-stepper">${steps}</div>`);
}

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

	const primaryPhase = missions[0]?.phase ?? "understand";
	const stepperHtml = renderPhaseStepper(primaryPhase);

	const ge = data.graphExecution;
	const lastTransRow = ge?.lastTransition
		? html`<div class="metrics-row">
		<div class="metric"><div class="metric-label">Last Transition</div><div class="metric-value">${ge.lastTransition.fromNode} → ${ge.lastTransition.toNode}</div></div>
		<div class="metric"><div class="metric-label">Trigger</div><div class="metric-value">${ge.lastTransition.trigger}</div></div>
		<div class="metric"><div class="metric-label">At</div><div class="metric-value">${timeAgo(ge.lastTransition.createdAt)}</div></div>
	</div>`
		: html``;
	const recentTransitions = ge?.recentTransitions ?? [];
	const historyRows = recentTransitions
		.map(
			(t) =>
				html`<div class="metrics-row" style="font-size:0.8em">
		<div class="metric"><div class="metric-label">${timeAgo(t.createdAt)}</div><div class="metric-value">${t.fromNode} → ${t.toNode} <em>${t.trigger}</em></div></div>
	</div>`,
		)
		.map((r) => r.value)
		.join("\n");
	const historySection =
		recentTransitions.length > 0
			? html`<div class="graph-transition-history">${new Raw(historyRows)}</div>`
			: html``;
	const graphSection = ge
		? html`<section class="graph-execution">
	<h2>Graph Execution</h2>
	<div class="metrics-row">
		<div class="metric"><div class="metric-label">Cell Type</div><div class="metric-value">${ge.cellType}</div></div>
		<div class="metric"><div class="metric-label">Current Node</div><div class="metric-value">${ge.currentNodeId}</div></div>
		<div class="metric"><div class="metric-label">Transitions</div><div class="metric-value">${String(ge.transitionCount)}</div></div>
	</div>
	${lastTransRow}
	${historySection}
</section>`
		: html``;

	return html`${stepperHtml}${graphSection}<table class="table">
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
		const body = layout("Not Found", html`<h1>Project not found</h1>`, {
			activeNav: "Missions",
			slug,
		});
		return new Response(body, { status: 404, headers: { "Content-Type": "text/html" } });
	}

	const projectPath = project.path;
	const missionStore = createMissionStore(join(projectPath, ".overstory", "sessions.db"));

	try {
		const missionId = params.id ?? "";
		const mission = missionStore.getById(missionId);

		if (!mission) {
			const body = layout("Not Found", html`<h1>Mission not found</h1>`, {
				activeNav: "Missions",
				slug,
			});
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
	${renderPhaseStepper(mission.phase ?? "understand")}
	${actionButtons}
	<div id="action-result"></div>
</div>
${frozenSection}
<div class="section-card">
	<h3>Roles</h3>
	${coordinatorBadge}${analystBadge}${execBadge}
</div>`;

		const body = layout(`Mission: ${mission.slug || mission.id}`, content, {
			activeNav: "Missions",
			slug,
		});
		return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
	} finally {
		missionStore.close();
	}
}
