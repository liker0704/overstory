/**
 * Tier 0 mechanical process monitoring daemon.
 *
 * Runs on a configurable interval, checking the health of all active agent
 * sessions. Implements progressive nudging for stalled agents instead of
 * immediately escalating to AI triage:
 *
 *   Level 0 (warn):      Log warning via onHealthCheck callback, no direct action
 *   Level 1 (nudge):     Send tmux nudge via nudgeAgent()
 *   Level 2 (escalate):  Invoke Tier 1 AI triage (if tier1Enabled), else skip
 *   Level 3 (terminate): Kill tmux session
 *
 * Phase 4 tier numbering:
 *   Tier 0 = Mechanical daemon (this file)
 *   Tier 1 = Triage agent (triage.ts)
 *   Tier 2 = Monitor agent (not yet implemented)
 *   Tier 3 = Supervisor monitors (per-project)
 *
 * ZFC Principle: Observable state (tmux alive, pid alive) is the source of
 * truth. See health.ts for the full ZFC documentation.
 */

import { existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { nudgeAgent } from "../commands/nudge.ts";
import { createEventStore } from "../events/store.ts";
import {
	findLatestStdoutLog,
	startEventTailer,
	type TailerHandle,
	type TailerOptions,
} from "../events/tailer.ts";
import { pollHeadroom } from "../headroom/adapter.ts";
import { createHeadroomStore } from "../headroom/store.ts";
import { evaluateThrottlePolicy } from "../headroom/throttle.ts";
import type { ThrottlePolicy } from "../headroom/throttle-types.ts";
import type { HeadroomConfig, HeadroomStore } from "../headroom/types.ts";
import { runPolicyEvaluation } from "../health/policy/orchestrator.ts";
import { computeScore } from "../health/score.ts";
import { collectSignals } from "../health/signals.ts";
import { sanitize } from "../logging/sanitizer.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore, type MailStore } from "../mail/store.ts";
import { createMulchClient } from "../mulch/client.ts";
import { normalizeSpans } from "../observability/normalize.ts";
import { createExportPipeline, type ExportPipeline } from "../observability/pipeline.ts";
import { buildExporters } from "../observability/registry.ts";
import { handleTaskFailure } from "../resilience/engine.ts";
import { createResilienceStore, type ResilienceStore } from "../resilience/store.ts";
import type { RerouteDecision, ResilienceConfig } from "../resilience/types.ts";
import { getConnection, removeConnection } from "../runtimes/connections.ts";
import { getRuntime } from "../runtimes/registry.ts";
import type { RateLimitState, RuntimeConnection } from "../runtimes/types.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type {
	AgentSession,
	EventStore,
	HealthCheck,
	MailMessage,
	OverstoryConfig,
} from "../types.ts";
import { cleanupWorktreeForRespawn } from "../worktree/cleanup.ts";
import {
	capturePaneContent,
	isProcessAlive,
	isSessionAlive,
	killProcessTree,
	killSession,
	removeAgentEnvFile,
	sendKeys,
} from "../worktree/tmux.ts";
import { evaluateHealth, transitionState } from "./health.ts";
import { swapRuntime } from "./swap.ts";
import { triageAgent } from "./triage.ts";

/** Maximum escalation level (terminate). */
const MAX_ESCALATION_LEVEL = 3;

/**
 * Persistent agent capabilities that are excluded from run-level completion checks.
 * These agents are long-running and should not count toward "all workers done".
 */
const PERSISTENT_CAPABILITIES = new Set(["coordinator", "monitor"]);

/**
 * Module-level registry of active event tailers for headless agents.
 * Maps agentName → TailerHandle. Persists across daemon ticks so tailers
 * survive between tick invocations. Overridable via DaemonOptions._tailerRegistry.
 */
const _defaultTailerRegistry: Map<string, TailerHandle> = new Map();

/**
 * Record an agent failure to mulch for future reference.
 * Fire-and-forget: never throws, logs errors internally if mulch fails.
 *
 * @param root - Project root directory
 * @param session - The agent session that failed
 * @param reason - Human-readable failure reason
 * @param tier - Which watchdog tier detected the failure (0 or 1)
 * @param triageSuggestion - Optional triage verdict from Tier 1 AI analysis
 */
async function recordFailure(
	root: string,
	session: AgentSession,
	reason: string,
	tier: 0 | 1,
	triageSuggestion?: string,
): Promise<void> {
	try {
		const mulch = createMulchClient(root);
		const tierLabel = tier === 0 ? "Tier 0 (process death)" : "Tier 1 (AI triage)";
		const description = [
			`Agent: ${session.agentName}`,
			`Capability: ${session.capability}`,
			`Failure reason: ${reason}`,
			triageSuggestion ? `Triage suggestion: ${triageSuggestion}` : null,
			`Detected by: ${tierLabel}`,
		]
			.filter((line) => line !== null)
			.join("\n");

		await mulch.record("agents", {
			type: "failure",
			description,
			tags: ["watchdog", "auto-recorded"],
			evidenceBead: session.taskId || undefined,
		});
	} catch {
		// Fire-and-forget: recording failures must not break the watchdog
	}
}

/**
 * Read the current run ID from current-run.txt, or null if no active run.
 * Async because it uses Bun.file().
 */
