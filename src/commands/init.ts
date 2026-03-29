/**
 * CLI command: ov init [--force] [--yes|-y] [--name <name>]
 *
 * Scaffolds the `.overstory/` directory in the current project with:
 * - config.yaml (serialized from DEFAULT_CONFIG)
 * - agent-manifest.json (starter agent definitions)
 * - hooks.json (central hooks config)
 * - Required subdirectories (agents/, worktrees/, specs/, logs/)
 * - .gitignore entries for transient files
 */

import { Database } from "bun:sqlite";
import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { DEFAULT_CONFIG } from "../config.ts";
import { serializeConfigToYaml } from "../config-yaml.ts";
import type { OnboardStatus, Spawner, ToolStatus } from "../ecosystem/bootstrap.ts";
import {
	defaultSpawner,
	initSiblingTool,
	onboardTool,
	resolveToolSet,
	SIBLING_TOOLS,
	setupGitattributes,
} from "../ecosystem/bootstrap.ts";
import { ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { printHint, printSuccess, printWarning } from "../logging/color.ts";
import type { AgentManifest } from "../types.ts";

const OVERSTORY_DIR = ".overstory";

// Re-export types and functions that external consumers import from this module.
export type { Spawner } from "../ecosystem/bootstrap.ts";
export { resolveToolSet } from "../ecosystem/bootstrap.ts";

/**
 * Detect the project name from git or fall back to directory name.
 */
async function detectProjectName(root: string): Promise<string> {
	// Try git remote origin
	try {
		const proc = Bun.spawn(["git", "remote", "get-url", "origin"], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode === 0) {
			const url = (await new Response(proc.stdout).text()).trim();
			// Extract repo name from URL: git@host:user/repo.git or https://host/user/repo.git
			const match = url.match(/\/([^/]+?)(?:\.git)?$/);
			if (match?.[1]) {
				return match[1];
			}
		}
	} catch {
		// Git not available or not a git repo
	}

	return basename(root);
}

/**
 * Detect the canonical branch name from git.
 */
async function detectCanonicalBranch(root: string): Promise<string> {
	try {
		const proc = Bun.spawn(["git", "symbolic-ref", "refs/remotes/origin/HEAD"], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode === 0) {
			const ref = (await new Response(proc.stdout).text()).trim();
			// refs/remotes/origin/main -> main
			const branch = ref.split("/").pop();
			if (branch) {
				return branch;
			}
		}
	} catch {
		// Not available
	}

	// Fall back to checking current branch
	try {
		const proc = Bun.spawn(["git", "branch", "--show-current"], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode === 0) {
			const branch = (await new Response(proc.stdout).text()).trim();
			if (branch) {
				return branch;
			}
		}
	} catch {
		// Not available
	}

	return "main";
}

/**
 * Build the starter agent manifest.
 */
export function buildAgentManifest(): AgentManifest {
	const agents: AgentManifest["agents"] = {
		scout: {
			file: "scout.md",
			model: "haiku",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["explore", "research"],
			canSpawn: false,
			constraints: ["read-only"],
		},
		builder: {
			file: "builder.md",
			model: "sonnet",
			tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
			capabilities: ["implement", "refactor", "fix"],
			canSpawn: false,
			constraints: [],
		},
		reviewer: {
			file: "reviewer.md",
			model: "sonnet",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["review", "validate"],
			canSpawn: false,
			constraints: ["read-only"],
		},
		lead: {
			file: "lead.md",
			model: "opus",
			tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Task"],
			capabilities: ["coordinate", "implement", "review"],
			canSpawn: true,
			constraints: [],
		},
		merger: {
			file: "merger.md",
			model: "sonnet",
			tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
			capabilities: ["merge", "resolve-conflicts"],
			canSpawn: false,
			constraints: [],
		},
		coordinator: {
			file: "coordinator.md",
			model: "opus",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["coordinate", "dispatch", "escalate"],
			canSpawn: true,
			constraints: ["read-only", "no-worktree"],
		},
		"coordinator-mission": {
			file: "coordinator-mission.md",
			model: "opus",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["coordinate", "dispatch", "escalate", "mission"],
			canSpawn: true,
			constraints: ["read-only", "no-worktree"],
		},
		"mission-analyst": {
			file: "mission-analyst.md",
			model: "opus",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["research", "analyze", "synthesize", "mission"],
			canSpawn: true,
			constraints: ["read-only", "no-worktree"],
		},
		"execution-director": {
			file: "execution-director.md",
			model: "opus",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["dispatch", "coordinate", "execute", "mission"],
			canSpawn: true,
			constraints: ["read-only", "no-worktree"],
		},
		"lead-mission": {
			file: "lead-mission.md",
			model: "opus",
			tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Task"],
			capabilities: ["coordinate", "implement", "review", "mission-workstream"],
			canSpawn: true,
			constraints: [],
		},
		"plan-review-lead": {
			file: "plan-review-lead.md",
			model: "opus",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["review", "coordinate", "plan-review"],
			canSpawn: true,
			constraints: ["read-only", "no-worktree"],
		},
		"plan-devil-advocate": {
			file: "plan-devil-advocate.md",
			model: "sonnet",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["review", "plan-critic", "plan-risk"],
			canSpawn: false,
			constraints: ["read-only", "no-worktree"],
		},
		"plan-security-critic": {
			file: "plan-security-critic.md",
			model: "sonnet",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["review", "plan-critic", "security"],
			canSpawn: false,
			constraints: ["read-only", "no-worktree"],
		},
		"plan-performance-critic": {
			file: "plan-performance-critic.md",
			model: "sonnet",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["review", "plan-critic", "performance"],
			canSpawn: false,
			constraints: ["read-only", "no-worktree"],
		},
		"plan-second-opinion": {
			file: "plan-second-opinion.md",
			model: "sonnet",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["review", "plan-critic", "independent-validation"],
			canSpawn: false,
			constraints: ["read-only", "no-worktree"],
		},
		"plan-simulator": {
			file: "plan-simulator.md",
			model: "sonnet",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["review", "plan-critic", "simulation"],
			canSpawn: false,
			constraints: ["read-only", "no-worktree"],
		},
		monitor: {
			file: "monitor.md",
			model: "sonnet",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["monitor", "patrol"],
			canSpawn: false,
			constraints: ["read-only", "no-worktree"],
		},
		"research-lead": {
			file: "research-lead.md",
			model: "opus",
			tools: ["Read", "Write", "Glob", "Grep", "Bash", "Agent"],
			capabilities: ["research-lead"],
			canSpawn: true,
			constraints: ["no-worktree"],
		},
		researcher: {
			file: "researcher.md",
			model: "opus",
			tools: ["Read", "Glob", "Grep", "Bash", "mcp"],
			capabilities: ["researcher"],
			canSpawn: false,
			constraints: ["read-only"],
		},
		architect: {
			file: "architect.md",
			model: "opus",
			tools: ["Read", "Glob", "Grep", "Bash", "Write"],
			capabilities: ["architect", "design"],
			canSpawn: true,
			constraints: ["no-worktree"],
		},
		tester: {
			file: "tester.md",
			model: "sonnet",
			tools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit"],
			capabilities: ["tester", "test-write"],
			canSpawn: false,
			constraints: [],
		},
		"architecture-review-lead": {
			file: "architecture-review-lead.md",
			model: "opus",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["review", "coordinate", "architecture-review"],
			canSpawn: true,
			constraints: ["read-only", "no-worktree"],
		},
		"plan-architecture-critic": {
			file: "plan-architecture-critic.md",
			model: "sonnet",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["review", "plan-critic", "architecture"],
			canSpawn: false,
			constraints: ["read-only", "no-worktree"],
		},
		"architecture-sync": {
			file: "architecture-sync.md",
			model: "sonnet",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["architecture-sync", "knowledge-extraction"],
			canSpawn: false,
			constraints: ["read-only", "no-worktree"],
		},
	};

	// Build capability index: map each capability to agent names that declare it
	const capabilityIndex: Record<string, string[]> = {};
	for (const [name, def] of Object.entries(agents)) {
		for (const cap of def.capabilities) {
			const existing = capabilityIndex[cap];
			if (existing) {
				existing.push(name);
			} else {
				capabilityIndex[cap] = [name];
			}
		}
	}

	return { version: "1.0", agents, capabilityIndex };
}

/**
 * Build the hooks.json content for the project orchestrator.
 *
 * Always generates from scratch (not from the agent template, which contains
 * {{AGENT_NAME}} placeholders and space indentation). Uses tab indentation
 * to match Biome formatting rules.
 */
export function buildHooksJson(): string {
	// Tool name extraction: reads hook stdin JSON and extracts tool_name field.
	// Claude Code sends {"tool_name":"Bash","tool_input":{...}} on stdin for
	// PreToolUse/PostToolUse hooks.
	const toolNameExtract =
		'read -r INPUT; TOOL_NAME=$(echo "$INPUT" | sed \'s/.*"tool_name": *"\\([^"]*\\)".*/\\1/\');';

	const hooks = {
		hooks: {
			SessionStart: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: "ov prime --agent orchestrator",
						},
					],
				},
			],
			UserPromptSubmit: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: "ov mail check --inject --agent orchestrator",
						},
					],
				},
			],
			PreToolUse: [
				{
					matcher: "Bash",
					hooks: [
						{
							type: "command",
							command:
								'read -r INPUT; CMD=$(echo "$INPUT" | sed \'s/.*"command": *"\\([^"]*\\)".*/\\1/\'); if echo "$CMD" | grep -qE \'\\bgit\\s+push\\b\'; then echo \'{"decision":"block","reason":"git push is blocked by overstory — merge locally, push manually when ready"}\'; exit 0; fi;',
						},
					],
				},
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: `${toolNameExtract} ov log tool-start --agent orchestrator --tool-name "$TOOL_NAME"`,
						},
					],
				},
			],
			PostToolUse: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: `${toolNameExtract} ov log tool-end --agent orchestrator --tool-name "$TOOL_NAME"`,
						},
					],
				},
				{
					matcher: "Bash",
					hooks: [
						{
							type: "command",
							command:
								"read -r INPUT; if echo \"$INPUT\" | grep -q 'git commit'; then mulch diff HEAD~1 2>/dev/null || true; fi",
						},
					],
				},
			],
			Stop: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: "ov log session-end --agent orchestrator",
						},
						{
							type: "command",
							command: "mulch learn",
						},
					],
				},
			],
			PreCompact: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: "ov prime --agent orchestrator --compact",
						},
					],
				},
			],
		},
	};

	return `${JSON.stringify(hooks, null, "\t")}\n`;
}

