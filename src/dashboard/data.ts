/**
 * Dashboard data loading, caching, and store management.
 *
 * Extracted from src/commands/dashboard.ts to keep the command file
 * focused on CLI wiring and the poll loop.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { getCachedTmuxSessions, getCachedWorktrees, type StatusData } from "../commands/status.ts";
import { createEventStore } from "../events/store.ts";
import { createHeadroomStore } from "../headroom/store.ts";
import type { HeadroomSnapshot, HeadroomStore } from "../headroom/types.ts";
import { extendAgentColorMap } from "../logging/format.ts";
import { createMailStore, type MailStore } from "../mail/store.ts";
import { createMergeQueue, type MergeQueue } from "../merge/queue.ts";
import { createMetricsStore, type MetricsStore } from "../metrics/store.ts";
import { type MissionRoleStates, resolveMissionRoleStates } from "../missions/runtime-context.ts";
import { createMissionStore } from "../missions/store.ts";
import { createResilienceStore } from "../resilience/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { SessionStore } from "../sessions/store.ts";
import { createTrackerClient, resolveBackend } from "../tracker/factory.ts";
import type { TrackerIssue } from "../tracker/types.ts";
import type {
	AgentSession,
	EventStore,
	MailMessage,
	Mission,
	OverstoryConfig,
	StoredEvent,
} from "../types.ts";
import { evaluateHealth } from "../watchdog/health.ts";

/**
 * Pre-opened database handles for the dashboard poll loop.
 * Stores are opened once and reused across ticks to avoid
 * repeated open/close/PRAGMA/WAL checkpoint overhead.
 */
export interface DashboardStores {
	sessionStore: SessionStore;
	mailStore: MailStore | null;
	mergeQueue: MergeQueue | null;
	metricsStore: MetricsStore | null;
	eventStore: EventStore | null;
	headroomStore?: HeadroomStore | null;
}

/**
 * Open all database connections needed by the dashboard.
 * Returns null handles for databases that do not exist on disk.
 */
export function openDashboardStores(root: string): DashboardStores {
	const overstoryDir = join(root, ".overstory");
	const { store: sessionStore } = openSessionStore(overstoryDir);

	let mailStore: MailStore | null = null;
	try {
		const mailDbPath = join(overstoryDir, "mail.db");
		if (existsSync(mailDbPath)) {
			mailStore = createMailStore(mailDbPath);
		}
	} catch {
		// mail db might not be openable
	}

	let mergeQueue: MergeQueue | null = null;
	try {
		const queuePath = join(overstoryDir, "merge-queue.db");
		if (existsSync(queuePath)) {
			mergeQueue = createMergeQueue(queuePath);
		}
	} catch {
		// queue db might not be openable
	}

	let metricsStore: MetricsStore | null = null;
	try {
		const metricsDbPath = join(overstoryDir, "metrics.db");
		if (existsSync(metricsDbPath)) {
			metricsStore = createMetricsStore(metricsDbPath);
		}
	} catch {
		// metrics db might not be openable
	}

	let eventStore: EventStore | null = null;
	try {
		const eventsDbPath = join(overstoryDir, "events.db");
		if (existsSync(eventsDbPath)) {
			eventStore = createEventStore(eventsDbPath);
		}
	} catch {
		// events db might not be openable
	}

	let headroomStore: HeadroomStore | null = null;
	try {
		const headroomDbPath = join(overstoryDir, "headroom.db");
		if (existsSync(headroomDbPath)) {
			headroomStore = createHeadroomStore(headroomDbPath);
		}
	} catch {
		// headroom db might not be openable
	}

	return { sessionStore, mailStore, mergeQueue, metricsStore, eventStore, headroomStore };
}

/**
 * Close all dashboard database connections.
 */
export function closeDashboardStores(stores: DashboardStores): void {
	try {
		stores.sessionStore.close();
	} catch {
		/* best effort */
	}
	try {
		stores.mailStore?.close();
	} catch {
		/* best effort */
	}
	try {
		stores.mergeQueue?.close();
	} catch {
		/* best effort */
	}
	try {
		stores.metricsStore?.close();
	} catch {
		/* best effort */
	}
	try {
		stores.eventStore?.close();
	} catch {
		/* best effort */
	}
	try {
		stores.headroomStore?.close();
	} catch {
		/* best effort */
	}
}

