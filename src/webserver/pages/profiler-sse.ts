/**
 * Dedicated SSE endpoint for the profiler page.
 *
 * Does NOT use the shared SSEManager — profiler has its own lightweight
 * polling loop that only runs when the profiler page is open.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { buildProfilerTrace } from "../../profiler/build.ts";
import { acquireStores, releaseStores } from "../connections.ts";
import { loadRegistry } from "../registry.ts";
import { renderWaterfall } from "./profiler-waterfall.ts";

const POLL_INTERVAL_MS = 10_000;
const KEEPALIVE_INTERVAL_MS = 15_000;

export async function handleProfilerSSE(
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

	const url = new URL(req.url);
	const runId = url.searchParams.get("run") ?? "";
	if (!runId) {
		return new Response("Missing run parameter", { status: 400 });
	}

	const projectPath = project.path;
	let lastHash = "";
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
	let closed = false;

	let cleanup: (() => void) | null = null;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			function send(event: string, data: string): void {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
				} catch {
					doCleanup();
				}
			}

			function sendKeepalive(): void {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(": keepalive\n\n"));
				} catch {
					doCleanup();
				}
			}

			async function poll(): Promise<void> {
				if (closed) return;
				let stores: Awaited<ReturnType<typeof acquireStores>> | null = null;
				try {
					stores = await acquireStores(projectPath);
					if (!stores.eventStore) return;
					const trace = buildProfilerTrace({
						eventStore: stores.eventStore,
						sessionStore: stores.sessionStore,
						metricsStore: stores.metricsStore,
						runId,
					});

					const waterfallHtml = trace ? renderWaterfall(trace, slug) : "";
					const hash = simpleHash(waterfallHtml);
					if (hash !== lastHash) {
						lastHash = hash;
						// Encode multi-line data per SSE spec: each line must have data: prefix
						const encoded = waterfallHtml
							.split("\n")
							.filter((line) => line !== "")
							.join("\ndata: ");
						send("waterfall", encoded);
					}
				} catch {
					// Swallow poll errors — SSE should be resilient
				} finally {
					if (stores) releaseStores(projectPath);
				}
			}

			function doCleanup(): void {
				if (closed) return;
				closed = true;
				if (pollTimer) clearInterval(pollTimer);
				if (keepaliveTimer) clearInterval(keepaliveTimer);
				try {
					controller.close();
				} catch {
					// already closed
				}
			}

			cleanup = doCleanup;

			// Initial poll
			poll();

			pollTimer = setInterval(poll, POLL_INTERVAL_MS);
			keepaliveTimer = setInterval(sendKeepalive, KEEPALIVE_INTERVAL_MS);

			// Clean up on abort
			req.signal.addEventListener("abort", doCleanup);
		},
		cancel() {
			cleanup?.();
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
}

function simpleHash(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		hash = ((hash << 5) - hash + ch) | 0;
	}
	return String(hash);
}
