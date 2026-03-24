/**
 * `ov prime` command.
 *
 * Loads context for the orchestrator or a specific agent and outputs it
 * to stdout for injection into Claude Code's context via hooks.
 *
 * Called by the SessionStart hook.
 */

import { join } from "node:path";
import { loadCheckpoint } from "../agents/checkpoint.ts";
import { loadIdentity } from "../agents/identity.ts";
import { createManifestLoader } from "../agents/manifest.ts";
import { loadConfig } from "../config.ts";
import type { ProjectContext } from "../context/types.ts";
import { jsonOutput } from "../json.ts";
import { printWarning } from "../logging/color.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { createMulchClient } from "../mulch/client.ts";
import type { EmbeddingProvider } from "../mulch/semantic.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentIdentity, AgentManifest, SessionCheckpoint, SessionMetrics } from "../types.ts";
import { getCurrentSessionName } from "../worktree/tmux.ts";
import { OVERSTORY_GITIGNORE } from "./init.ts";

/** Subset of mulch config that may carry semantic settings. */
interface MulchSemanticConfig {
	enabled: boolean;
	provider: EmbeddingProvider;
	model: string;
}

/**
 * Load a cached ProjectContext from disk. Returns null if missing, unreadable, or invalid.
 * Non-fatal: all failures are silently caught.
 */