/**
 * Rolling event buffer with incremental dedup by lastSeenId.
 * Maintains a fixed-size window of the most recent events.
 */
export class EventBuffer {
	private events: StoredEvent[] = [];
	private lastSeenId = 0;
	private colorMap: Map<string, (s: string) => string> = new Map();
	private readonly maxSize: number;

	constructor(maxSize = 100) {
		this.maxSize = maxSize;
	}

	poll(eventStore: EventStore): void {
		const since = new Date(Date.now() - 60 * 1000).toISOString();
		const allEvents = eventStore.getTimeline({ since, limit: 1000 });
		const newEvents = allEvents.filter((e) => e.id > this.lastSeenId);

		if (newEvents.length === 0) return;

		extendAgentColorMap(this.colorMap, newEvents);
		this.events = [...this.events, ...newEvents].slice(-this.maxSize);

		const lastEvent = newEvents[newEvents.length - 1];
		if (lastEvent) {
			this.lastSeenId = lastEvent.id;
		}
	}

	getEvents(): StoredEvent[] {
		return this.events;
	}

	getColorMap(): Map<string, (s: string) => string> {
		return this.colorMap;
	}

	get size(): number {
		return this.events.length;
	}
}

/** Tracker data cached between dashboard ticks (10s TTL). */
interface TrackerCache {
	tasks: TrackerIssue[];
	fetchedAt: number; // Date.now() ms
}

/** Module-level tracker cache (persists across poll ticks). */
let trackerCache: TrackerCache | null = null;
const TRACKER_CACHE_TTL_MS = 10_000; // 10 seconds

/** Session data cached between ticks -- stale-on-error fallback. */
interface SessionDataCache {
	sessions: AgentSession[];
}

/** Module-level session cache (persists across poll ticks, used as fallback on SQLite errors). */
let sessionDataCache: SessionDataCache | null = null;

/**
 * All data needed to render one dashboard frame.
 */
export interface DashboardData {
	currentRunId?: string | null;
	status: StatusData;
	recentMail: MailMessage[];
	mergeQueue: Array<{ branchName: string; agentName: string; status: string }>;
	metrics: {
		totalSessions: number;
		avgDuration: number;
		byCapability: Record<string, number>;
	};
	tasks: TrackerIssue[];
	recentEvents: StoredEvent[];
	feedColorMap: Map<string, (s: string) => string>;
	/** Runtime config for resolving per-capability runtime names in the agent panel. */
	runtimeConfig?: OverstoryConfig["runtime"];
	mission?: Mission | null;
	resilience?: {
		openBreakers: Array<{ capability: string; failureCount: number }>;
		activeRetryCount: number;
	};
	headroom?: HeadroomSnapshot[];
}

/**
 * Filter agents by run ID. When run-scoped, also includes sessions with null
 * runId (e.g. coordinator) because SQL WHERE run_id = ? never matches NULL.
 */
export function filterAgentsByRun<T extends { runId: string | null }>(
	agents: T[],
	runId: string | null | undefined,
): T[] {
	if (!runId) return agents;
	return agents.filter((a) => a.runId === runId || a.runId === null);
}

/**
 * Read the current run ID from current-run.txt, or null if no active run.
 */
