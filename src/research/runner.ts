import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	getPersistentAgentStatus,
	startPersistentAgent,
	stopPersistentAgent,
} from "../agents/persistent-root.ts";
import { loadConfig } from "../config.ts";
import { AgentError, ValidationError } from "../errors.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { validateMcpKeys } from "./mcp.ts";
import { readReport } from "./output.ts";
import type { ResearchReport, ResearchSession } from "./types.ts";

// === Utilities ===

/**
 * Convert a topic string into a URL-safe slug.
 * Strips non-ascii, lowercases, replaces non-alphanumeric runs with hyphens,
 * collapses multiple hyphens, trims leading/trailing hyphens, truncates to 60 chars.
 */
export function slugifyTopic(topic: string): string {
	let slug = topic.toLowerCase();
	// Strip non-ascii characters (keep only printable ASCII range)
	slug = slug.replace(/[^\u0020-\u007e]/g, "");
	// Replace non-alphanumeric characters with hyphens
	slug = slug.replace(/[^a-z0-9]+/g, "-");
	// Collapse multiple hyphens
	slug = slug.replace(/-{2,}/g, "-");
	// Trim leading/trailing hyphens
	slug = slug.replace(/^-+|-+$/g, "");
	// Truncate to 60 chars
	if (slug.length > 60) {
		slug = slug.slice(0, 60);
		// Trim trailing hyphen after truncation
		slug = slug.replace(/-+$/, "");
	}
	return slug;
}

/**
 * Resolve a slug that doesn't collide with existing directories.
 * If <outputBase>/<baseSlug>/ doesn't exist, returns baseSlug.
 * Otherwise appends -2, -3, etc. until a unique name is found.
 */
export function resolveUniqueSlug(baseSlug: string, outputBase: string): string {
	if (!existsSync(join(outputBase, baseSlug))) {
		return baseSlug;
	}
	let counter = 2;
	while (existsSync(join(outputBase, `${baseSlug}-${counter}`))) {
		counter++;
	}
	return `${baseSlug}-${counter}`;
}

/**
 * Clamp maxResearchers to the valid range [1, 20].
 */
export function validateMaxResearchers(n: number): number {
	return Math.max(1, Math.min(20, Math.round(n)));
}

// === Beacon Builder ===

function buildResearchBeacon(
	agentName: string,
	topic: string,
	maxResearchers: number,
	outputPath: string,
): string {
	const timestamp = new Date().toISOString();
	const parts = [
		`[OVERSTORY] ${agentName} (research-lead) ${timestamp}`,
		`Role: research lead | Topic: ${topic} | Max researchers: ${maxResearchers} | Output: ${outputPath}`,
		`Startup: run mulch prime, validate MCP tools, then spawn up to ${maxResearchers} researcher agents to gather information on the topic and synthesize a report.`,
	];
	return parts.join(" — ");
}

// === Slug Resolution from Agent Name ===

function agentNameToSlug(agentName: string): string {
	if (agentName.startsWith("research-")) {
		return agentName.slice("research-".length);
	}
	return agentName;
}

function resolveAgentName(nameOrSlug: string): string {
	if (nameOrSlug.startsWith("research-")) {
		return nameOrSlug;
	}
	return `research-${nameOrSlug}`;
}

// === Core Functions ===

export interface StartResearchOpts {
	topic: string;
	name?: string;
	maxResearchers?: number;
	attach?: boolean;
	watchdog?: boolean;
	json?: boolean;
}

/**
 * Start a new research session for the given topic.
 * Validates MCP keys, creates output directory, spawns research-lead agent.
 */
export async function startResearch(
	opts: StartResearchOpts,
): Promise<{ slug: string; agentName: string; runId: string }> {
	const validation = validateMcpKeys();
	if (!validation.valid) {
		throw new ValidationError(validation.error ?? "MCP key validation failed", {});
	}

	const maxResearchers = validateMaxResearchers(opts.maxResearchers ?? 5);
	const baseSlug = slugifyTopic(opts.topic);

	const config = await loadConfig(process.cwd());
	const projectRoot = config.project.root;
	const overstoryDir = join(projectRoot, ".overstory");
	const outputBase = config.research?.outputDir ?? join(overstoryDir, "research");

	const slug = resolveUniqueSlug(baseSlug, outputBase);
	const outputPath = join(outputBase, slug);
	mkdirSync(outputPath, { recursive: true });

	const agentName = opts.name ?? `research-${slug}`;
	const beacon = buildResearchBeacon(agentName, opts.topic, maxResearchers, outputPath);

	const result = await startPersistentAgent({
		agentName,
		capability: "research-lead",
		projectRoot,
		overstoryDir,
		tmuxSession: `overstory-research-${slug}`,
		createRun: true,
		beacon,
	});

	if (!result.runId) {
		throw new AgentError("startPersistentAgent did not return a runId", { agentName });
	}
	return { slug, agentName, runId: result.runId };
}

/**
 * Stop a running research session.
 * Stops all child researchers in parallel, then stops the lead agent.
 */
