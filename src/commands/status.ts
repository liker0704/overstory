/**
 * CLI command: overstory status [--json] [--watch]
 *
 * Shows active agents, worktree status, task summary, mail queue depth,
 * and merge queue state. --watch mode uses polling for live updates.
 */

import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createHeadroomStore } from "../headroom/store.ts";
import type { HeadroomSnapshot } from "../headroom/types.ts";
import { jsonOutput } from "../json.ts";
import { accent, color } from "../logging/color.ts";
import { formatDuration, formatRelativeTime } from "../logging/format.ts";
import { renderHeader } from "../logging/theme.ts";
import { createMailStore } from "../mail/store.ts";
import { createMergeQueue } from "../merge/queue.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { computeArtifactStaleness } from "../missions/artifact-staleness.ts";
import type { MissionRoleStates } from "../missions/runtime-context.ts";
import { resolveMissionRoleStates } from "../missions/runtime-context.ts";
import { listSpecMeta } from "../missions/spec-meta.ts";
import { createMissionStore } from "../missions/store.ts";
import { createResilienceStore } from "../resilience/store.ts";
import { createReviewStore } from "../review/store.ts";
import type { ReviewSubjectType } from "../review/types.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession, Mission } from "../types.ts";
import { evaluateHealth } from "../watchdog/health.ts";
import { listWorktrees } from "../worktree/manager.ts";
import { isProcessAlive, listSessions } from "../worktree/tmux.ts";

// ---------------------------------------------------------------------------
// Subprocess result cache (TTL-based, module-level)
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
	data: T;
	timestamp: number;
}

let worktreeCache: CacheEntry<Array<{ path: string; branch: string; head: string }>> | null = null;
let tmuxCache: CacheEntry<Array<{ name: string; pid: number }>> | null = null;

const DEFAULT_CACHE_TTL_MS = 10_000; // 10 seconds

export function invalidateStatusCache(): void {
	worktreeCache = null;
	tmuxCache = null;
}

export async function getCachedWorktrees(
	root: string,
	ttlMs: number = DEFAULT_CACHE_TTL_MS,
): Promise<Array<{ path: string; branch: string; head: string }>> {
	const now = Date.now();
	if (worktreeCache && now - worktreeCache.timestamp < ttlMs) {
		return worktreeCache.data;
	}
	const data = await listWorktrees(root);
	worktreeCache = { data, timestamp: now };
	return data;
}

export async function getCachedTmuxSessions(
	ttlMs: number = DEFAULT_CACHE_TTL_MS,
): Promise<Array<{ name: string; pid: number }>> {
	const now = Date.now();
	if (tmuxCache && now - tmuxCache.timestamp < ttlMs) {
		return tmuxCache.data;
	}
	try {
		const data = await listSessions();
		tmuxCache = { data, timestamp: now };
		return data;
	} catch {
		return tmuxCache?.data ?? [];
	}
}

export interface VerboseAgentDetail {
	worktreePath: string;
	logsDir: string;
	lastMailSent: string | null;
	lastMailReceived: string | null;
	capability: string;
}

export interface StatusData {
	currentRunId?: string | null;
	agents: AgentSession[];
	worktrees: Array<{ path: string; branch: string; head: string }>;
	tmuxSessions: Array<{ name: string; pid: number }>;
	unreadMailCount: number;
	mergeQueueCount: number;
	recentMetricsCount: number;
	verboseDetails?: Record<string, VerboseAgentDetail>;
	mission?: Mission | null;
	missionRoles?: MissionRoleStates | null;
	artifactStatus?: {
		missionArtifacts: Array<{ type: string; status: string }>;
		reviews: { total: number; fresh: number; stale: number; underTarget: number; unscored: number };
		specs: {
			total: number;
			current: number;
			stale: number;
			superseded: number;
			unscored: number;
			underTarget: number;
		};
	};
	resilience?: {
		openBreakers: Array<{ capability: string; since: string | null; failureCount: number }>;
		activeRetries: Array<{ taskId: string; attempt: number; startedAt: string }>;
		recentReroutes: number;
	};
	headroom?: HeadroomSnapshot[];
}

