import { OverstoryError } from "../errors.ts";
import { missionAction, missionAnswer, missionStart } from "./actions.ts";
import { closeAllPools } from "./connections.ts";
import { handleAgentsPage } from "./pages/agents.ts";
import { handleEventsPage } from "./pages/events.ts";
import { handleHomePage } from "./pages/home.ts";
import { handleMailPage } from "./pages/mail.ts";
import { handleMergePage } from "./pages/merge.ts";
import { handleMissionsPage } from "./pages/missions.ts";
import { handleProjectPage } from "./pages/project.ts";
import { createRouter } from "./router.ts";
import { CSS } from "./static/css.ts";
import { HTMX_JS } from "./static/htmx.ts";
import { CLIENT_JS } from "./static/js.ts";
import type { ProjectEntry, ProjectRegistry, Route, WebConfig } from "./types.ts";

async function resolveProject(
	registryPath: string,
	slug: string,
): Promise<ProjectEntry | undefined> {
	const registry = await loadRegistry(registryPath);
	return registry.projects.find((p) => p.slug === slug);
}

function htmlPartial(html: string, status = 200): Response {
	return new Response(html, {
		status,
		headers: { "Content-Type": "text/html" },
	});
}

async function loadRegistry(registryPath: string): Promise<ProjectRegistry> {
	try {
		const file = Bun.file(registryPath);
		const exists = await file.exists();
		if (!exists) return { projects: [], discoveryPaths: [] };
		const text = await file.text();
		const parsed = JSON.parse(text) as unknown;
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			"projects" in parsed &&
			"discoveryPaths" in parsed
		) {
			return parsed as ProjectRegistry;
		}
	} catch {
		// file missing or invalid JSON
	}
	return { projects: [], discoveryPaths: [] };
}