export async function loadCachedProjectContext(
	projectRoot: string,
	cachePath: string,
): Promise<ProjectContext | null> {
	try {
		const fullPath = join(projectRoot, cachePath);
		const file = Bun.file(fullPath);
		if (!(await file.exists())) return null;
		const data = JSON.parse(await file.text());
		if (data && typeof data === "object" && data.version === 1 && data.signals) {
			return data as ProjectContext;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Render a compact single-paragraph summary of a ProjectContext.
 * Output is intentionally brief (< 2KB) for injection into overlays and prime output.
 */
export function renderCompactContext(ctx: ProjectContext): string {
	const lines: string[] = [];
	const s = ctx.signals;

	if (s.languages.length > 0) {
		const langs = s.languages.map((l) => {
			let desc = l.language;
			if (l.framework) desc += `/${l.framework}`;
			if (l.packageManager) desc += ` (${l.packageManager})`;
			return desc;
		});
		lines.push(`**Stack:** ${langs.join(", ")}`);
	}

	if (s.directoryProfile.sourceRoots.length > 0) {
		lines.push(
			`**Source roots:** ${s.directoryProfile.sourceRoots.map((r) => `\`${r}\``).join(", ")}`,
		);
	}

	if (s.testConventions.framework) {
		lines.push(`**Tests:** ${s.testConventions.framework} (${s.testConventions.filePattern})`);
	}

	if (s.errorPatterns.baseClass) {
		lines.push(`**Errors:** extends \`${s.errorPatterns.baseClass}\``);
	}

	if (s.namingVocabulary.conventions.length > 0) {
		const conv = s.namingVocabulary.conventions.map((c) => c.description).join(", ");
		lines.push(`**Naming:** ${conv}`);
	}

	if (s.importHotspots.length > 0) {
		const top = s.importHotspots.slice(0, 5).map((h) => `\`${h.module}\` (${h.importCount})`);
		lines.push(`**Key modules:** ${top.join(", ")}`);
	}

	if (s.sharedInvariants.length > 0) {
		const invs = s.sharedInvariants.map((i) => i.description);
		lines.push(`**Invariants:** ${invs.join("; ")}`);
	}

	return lines.join("\n");
}

export interface PrimeOptions {
	agent?: string;
	compact?: boolean;
	json?: boolean;
	/** Override the instruction path referenced in agent activation context. Defaults to ".claude/CLAUDE.md". */
	instructionPath?: string;
	/** Files to use as context signal for semantic reranking. Requires mulch.semantic.enabled: true in config. */
	files?: string[];
}

/**
 * Format the agent manifest section for output.
 */
function formatManifest(manifest: AgentManifest): string {
	const lines: string[] = [];
	for (const [name, def] of Object.entries(manifest.agents)) {
		const caps = def.capabilities.join(", ");
		const spawn = def.canSpawn ? " (can spawn)" : "";
		lines.push(`- **${name}** [${def.model}]: ${caps}${spawn}`);
	}
	return lines.length > 0 ? lines.join("\n") : "No agents registered.";
}

/**
 * Format recent session metrics for output.
 */
function formatMetrics(sessions: SessionMetrics[]): string {
	if (sessions.length === 0) {
		return "No recent sessions.";
	}

	const lines: string[] = [];
	for (const s of sessions) {
		const status = s.completedAt !== null ? "completed" : "in-progress";
		const duration = s.durationMs > 0 ? ` (${Math.round(s.durationMs / 1000)}s)` : "";
		const merge = s.mergeResult !== null ? ` [${s.mergeResult}]` : "";
		lines.push(`- ${s.agentName} (${s.capability}): ${s.taskId} — ${status}${duration}${merge}`);
	}
	return lines.join("\n");
}

/**
 * Format agent identity for output.
 */
function formatIdentity(identity: AgentIdentity): string {
	const lines: string[] = [];
	lines.push(`Name: ${identity.name}`);
	lines.push(`Capability: ${identity.capability}`);
	lines.push(`Sessions completed: ${identity.sessionsCompleted}`);

	if (identity.expertiseDomains.length > 0) {
		lines.push(`Expertise: ${identity.expertiseDomains.join(", ")}`);
	}

	if (identity.recentTasks.length > 0) {
		lines.push("Recent tasks:");
		for (const task of identity.recentTasks) {
			lines.push(`  - ${task.taskId}: ${task.summary} (${task.completedAt})`);
		}
	}

	return lines.join("\n");
}

/**
 * Format checkpoint recovery section for compact priming.
 */
function formatCheckpointRecovery(checkpoint: SessionCheckpoint): string {
	const lines: string[] = [];
	lines.push("\n## Session Recovery");
	lines.push("");
	lines.push("You are resuming from a previous session that was compacted.");
	lines.push("");
	lines.push(`**Progress so far:** ${checkpoint.progressSummary}`);
	lines.push(`**Files modified:** ${checkpoint.filesModified.join(", ") || "none"}`);
	lines.push(`**Pending work:** ${checkpoint.pendingWork}`);
	lines.push(`**Branch:** ${checkpoint.currentBranch}`);
	return lines.join("\n");
}

/**
 * Auto-heal .overstory/.gitignore if its content differs from the template.
 * Ensures existing projects get updated gitignore on session start.
 */
async function healGitignore(overstoryDir: string): Promise<void> {
	const gitignorePath = join(overstoryDir, ".gitignore");
	try {
		const current = await Bun.file(gitignorePath).text();
		if (current === OVERSTORY_GITIGNORE) {
			return; // Already up to date
		}
	} catch {
		// File does not exist — write it fresh
	}
	await Bun.write(gitignorePath, OVERSTORY_GITIGNORE);
}

/**
 * Format a single mulch record (from semantic search result) as plain text for expertise output.
 */
function formatSemanticRecord(record: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const key of ["content", "description", "title", "rationale", "name"]) {
		const v = record[key];
		if (typeof v === "string" && v) parts.push(v);
	}
	return parts.join(" ");
}

/**
 * Prime command entry point.
 *
 * Gathers project state and outputs context to stdout for injection
 * into Claude Code's context.
 *
 * @param opts - Command options
 */