async function readCurrentRunId(overstoryDir: string): Promise<string | null> {
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
 * Gather all status data.
 * @param agentName - Which agent's perspective for unread mail count (default "orchestrator")
 * @param verbose - When true, collect extra per-agent detail (worktree path, logs dir, last mail)
 * @param runId - When provided, only sessions for that run are returned; null/undefined shows all
 */
export async function gatherStatus(
	root: string,
	agentName = "orchestrator",
	verbose = false,
	runId?: string | null,
): Promise<StatusData> {
	const overstoryDir = join(root, ".overstory");
	const { store } = openSessionStore(overstoryDir);

	let sessions: AgentSession[];
	try {
		// When run-scoped, also include sessions with null runId (e.g. coordinator)
		// because SQL WHERE run_id = $run_id never matches NULL rows.
		sessions = runId
			? [...store.getByRun(runId), ...store.getAll().filter((s) => s.runId === null)]
			: store.getAll();

		const worktrees = await getCachedWorktrees(root);

		const tmuxSessions = await getCachedTmuxSessions();

		// Reconcile agent states using the same health evaluation as the
		// dashboard and watchdog. This handles:
		//   1. tmux dead -> zombie (regardless of recorded state)
		//   2. persistent capabilities (coordinator, monitor) booting -> working when tmux alive
		//   3. time-based stale/zombie detection for non-persistent agents
		const tmuxSessionNames = new Set(tmuxSessions.map((s) => s.name));
		const healthThresholds = { staleMs: 300_000, zombieMs: 600_000 };
		for (const session of sessions) {
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
					store.updateState(session.agentName, check.state);
					session.state = check.state;
				} catch {
					// Best effort: don't fail status display if update fails
				}
			}
		}

		let unreadMailCount = 0;
		let mailStore: ReturnType<typeof createMailStore> | null = null;
		try {
			const mailDbPath = join(root, ".overstory", "mail.db");
			const mailFile = Bun.file(mailDbPath);
			if (await mailFile.exists()) {
				mailStore = createMailStore(mailDbPath);
				const unread = mailStore.getAll({ to: agentName, unread: true });
				unreadMailCount = unread.length;
			}
		} catch {
			// mail db might not exist
		}

		let mergeQueueCount = 0;
		try {
			const queuePath = join(root, ".overstory", "merge-queue.db");
			const queue = createMergeQueue(queuePath);
			mergeQueueCount = queue.list("pending").length;
			queue.close();
		} catch {
			// queue might not exist
		}

		let recentMetricsCount = 0;
		try {
			const metricsDbPath = join(root, ".overstory", "metrics.db");
			const metricsFile = Bun.file(metricsDbPath);
			if (await metricsFile.exists()) {
				const metricsStore = createMetricsStore(metricsDbPath);
				recentMetricsCount = metricsStore.countSessions();
				metricsStore.close();
			}
		} catch {
			// metrics db might not exist
		}

		let verboseDetails: Record<string, VerboseAgentDetail> | undefined;
		if (verbose && sessions.length > 0) {
			verboseDetails = {};
			for (const session of sessions) {
				const logsDir = join(root, ".overstory", "logs", session.agentName);

				let lastMailSent: string | null = null;
				let lastMailReceived: string | null = null;
				if (mailStore) {
					try {
						const sent = mailStore.getAll({ from: session.agentName });
						if (sent.length > 0 && sent[0]) {
							lastMailSent = sent[0].createdAt;
						}
						const received = mailStore.getAll({ to: session.agentName });
						if (received.length > 0 && received[0]) {
							lastMailReceived = received[0].createdAt;
						}
					} catch {
						// Best effort
					}
				}

				verboseDetails[session.agentName] = {
					worktreePath: session.worktreePath,
					logsDir,
					lastMailSent,
					lastMailReceived,
					capability: session.capability,
				};
			}
		}

		if (mailStore) {
			mailStore.close();
		}

		let mission: Mission | null = null;
		let missionRoles: MissionRoleStates | null = null;
		try {
			const sessionsDbPath = join(overstoryDir, "sessions.db");
			const dbFile = Bun.file(sessionsDbPath);
			if (await dbFile.exists()) {
				const missionStore = createMissionStore(sessionsDbPath);
				try {
					mission = missionStore.getActive();
					if (mission) {
						missionRoles = resolveMissionRoleStates(mission, sessions);
					}
				} finally {
					missionStore.close();
				}
			}
		} catch {
			// mission store unavailable
		}

		let artifactStatus: StatusData["artifactStatus"];
		if (mission) {
			try {
				const missionDir = mission.artifactRoot ?? join(overstoryDir, "missions", mission.id);
				const stalenessReport = await computeArtifactStaleness(missionDir);
				const missionArtifacts = stalenessReport.results.map((r) => ({
					type: r.artifactType as string,
					status: r.status as string,
				}));

				let reviews = { total: 0, fresh: 0, stale: 0, underTarget: 0, unscored: 0 };
				const reviewDbPath = join(overstoryDir, "reviews.db");
				const reviewDbFile = Bun.file(reviewDbPath);
				if (await reviewDbFile.exists()) {
					const reviewStore = createReviewStore(reviewDbPath);
					try {
						const subjectTypes: ReviewSubjectType[] = ["session", "handoff", "spec", "mission"];
						let total = 0;
						let fresh = 0;
						let staleCount = 0;
						let underTarget = 0;
						let unscored = 0;
						for (const type of subjectTypes) {
							for (const rec of reviewStore.getByType(type)) {
								total++;
								if (rec.artifactStatus === "fresh") fresh++;
								else if (rec.artifactStatus === "stale") staleCount++;
								else if (rec.artifactStatus === "under-target") underTarget++;
								else if (rec.artifactStatus === "unscored") unscored++;
							}
						}
						reviews = { total, fresh, stale: staleCount, underTarget, unscored };
					} finally {
						reviewStore.close();
					}
				}

				const specMetas = await listSpecMeta(root);
				let specCurrent = 0;
				let specStale = 0;
				let specSuperseded = 0;
				let specUnscored = 0;
				let specUnderTarget = 0;
				for (const s of specMetas) {
					if (s.status === "current") specCurrent++;
					else if (s.status === "stale") specStale++;
					else if (s.status === "superseded") specSuperseded++;
					else if (s.status === "unscored") specUnscored++;
					else if (s.status === "under-target") specUnderTarget++;
				}
				const specs = {
					total: specMetas.length,
					current: specCurrent,
					stale: specStale,
					superseded: specSuperseded,
					unscored: specUnscored,
					underTarget: specUnderTarget,
				};

				artifactStatus = { missionArtifacts, reviews, specs };
			} catch {
				// artifact status unavailable
			}
		}

		let resilience: StatusData["resilience"];
		try {
			const resilienceDbPath = join(root, ".overstory", "resilience.db");
			const resilienceFile = Bun.file(resilienceDbPath);
			if (await resilienceFile.exists()) {
				const resilienceStore = createResilienceStore(resilienceDbPath);
				try {
					const openBreakers = resilienceStore.listOpenBreakers().map((b) => ({
						capability: b.capability,
						since: b.openedAt,
						failureCount: b.failureCount,
					}));
					const activeRetries = resilienceStore.getPendingRetries(100).map((r) => ({
						taskId: r.taskId,
						attempt: r.attempt,
						startedAt: r.startedAt,
					}));
					resilience = { openBreakers, activeRetries, recentReroutes: 0 };
				} finally {
					resilienceStore.close();
				}
			}
		} catch {
			// resilience db unavailable
		}

		let headroom: HeadroomSnapshot[] | undefined;
		try {
			const headroomDbPath = join(root, ".overstory", "headroom.db");
			const headroomFile = Bun.file(headroomDbPath);
			if (await headroomFile.exists()) {
				const headroomStore = createHeadroomStore(headroomDbPath);
				try {
					headroom = headroomStore.getAll();
				} finally {
					headroomStore.close();
				}
			}
		} catch {
			// headroom db unavailable
		}

		return {
			currentRunId: runId,
			agents: sessions,
			worktrees,
			tmuxSessions,
			unreadMailCount,
			mergeQueueCount,
			recentMetricsCount,
			verboseDetails,
			mission,
			missionRoles,
			artifactStatus,
			resilience,
			headroom,
		};
	} finally {
		store.close();
	}
}

