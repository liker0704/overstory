import type { DashboardData } from "../dashboard/data.ts";
import { EventBuffer, loadDashboardData } from "../dashboard/data.ts";
import { acquireStores, releaseStores } from "./connections.ts";

export interface SSEManagerConfig {
	pollIntervalMs: number;
	connectionTtlMs: number;
}

export interface PanelRenderers {
	agents: (data: DashboardData) => string;
	mail: (data: DashboardData) => string;
	merge: (data: DashboardData) => string;
	metrics: (data: DashboardData) => string;
	events: (data: DashboardData) => string;
	mission: (data: DashboardData) => string;
	headroom: (data: DashboardData) => string;
	resilience: (data: DashboardData) => string;
}

export const PANEL_NAMES = [
	"agents",
	"mail",
	"merge",
	"metrics",
	"events",
	"mission",
	"headroom",
	"resilience",
] as const;

export type PanelName = (typeof PANEL_NAMES)[number];

export interface SSEClient {
	id: string;
	slug: string;
	projectPath: string;
	controller: ReadableStreamDefaultController;
	encoder: TextEncoder;
	connectedAt: number;
}

interface ProjectPollState {
	slug: string;
	projectPath: string;
	clients: Map<string, SSEClient>;
	interval: ReturnType<typeof setInterval> | null;
	panelHashes: Map<string, string>;
	eventBuffer: EventBuffer;
	snapshotNeeded: Set<string>; // client ids that need full snapshot
}

export interface SSEManagerDeps {
	acquireStores: typeof acquireStores;
	releaseStores: typeof releaseStores;
	loadDashboardData: typeof loadDashboardData;
	hashFn: (html: string) => string;
	now: () => number;
}

let clientCounter = 0;

function defaultHashFn(html: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(html);
	return hasher.digest("hex");
}

function buildSseEvent(eventName: string, data: string): Uint8Array {
	const encoder = new TextEncoder();
	return encoder.encode(`event: ${eventName}\ndata: ${data}\n\n`);
}

function buildSseComment(comment: string): Uint8Array {
	const encoder = new TextEncoder();
	return encoder.encode(`:${comment}\n\n`);
}

function tryEnqueue(client: SSEClient, chunk: Uint8Array): boolean {
	try {
		client.controller.enqueue(chunk);
		return true;
	} catch {
		return false;
	}
}

export class SSEManager {
	private readonly config: SSEManagerConfig;
	private readonly renderers: PanelRenderers;
	private readonly deps: SSEManagerDeps;
	private readonly projects = new Map<string, ProjectPollState>();
	private readonly keepaliveTimers = new Map<string, ReturnType<typeof setInterval>>();
	private shutdown_ = false;

	constructor(config: SSEManagerConfig, renderers: PanelRenderers, deps?: Partial<SSEManagerDeps>) {
		this.config = config;
		this.renderers = renderers;
		this.deps = {
			acquireStores: deps?.acquireStores ?? acquireStores,
			releaseStores: deps?.releaseStores ?? releaseStores,
			loadDashboardData: deps?.loadDashboardData ?? loadDashboardData,
			hashFn: deps?.hashFn ?? defaultHashFn,
			now: deps?.now ?? (() => Date.now()),
		};
	}