export async function primeCommand(opts: PrimeOptions): Promise<void> {
	const agentName = opts.agent ?? null;
	const compact = opts.compact ?? false;
	const useJson = opts.json ?? false;
	const instructionPath = opts.instructionPath ?? ".claude/CLAUDE.md";
	const contextFiles = opts.files ?? [];

	// 1. Load config
	const config = await loadConfig(process.cwd());

	// 2. Auto-heal .overstory/.gitignore
	const overstoryDir = join(config.project.root, ".overstory");
	await healGitignore(overstoryDir);

	// Resolve optional semantic config (field may not be present in config type)
	const mulchWithSemantic = config.mulch as {
		enabled: boolean;
		domains: string[];
		primeFormat: string;
		semantic?: MulchSemanticConfig;
	};
	const semanticCfg = mulchWithSemantic.semantic;
	const semanticEnabled = semanticCfg?.enabled === true;

	// 3. Load mulch expertise (optional — skip on failure)
	let expertiseOutput: string | null = null;
	if (!compact && config.mulch.enabled) {
		try {
			const mulch = createMulchClient(config.project.root, semanticCfg);
			const domains = config.mulch.domains.length > 0 ? config.mulch.domains : undefined;

			if (semanticEnabled) {
				if (contextFiles.length === 0) {
					// FIX 2: Semantic requires a context signal — exit with error
					process.stderr.write(
						"Error: mulch.semantic.enabled is true but no --files context signal provided\n",
					);
					process.exit(1);
				}
				// FIX 1: Use semanticSearch() to rerank records instead of passing --files to prime
				const query = contextFiles.join(" ");
				const semanticResults = await mulch.semanticSearch?.(query, {
					domain: domains?.length === 1 ? domains[0] : undefined,
				});
				if (semanticResults && semanticResults.length > 0) {
					// Format semantically ranked records as expertise output
					expertiseOutput = semanticResults
						.map((r) => formatSemanticRecord(r.record))
						.filter(Boolean)
						.join("\n");
				} else {
					// Embeddings unavailable — fall back to standard prime with warning
					printWarning("Semantic embeddings unavailable; using standard prime output");
					expertiseOutput = await mulch.prime(domains, config.mulch.primeFormat);
				}
			} else {
				expertiseOutput = await mulch.prime(domains, config.mulch.primeFormat);
			}
		} catch {
			// Mulch is optional — silently skip if it fails
		}
	}

	// 4. Output context (orchestrator or agent)
	if (useJson) {
		// Capture context as text, wrap in JSON envelope
		const capture: string[] = [];
		const origWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = (chunk: string | Uint8Array) => {
			capture.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		};
		try {
			if (agentName !== null) {
				await outputAgentContext(config, agentName, compact, expertiseOutput, instructionPath);
			} else {
				await outputOrchestratorContext(config, compact, expertiseOutput);
			}
		} finally {
			process.stdout.write = origWrite;
		}
		jsonOutput("prime", {
			agent: agentName,
			compact,
			context: capture.join(""),
		});
	} else {
		if (agentName !== null) {
			await outputAgentContext(config, agentName, compact, expertiseOutput, instructionPath);
		} else {
			await outputOrchestratorContext(config, compact, expertiseOutput);
		}
	}
}

/**
 * Output context for a specific agent.
 */
async function outputAgentContext(
	config: Awaited<ReturnType<typeof loadConfig>>,
	agentName: string,
	compact: boolean,
	expertiseOutput: string | null,
	instructionPath: string,
): Promise<void> {
	const sections: string[] = [];

	sections.push(`# Agent Context: ${agentName}`);

	// Check if the agent exists in the SessionStore or has an identity file
	const overstoryDir = join(config.project.root, ".overstory");
	const { store } = openSessionStore(overstoryDir);
	let sessionExists = false;
	let boundSession: { taskId: string } | null = null;
	try {
		const agentSession = store.getByName(agentName);
		sessionExists = agentSession !== null;
		if (
			agentSession &&
			agentSession.state !== "completed" &&
			agentSession.state !== "zombie" &&
			agentSession.taskId
		) {
			boundSession = { taskId: agentSession.taskId };
		}
	} finally {
		store.close();
	}

	// Identity section
	let identity: AgentIdentity | null = null;
	try {
		const baseDir = join(config.project.root, ".overstory", "agents");
		identity = await loadIdentity(baseDir, agentName);
	} catch {
		// Identity may not exist yet
	}

	// Warn if agent is completely unknown (no session and no identity)
	if (!sessionExists && identity === null) {
		printWarning(`agent "${agentName}" not found in sessions or identity store.`);
	}

	sections.push("\n## Identity");
	if (identity !== null) {
		sections.push(formatIdentity(identity));
	} else {
		sections.push("New agent - no prior sessions");
	}

	// Activation context: if agent has a bound task, inject it
	if (boundSession) {
		sections.push("\n## Activation");
		sections.push(`You have a bound task: **${boundSession.taskId}**`);
		sections.push(`Read your overlay at \`${instructionPath}\` and begin working immediately.`);
		sections.push("Do not wait for dispatch mail. Your assignment was bound at spawn time.");
	}

	// In compact mode, check for checkpoint recovery
	if (compact) {
		const baseDir = join(config.project.root, ".overstory", "agents");
		const checkpoint = await loadCheckpoint(baseDir, agentName);
		if (checkpoint !== null) {
			sections.push(formatCheckpointRecovery(checkpoint));
		}
	}

	// In compact mode, skip expertise
	if (!compact && expertiseOutput !== null) {
		sections.push("\n## Expertise");
		sections.push(expertiseOutput.trim());
	}

	// Project Context section (skipped in compact mode)
	if (!compact && config.context?.enabled !== false) {
		const cachePath = config.context?.cachePath ?? ".overstory/project-context.json";
		const cached = await loadCachedProjectContext(config.project.root, cachePath);
		if (cached) {
			const rendered = renderCompactContext(cached);
			if (rendered.trim().length > 0) {
				sections.push("\n## Project Context");
				sections.push(rendered);
			}
		}
	}

	process.stdout.write(`${sections.join("\n")}\n`);
}