export async function readCurrentRunId(overstoryDir: string): Promise<string | null> {
	const path = join(overstoryDir, "current-run.txt");
	const file = Bun.file(path);
	if (!(await file.exists())) {
		return null;
	}
	const text = await file.text();
	const trimmed = text.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Load all data sources for the dashboard using pre-opened store handles.
 * When runId is provided, all panels are scoped to agents in that run.
 * No stores are opened or closed here -- that is the caller's responsibility.
 */
export async function loadDashboardData(
	root: string,
	stores: DashboardStores,
	runId?: string | null,
	thresholds?: { staleMs: number; zombieMs: number },
	eventBuffer?: EventBuffer,
	runtimeConfig?: OverstoryConfig["runtime"],
): Promise<DashboardData> {
	// Get all sessions from the pre-opened session store -- fall back to cache on SQLite errors.
	let allSessions: AgentSession[];
	try {
		allSessions = stores.sessionStore.getAll();
		sessionDataCache = { sessions: allSessions };
	} catch {
		// SQLite lock contention or I/O error -- use last known sessions
		allSessions = sessionDataCache?.sessions ?? [];
	}

	// Get worktrees and tmux sessions via cached subprocess helpers
	const worktrees = await getCachedWorktrees(root);
	const tmuxSessions = await getCachedTmuxSessions();

	// Evaluate health for active agents using the same logic as the watchdog.
	const tmuxSessionNames = new Set(tmuxSessions.map((s) => s.name));
	const healthThresholds = thresholds ?? { staleMs: 300_000, zombieMs: 600_000 };
	try {
		for (const session of allSessions) {
			if (session.state === "completed") continue;
			const tmuxAlive = tmuxSessionNames.has(session.tmuxSession);
			const rateLimitState =
				session.rateLimitedSince !== null
					? {
							limited: true as const,
							resumesAt: null,
							message: "Stored rate limit state",
						}
					: undefined;
			const check = evaluateHealth(session, tmuxAlive, healthThresholds, rateLimitState);
			if (check.state !== session.state) {
				try {
					stores.sessionStore.updateState(session.agentName, check.state);
					session.state = check.state;
				} catch {
					// Best effort: don't fail dashboard if update fails
				}
			}
		}
	} catch {
		// Best effort: evaluateHealth loop should not crash the dashboard
	}

	// If run-scoped, filter agents to only those belonging to the current run.
	const filteredAgents = filterAgentsByRun(allSessions, runId);

	// Count unread mail
	let unreadMailCount = 0;
	if (stores.mailStore) {
		try {
			const unread = stores.mailStore.getAll({ to: "orchestrator", unread: true });
			unreadMailCount = unread.length;
		} catch {
			// best effort
		}
	}

	// Count merge queue pending entries
	let mergeQueueCount = 0;
	if (stores.mergeQueue) {
		try {
			mergeQueueCount = stores.mergeQueue.list("pending").length;
		} catch {
			// best effort
		}
	}

	// Count recent metrics sessions
	let recentMetricsCount = 0;
	if (stores.metricsStore) {
		try {
			recentMetricsCount = stores.metricsStore.countSessions();
		} catch {
			// best effort
		}
	}

	const status: StatusData = {
		currentRunId: runId,
		agents: filteredAgents,
		worktrees,
		tmuxSessions,
		unreadMailCount,
		mergeQueueCount,
		recentMetricsCount,
	};

	// Load recent mail from pre-opened mail store
	let recentMail: MailMessage[] = [];
	if (stores.mailStore) {
		try {
			if (runId && filteredAgents.length > 0) {
				const agentNames = new Set(filteredAgents.map((a) => a.agentName));
				const allMail = stores.mailStore.getAll({ limit: 50 });
				recentMail = allMail
					.filter((m) => agentNames.has(m.from) || agentNames.has(m.to))
					.slice(0, 5);
			} else {
				recentMail = stores.mailStore.getAll({ limit: 5 });
			}
		} catch {
			// best effort
		}
	}

	// Load merge queue entries from pre-opened merge queue
	let mergeQueueEntries: Array<{ branchName: string; agentName: string; status: string }> = [];
	if (stores.mergeQueue) {
		try {
			let entries = stores.mergeQueue.list();
			if (runId && filteredAgents.length > 0) {
				const agentNames = new Set(filteredAgents.map((a) => a.agentName));
				entries = entries.filter((e) => agentNames.has(e.agentName));
			}
			mergeQueueEntries = entries.map((e) => ({
				branchName: e.branchName,
				agentName: e.agentName,
				status: e.status,
			}));
		} catch {
			// best effort
		}
	}

	// Load metrics from pre-opened metrics store
	let totalSessions = 0;
	let avgDuration = 0;
	const byCapability: Record<string, number> = {};
	if (stores.metricsStore) {
		try {
			if (runId && filteredAgents.length > 0) {
				const agentNames = new Set(filteredAgents.map((a) => a.agentName));
				const sessions = stores.metricsStore.getRecentSessions(100);
				const filtered = sessions.filter((s) => agentNames.has(s.agentName));

				totalSessions = filtered.length;

				const completedSessions = filtered.filter((s) => s.completedAt !== null);
				if (completedSessions.length > 0) {
					avgDuration =
						completedSessions.reduce((sum, s) => sum + s.durationMs, 0) / completedSessions.length;
				}

				for (const session of filtered) {
					const cap = session.capability;
					byCapability[cap] = (byCapability[cap] ?? 0) + 1;
				}
			} else {
				totalSessions = stores.metricsStore.countSessions();
				avgDuration = stores.metricsStore.getAverageDuration();

				const sessions = stores.metricsStore.getRecentSessions(100);
				for (const session of sessions) {
					const cap = session.capability;
					byCapability[cap] = (byCapability[cap] ?? 0) + 1;
				}
			}
		} catch {
			// best effort
		}
	}

	// Load tasks from tracker with cache
	let tasks: TrackerIssue[] = [];
	const now2 = Date.now();
	if (!trackerCache || now2 - trackerCache.fetchedAt > TRACKER_CACHE_TTL_MS) {
		try {
			const backend = await resolveBackend("auto", root);
			const tracker = createTrackerClient(backend, root);
			tasks = await tracker.list({ limit: 10 });
			trackerCache = { tasks, fetchedAt: now2 };
		} catch {
			// tracker unavailable -- graceful degradation
			tasks = trackerCache?.tasks ?? [];
		}
	} else {
		tasks = trackerCache.tasks;
	}

	// Load recent events via incremental buffer (or fallback to empty)
	let recentEvents: StoredEvent[] = [];
	let feedColorMap: Map<string, (s: string) => string> = new Map();
	if (eventBuffer && stores.eventStore) {
		try {
			eventBuffer.poll(stores.eventStore);
			recentEvents = [...eventBuffer.getEvents()].reverse();
			feedColorMap = eventBuffer.getColorMap();
		} catch {
			/* best effort */
		}
	}

	// Load active mission inline (fast, open/close per tick)
	let mission: Mission | null = null;
	let missionRoles: MissionRoleStates | null = null;
	try {
		const sessionsDbPath = join(root, ".overstory", "sessions.db");
		if (existsSync(sessionsDbPath)) {
			const missionStore = createMissionStore(sessionsDbPath);
			try {
				mission = missionStore.getActive();
				if (mission) {
					missionRoles = resolveMissionRoleStates(mission, allSessions);
				}
			} finally {
				missionStore.close();
			}
		}
	} catch {
		// mission store unavailable
	}

	status.mission = mission;
	status.missionRoles = missionRoles;

	let resilience: DashboardData["resilience"];
	try {
		const resilienceDbPath = join(root, ".overstory", "resilience.db");
		if (existsSync(resilienceDbPath)) {
			const resilienceStore = createResilienceStore(resilienceDbPath);
			try {
				const openBreakers = resilienceStore.listOpenBreakers().map((b) => ({
					capability: b.capability,
					failureCount: b.failureCount,
				}));
				const retries = resilienceStore.getPendingRetries(100);
				resilience = { openBreakers, activeRetryCount: retries.length };
			} finally {
				resilienceStore.close();
			}
		}
	} catch {
		// resilience db unavailable
	}

	let headroom: HeadroomSnapshot[] | undefined;
	if (stores.headroomStore) {
		try {
			headroom = stores.headroomStore.getAll();
		} catch {
			// best effort
		}
	}

	return {
		currentRunId: runId,
		status,
		recentMail,
		mergeQueue: mergeQueueEntries,
		metrics: { totalSessions, avgDuration, byCapability },
		tasks,
		recentEvents,
		feedColorMap,
		runtimeConfig,
		mission,
		resilience,
		headroom,
	};
}