export function createServer(
	config: WebConfig,
	registryPath: string,
): ReturnType<typeof Bun.serve> {
	const cleanup = () => {
		closeAllPools();
	};
	process.on("SIGTERM", cleanup);
	process.on("SIGINT", cleanup);

	const cacheHeaders = { "Cache-Control": "public, max-age=31536000" };

	const routes: Route[] = [
		{
			method: "GET",
			pattern: new URLPattern({ pathname: "/" }),
			handler: handleHomePage,
		},
		{
			method: "GET",
			pattern: new URLPattern({ pathname: "/static/css" }),
			handler: async () =>
				new Response(CSS, {
					status: 200,
					headers: { "Content-Type": "text/css", ...cacheHeaders },
				}),
		},
		{
			method: "GET",
			pattern: new URLPattern({ pathname: "/static/js" }),
			handler: async () =>
				new Response(CLIENT_JS, {
					status: 200,
					headers: { "Content-Type": "application/javascript", ...cacheHeaders },
				}),
		},
		{
			method: "GET",
			pattern: new URLPattern({ pathname: "/static/htmx" }),
			handler: async () =>
				new Response(HTMX_JS, {
					status: 200,
					headers: { "Content-Type": "application/javascript", ...cacheHeaders },
				}),
		},
		{
			method: "GET",
			pattern: new URLPattern({ pathname: "/project/:slug/sse" }),
			handler: async (req, params) => {
				const slug = params.slug ?? "";
				const encoder = new TextEncoder();
				const stream = new ReadableStream({
					start(controller) {
						controller.enqueue(
							encoder.encode(`event: connected\ndata: ${JSON.stringify({ slug })}\n\n`),
						);
						const interval = setInterval(() => {
							controller.enqueue(encoder.encode(":heartbeat\n\n"));
						}, 30_000);
						req.signal.addEventListener("abort", () => {
							clearInterval(interval);
							controller.close();
						});
					},
				});
				return new Response(stream, {
					status: 200,
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
						Connection: "keep-alive",
					},
				});
			},
		},
		{
			method: "GET",
			pattern: new URLPattern({ pathname: "/project/:slug/agents" }),
			handler: handleAgentsPage,
		},
		{
			method: "GET",
			pattern: new URLPattern({ pathname: "/project/:slug/missions" }),
			handler: handleMissionsPage,
		},
		{
			method: "GET",
			pattern: new URLPattern({ pathname: "/project/:slug/mail" }),
			handler: handleMailPage,
		},
		{
			method: "GET",
			pattern: new URLPattern({ pathname: "/project/:slug/merge" }),
			handler: handleMergePage,
		},
		{
			method: "GET",
			pattern: new URLPattern({ pathname: "/project/:slug/events" }),
			handler: handleEventsPage,
		},
		{
			method: "GET",
			pattern: new URLPattern({ pathname: "/project/:slug/mission/:id" }),
			handler: async (_req, params) => {
				const slug = params.slug ?? "";
				const id = params.id ?? "";
				return htmlPartial(
					`<div>Mission detail for ${id} in project ${slug} — not yet implemented</div>`,
				);
			},
		},
		{
			method: "GET",
			pattern: new URLPattern({ pathname: "/project/:slug" }),
			handler: handleProjectPage,
		},
		{
			method: "GET",
			pattern: new URLPattern({ pathname: "/api/v1/projects" }),
			handler: async () => {
				const registry = await loadRegistry(registryPath);
				return new Response(JSON.stringify(registry), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
		},
		{
			method: "GET",
			pattern: new URLPattern({ pathname: "/api/v1/project/:slug/state" }),
			handler: async (_req, params) => {
				const slug = params.slug ?? "";
				return new Response(JSON.stringify({ slug, status: "not implemented" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
		},
		{
			method: "POST",
			pattern: new URLPattern({ pathname: "/project/:slug/mission/start" }),
			handler: async (req, params) => {
				const slug = params.slug ?? "";
				const project = await resolveProject(registryPath, slug);
				if (!project) {
					return htmlPartial('<div class="alert alert-danger">Project not found</div>');
				}
				const formData = await req.formData();
				const objective = formData.get("objective");
				const result = await missionStart(project.path, {
					slug,
					objective: typeof objective === "string" ? objective : undefined,
				});
				if (result.success) {
					return htmlPartial(
						`<div class="alert alert-success">Mission started. <a href="/project/${slug}/missions">View missions</a></div>`,
					);
				}
				return htmlPartial(
					`<div class="alert alert-danger">Failed: <pre>${result.error ?? "unknown error"}</pre></div>`,
				);
			},
		},
		{
			method: "POST",
			pattern: new URLPattern({ pathname: "/project/:slug/mission/pause" }),
			handler: async (_req, params) => {
				const slug = params.slug ?? "";
				const project = await resolveProject(registryPath, slug);
				if (!project) {
					return htmlPartial('<div class="alert alert-danger">Project not found</div>');
				}
				const result = await missionAction(project.path, "pause");
				if (result.success) {
					return htmlPartial(
						`<div class="alert alert-success">Mission paused. <a href="/project/${slug}/missions">View missions</a></div>`,
					);
				}
				return htmlPartial(
					`<div class="alert alert-danger">Failed: <pre>${result.error ?? "unknown error"}</pre></div>`,
				);
			},
		},
		{
			method: "POST",
			pattern: new URLPattern({ pathname: "/project/:slug/mission/resume" }),
			handler: async (_req, params) => {
				const slug = params.slug ?? "";
				const project = await resolveProject(registryPath, slug);
				if (!project) {
					return htmlPartial('<div class="alert alert-danger">Project not found</div>');
				}
				const result = await missionAction(project.path, "resume");
				if (result.success) {
					return htmlPartial(
						`<div class="alert alert-success">Mission resumed. <a href="/project/${slug}/missions">View missions</a></div>`,
					);
				}
				return htmlPartial(
					`<div class="alert alert-danger">Failed: <pre>${result.error ?? "unknown error"}</pre></div>`,
				);
			},
		},
		{
			method: "POST",
			pattern: new URLPattern({ pathname: "/project/:slug/mission/stop" }),
			handler: async (_req, params) => {
				const slug = params.slug ?? "";
				const project = await resolveProject(registryPath, slug);
				if (!project) {
					return htmlPartial('<div class="alert alert-danger">Project not found</div>');
				}
				const result = await missionAction(project.path, "stop");
				if (result.success) {
					return htmlPartial(
						`<div class="alert alert-success">Mission stopped. <a href="/project/${slug}/missions">View missions</a></div>`,
					);
				}
				return htmlPartial(
					`<div class="alert alert-danger">Failed: <pre>${result.error ?? "unknown error"}</pre></div>`,
				);
			},
		},
		{
			method: "POST",
			pattern: new URLPattern({ pathname: "/project/:slug/mission/answer" }),
			handler: async (req, params) => {
				const slug = params.slug ?? "";
				const project = await resolveProject(registryPath, slug);
				if (!project) {
					return htmlPartial('<div class="alert alert-danger">Project not found</div>');
				}
				const formData = await req.formData();
				const text = formData.get("text");
				if (typeof text !== "string" || text.trim() === "") {
					return htmlPartial('<div class="alert alert-danger">Answer text is required</div>');
				}
				const result = await missionAnswer(project.path, text);
				if (result.success) {
					return htmlPartial(
						`<div class="alert alert-success">Answer submitted. <a href="/project/${slug}/missions">View missions</a></div>`,
					);
				}
				return htmlPartial(
					`<div class="alert alert-danger">Failed: <pre>${result.error ?? "unknown error"}</pre></div>`,
				);
			},
		},
	];

	const handler = createRouter(routes);

	try {
		return Bun.serve({
			hostname: config.host,
			port: config.port,
			fetch: handler,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes("EADDRINUSE")) {
			throw new OverstoryError(`Port ${config.port} is already in use`, "WEBSERVER_PORT_IN_USE", {
				cause: err instanceof Error ? err : new Error(message),
			});
		}
		throw err;
	}
}