function missionStateColor(state: string): (s: string) => string {
	switch (state) {
		case "active":
			return color.green;
		case "frozen":
			return color.yellow;
		case "completed":
			return color.cyan;
		case "failed":
			return color.red;
		case "stopped":
			return color.dim;
		default:
			return (s: string) => s;
	}
}

/**
 * Print status in human-readable format.
 */
export function printStatus(data: StatusData): void {
	const now = Date.now();
	const w = process.stdout.write.bind(process.stdout);

	w(`${renderHeader("Overstory Status")}\n\n`);
	if (data.currentRunId) {
		w(`Run: ${accent(data.currentRunId)}\n`);
	}

	// Mission section (only when active mission exists)
	if (data.mission) {
		const m = data.mission;
		const roles = data.missionRoles;
		const stateColorFn = missionStateColor(m.state);
		const stateStr = stateColorFn(`${m.state}/${m.phase}`);
		w(`Mission: ${accent(m.slug)} (${stateStr})\n`);
		w(`   Objective:    ${m.objective}\n`);
		const pending = m.pendingUserInput ? (m.pendingInputKind ?? "input") : "none";
		w(`   Pending:      ${pending}\n`);
		w(`   First freeze: ${m.firstFreezeAt ?? "never"}\n`);
		w(`   Reopens:      ${m.reopenCount}\n`);
		w(`   Paused:       ${m.pausedWorkstreamIds.length} workstreams\n`);
		if (m.pauseReason) {
			w(`   Pause reason: ${m.pauseReason}\n`);
		}
		w(`   Coordinator:  ${roles?.coordinator ?? "unknown"}\n`);
		w(`   Analyst:      ${roles?.analyst ?? "unknown"}\n`);
		w(`   Exec Dir:     ${roles?.executionDirector ?? "unknown"}\n`);
		w("\n");
	}

	// Artifact status (only when mission is active)
	if (data.artifactStatus) {
		const as = data.artifactStatus;
		w("Artifacts:\n");
		if (as.missionArtifacts.length > 0) {
			w("  Mission:\n");
			for (const a of as.missionArtifacts) {
				const statusColor =
					a.status === "fresh"
						? color.green
						: a.status === "stale"
							? color.yellow
							: a.status === "under-target"
								? color.red
								: (s: string) => s;
				w(`    ${a.type}: ${statusColor(a.status)}\n`);
			}
		}
		const r = as.reviews;
		const reviewParts: string[] = [];
		if (r.fresh > 0) reviewParts.push(color.green(`${r.fresh} fresh`));
		if (r.stale > 0) reviewParts.push(color.yellow(`${r.stale} stale`));
		if (r.underTarget > 0) reviewParts.push(color.red(`${r.underTarget} under-target`));
		if (r.unscored > 0) reviewParts.push(`${r.unscored} unscored`);
		w(`  Reviews: ${r.total}${reviewParts.length > 0 ? ` (${reviewParts.join(", ")})` : ""}\n`);
		const s = as.specs;
		const specParts: string[] = [];
		if (s.current > 0) specParts.push(color.green(`${s.current} current`));
		if (s.stale > 0) specParts.push(color.yellow(`${s.stale} stale`));
		if (s.superseded > 0) specParts.push(`${s.superseded} superseded`);
		if (s.underTarget > 0) specParts.push(color.red(`${s.underTarget} under-target`));
		if (s.unscored > 0) specParts.push(`${s.unscored} unscored`);
		w(`  Specs: ${s.total}${specParts.length > 0 ? ` (${specParts.join(", ")})` : ""}\n`);
		w("\n");
	}

	// Active agents
	const active = data.agents.filter((a) => a.state !== "zombie" && a.state !== "completed");
	w(`Agents: ${active.length} active\n`);
	if (active.length > 0) {
		const tmuxSessionNames = new Set(data.tmuxSessions.map((s) => s.name));
		for (const agent of active) {
			const endTime =
				agent.state === "completed" || agent.state === "zombie"
					? new Date(agent.lastActivity).getTime()
					: now;
			const duration = formatDuration(endTime - new Date(agent.startedAt).getTime());
			const isHeadless = agent.tmuxSession === "" && agent.pid !== null;
			const alive = isHeadless
				? agent.pid !== null && isProcessAlive(agent.pid)
				: tmuxSessionNames.has(agent.tmuxSession);
			const aliveMarker = alive ? color.green(">") : color.red("x");
			w(`   ${aliveMarker} ${accent(agent.agentName)} [${agent.capability}] `);
			w(`${agent.state} | ${accent(agent.taskId)} | ${duration}\n`);

			const detail = data.verboseDetails?.[agent.agentName];
			if (detail) {
				w(`     Worktree: ${detail.worktreePath}\n`);
				w(`     Logs:     ${detail.logsDir}\n`);
				w(`     Mail sent: ${detail.lastMailSent ?? "none"}`);
				w(` | received: ${detail.lastMailReceived ?? "none"}\n`);
			}
		}
	} else {
		w("   No active agents\n");
	}
	w("\n");

	// Worktrees
	const overstoryWts = data.worktrees.filter((wt) => wt.branch.startsWith("overstory/"));
	w(`Worktrees: ${overstoryWts.length}\n`);
	for (const wt of overstoryWts) {
		w(`   ${wt.branch}\n`);
	}
	if (overstoryWts.length === 0) {
		w("   No agent worktrees\n");
	}
	w("\n");

	// Mail
	w(`Mail: ${data.unreadMailCount} unread\n`);

	// Merge queue
	w(`Merge queue: ${data.mergeQueueCount} pending\n`);

	// Metrics
	w(`Sessions recorded: ${data.recentMetricsCount}\n`);

	// Resilience
	if (data.resilience) {
		const r = data.resilience;
		w("\n");
		w(`Resilience:\n`);
		if (r.openBreakers.length > 0) {
			w("  Open breakers:\n");
			for (const b of r.openBreakers) {
				w(`    ${color.red("●")} ${accent(b.capability)} — ${b.failureCount} failures`);
				if (b.since) w(` (since ${b.since})`);
				w("\n");
			}
		} else {
			w("  Breakers: all closed\n");
		}
		if (r.activeRetries.length > 0) {
			w(`  Active retries: ${r.activeRetries.length}\n`);
			for (const rt of r.activeRetries) {
				w(`    ${accent(rt.taskId)} — attempt ${rt.attempt}\n`);
			}
		}
	}

	// Headroom
	if (data.headroom && data.headroom.length > 0) {
		w("\n");
		w("Quota Headroom:\n");
		for (const snap of data.headroom) {
			if (snap.state === "unavailable") {
				w(`  ${accent(snap.runtime)}  unavailable\n`);
			} else {
				let pctStr = "?%";
				if (
					snap.requestsRemaining !== null &&
					snap.requestsLimit !== null &&
					snap.requestsLimit > 0
				) {
					const pct = Math.round((snap.requestsRemaining / snap.requestsLimit) * 100);
					pctStr = `${pct}%`;
				}
				const age = formatRelativeTime(snap.capturedAt);
				w(`  ${accent(snap.runtime)}  ${pctStr} requests remaining (${snap.state}, ${age})\n`);
			}
		}
	}
}