/**
 * Output context for the orchestrator.
 */
async function outputOrchestratorContext(
	config: Awaited<ReturnType<typeof loadConfig>>,
	compact: boolean,
	expertiseOutput: string | null,
): Promise<void> {
	// Register orchestrator tmux session for reverse-nudge (agents → orchestrator)
	try {
		const tmuxSession = await getCurrentSessionName();
		if (tmuxSession) {
			const regPath = join(config.project.root, ".overstory", "orchestrator-tmux.json");
			await Bun.write(
				regPath,
				`${JSON.stringify({ tmuxSession, registeredAt: new Date().toISOString() }, null, "\t")}\n`,
			);
		}
	} catch {
		// Tmux detection is optional — silently skip
	}

	// Record the orchestrator's current branch for merge targeting
	let sessionBranch: string | null = null;
	try {
		const branchProc = Bun.spawn(["git", "symbolic-ref", "--short", "HEAD"], {
			cwd: config.project.root,
			stdout: "pipe",
			stderr: "pipe",
		});
		const branchExit = await branchProc.exited;
		if (branchExit === 0) {
			const branch = (await new Response(branchProc.stdout).text()).trim();
			if (branch) {
				sessionBranch = branch;
				const sessionBranchPath = join(config.project.root, ".overstory", "session-branch.txt");
				await Bun.write(sessionBranchPath, `${branch}\n`);
			}
		}
	} catch {
		// Branch detection is optional — silently skip
	}

	const sections: string[] = [];

	// Project section
	sections.push("# Overstory Context");
	sections.push(`\n## Project: ${config.project.name}`);
	sections.push(`Canonical branch: ${config.project.canonicalBranch}`);
	if (sessionBranch && sessionBranch !== config.project.canonicalBranch) {
		sections.push(`Session branch: ${sessionBranch} (merge target)`);
	}
	sections.push(`Max concurrent agents: ${config.agents.maxConcurrent}`);
	sections.push(`Max depth: ${config.agents.maxDepth}`);

	// Agent manifest section
	sections.push("\n## Agent Manifest");
	try {
		const manifestPath = join(config.project.root, config.agents.manifestPath);
		const baseDir = join(config.project.root, config.agents.baseDir);
		const loader = createManifestLoader(manifestPath, baseDir);
		const manifest = await loader.load();
		sections.push(formatManifest(manifest));
	} catch {
		sections.push("No agent manifest found.");
	}

	// In compact mode, skip metrics and expertise
	if (!compact) {
		// Recent activity section
		sections.push("\n## Recent Activity");
		try {
			const metricsPath = join(config.project.root, ".overstory", "metrics.db");
			const store = createMetricsStore(metricsPath);
			try {
				const sessions = store.getRecentSessions(5);
				sections.push(formatMetrics(sessions));
			} finally {
				store.close();
			}
		} catch {
			sections.push("No metrics available.");
		}

		// Expertise section
		if (expertiseOutput !== null) {
			sections.push("\n## Expertise");
			sections.push(expertiseOutput.trim());
		}

		// Project Context section
		if (config.context?.enabled !== false) {
			const cachePath = config.context?.cachePath ?? ".overstory/project-context.json";
			const cached = await loadCachedProjectContext(config.project.root, cachePath);
			if (cached) {
				const rendered = renderCompactContext(cached);
				if (rendered.trim().length > 0) {
					sections.push("\n## Project Context");
					sections.push(rendered);
				}
			}
		}
	}

	process.stdout.write(`${sections.join("\n")}\n`);
}