export async function stopResearch(nameOrSlug?: string): Promise<void> {
	const config = await loadConfig(process.cwd());
	const projectRoot = config.project.root;
	const overstoryDir = join(projectRoot, ".overstory");

	let agentName: string;
	if (nameOrSlug !== undefined) {
		agentName = resolveAgentName(nameOrSlug);
	} else {
		// Find most recent active research-lead session
		const { store } = openSessionStore(overstoryDir);
		try {
			const all = store.getAll();
			const leads = all
				.filter(
					(s) =>
						s.capability === "research-lead" && s.state !== "completed" && s.state !== "zombie",
				)
				.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
			const lead = leads[0];
			if (!lead) {
				throw new AgentError("No active research session found", { agentName: "research" });
			}
			agentName = lead.agentName;
		} finally {
			store.close();
		}
	}

	// Find children via run ID
	const { store } = openSessionStore(overstoryDir);
	let runId: string | null = null;
	let children: string[] = [];
	try {
		const session = store.getByName(agentName);
		if (session?.runId) {
			runId = session.runId;
			const childSessions = store.getByRun(runId);
			children = childSessions
				.filter((s) => s.agentName !== agentName && s.state !== "completed" && s.state !== "zombie")
				.map((s) => s.agentName);
		}
	} finally {
		store.close();
	}

	// Stop children in parallel
	await Promise.allSettled(
		children.map((childName) =>
			stopPersistentAgent(childName, { projectRoot, overstoryDir, runStatus: "stopped" }),
		),
	);

	// Stop the lead last
	await stopPersistentAgent(agentName, { projectRoot, overstoryDir, runStatus: "stopped" });

	// Update report frontmatter status if report exists
	const slug = agentNameToSlug(agentName);
	const outputBase = config.research?.outputDir ?? join(overstoryDir, "research");
	const reportPath = join(outputBase, slug, "report.md");
	if (existsSync(reportPath)) {
		try {
			const content = await Bun.file(reportPath).text();
			const updated = content.replace(/^(status:\s*).*$/m, "$1stopped");
			await Bun.write(reportPath, updated);
		} catch {
			// Non-fatal: report update failure should not break stop
		}
	}
}

/**
 * Get the status of a research session.
 * Session store is authoritative; report file supplements with extra fields.
 */
export async function getResearchStatus(nameOrSlug?: string): Promise<ResearchSession | null> {
	const config = await loadConfig(process.cwd());
	const projectRoot = config.project.root;
	const overstoryDir = join(projectRoot, ".overstory");
	const outputBase = config.research?.outputDir ?? join(overstoryDir, "research");

	let agentName: string;
	if (nameOrSlug !== undefined) {
		agentName = resolveAgentName(nameOrSlug);
	} else {
		const { store } = openSessionStore(overstoryDir);
		try {
			const all = store.getAll();
			const leads = all
				.filter((s) => s.capability === "research-lead")
				.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
			const lead = leads[0];
			if (!lead) return null;
			agentName = lead.agentName;
		} finally {
			store.close();
		}
	}

	const status = await getPersistentAgentStatus(agentName, { projectRoot, overstoryDir });
	if (!status) return null;

	const slug = agentNameToSlug(agentName);
	const reportPath = join(outputBase, slug, "report.md");

	// Supplement with report data if available
	let report: ResearchReport | null = null;
	try {
		report = await readReport(reportPath);
	} catch {
		// Non-fatal
	}

	const session: ResearchSession = {
		slug,
		topic: report?.topic ?? slug,
		agentName,
		status: status.running ? "running" : (report?.status ?? "stopped"),
		startedAt: status.startedAt,
		reportPath,
	};

	return session;
}

/**
 * List all research sessions (research-lead capability), sorted by startedAt descending.
 */
export async function listResearch(): Promise<ResearchSession[]> {
	const config = await loadConfig(process.cwd());
	const projectRoot = config.project.root;
	const overstoryDir = join(projectRoot, ".overstory");
	const outputBase = config.research?.outputDir ?? join(overstoryDir, "research");

	const { store } = openSessionStore(overstoryDir);
	let sessions: ResearchSession[];
	try {
		const all = store.getAll();
		const leads = all
			.filter((s) => s.capability === "research-lead")
			.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

		sessions = leads.map((s) => {
			const slug = agentNameToSlug(s.agentName);
			const reportPath = join(outputBase, slug, "report.md");
			return {
				slug,
				topic: slug,
				agentName: s.agentName,
				status: (s.state === "working" ? "running" : "stopped") as ResearchSession["status"],
				startedAt: s.startedAt,
				reportPath,
			};
		});
	} finally {
		store.close();
	}

	return sessions;
}

/**
 * Get the output report for a research session.
 * Returns the file content (or path if opts.path is true), or null if not found.
 */
export async function getResearchOutput(
	nameOrSlug?: string,
	opts?: { path?: boolean },
): Promise<string | null> {
	const config = await loadConfig(process.cwd());
	const projectRoot = config.project.root;
	const overstoryDir = join(projectRoot, ".overstory");
	const outputBase = config.research?.outputDir ?? join(overstoryDir, "research");

	let agentName: string;
	if (nameOrSlug !== undefined) {
		agentName = resolveAgentName(nameOrSlug);
	} else {
		const { store } = openSessionStore(overstoryDir);
		try {
			const all = store.getAll();
			const leads = all
				.filter((s) => s.capability === "research-lead")
				.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
			const lead = leads[0];
			if (!lead) return null;
			agentName = lead.agentName;
		} finally {
			store.close();
		}
	}

	const slug = agentNameToSlug(agentName);
	const reportPath = join(outputBase, slug, "report.md");

	if (!existsSync(reportPath)) return null;

	if (opts?.path) return reportPath;

	try {
		return await Bun.file(reportPath).text();
	} catch {
		return null;
	}
}