interface StatusOpts {
	json?: boolean;
	watch?: boolean;
	verbose?: boolean;
	all?: boolean;
	interval?: string;
	agent?: string;
}

async function executeStatus(opts: StatusOpts): Promise<void> {
	const json = opts.json ?? false;
	const watch = opts.watch ?? false;
	const verbose = opts.verbose ?? false;
	const all = opts.all ?? false;
	const intervalStr = opts.interval;
	const interval = intervalStr ? Number.parseInt(intervalStr, 10) : 3000;

	if (Number.isNaN(interval) || interval < 500) {
		throw new ValidationError("--interval must be a number >= 500 (milliseconds)", {
			field: "interval",
			value: intervalStr,
		});
	}

	const agentName = opts.agent ?? "orchestrator";

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const root = config.project.root;

	let runId: string | null | undefined;
	if (!all) {
		const overstoryDir = join(root, ".overstory");
		runId = await readCurrentRunId(overstoryDir);
	}

	if (watch) {
		process.stderr.write(
			"Warning: --watch is deprecated. Use 'ov dashboard' for live monitoring.\n\n",
		);
		// Polling loop (kept for one release cycle)
		while (true) {
			// Clear screen
			process.stdout.write("\x1b[2J\x1b[H");
			const data = await gatherStatus(root, agentName, verbose, runId);
			if (json) {
				jsonOutput("status", data as unknown as Record<string, unknown>);
			} else {
				printStatus(data);
			}
			await Bun.sleep(interval);
		}
	} else {
		const data = await gatherStatus(root, agentName, verbose, runId);
		if (json) {
			jsonOutput("status", data as unknown as Record<string, unknown>);
		} else {
			printStatus(data);
		}
	}
}

