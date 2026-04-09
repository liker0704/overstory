/**
 * Profiler page handler and span detail endpoint.
 *
 * Routes:
 * - GET /project/:slug/profiler — full page (default: current run)
 * - GET /project/:slug/profiler/span/:spanId?run=<runId> — span detail partial
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { buildProfilerTrace, listAvailableRuns } from "../../profiler/build.ts";
import { createRunStore } from "../../sessions/store.ts";
import type { RunStore } from "../../sessions/types.ts";
import { acquireStores, releaseStores } from "../connections.ts";
import { loadRegistry } from "../registry.ts";
import { html, layout } from "../templates/layout.ts";
import { emptyState } from "../templates/partials.ts";
import { renderProfilerPage, renderSpanDetail } from "./profiler-waterfall.ts";

export async function handleProfilerPage(
	req: Request,
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
		const overstoryDir = join(projectPath, ".overstory");
		const runStore = createRunStore(join(overstoryDir, "sessions.db"));

		try {
			// Resolve run ID: query param > current-run.txt > most recent
			const url = new URL(req.url);
			const runId = await resolveRunId(url, overstoryDir, runStore);

			const runs = listAvailableRuns(runStore);

			let trace = null;
			if (runId && stores.eventStore) {
				trace = buildProfilerTrace({
					eventStore: stores.eventStore,
					sessionStore: stores.sessionStore,
					metricsStore: stores.metricsStore,
					runId,
				});
			}

			const content = renderProfilerPage(trace, runs, runId ?? "", slug);
			const body = layout("Profiler", content, { activeNav: "Profiler", slug });
			return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
		} finally {
			runStore.close();
		}
	} finally {
		releaseStores(projectPath);
	}
}

export async function handleSpanDetail(
	req: Request,
	params: Record<string, string>,
): Promise<Response> {
	const registryPath = join(homedir(), ".overstory", "projects.json");
	const registry = await loadRegistry(registryPath);
	const slug = params.slug ?? "";
	const project = registry.projects.find((p) => p.slug === slug);

	if (!project) {
		return new Response("Project not found", { status: 404 });
	}

	const projectPath = project.path;
	const stores = await acquireStores(projectPath);

	try {
		const url = new URL(req.url);
		const runId = url.searchParams.get("run") ?? "";
		const spanId = params.spanId ?? "";

		if (!runId || !spanId || !stores.eventStore) {
			return htmlResponse(emptyState("Missing run or span ID.").value);
		}

		const trace = buildProfilerTrace({
			eventStore: stores.eventStore,
			sessionStore: stores.sessionStore,
			metricsStore: stores.metricsStore,
			runId,
		});

		if (!trace) {
			return htmlResponse(emptyState("Trace not found.").value);
		}

		const span = trace.flatSpans.find((s) => s.spanId === spanId);
		if (!span) {
			return htmlResponse(emptyState("Span not found.").value);
		}

		return htmlResponse(renderSpanDetail(span));
	} finally {
		releaseStores(projectPath);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveRunId(
	url: URL,
	overstoryDir: string,
	runStore: RunStore,
): Promise<string | null> {
	// 1. Explicit query param
	const fromParam = url.searchParams.get("run");
	if (fromParam) return fromParam;

	// 2. current-run.txt
	const currentRunPath = join(overstoryDir, "current-run.txt");
	const file = Bun.file(currentRunPath);
	if (await file.exists()) {
		const text = await file.text();
		const trimmed = text.trim();
		if (trimmed) return trimmed;
	}

	// 3. Most recent run
	const runs = runStore.listRuns({ limit: 1 });
	const first = runs[0];
	return first?.id ?? null;
}

function htmlResponse(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: { "Content-Type": "text/html" },
	});
}
