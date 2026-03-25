import { OverstoryError } from "../errors.ts";
import { createRouter } from "./router.ts";
import type { ProjectRegistry, Route, WebConfig } from "./types.ts";

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
	const cacheHeaders = { "Cache-Control": "public, max-age=31536000" };

	const routes: Route[] = [
		{
			method: "GET",
			pattern: new URLPattern({ pathname: "/" }),
			handler: async () =>
				new Response("<html><body><h1>Overstory</h1></body></html>", {
					status: 200,
					headers: { "Content-Type": "text/html" },
				}),
		},
		{
			method: "GET",
			pattern: new URLPattern({ pathname: "/static/css" }),
			handler: async () =>
				new Response("", {
					status: 200,
					headers: { "Content-Type": "text/css", ...cacheHeaders },
				}),
		},
		{
			method: "GET",
			pattern: new URLPattern({ pathname: "/static/js" }),
			handler: async () =>
				new Response("", {
					status: 200,
					headers: { "Content-Type": "application/javascript", ...cacheHeaders },
				}),
		},
		{
			method: "GET",
			pattern: new URLPattern({ pathname: "/static/htmx" }),
			handler: async () =>
				new Response("", {
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
			pattern: new URLPattern({ pathname: "/project/:slug" }),
			handler: async (_req, params) => {
				const slug = params.slug ?? "";
				return new Response(`<html><body><h1>Project: ${slug}</h1></body></html>`, {
					status: 200,
					headers: { "Content-Type": "text/html" },
				});
			},
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
			handler: async () =>
				new Response(JSON.stringify({ status: "not implemented" }), {
					status: 202,
					headers: { "Content-Type": "application/json" },
				}),
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