	connect(req: Request, slug: string, projectPath: string): Response {
		clientCounter++;
		const clientId = `client-${clientCounter}`;

		let client: SSEClient;
		const stream = new ReadableStream({
			start: (controller) => {
				client = {
					id: clientId,
					slug,
					projectPath,
					controller,
					encoder: new TextEncoder(),
					connectedAt: this.deps.now(),
				};

				// Connected event
				controller.enqueue(buildSseEvent("connected", JSON.stringify({ slug, clientId })));

				this._addClient(client);

				// Keepalive every 15s
				const keepaliveInterval = setInterval(() => {
					if (!tryEnqueue(client, buildSseComment("keepalive"))) {
						clearInterval(keepaliveInterval);
						this.keepaliveTimers.delete(clientId);
					}
				}, 15_000);
				this.keepaliveTimers.set(clientId, keepaliveInterval);

				req.signal.addEventListener("abort", () => {
					clearInterval(keepaliveInterval);
					this.keepaliveTimers.delete(clientId);
					this._removeClient(slug, clientId);
					try {
						controller.close();
					} catch {
						// already closed
					}
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
	}

	async shutdown(): Promise<void> {
		this.shutdown_ = true;

		for (const timer of this.keepaliveTimers.values()) {
			clearInterval(timer);
		}
		this.keepaliveTimers.clear();

		for (const state of this.projects.values()) {
			if (state.interval !== null) {
				clearInterval(state.interval);
				state.interval = null;
			}
			for (const client of state.clients.values()) {
				try {
					client.controller.close();
				} catch {
					// already closed
				}
			}
			state.clients.clear();
		}
		this.projects.clear();
	}

	getClientCount(): number {
		let count = 0;
		for (const state of this.projects.values()) {
			count += state.clients.size;
		}
		return count;
	}

	getProjectCount(): number {
		return this.projects.size;
	}

	private _addClient(client: SSEClient): void {
		const { slug, projectPath } = client;
		let state = this.projects.get(slug);

		if (state === undefined) {
			state = {
				slug,
				projectPath,
				clients: new Map(),
				interval: null,
				panelHashes: new Map(),
				eventBuffer: new EventBuffer(),
				snapshotNeeded: new Set(),
			};
			this.projects.set(slug, state);
		}

		state.clients.set(client.id, client);
		state.snapshotNeeded.add(client.id);

		if (state.interval === null) {
			state.interval = setInterval(() => {
				this._pollTick(slug).catch(() => {
					// errors are handled inside _pollTick
				});
			}, this.config.pollIntervalMs);
		}
	}

	private _removeClient(slug: string, clientId: string): void {
		const state = this.projects.get(slug);
		if (state === undefined) return;

		state.clients.delete(clientId);
		state.snapshotNeeded.delete(clientId);

		if (state.clients.size === 0) {
			if (state.interval !== null) {
				clearInterval(state.interval);
				state.interval = null;
			}
			this.projects.delete(slug);
			this.deps.releaseStores(state.projectPath, this.config.connectionTtlMs);
		}
	}

	private async _pollTick(slug: string): Promise<void> {
		if (this.shutdown_) return;

		const state = this.projects.get(slug);
		if (state === undefined || state.clients.size === 0) return;

		let stores: Awaited<ReturnType<typeof acquireStores>>;
		try {
			stores = await this.deps.acquireStores(state.projectPath);
		} catch {
			return;
		}

		let data: DashboardData;
		try {
			data = await this.deps.loadDashboardData(
				state.projectPath,
				stores,
				null,
				undefined,
				state.eventBuffer,
			);
		} catch {
			this.deps.releaseStores(state.projectPath);
			return;
		}

		this.deps.releaseStores(state.projectPath);

		// Render all panels
		const rendered: Record<PanelName, string> = {
			agents: this.renderers.agents(data),
			mail: this.renderers.mail(data),
			merge: this.renderers.merge(data),
			metrics: this.renderers.metrics(data),
			events: this.renderers.events(data),
			mission: this.renderers.mission(data),
			headroom: this.renderers.headroom(data),
			resilience: this.renderers.resilience(data),
		};

		// Hash panels and determine changed ones
		const changedPanels: PanelName[] = [];
		for (const panel of PANEL_NAMES) {
			const html = rendered[panel];
			const hash = this.deps.hashFn(html);
			const prev = state.panelHashes.get(panel);
			if (prev !== hash) {
				state.panelHashes.set(panel, hash);
				changedPanels.push(panel);
			}
		}

		// Dispatch to each client
		const deadClients: string[] = [];
		for (const client of state.clients.values()) {
			const isFirstSnapshot = state.snapshotNeeded.has(client.id);
			const panelsToSend = isFirstSnapshot ? PANEL_NAMES : changedPanels;

			for (const panel of panelsToSend) {
				const html = rendered[panel];
				const ok = tryEnqueue(client, buildSseEvent(panel, html));
				if (!ok) {
					deadClients.push(client.id);
					break;
				}
			}

			if (isFirstSnapshot) {
				state.snapshotNeeded.delete(client.id);
			}
		}

		for (const id of deadClients) {
			this._removeClient(slug, id);
		}
	}
}