/**
 * Bootstrap all SQLite databases with their full schema.
 * Each factory function creates the DB file and applies all migrations
 * if it doesn't exist yet. If it already exists, migrations run idempotently.
 */
async function bootstrapDatabases(overstoryPath: string): Promise<void> {
	const { createMailStore } = await import("../mail/store.ts");
	const { createSessionStore } = await import("../sessions/store.ts");
	const { createMetricsStore } = await import("../metrics/store.ts");
	const { createMergeQueue } = await import("../merge/queue.ts");
	const { createEventStore } = await import("../events/store.ts");

	const stores = [
		{ name: "mail.db", create: () => createMailStore(join(overstoryPath, "mail.db")) },
		{ name: "sessions.db", create: () => createSessionStore(join(overstoryPath, "sessions.db")) },
		{ name: "metrics.db", create: () => createMetricsStore(join(overstoryPath, "metrics.db")) },
		{
			name: "merge-queue.db",
			create: () => createMergeQueue(join(overstoryPath, "merge-queue.db")),
		},
		{ name: "events.db", create: () => createEventStore(join(overstoryPath, "events.db")) },
	];

	for (const { name, create } of stores) {
		try {
			const store = create();
			store.close();
		} catch {
			printWarning(`Failed to bootstrap ${name} — will be created on first use`);
		}
	}
}