async function executeStatusSet(
	statusLine: string,
	opts: { agent: string; json?: boolean },
): Promise<void> {
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const root = config.project.root;
	const overstoryDir = join(root, ".overstory");

	const { store } = openSessionStore(overstoryDir);
	try {
		const session = store.getByName(opts.agent);
		if (!session) {
			throw new ValidationError(`No session found for agent: ${opts.agent}`, {
				field: "agent",
				value: opts.agent,
			});
		}
		store.updateStatusLine(opts.agent, statusLine);
		if (opts.json) {
			jsonOutput("status_set", { agent: opts.agent, statusLine });
		}
	} finally {
		store.close();
	}
}

export function createStatusCommand(): Command {
	const cmd = new Command("status")
		.enablePositionalOptions()
		.description("Show all active agents and project state")
		.option("--json", "Output as JSON")
		.option("--verbose", "Show extra detail per agent (worktree, logs, mail timestamps)")
		.option("--agent <name>", "Show unread mail for this agent (default: orchestrator)")
		.option("--all", "Show sessions from all runs (default: current run only)")
		.option("--watch", "(deprecated) Use 'ov dashboard' for live monitoring")
		.option("--interval <ms>", "Poll interval for --watch in milliseconds (default: 3000)")
		.action(async (opts: StatusOpts) => {
			await executeStatus(opts);
		});

	cmd
		.command("set <statusLine>")
		.description("Set agent status line (self-reported current activity)")
		.requiredOption("--agent <name>", "Agent name (use $OVERSTORY_AGENT_NAME)")
		.option("--json", "Output as JSON")
		.action(async (statusLine: string, opts: { agent: string; json?: boolean }) => {
			await executeStatusSet(statusLine, opts);
		});

	return cmd;
}

export async function statusCommand(args: string[]): Promise<void> {
	const cmd = createStatusCommand();
	cmd.exitOverride();
	try {
		await cmd.parseAsync(args, { from: "user" });
	} catch (err: unknown) {
		if (err && typeof err === "object" && "code" in err) {
			const code = (err as { code: string }).code;
			if (code === "commander.helpDisplayed" || code === "commander.version") {
				return;
			}
		}
		throw err;
	}
}