async function readCurrentRunId(overstoryDir: string): Promise<string | null> {
	const path = join(overstoryDir, "current-run.txt");
	const file = Bun.file(path);
	if (!(await file.exists())) {
		return null;
	}
	try {
		const text = await file.text();
		const trimmed = text.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch {
		return null;
	}
}

/**
 * Fire-and-forget: record an event to EventStore. Never throws.
 */
function recordEvent(
	eventStore: EventStore | null,
	event: {
		runId: string | null;
		agentName: string;
		eventType: "custom" | "mail_sent";
		level: "debug" | "info" | "warn" | "error";
		data: Record<string, unknown>;
	},
): void {
	if (!eventStore) return;
	try {
		eventStore.insert({
			runId: event.runId,
			agentName: event.agentName,
			sessionId: null,
			eventType: event.eventType,
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			level: event.level,
			data: JSON.stringify(event.data),
		});
	} catch {
		// Fire-and-forget: event recording must never break the daemon
	}
}

function latestNonCustomEventType(eventStore: EventStore | null, agentName: string): string | null {
	if (!eventStore) return null;
	try {
		const events = eventStore.getByAgent(agentName);
		for (let i = events.length - 1; i >= 0; i--) {
			const event = events[i];
			if (event && event.eventType !== "custom") {
				return event.eventType;
			}
		}
	} catch {
		// Best-effort reconciliation only
	}
	return null;
}

function hasRecentRateLimitHistory(eventStore: EventStore | null, agentName: string): boolean {
	if (!eventStore) return false;
	try {
		const events = eventStore.getByAgent(agentName);
		for (let i = events.length - 1; i >= 0 && i >= events.length - 12; i--) {
			const event = events[i];
			if (!event || event.eventType !== "custom" || !event.data) {
				continue;
			}
			try {
				const data = JSON.parse(event.data) as { type?: string };
				if (
					data.type === "rate_limited" ||
					data.type === "rate_limit_wait_confirmed" ||
					data.type === "rate_limit_cleared" ||
					data.type === "rate_limit_resumed" ||
					data.type === "rate_limit_resume_reconciled"
				) {
					return true;
				}
			} catch {
				// Ignore malformed custom payloads
			}
		}
	} catch {
		// Best-effort reconciliation only
	}
	return false;
}

function hasRecentCompletionSignal(eventStore: EventStore | null, agentName: string): boolean {
	if (!eventStore) return false;
	try {
		const events = eventStore.getByAgent(agentName);
		for (let i = events.length - 1; i >= 0 && i >= events.length - 20; i--) {
			const event = events[i];
			if (!event || event.eventType !== "mail_sent" || !event.data) {
				continue;
			}
			try {
				const data = JSON.parse(event.data) as { type?: string };
				if (data.type === "worker_done" || data.type === "merge_ready") {
					return true;
				}
			} catch {
				// Ignore malformed mail_sent payloads
			}
		}
	} catch {
		// Best-effort reconciliation only
	}
	return false;
}

function reconcileSessionToCompleted(params: {
	session: AgentSession;
	store: ReturnType<typeof openSessionStore>["store"];
	runId: string | null;
	eventStore: EventStore | null;
	eventType: string;
	reason?: string;
}): void {
	const { session, store, runId, eventStore, eventType, reason } = params;
	store.updateState(session.agentName, "completed");
	store.updateLastActivity(session.agentName);
	store.updateEscalation(session.agentName, 0, null);
	store.updateRateLimitedSince(session.agentName, null);
	session.state = "completed";
	session.lastActivity = new Date().toISOString();
	session.escalationLevel = 0;
	session.stalledSince = null;
	session.rateLimitedSince = null;
	recordEvent(eventStore, {
		runId,
		agentName: session.agentName,
		eventType: "custom",
		level: "info",
		data: {
			type: eventType,
			runtime: session.runtime,
			reason: reason ?? null,
		},
	});
}

function buildRateLimitResumeNudge(session: AgentSession): string {
	return [
		"Rate limit has reset.",
		`Run ov mail check --agent ${session.agentName} if needed, then continue task ${session.taskId} from where you left off.`,
	].join(" ");
}

async function sendRateLimitResumeNudge(params: {
	session: AgentSession;
	sendInput: (name: string, keys: string) => Promise<void>;
	store: ReturnType<typeof openSessionStore>["store"];
	runId: string | null;
	eventStore: EventStore | null;
	eventType: "rate_limit_resumed" | "rate_limit_resume_reconciled";
}): Promise<void> {
	const { session, sendInput, store, runId, eventStore, eventType } = params;
	const msg = buildRateLimitResumeNudge(session);
	await sendInput(session.tmuxSession, msg);
	await Bun.sleep(500);
	await sendInput(session.tmuxSession, "");
	store.updateLastActivity(session.agentName);
	session.lastActivity = new Date().toISOString();
	if (session.state !== "working") {
		store.updateState(session.agentName, "working");
		session.state = "working";
	}
	recordEvent(eventStore, {
		runId,
		agentName: session.agentName,
		eventType: "custom",
		level: "info",
		data: {
			type: eventType,
			runtime: session.runtime,
		},
	});
}

function isRateLimitOptionsDialog(paneContent: string): boolean {
	const lower = paneContent.toLowerCase();
	return (
		lower.includes("/rate-limit-options") ||
		(lower.includes("what do you want to do?") &&
			lower.includes("stop and wait for limit to reset"))
	);
}

/**
 * Build a phase-aware completion message based on the capabilities of completed workers.
 *
 * Single-capability batches get targeted messages (e.g. scouts → "Ready for next phase"),
 * while mixed-capability batches get a generic summary with a breakdown.
 */
export function buildCompletionMessage(
	workerSessions: readonly AgentSession[],
	runId: string,
): string {
	const capabilities = new Set(workerSessions.map((s) => s.capability));
	const count = workerSessions.length;

	if (capabilities.size === 1) {
		if (capabilities.has("scout")) {
			return `[WATCHDOG] All ${count} scout(s) in run ${runId} have completed. Ready for next phase.`;
		}
		if (capabilities.has("builder")) {
			return `[WATCHDOG] All ${count} builder(s) in run ${runId} have completed. Awaiting lead verification.`;
		}
		if (capabilities.has("reviewer")) {
			return `[WATCHDOG] All ${count} reviewer(s) in run ${runId} have completed. Reviews done.`;
		}
		if (capabilities.has("lead")) {
			return `[WATCHDOG] All ${count} lead(s) in run ${runId} have completed. Ready for merge/cleanup.`;
		}
		if (capabilities.has("merger")) {
			return `[WATCHDOG] All ${count} merger(s) in run ${runId} have completed. Merges done.`;
		}
	}

	const breakdown = Array.from(capabilities).sort().join(", ");
	return `[WATCHDOG] All ${count} worker(s) in run ${runId} have completed (${breakdown}). Ready for next steps.`;
}

/**
 * Check if all worker sessions for the active run have completed, and if so,
 * nudge the coordinator. Fire-and-forget: never throws.
 *
 * Deduplication: uses a marker file (run-complete-notified.txt) to prevent
 * repeated nudges for the same run ID.
 */
async function checkRunCompletion(ctx: {
	store: { getByRun: (runId: string) => AgentSession[] };
	runId: string;
	overstoryDir: string;
	root: string;
	nudge: (
		projectRoot: string,
		agentName: string,
		message: string,
		force: boolean,
	) => Promise<{ delivered: boolean; reason?: string }>;
	eventStore: EventStore | null;
}): Promise<void> {
	const { store, runId, overstoryDir, root, nudge, eventStore } = ctx;

	const runSessions = store.getByRun(runId);
	const workerSessions = runSessions.filter((s) => !PERSISTENT_CAPABILITIES.has(s.capability));

	if (workerSessions.length === 0) {
		return;
	}

	const allCompleted = workerSessions.every((s) => s.state === "completed");
	if (!allCompleted) {
		return;
	}

	// Dedup: check marker file
	const markerPath = join(overstoryDir, "run-complete-notified.txt");
	try {
		const file = Bun.file(markerPath);
		if (await file.exists()) {
			const existing = await file.text();
			if (existing.trim() === runId) {
				return; // Already notified
			}
		}
	} catch {
		// Read failure is non-fatal — proceed with nudge
	}

	// Nudge the coordinator
	const message = buildCompletionMessage(workerSessions, runId);
	try {
		await nudge(root, "coordinator", message, true);
	} catch {
		// Nudge delivery failure is non-fatal
	}

	// Record the event
	const capabilitiesArr = Array.from(new Set(workerSessions.map((s) => s.capability))).sort();
	const phase = capabilitiesArr.length === 1 ? capabilitiesArr[0] : "mixed";
	recordEvent(eventStore, {
		runId,
		agentName: "watchdog",
		eventType: "custom",
		level: "info",
		data: {
			type: "run_complete",
			workerCount: workerSessions.length,
			completedAgents: workerSessions.map((s) => s.agentName),
			capabilities: capabilitiesArr,
			phase,
		},
	});

	// Write dedup marker
	try {
		await Bun.write(markerPath, runId);
	} catch {
		// Marker write failure is non-fatal
	}
}

/** Options shared between startDaemon and runDaemonTick. */
export interface DaemonOptions {
	root: string;
	staleThresholdMs: number;
	zombieThresholdMs: number;
	nudgeIntervalMs?: number;
	tier1Enabled?: boolean;
	/** Full config for rate limit detection and runtime resolution. */
	config?: OverstoryConfig;
	onHealthCheck?: (check: HealthCheck) => void;
	/** Dependency injection for testing. Uses real implementations when omitted. */
	_tmux?: {
		isSessionAlive: (name: string) => Promise<boolean>;
		killSession: (name: string) => Promise<void>;
		sendKeys?: (name: string, keys: string) => Promise<void>;
	};
	/** Dependency injection for testing. Uses real triageAgent when omitted. */
	_triage?: (options: {
		agentName: string;
		root: string;
		lastActivity: string;
	}) => Promise<"retry" | "terminate" | "extend">;
	/** Dependency injection for testing. Uses real nudgeAgent when omitted. */
	_nudge?: (
		projectRoot: string,
		agentName: string,
		message: string,
		force: boolean,
	) => Promise<{ delivered: boolean; reason?: string }>;
	/** Dependency injection for testing. Uses real isProcessAlive/killProcessTree when omitted. */
	_process?: {
		isAlive: (pid: number) => boolean;
		killTree: (pid: number) => Promise<void>;
	};
	/** Dependency injection for testing. Overrides EventStore creation. */
	_eventStore?: EventStore | null;
	/** Dependency injection for testing. Uses real recordFailure when omitted. */
	_recordFailure?: (
		root: string,
		session: AgentSession,
		reason: string,
		tier: 0 | 1,
		triageSuggestion?: string,
	) => Promise<void>;
	/** Dependency injection for testing. Uses real getConnection when omitted. */
	_getConnection?: (name: string) => RuntimeConnection | undefined;
	/** Dependency injection for testing. Uses real removeConnection when omitted. */
	_removeConnection?: (name: string) => void;
	/** Dependency injection for testing. Uses _defaultTailerRegistry when omitted. */
	_tailerRegistry?: Map<string, TailerHandle>;
	/** Dependency injection for testing. Uses startEventTailer when omitted. */
	_tailerFactory?: (opts: TailerOptions) => TailerHandle;
	/** Dependency injection for testing. Uses findLatestStdoutLog when omitted. */
	_findLatestStdoutLog?: (overstoryDir: string, agentName: string) => Promise<string | null>;
	/** Dependency injection for testing. Uses real capturePaneContent when omitted. */
	_capturePaneContent?: (name: string, lines?: number) => Promise<string | null>;
	/** Dependency injection for testing. Overrides MailStore creation for decision gate detection. */
	_mailStore?: MailStore | null;
	/** DI for resilience store. If not provided, created from resilience.db when config.resilience exists. */
	_resilienceStore?: ResilienceStore | null;
	/** DI for headroom store. If not provided, created from headroom.db when config.headroom exists. */
	_headroomStore?: HeadroomStore | null;
	/** DI for export pipeline. If not provided, built from config.observability when enabled. */
	_exportPipeline?: ExportPipeline | null;
}

/**
 * Start the watchdog daemon that periodically monitors agent health.
 *
 * On each tick:
 * 1. Loads sessions from SessionStore (sessions.db)
 * 2. For each session (including zombies — ZFC requires re-checking observable
 *    state), checks tmux liveness and evaluates health
 * 3. For "terminate" actions: kills tmux session immediately
 * 4. For "investigate" actions: surfaces via onHealthCheck, no auto-kill
 * 5. For "escalate" actions: applies progressive nudging based on escalationLevel
 * 6. Persists updated session states back to SessionStore
 *
 * @param options.root - Project root directory (contains .overstory/)
 * @param options.intervalMs - Polling interval in milliseconds
 * @param options.staleThresholdMs - Time after which an agent is considered stale
 * @param options.zombieThresholdMs - Time after which an agent is considered a zombie
 * @param options.nudgeIntervalMs - Time between progressive nudge stage transitions (default 60000)
 * @param options.tier1Enabled - Whether Tier 1 AI triage is enabled (default false)
 * @param options.onHealthCheck - Optional callback for each health check result
 * @returns An object with a `stop` function to halt the daemon
 */
export function startDaemon(options: DaemonOptions & { intervalMs: number }): { stop: () => void } {
	const { intervalMs } = options;

	// Run the first tick immediately, then on interval
	runDaemonTick(options).catch(() => {
		// Swallow errors in the first tick — daemon must not crash
	});

	const interval = setInterval(() => {
		runDaemonTick(options).catch(() => {
			// Swallow errors in periodic ticks — daemon must not crash
		});
	}, intervalMs);

	return {
		stop(): void {
			clearInterval(interval);
		},
	};
}

/**
 * Kill an agent using the appropriate method based on whether it is headless or TUI.
 *
 * Headless agents (tmuxSession === "" && pid !== null) are killed via PID process tree.
 * TUI agents are killed via their named tmux session (only if tmuxAlive).
 *
 * This prevents the blast-radius bug where killSession("") with tmux prefix matching
 * would kill ALL tmux sessions when a headless agent is terminated.
 */
async function killAgent(ctx: {
	session: AgentSession;
	tmuxAlive: boolean;
	tmux: { killSession: (name: string) => Promise<void> };
	process: { killTree: (pid: number) => Promise<void> };
}): Promise<void> {
	const { session, tmuxAlive, tmux, process: proc } = ctx;
	const isHeadless = session.tmuxSession === "" && session.pid !== null;
	if (isHeadless && session.pid !== null) {
		try {
			await proc.killTree(session.pid);
		} catch {
			// Already exited — not an error
		}
	} else if (tmuxAlive) {
		try {
			await tmux.killSession(session.tmuxSession);
		} catch {
			// Session may have died between check and kill — not an error
		}
	}
}

/**
 * Run a single daemon tick. Exported for testing — allows direct invocation
 * of the monitoring logic without starting the interval-based daemon loop.
 *
 * @param options - Same options as startDaemon (minus intervalMs)
 */
export async function runDaemonTick(options: DaemonOptions): Promise<void> {
	const {
		root,
		staleThresholdMs,
		zombieThresholdMs,
		nudgeIntervalMs = 60_000,
		tier1Enabled = false,
		onHealthCheck,
	} = options;
	const tmux = {
		isSessionAlive,
		killSession,
		sendKeys,
		...options._tmux,
	};
	const sendInput = tmux.sendKeys ?? sendKeys;
	const proc = options._process ?? { isAlive: isProcessAlive, killTree: killProcessTree };
	const triage = options._triage ?? triageAgent;
	const nudge = options._nudge ?? nudgeAgent;
	const recordFailureFn = options._recordFailure ?? recordFailure;
	const getConn = options._getConnection ?? getConnection;
	const removeConn = options._removeConnection ?? removeConnection;
	const tailerRegistry = options._tailerRegistry ?? _defaultTailerRegistry;
	const tailerFactory = options._tailerFactory ?? startEventTailer;
	const findStdoutLog = options._findLatestStdoutLog ?? findLatestStdoutLog;
	const capturePane = options._capturePaneContent ?? capturePaneContent;
	const rateLimitConfig = options.config?.rateLimit;

	const overstoryDir = join(root, ".overstory");
	const { store } = openSessionStore(overstoryDir);

	// Open MailStore for decision gate detection (fire-and-forget: non-fatal if unavailable)
	let mailStore: MailStore | null = null;
	let ownMailStore = false;
	if (options._mailStore !== undefined) {
		mailStore = options._mailStore;
	} else {
		try {
			mailStore = createMailStore(join(overstoryDir, "mail.db"));
			ownMailStore = true;
		} catch {
			// MailStore creation failure is non-fatal — decision gate detection will be skipped
		}
	}

	// Open EventStore for recording daemon events (fire-and-forget)
	let eventStore: EventStore | null = null;
	let runId: string | null = null;
	const useInjectedEventStore = options._eventStore !== undefined;
	if (useInjectedEventStore) {
		eventStore = options._eventStore ?? null;
	} else {
		try {
			const eventsDbPath = join(overstoryDir, "events.db");
			eventStore = createEventStore(eventsDbPath);
		} catch {
			// EventStore creation failure is non-fatal for the daemon
		}
	}
	try {
		runId = await readCurrentRunId(overstoryDir);
	} catch {
		// Reading run ID failure is non-fatal
	}

	// Open ResilienceStore if resilience config is present
	let resilienceStore: ResilienceStore | null = null;
	let ownResilienceStore = false;
	const rawResilienceConfig = options.config?.resilience;
	let resilienceConfig: ResilienceConfig | null = null;
	if (options._resilienceStore !== undefined) {
		resilienceStore = options._resilienceStore;
		if (resilienceStore && rawResilienceConfig) {
			resilienceConfig = buildResilienceConfig(rawResilienceConfig);
		}
	} else if (rawResilienceConfig) {
		try {
			resilienceStore = createResilienceStore(join(overstoryDir, "resilience.db"));
			ownResilienceStore = true;
			resilienceConfig = buildResilienceConfig(rawResilienceConfig);
		} catch {
			// Non-fatal: resilience features disabled for this tick
		}
	}

	// Open HeadroomStore if headroom config is present
	let headroomStore: HeadroomStore | null = null;
	let ownHeadroomStore = false;
	// TODO: remove cast once HeadroomConfig is added to OverstoryConfig in config-types.ts
	const headroomConfig = (
		options.config as (OverstoryConfig & { headroom?: HeadroomConfig }) | undefined
	)?.headroom;
	if (options._headroomStore !== undefined) {
		headroomStore = options._headroomStore;
	} else if (headroomConfig?.enabled !== false) {
		try {
			headroomStore = createHeadroomStore(join(overstoryDir, "headroom.db"));
			ownHeadroomStore = true;
		} catch {
			// Non-fatal: headroom features disabled for this tick
		}
	}

	// Build observability export pipeline if enabled
	let exportPipeline: ExportPipeline | null = null;
	if (options._exportPipeline !== undefined) {
		exportPipeline = options._exportPipeline;
	} else if (options.config?.observability?.enabled) {
		const exporterConfigs = options.config.observability.exporters;
		const exporters = buildExporters(exporterConfigs);
		if (exporters.length > 0) {
			exportPipeline = createExportPipeline(exporters);
		}
	}

	// Stale spawn-paused sentinel cleanup on daemon tick
	if (options.config?.healthPolicy?.enabled) {
		try {
			const sentinelPath = join(overstoryDir, "spawn-paused");
			if (existsSync(sentinelPath)) {
				const maxPauseMs = options.config.healthPolicy.maxPauseDurationMs;
				const stat = statSync(sentinelPath);
				const age = Date.now() - stat.mtimeMs;
				if (age > maxPauseMs) {
					unlinkSync(sentinelPath);
					recordEvent(eventStore, {
						runId,
						agentName: "watchdog",
						eventType: "custom",
						level: "info",
						data: { type: "stale_sentinel_cleaned", ageMs: age, maxPauseMs },
					});
				}
			}
		} catch {
			// Non-fatal: sentinel cleanup failure doesn't block the tick
		}
	}

	// Recover pending retries on daemon init
	if (resilienceStore && resilienceConfig) {
		try {
			const pendingRetries = resilienceStore.getPendingRetries(resilienceConfig.retry.maxAttempts);
			for (const retry of pendingRetries) {
				const activeSessions = store.getActive();
				if (activeSessions.length >= (options.config?.agents.maxConcurrent ?? 10)) break;

				try {
					const respawnProc = Bun.spawn(
						["ov", "sling", retry.taskId, "--capability", retry.capability, "--skip-task-check"],
						{ cwd: root, stdout: "pipe", stderr: "pipe" },
					);
					await respawnProc.exited;
				} catch {
					// Respawn failure is non-fatal — will retry next tick
				}
			}
		} catch {
			// Pending retry recovery failure is non-fatal
		}
	}

	try {
		const thresholds = {
			staleMs: staleThresholdMs,
			zombieMs: zombieThresholdMs,
		};

		const sessions = store.getAll();

		// Track active headless agents to clean up stale tailers after the loop.
		const activeHeadlessAgents = new Set<string>();
		const eventsDbPath = join(overstoryDir, "events.db");

		// Open mail store once for the entire tick (not per-agent)
		let mailStore: ReturnType<typeof createMailStore> | null = null;
		try {
			mailStore = createMailStore(join(overstoryDir, "mail.db"));
		} catch {
			// Non-fatal: mail nudge disabled for this tick
		}

		for (const session of sessions) {
			// Completed sessions: kill lingering tmux/process, then skip.
			// The session-end hook marks agents completed but can't kill its own
			// tmux session (it runs inside it). The watchdog cleans up on next tick.
			if (session.state === "completed" && session.rateLimitedSince === null) {
				if (session.tmuxSession && session.tmuxSession !== "") {
					const alive = await tmux.isSessionAlive(session.tmuxSession);
					if (alive) {
						try {
							await tmux.killSession(session.tmuxSession);
							recordEvent(eventStore, {
								runId,
								agentName: session.agentName,
								eventType: "custom",
								level: "info",
								data: {
									type: "completed_cleanup",
									tmuxSession: session.tmuxSession,
								},
							});
						} catch {
							// Non-fatal: tmux kill failure
						}
					}
				} else if (session.pid !== null) {
					if (proc.isAlive(session.pid)) {
						try {
							await proc.killTree(session.pid);
						} catch {
							// Non-fatal: process kill failure
						}
					}
				}
				continue;
			}

			// ZFC: Don't skip zombies. Re-check tmux liveness on every tick.
			// A zombie with a live tmux session needs investigation, not silence.

			// Event tailer management: start a background NDJSON tailer for each
			// active headless agent that doesn't already have one running.
			// Tailers persist between ticks (module-level registry) so events are
			// continuously written to events.db while the agent is working.
			if (session.tmuxSession === "" && session.pid !== null) {
				activeHeadlessAgents.add(session.agentName);
				if (!tailerRegistry.has(session.agentName)) {
					// Discover the latest stdout.log for this agent and start tailing.
					const logPath = await findStdoutLog(overstoryDir, session.agentName);
					if (logPath) {
						const handle = tailerFactory({
							stdoutLogPath: logPath,
							agentName: session.agentName,
							runId,
							eventsDbPath,
						});
						tailerRegistry.set(session.agentName, handle);
					}
				}
			}

			// RPC health check: for headless agents with an active connection,
			// call getState() to refresh lastActivity before evaluateHealth().
			// This prevents false-positive stale/zombie classification for agents
			// that are actively working but haven't updated lastActivity via hooks.
			//
			// For non-RPC headless agents, fall back to event-based activity detection:
			// if events.db has a recent event from this agent within the stale window,
			// the agent is considered active and lastActivity is refreshed.
			if (session.tmuxSession === "" && session.pid !== null) {
				const conn = getConn(session.agentName);
				if (conn) {
					try {
						const state = await Promise.race([
							conn.getState(),
							new Promise<never>((_, reject) =>
								setTimeout(() => reject(new Error("getState timed out")), 5000),
							),
						]);
						if (state.status === "idle" || state.status === "working") {
							store.updateLastActivity(session.agentName);
							// Refresh the session object so evaluateHealth sees updated lastActivity
							session.lastActivity = new Date().toISOString();
						}
					} catch {
						// getState() failed or timed out — remove stale connection
						removeConn(session.agentName);
					}
				} else if (eventStore) {
					// No RPC connection — check events.db for recent activity
					try {
						const recentEvents = eventStore.getByAgent(session.agentName, {
							since: new Date(Date.now() - staleThresholdMs).toISOString(),
							limit: 1,
						});
						if (recentEvents.length > 0) {
							store.updateLastActivity(session.agentName);
							session.lastActivity = new Date().toISOString();
						}
					} catch {
						// Non-fatal: event store query failure should not affect monitoring
					}
				}
			}

			const tmuxAlive = await tmux.isSessionAlive(session.tmuxSession);
			const latestEventType = latestNonCustomEventType(eventStore, session.agentName);
			const recentRateLimitHistory = hasRecentRateLimitHistory(eventStore, session.agentName);

			// Capture pane content once — reused for rate limit detection and idle mail nudge
			let lastPaneContent: string | null = null;

			// Rate limit detection: capture pane content and check via runtime adapter
			let rateLimitState: RateLimitState | undefined;
			if (tmuxAlive && session.tmuxSession !== "" && rateLimitConfig?.enabled) {
				try {
					const runtime = getRuntime(session.runtime, options.config, session.capability);
					if (runtime.detectRateLimit) {
						lastPaneContent = await capturePane(session.tmuxSession);
						if (lastPaneContent) {
							// Guard against false positives: if agent is at the prompt
							// (ready), it's not rate limited — even if pane text mentions
							// "rate limit" in conversation.
							const readyState = runtime.detectReady(lastPaneContent);
							if (readyState.phase !== "ready") {
								rateLimitState = runtime.detectRateLimit(lastPaneContent);
							}
						}
					}
				} catch {
					// Runtime resolution or pane capture failure is non-fatal
				}

				if (
					rateLimitState?.limited &&
					rateLimitConfig.behavior === "wait" &&
					lastPaneContent &&
					isRateLimitOptionsDialog(lastPaneContent) &&
					tmux.sendKeys
				) {
					try {
						await tmux.sendKeys(session.tmuxSession, "");
						recordEvent(eventStore, {
							runId,
							agentName: session.agentName,
							eventType: "custom",
							level: "info",
							data: {
								type: "rate_limit_wait_confirmed",
								runtime: session.runtime,
							},
						});
					} catch {
						// Non-fatal: dialog confirmation failure should not break monitoring
					}
				}

				// Track rate limit state transitions in session store
				if (rateLimitState?.limited && session.rateLimitedSince === null) {
					// Newly rate-limited — record timestamp and notify
					const now = new Date().toISOString();
					store.updateRateLimitedSince(session.agentName, now);
					session.rateLimitedSince = now;

					// Persist resumesAt so the time guard can prevent premature resume nudges
					if (rateLimitState.resumesAt) {
						const resumesAtIso = rateLimitState.resumesAt.toISOString();
						store.updateRateLimitResumesAt(session.agentName, resumesAtIso);
						session.rateLimitResumesAt = resumesAtIso;
					}

					recordEvent(eventStore, {
						runId,
						agentName: session.agentName,
						eventType: "custom",
						level: "warn",
						data: {
							type: "rate_limited",
							runtime: session.runtime,
							message: rateLimitState.message,
							resumesAt: rateLimitState.resumesAt?.toISOString() ?? null,
						},
					});

					// Notify coordinator if configured
					if (rateLimitConfig.notifyCoordinator) {
						try {
							const mailDbPath = join(overstoryDir, "mail.db");
							const mailStore = createMailStore(mailDbPath);
							const mailClient = createMailClient(mailStore);
							mailClient.sendProtocol({
								from: "watchdog",
								to: "coordinator",
								subject: `Rate limited: ${session.agentName}`,
								body: `Agent ${session.agentName} (${session.runtime}) hit rate limit. ${rateLimitState.message}`,
								type: "rate_limited",
								priority: "high",
								payload: {
									agentName: session.agentName,
									runtime: session.runtime,
									resumesAt: rateLimitState.resumesAt?.toISOString() ?? null,
									message: rateLimitState.message,
								},
							});
							mailStore.close();
						} catch {
							// Mail send failure is non-fatal
						}
					}

					// Swap to alternate runtime if configured
					if (rateLimitConfig.behavior === "swap" && rateLimitConfig.swapRuntime) {
						const swapPaneContent = await capturePane(session.tmuxSession, 500);
						const result = await swapRuntime({
							root,
							session,
							targetRuntimeName: rateLimitConfig.swapRuntime,
							config: options.config as OverstoryConfig,
							paneContext: swapPaneContent,
						});
						if (result.success) {
							recordEvent(eventStore, {
								runId,
								agentName: session.agentName,
								eventType: "custom",
								level: "info",
								data: {
									type: "rate_limit_swap",
									from: session.runtime,
									to: result.newRuntime,
								},
							});
							continue;
						}
					}
				} else if (!rateLimitState?.limited && session.rateLimitedSince !== null) {
					// Guard: don't declare limit lifted if resumesAt time hasn't passed yet.
					// This prevents spamming resume nudges while the agent is at the prompt
					// but the rate limit window is still active.
					const resumesAt = session.rateLimitResumesAt;
					if (resumesAt && new Date(resumesAt).getTime() > Date.now()) {
						continue;
					}

					// Rate limit lifted — clear tracking
					store.updateRateLimitedSince(session.agentName, null);
					store.updateRateLimitResumesAt(session.agentName, null);
					session.rateLimitedSince = null;
					session.rateLimitResumesAt = null;

					recordEvent(eventStore, {
						runId,
						agentName: session.agentName,
						eventType: "custom",
						level: "info",
						data: { type: "rate_limit_cleared", runtime: session.runtime },
					});

					if (
						rateLimitConfig.behavior === "wait" &&
						session.state !== "completed" &&
						lastPaneContent
					) {
						try {
							const runtime = getRuntime(session.runtime, options.config, session.capability);
							const readyState = runtime.detectReady(lastPaneContent);
							if (readyState.phase === "ready") {
								await sendRateLimitResumeNudge({
									session,
									sendInput,
									store,
									runId,
									eventStore,
									eventType: "rate_limit_resumed",
								});
							}
						} catch {
							// Non-fatal: resume nudge failure should not break monitoring
						}
					}

					// Completed sessions may still be sitting on the wait dialog. Dismiss it so
					// the normal completed-session cleanup can remove the tmux session next tick.
					if (session.state === "completed" && session.tmuxSession) {
						try {
							await sendInput(session.tmuxSession, "");
						} catch {
							// Non-fatal: tmux session may have died
						}
					}
				}
			}

			// TUI reconciliation: unread-mail wakeups and held session-end completion.
			if (mailStore && tmuxAlive && session.tmuxSession !== "" && session.state !== "completed") {
				try {
					const unread = mailStore.getUnread(session.agentName);
					const paneContent = lastPaneContent ?? (await capturePane(session.tmuxSession));
					if (paneContent) {
						const runtime = getRuntime(session.runtime, options.config, session.capability);
						const readyState = runtime.detectReady(paneContent);
						if (readyState.phase === "ready") {
							if (unread.length > 0) {
								const subjects = unread
									.slice(0, 3)
									.map((m) => m.subject)
									.join("; ");
								const msg = `You have ${unread.length} unread message(s): ${subjects} — check mail: ov mail check --agent ${session.agentName}`;
								await sendInput(session.tmuxSession, msg);
								await Bun.sleep(500);
								await sendInput(session.tmuxSession, "");
								store.updateLastActivity(session.agentName);
								session.lastActivity = new Date().toISOString();
								if (session.state !== "working") {
									store.updateState(session.agentName, "working");
									session.state = "working";
								}
							} else if (session.state === "zombie" && latestEventType === "session_end") {
								if (recentRateLimitHistory) {
									await sendRateLimitResumeNudge({
										session,
										sendInput,
										store,
										runId,
										eventStore,
										eventType: "rate_limit_resume_reconciled",
									});
								} else {
									reconcileSessionToCompleted({
										session,
										store,
										runId,
										eventStore,
										eventType: "zombie_session_end_reconciled",
										reason: "tmux alive, ready prompt, no recent rate-limit history",
									});
								}
								continue;
							}
						}
					}
				} catch {
					// Non-fatal: reconciliation failure shouldn't break watchdog
				}
			}

			if (
				session.tmuxSession !== "" &&
				!tmuxAlive &&
				session.state !== "completed" &&
				latestEventType === "session_end"
			) {
				const completionSignal = hasRecentCompletionSignal(eventStore, session.agentName);
				if (!recentRateLimitHistory || completionSignal) {
					reconcileSessionToCompleted({
						session,
						store,
						runId,
						eventStore,
						eventType: recentRateLimitHistory
							? "rate_limit_session_end_dead_reconciled"
							: "zombie_session_end_dead_reconciled",
						reason: recentRateLimitHistory
							? "tmux died after session_end; recent completion signal confirms work finished"
							: "tmux died after session_end with no recent rate-limit history",
					});
					continue;
				}
			}

			const check = evaluateHealth(session, tmuxAlive, thresholds, rateLimitState);

			// Transition state forward only (investigate action holds state)
			const newState = transitionState(session.state, check);
			if (newState !== session.state) {
				store.updateState(session.agentName, newState);
				session.state = newState;
			}

			if (onHealthCheck) {
				onHealthCheck(check);
			}

			if (check.action === "terminate") {
				// Record the failure via mulch (Tier 0 detection)
				const reason = check.reconciliationNote ?? "Process terminated";
				await recordFailureFn(root, session, reason, 0);

				// Consult resilience engine if configured
				if (resilienceStore && resilienceConfig) {
					const decision = handleTaskFailure(
						session.taskId,
						session.capability,
						"unknown",
						resilienceStore,
						resilienceConfig,
					);
					await handleRerouteDecision({
						decision,
						session,
						root,
						overstoryDir,
						config: options.config,
						eventStore,
						runId,
						tmux,
						process: proc,
						tmuxAlive,
					});
				} else {
					// No resilience config — existing terminate behavior
					await killAgent({ session, tmuxAlive, tmux, process: proc });
					removeAgentEnvFile(session.worktreePath);
				}

				store.updateState(session.agentName, "zombie");
				// Reset escalation tracking on terminal state
				store.updateEscalation(session.agentName, 0, null);
				session.state = "zombie";
				session.escalationLevel = 0;
				session.stalledSince = null;
			} else if (check.action === "investigate") {
				// ZFC: tmux alive but SessionStore says zombie.
				// Log the conflict but do NOT auto-kill.
				// The onHealthCheck callback surfaces this to the operator.
				// No state change — keep zombie until a human or higher-tier agent decides.
			} else if (check.action === "escalate") {
				// Decision gate check: if the agent sent a decision_gate message, it is
				// intentionally paused waiting for a human decision — not a stall.
				// Skip watchdog escalation and clear any accumulated stall state.
				if (mailStore !== null) {
					const recentMail = mailStore.getAll({ from: session.agentName, limit: 20 });
					const hasPendingDecisionGate = recentMail.some((m) => m.type === "decision_gate");
					if (hasPendingDecisionGate) {
						if (session.stalledSince !== null) {
							store.updateEscalation(session.agentName, 0, null);
							session.stalledSince = null;
							session.escalationLevel = 0;
						}
						continue;
					}
				}

				// Progressive nudging: increment escalation level based on elapsed time
				// instead of immediately delegating to AI triage.

				// Initialize stalledSince on first escalation detection
				if (session.stalledSince === null) {
					session.stalledSince = new Date().toISOString();
					session.escalationLevel = 0;
					store.updateEscalation(session.agentName, 0, session.stalledSince);
				}

				// Check if enough time has passed to advance to the next escalation level
				const stalledMs = Date.now() - new Date(session.stalledSince).getTime();
				const expectedLevel = Math.min(
					Math.floor(stalledMs / nudgeIntervalMs),
					MAX_ESCALATION_LEVEL,
				);

				if (expectedLevel > session.escalationLevel) {
					session.escalationLevel = expectedLevel;
					store.updateEscalation(session.agentName, expectedLevel, session.stalledSince);
				}

				// Execute the action for the current escalation level
				const actionResult = await executeEscalationAction({
					session,
					root,
					overstoryDir,
					tmuxAlive,
					tier1Enabled,
					tmux,
					process: proc,
					triage,
					nudge,
					eventStore,
					runId,
					recordFailure: recordFailureFn,
					resilienceStore,
					resilienceConfig,
					config: options.config,
				});

				if (actionResult.terminated) {
					store.updateState(session.agentName, "zombie");
					store.updateEscalation(session.agentName, 0, null);
					session.state = "zombie";
					session.escalationLevel = 0;
					session.stalledSince = null;
				}
			} else if (check.action === "none" && session.stalledSince !== null) {
				// Agent recovered — reset escalation tracking
				store.updateEscalation(session.agentName, 0, null);
				session.stalledSince = null;
				session.escalationLevel = 0;
			}
		}

		// Close shared mail store for this tick
		if (mailStore) {
			try {
				mailStore.close();
			} catch {
				// Non-fatal
			}
		}

		// === Tailer cleanup ===
		// Stop tailers for any headless agent that is no longer in the active set
		// (i.e. completed, removed from store, or was never a headless agent).
		for (const [name, handle] of tailerRegistry) {
			if (!activeHeadlessAgents.has(name)) {
				handle.stop();
				tailerRegistry.delete(name);
			}
		}

		// === Run-level completion detection ===
		// After monitoring individual sessions, check if the entire run is done.
		if (runId) {
			await checkRunCompletion({
				store,
				runId,
				overstoryDir,
				root,
				nudge,
				eventStore,
			});
		}
		// Poll headroom if store and config are available
		if (headroomStore && headroomConfig?.enabled !== false) {
			try {
				// Resolve active runtimes from config
				const runtimeNames = new Set<string>();
				runtimeNames.add(options.config?.runtime?.default ?? "claude");
				if (options.config?.runtime?.capabilities) {
					for (const rt of Object.values(options.config.runtime.capabilities)) {
						if (rt !== undefined) runtimeNames.add(rt);
					}
				}
				const runtimes = [...runtimeNames]
					.map((name) => {
						try {
							return getRuntime(name);
						} catch {
							return null;
						}
					})
					.filter((rt): rt is NonNullable<typeof rt> => rt !== null);

				const snapshots = await pollHeadroom({ store: headroomStore, runtimes });
				const warnThreshold = headroomConfig?.warnThresholdPercent ?? 20;
				const criticalThreshold = headroomConfig?.criticalThresholdPercent ?? 10;

				for (const snap of snapshots) {
					if (
						snap.requestsRemaining !== null &&
						snap.requestsLimit !== null &&
						snap.requestsLimit > 0
					) {
						const pct = (snap.requestsRemaining / snap.requestsLimit) * 100;
						if (pct < criticalThreshold) {
							recordEvent(eventStore, {
								runId,
								agentName: "watchdog",
								eventType: "custom",
								level: "error",
								data: {
									type: "headroom_critical",
									runtime: snap.runtime,
									percent: Math.round(pct),
								},
							});
						} else if (pct < warnThreshold) {
							recordEvent(eventStore, {
								runId,
								agentName: "watchdog",
								eventType: "custom",
								level: "warn",
								data: {
									type: "headroom_warn",
									runtime: snap.runtime,
									percent: Math.round(pct),
								},
							});
						}
					}
				}

				// === Throttle policy enforcement ===
				const throttleConfig = headroomConfig?.throttle;
				if (throttleConfig) {
					const throttlePolicy: ThrottlePolicy = {
						slowThresholdPercent: throttleConfig.slowThresholdPercent ?? 20,
						pauseThresholdPercent: throttleConfig.pauseThresholdPercent ?? 10,
						blockSpawnsOnPause: throttleConfig.blockSpawnsOnPause ?? true,
					};
					const activeSessions = sessions.filter(
						(s) => s.state === "working" || s.state === "booting",
					);
					const throttleActions = evaluateThrottlePolicy(snapshots, activeSessions, throttlePolicy);
					for (const action of throttleActions) {
						if (action.level === "pause" || action.level === "slow") {
							const eventType = action.level === "pause" ? "throttle_pause" : "throttle_slow";
							nudge(
								options.root,
								action.targetAgent,
								`THROTTLE PAUSE: ${action.reason}. Reduce activity.`,
								true,
							).catch(() => {
								// Fire-and-forget: nudge failure is non-fatal
							});
							recordEvent(eventStore, {
								runId,
								agentName: "watchdog",
								eventType: "custom",
								level: action.level === "pause" ? "error" : "warn",
								data: {
									type: eventType,
									targetAgent: action.targetAgent,
									runtime: action.runtime,
									reason: action.reason,
								},
							});
						}
					}
				}
			} catch {
				// Non-fatal: headroom polling failure doesn't block the tick
			}
		}

		// === Health policy evaluation ===
		if (options.config?.healthPolicy?.enabled) {
			try {
				const signals = collectSignals({ overstoryDir });
				const score = computeScore(signals);
				const policyResult = await runPolicyEvaluation({
					overstoryDir,
					config: options.config,
					score,
					history: [],
					mailSend: (to, subject, body, type, _payload) => {
						try {
							const policyMailStore = createMailStore(join(overstoryDir, "mail.db"));
							const mc = createMailClient(policyMailStore);
							mc.send({
								from: "watchdog",
								to,
								subject,
								body,
								type: type as MailMessage["type"],
								priority: "normal",
							});
							policyMailStore.close();
						} catch {
							// Non-fatal
						}
					},
					logEvent: (eventType, data) => {
						recordEvent(eventStore, {
							runId,
							agentName: "watchdog",
							eventType: eventType as "custom",
							level: "info",
							data,
						});
					},
				});
				if (policyResult && eventStore) {
					for (const evaluation of policyResult.evaluations) {
						if (evaluation.triggered) {
							recordEvent(eventStore, {
								runId,
								agentName: "watchdog",
								eventType: "custom",
								level: "info",
								data: {
									type: "health_action",
									ruleId: evaluation.rule.id,
									action: evaluation.rule.action,
									suppressed: evaluation.suppressed,
									dryRun: evaluation.dryRun,
								},
							});
						}
					}
				}
			} catch {
				// Error boundary: policy evaluation must never crash the daemon
			}
		}

		if (exportPipeline && eventStore) {
			try {
				const recentEvents = runId
					? eventStore.getByRun(runId, { limit: 100 })
					: eventStore.getErrors({ limit: 100 });
				if (recentEvents.length > 0) {
					const spans = normalizeSpans(recentEvents, {});
					exportPipeline.enqueue(spans);
				}
			} catch {
				// Non-fatal: export pipeline errors must not crash the daemon
			}
		}
	} finally {
		store.close();
		// Close MailStore only if we created it (not injected)
		if (mailStore && ownMailStore) {
			try {
				mailStore.close();
			} catch {
				// Non-fatal
			}
		}
		// Close ResilienceStore only if we created it (not injected)
		if (resilienceStore && ownResilienceStore) {
			try {
				resilienceStore.close();
			} catch {
				// Non-fatal
			}
		}
		// Close HeadroomStore only if we created it (not injected)
		if (headroomStore && ownHeadroomStore) {
			try {
				headroomStore.close();
			} catch {
				// Non-fatal
			}
		}
		// Close EventStore only if we created it (not injected)
		if (eventStore && !useInjectedEventStore) {
			try {
				eventStore.close();
			} catch {
				// Non-fatal
			}
		}
	}
}

/**
 * Execute the escalation action corresponding to the agent's current escalation level.
 *
 * Level 0 (warn):      No direct action — onHealthCheck callback already fired above.
 * Level 1 (nudge):     Send a tmux nudge to the agent.
 * Level 2 (escalate):  Invoke Tier 1 AI triage (if tier1Enabled; skip otherwise).
 * Level 3 (terminate): Kill the tmux session.
 *
 * @returns Object indicating whether the agent was terminated or state changed.
 */
async function executeEscalationAction(ctx: {
	session: AgentSession;
	root: string;
	overstoryDir: string;
	tmuxAlive: boolean;
	tier1Enabled: boolean;
	tmux: {
		isSessionAlive: (name: string) => Promise<boolean>;
		killSession: (name: string) => Promise<void>;
	};
	process: {
		killTree: (pid: number) => Promise<void>;
	};
	triage: (options: {
		agentName: string;
		root: string;
		lastActivity: string;
	}) => Promise<"retry" | "terminate" | "extend">;
	nudge: (
		projectRoot: string,
		agentName: string,
		message: string,
		force: boolean,
	) => Promise<{ delivered: boolean; reason?: string }>;
	eventStore: EventStore | null;
	runId: string | null;
	recordFailure: (
		root: string,
		session: AgentSession,
		reason: string,
		tier: 0 | 1,
		triageSuggestion?: string,
	) => Promise<void>;
	resilienceStore: ResilienceStore | null;
	resilienceConfig: ResilienceConfig | null;
	config?: OverstoryConfig;
}): Promise<{ terminated: boolean; stateChanged: boolean }> {
	const {
		session,
		root,
		overstoryDir,
		tmuxAlive,
		tier1Enabled,
		tmux,
		process: proc,
		triage,
		nudge,
		eventStore,
		runId,
		recordFailure,
		resilienceStore,
		resilienceConfig,
	} = ctx;

	switch (session.escalationLevel) {
		case 0: {
			// Level 0: warn — onHealthCheck callback already fired, no direct action
			recordEvent(eventStore, {
				runId,
				agentName: session.agentName,
				eventType: "custom",
				level: "warn",
				data: { type: "escalation", escalationLevel: 0, action: "warn" },
			});
			return { terminated: false, stateChanged: false };
		}

		case 1: {
			// Level 1: nudge — send a tmux nudge to the agent
			let delivered = false;
			try {
				const result = await nudge(
					root,
					session.agentName,
					`[WATCHDOG] Agent "${session.agentName}" appears stalled. Please check your current task and report status.`,
					true, // force — skip debounce for watchdog nudges
				);
				delivered = result.delivered;
			} catch {
				// Nudge delivery failure is non-fatal for the watchdog
			}
			recordEvent(eventStore, {
				runId,
				agentName: session.agentName,
				eventType: "custom",
				level: "warn",
				data: { type: "nudge", escalationLevel: 1, delivered },
			});
			return { terminated: false, stateChanged: false };
		}

		case 2: {
			// Level 2: escalate — invoke Tier 1 AI triage if enabled
			if (!tier1Enabled) {
				// Tier 1 disabled — skip triage, progressive nudging continues to level 3
				return { terminated: false, stateChanged: false };
			}

			const verdict = await triage({
				agentName: session.agentName,
				root,
				lastActivity: session.lastActivity,
			});

			recordEvent(eventStore, {
				runId,
				agentName: session.agentName,
				eventType: "custom",
				level: "warn",
				data: { type: "triage", escalationLevel: 2, verdict },
			});

			if (verdict === "terminate") {
				// Record the failure via mulch (Tier 1 AI triage)
				await recordFailure(root, session, "AI triage classified as terminal failure", 1, verdict);

				// Consult resilience engine if configured
				if (resilienceStore && resilienceConfig) {
					const decision = handleTaskFailure(
						session.taskId,
						session.capability,
						"unknown",
						resilienceStore,
						resilienceConfig,
					);
					await handleRerouteDecision({
						decision,
						session,
						root,
						overstoryDir,
						config: ctx.config,
						eventStore,
						runId,
						tmux,
						process: proc,
						tmuxAlive,
					});
				} else {
					await killAgent({ session, tmuxAlive, tmux, process: proc });
				}
				return { terminated: true, stateChanged: true };
			}

			if (verdict === "retry") {
				// Send a nudge with a recovery message
				try {
					await nudge(
						root,
						session.agentName,
						"[WATCHDOG] Triage suggests recovery is possible. " +
							"Please retry your current operation or check for errors.",
						true, // force — skip debounce
					);
				} catch {
					// Nudge delivery failure is non-fatal
				}
			}

			// "retry" (after nudge) and "extend" leave the session running
			return { terminated: false, stateChanged: false };
		}

		default: {
			// Level 3+: terminate — kill the tmux session
			recordEvent(eventStore, {
				runId,
				agentName: session.agentName,
				eventType: "custom",
				level: "error",
				data: { type: "escalation", escalationLevel: 3, action: "terminate" },
			});

			// Record the failure via mulch (Tier 0: progressive escalation to terminal level)
			await recordFailure(root, session, "Progressive escalation reached terminal level", 0);

			// Consult resilience engine if configured
			if (resilienceStore && resilienceConfig) {
				const decision = handleTaskFailure(
					session.taskId,
					session.capability,
					"unknown",
					resilienceStore,
					resilienceConfig,
				);
				await handleRerouteDecision({
					decision,
					session,
					root,
					overstoryDir,
					config: ctx.config,
					eventStore,
					runId,
					tmux,
					process: proc,
					tmuxAlive,
				});
			} else {
				await killAgent({ session, tmuxAlive, tmux, process: proc });
				// Clean up .agent-env to prevent hook pollution in user sessions
				removeAgentEnvFile(session.worktreePath);
			}
			return { terminated: true, stateChanged: true };
		}
	}
}

/**
 * Build a full ResilienceConfig from the partial config stored in OverstoryConfig.
 * Fills in sensible defaults for any missing fields.
 */
function buildResilienceConfig(raw: NonNullable<OverstoryConfig["resilience"]>): ResilienceConfig {
	return {
		retry: {
			maxAttempts: raw.retry?.maxAttempts ?? 3,
			backoffBaseMs: raw.retry?.backoffBaseMs ?? 1_000,
			backoffMaxMs: raw.retry?.backoffMaxMs ?? 30_000,
			backoffMultiplier: raw.retry?.backoffMultiplier ?? 2,
			globalMaxConcurrent: raw.retry?.globalMaxConcurrent ?? 5,
		},
		circuitBreaker: {
			failureThreshold: raw.circuitBreaker?.failureThreshold ?? 3,
			windowMs: raw.circuitBreaker?.windowMs ?? 60_000,
			cooldownMs: raw.circuitBreaker?.cooldownMs ?? 10_000,
			halfOpenMaxProbes: raw.circuitBreaker?.halfOpenMaxProbes ?? 2,
		},
		reroute: {
			enabled: raw.reroute?.enabled ?? false,
			maxReroutes: raw.reroute?.maxReroutes ?? 2,
			fallbackCapability: raw.reroute?.fallbackCapability,
		},
	};
}

/**
 * Handle a reroute decision from the resilience engine.
 * Always kills the current agent first, then acts based on decision:
 *   retry             → clean worktree + respawn via sling
 *   recommend_reroute → send mail to parent/coordinator
 *   abandon           → kill only (existing terminate behavior)
 */
async function handleRerouteDecision(ctx: {
	decision: RerouteDecision;
	session: AgentSession;
	root: string;
	overstoryDir: string;
	config?: OverstoryConfig;
	eventStore: EventStore | null;
	runId: string | null;
	tmux: { killSession: (name: string) => Promise<void> };
	process: { killTree: (pid: number) => Promise<void> };
	tmuxAlive: boolean;
}): Promise<void> {
	const { decision, session, root, overstoryDir } = ctx;

	// Always kill the current agent first
	await killAgent({
		session,
		tmuxAlive: ctx.tmuxAlive,
		tmux: ctx.tmux,
		process: ctx.process,
	});
	removeAgentEnvFile(session.worktreePath);

	if (decision.action === "retry") {
		// Clean old worktree before respawn
		await cleanupWorktreeForRespawn({ root, agentName: session.agentName });

		// Schedule respawn non-blocking to avoid stalling the daemon tick
		const doRespawn = async () => {
			try {
				const respawnProc = Bun.spawn(
					["ov", "sling", session.taskId, "--capability", session.capability, "--skip-task-check"],
					{ cwd: root, stdout: "pipe", stderr: "pipe" },
				);
				await respawnProc.exited;
			} catch {
				// Respawn failure logged but not fatal
			}
		};

		if (decision.delay > 0) {
			setTimeout(() => void doRespawn(), decision.delay);
		} else {
			void doRespawn();
		}

		recordEvent(ctx.eventStore, {
			runId: ctx.runId,
			agentName: session.agentName,
			eventType: "custom",
			level: "info",
			data: {
				type: "resilience_retry",
				taskId: session.taskId,
				delay: decision.delay,
			},
		});
	} else if (decision.action === "recommend_reroute") {
		// Send reroute recommendation mail to parent/coordinator
		try {
			const rerouteMailStore = createMailStore(join(overstoryDir, "mail.db"));
			const mailClient = createMailClient(rerouteMailStore);
			const recipient = session.parentAgent ?? "coordinator";
			mailClient.send({
				from: "watchdog",
				to: recipient,
				subject: `reroute_recommendation: ${session.taskId}`,
				body: sanitize(
					`Task ${session.taskId} failed (${decision.reason}). Recommending reroute to ${decision.targetCapability ?? "alternate capability"}.`,
				),
				type: "reroute_recommendation",
				priority: "high",
			});
			rerouteMailStore.close();
		} catch {
			// Mail failure non-fatal
		}

		recordEvent(ctx.eventStore, {
			runId: ctx.runId,
			agentName: session.agentName,
			eventType: "custom",
			level: "warn",
			data: {
				type: "resilience_reroute",
				taskId: session.taskId,
				targetCapability: decision.targetCapability,
			},
		});
	} else {
		// abandon — agent already killed above, record event only
		recordEvent(ctx.eventStore, {
			runId: ctx.runId,
			agentName: session.agentName,
			eventType: "custom",
			level: "error",
			data: {
				type: "resilience_abandon",
				taskId: session.taskId,
				reason: decision.reason,
			},
		});
	}
}