/**
 * Migrate existing SQLite databases on --force reinit.
 *
 * Opens each DB, enables WAL mode, and re-runs CREATE TABLE/INDEX IF NOT EXISTS
 * to apply any schema additions without losing existing data.
 */
async function migrateExistingDatabases(overstoryPath: string): Promise<string[]> {
	const migrated: string[] = [];

	// Migrate mail.db
	const mailDbPath = join(overstoryPath, "mail.db");
	if (await Bun.file(mailDbPath).exists()) {
		const db = new Database(mailDbPath);
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA busy_timeout = 5000");
		db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'status',
  priority TEXT NOT NULL DEFAULT 'normal',
  thread_id TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
		db.exec(`
CREATE INDEX IF NOT EXISTS idx_inbox ON messages(to_agent, read);
CREATE INDEX IF NOT EXISTS idx_thread ON messages(thread_id)`);
		db.close();
		migrated.push("mail.db");
	}

	// Migrate metrics.db
	const metricsDbPath = join(overstoryPath, "metrics.db");
	if (await Bun.file(metricsDbPath).exists()) {
		const db = new Database(metricsDbPath);
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA busy_timeout = 5000");
		db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  agent_name TEXT NOT NULL,
  task_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  exit_code INTEGER,
  merge_result TEXT,
  parent_agent TEXT,
  PRIMARY KEY (agent_name, task_id)
)`);
		db.close();
		migrated.push("metrics.db");
	}

	return migrated;
}

/**
 * Content for .overstory/.gitignore — runtime state that should not be tracked.
 * Uses wildcard+whitelist pattern: ignore everything, whitelist tracked files.
 * Auto-healed by ov prime on each session start.
 * Config files (config.yaml, agent-manifest.json, hooks.json) remain tracked.
 */
export const OVERSTORY_GITIGNORE = `# Wildcard+whitelist: ignore everything, whitelist tracked files
# Auto-healed by ov prime on each session start
*
!.gitignore
!config.yaml
!agent-manifest.json
!hooks.json
!groups.json
!agent-defs/
!agent-defs/**
!README.md
`;

/**
 * Content for .overstory/README.md — explains the directory to contributors.
 */
export const OVERSTORY_README = `# .overstory/

This directory is managed by [overstory](https://github.com/jayminwest/overstory) — a multi-agent orchestration system for Claude Code.

Overstory turns a single Claude Code session into a multi-agent team by spawning worker agents in git worktrees via tmux, coordinating them through a custom SQLite mail system, and merging their work back with tiered conflict resolution.

## Key Commands

- \`ov init\`          — Initialize this directory
- \`ov status\`        — Show active agents and state
- \`ov sling <id>\`    — Spawn a worker agent
- \`ov mail check\`    — Check agent messages
- \`ov merge\`         — Merge agent work back
- \`ov dashboard\`     — Live TUI monitoring
- \`ov doctor\`        — Run health checks

## Structure

- \`config.yaml\`             — Project configuration
- \`agent-manifest.json\`     — Agent registry
- \`hooks.json\`              — Claude Code hooks config
- \`agent-defs/\`             — Agent definition files (.md)
- \`specs/\`                  — Task specifications
- \`agents/\`                 — Per-agent state and identity
- \`worktrees/\`              — Git worktrees (gitignored)
- \`logs/\`                   — Agent logs (gitignored)
`;

/**
 * Write .overstory/.gitignore for runtime state files.
 * Always overwrites to support --force reinit and auto-healing via prime.
 */
export async function writeOverstoryGitignore(overstoryPath: string): Promise<void> {
	const gitignorePath = join(overstoryPath, ".gitignore");
	await Bun.write(gitignorePath, OVERSTORY_GITIGNORE);
}

/**
 * Write .overstory/README.md explaining the directory to contributors.
 * Always overwrites to support --force reinit.
 */
export async function writeOverstoryReadme(overstoryPath: string): Promise<void> {
	const readmePath = join(overstoryPath, "README.md");
	await Bun.write(readmePath, OVERSTORY_README);
}

export interface InitOptions {
	yes?: boolean;
	name?: string;
	force?: boolean;
	/** Comma-separated list of ecosystem tools to bootstrap (e.g. "mulch,seeds"). Default: all. */
	tools?: string;
	skipMulch?: boolean;
	skipSeeds?: boolean;
	skipCanopy?: boolean;
	/** Skip the onboard step (injecting CLAUDE.md sections for ecosystem tools). */
	skipOnboard?: boolean;
	/** Output final result as JSON envelope. */
	json?: boolean;
	/** Injectable spawner for testability. */
	_spawner?: Spawner;
}

/**
 * Print a success status line.
 */
function printCreated(relativePath: string): void {
	printSuccess("Created", relativePath);
}

/**
 * Entry point for `ov init [--force] [--yes|-y] [--name <name>]`.
 *
 * Scaffolds the .overstory/ directory structure in the current working directory.
 *
 * @param opts - Command options
 */
export async function initCommand(opts: InitOptions): Promise<void> {
	const force = opts.force ?? false;
	const yes = opts.yes ?? false;
	const projectRoot = process.cwd();
	const spawner = opts._spawner ?? defaultSpawner;
	const overstoryPath = join(projectRoot, OVERSTORY_DIR);

	// 0. Verify we're inside a git repository
	const gitCheck = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], {
		cwd: projectRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const gitCheckExit = await gitCheck.exited;
	if (gitCheckExit !== 0) {
		throw new ValidationError("overstory requires a git repository. Run 'git init' first.", {
			field: "git",
		});
	}

	// 1. Check if .overstory/ already exists
	const existingDir = Bun.file(join(overstoryPath, "config.yaml"));
	if (await existingDir.exists()) {
		if (!force && !yes) {
			process.stdout.write(
				"Warning: .overstory/ already initialized in this project.\n" +
					"Use --force or --yes to reinitialize.\n",
			);
			return;
		}
		const flag = yes ? "--yes" : "--force";
		process.stdout.write(`Reinitializing .overstory/ (${flag})\n\n`);
	}

	// 2. Detect project info
	const projectName = opts.name ?? (await detectProjectName(projectRoot));
	const canonicalBranch = await detectCanonicalBranch(projectRoot);

	process.stdout.write(`Initializing overstory for "${projectName}"...\n\n`);

	// 3. Create directory structure
	const dirs = [
		OVERSTORY_DIR,
		join(OVERSTORY_DIR, "agents"),
		join(OVERSTORY_DIR, "agent-defs"),
		join(OVERSTORY_DIR, "worktrees"),
		join(OVERSTORY_DIR, "specs"),
		join(OVERSTORY_DIR, "logs"),
	];

	for (const dir of dirs) {
		await mkdir(join(projectRoot, dir), { recursive: true });
		printCreated(`${dir}/`);
	}

	// 3b. Deploy agent definition .md files from overstory install directory
	const overstoryAgentsDir = join(import.meta.dir, "..", "..", "agents");
	const agentDefsTarget = join(overstoryPath, "agent-defs");
	const agentDefFiles = await readdir(overstoryAgentsDir);
	for (const fileName of agentDefFiles) {
		if (!fileName.endsWith(".md")) continue;
		if (fileName === "supervisor.md") continue; // Deprecated: not deployed to new projects
		const source = Bun.file(join(overstoryAgentsDir, fileName));
		const content = await source.text();
		await Bun.write(join(agentDefsTarget, fileName), content);
		printCreated(`${OVERSTORY_DIR}/agent-defs/${fileName}`);
	}

	// 4. Write config.yaml
	const config = structuredClone(DEFAULT_CONFIG);
	config.project.name = projectName;
	config.project.root = projectRoot;
	config.project.canonicalBranch = canonicalBranch;

	const configYaml = serializeConfigToYaml(config as unknown as Record<string, unknown>);
	const configPath = join(overstoryPath, "config.yaml");
	await Bun.write(configPath, configYaml);
	printCreated(`${OVERSTORY_DIR}/config.yaml`);

	// 5. Write agent-manifest.json
	const manifest = buildAgentManifest();
	const manifestPath = join(overstoryPath, "agent-manifest.json");
	await Bun.write(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	printCreated(`${OVERSTORY_DIR}/agent-manifest.json`);

	// 6. Write hooks.json
	const hooksContent = buildHooksJson();
	const hooksPath = join(overstoryPath, "hooks.json");
	await Bun.write(hooksPath, hooksContent);
	printCreated(`${OVERSTORY_DIR}/hooks.json`);

	// 7. Write .overstory/.gitignore for runtime state
	await writeOverstoryGitignore(overstoryPath);
	printCreated(`${OVERSTORY_DIR}/.gitignore`);

	// 7b. Write .overstory/README.md
	await writeOverstoryReadme(overstoryPath);
	printCreated(`${OVERSTORY_DIR}/README.md`);

	// 8. Bootstrap SQLite databases (create with schema if they don't exist)
	await bootstrapDatabases(overstoryPath);

	// 9. Migrate existing SQLite databases on --force reinit
	if (force || yes) {
		const migrated = await migrateExistingDatabases(overstoryPath);
		for (const dbName of migrated) {
			printSuccess("Migrated", dbName);
		}
	}

	// 9. Bootstrap sibling ecosystem tools
	const toolSet = resolveToolSet(opts);
	const toolResults: Record<string, { status: ToolStatus; path: string }> = {
		overstory: { status: "initialized", path: overstoryPath },
	};

	if (toolSet.length > 0) {
		process.stdout.write("\n");
		process.stdout.write("Bootstrapping ecosystem tools...\n\n");
	}

	for (const tool of toolSet) {
		const status = await initSiblingTool(tool, projectRoot, spawner);
		toolResults[tool.name] = {
			status,
			path: join(projectRoot, tool.dotDir),
		};
	}

	// 10. Set up .gitattributes with merge=union for JSONL files
	const gitattrsUpdated = await setupGitattributes(projectRoot);
	if (gitattrsUpdated) {
		printCreated(".gitattributes");
	}

	// 11. Run onboard for each tool (inject CLAUDE.md sections)
	const onboardResults: Record<string, OnboardStatus> = {};
	if (!opts.skipOnboard) {
		for (const tool of toolSet) {
			if (toolResults[tool.name]?.status !== "skipped") {
				const status = await onboardTool(tool, projectRoot, spawner);
				onboardResults[tool.name] = status;
			}
		}
	}

	// 12. Auto-commit scaffold files so ecosystem dirs are tracked before agents create branches.
	// Without this, agent branches that add files to .mulch/.seeds/.canopy cause
	// untracked-vs-tracked conflicts in ov merge (overstory-fe42).
	let scaffoldCommitted = false;
	const pathsToAdd: string[] = [OVERSTORY_DIR];

	// Add .gitattributes if it exists
	try {
		await stat(join(projectRoot, ".gitattributes"));
		pathsToAdd.push(".gitattributes");
	} catch {
		// not present — skip
	}

	// Add CLAUDE.md if it exists (may have been modified by onboard)
	try {
		await stat(join(projectRoot, "CLAUDE.md"));
		pathsToAdd.push("CLAUDE.md");
	} catch {
		// not present — skip
	}

	// Add sibling tool dirs that were created
	for (const tool of SIBLING_TOOLS) {
		try {
			await stat(join(projectRoot, tool.dotDir));
			pathsToAdd.push(tool.dotDir);
		} catch {
			// not present — skip
		}
	}

	const addResult = await spawner(["git", "add", ...pathsToAdd], { cwd: projectRoot });
	if (addResult.exitCode !== 0) {
		printWarning("Scaffold commit skipped", addResult.stderr.trim() || "git add failed");
	} else {
		// git diff --cached --quiet exits 0 if nothing staged, 1 if changes are staged
		const diffResult = await spawner(["git", "diff", "--cached", "--quiet"], {
			cwd: projectRoot,
		});
		if (diffResult.exitCode !== 0) {
			// Changes are staged — commit them
			const commitResult = await spawner(
				["git", "commit", "-m", "chore: initialize overstory and ecosystem tools"],
				{ cwd: projectRoot },
			);
			if (commitResult.exitCode === 0) {
				printSuccess("Committed", "scaffold files");
				scaffoldCommitted = true;
			} else {
				printWarning("Scaffold commit failed", commitResult.stderr.trim() || "git commit failed");
			}
		}
	}

	// 13. Output final result
	if (opts.json) {
		jsonOutput("init", {
			project: projectName,
			tools: toolResults,
			onboard: onboardResults,
			gitattributes: gitattrsUpdated,
			scaffoldCommitted,
		});
		return;
	}

	printSuccess("Initialized");
	printHint("Next: run `ov hooks install` to enable Claude Code hooks.");
	printHint("Then: run `ov status` to see the current state.");
}
