/**
 * GitHub auto-pull poller.
 *
 * Background daemon that polls GitHub Issues for issues with the configured
 * readyLabel, claims them, and dispatches them to the coordinator via mail.
 * Started by `ov coordinator start --auto-pull` or when coordinator.autoPull
 * is true in config.yaml.
 *
 * Runs as a standalone process:
 *   bun run github-poller.ts --project-root <path>
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { AgentError } from "../errors.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import type { GitHubPollerConfig } from "../types.ts";

/** State tracked per GitHub issue. */
interface DispatchedEntry {
	taskId: string;
	dispatchedAt: string;
}

/** Persisted poller state — keyed by GitHub issue number (as string). */
interface PollerState {
	dispatched: Record<string, DispatchedEntry>;
}

/** Result of a single poll tick. */
export interface PollerTickResult {
	dispatched: number;
	skipped: number;
	errors: string[];
}

/** Raw issue shape returned by `gh issue list --json`. */
export interface GhRawIssue {
	number: number;
	title: string;
	state: string;
	labels: Array<{ name: string }>;
	assignees: Array<{ login: string }>;
	body: string;
}

const GH_JSON_FIELDS = "number,title,state,labels,assignees,body";

/** Injectable gh runner for testing. */
export type GhRunner = (
	args: string[],
	cwd: string,
) => Promise<{ stdout: string; exitCode: number }>;

/** Default gh runner — spawns the real `gh` CLI. */
export const defaultGhRunner: GhRunner = async (args, cwd) => {
	const proc = Bun.spawn(["gh", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const stdout = await new Response(proc.stdout).text();
	await new Response(proc.stderr).text(); // drain stderr
	const exitCode = await proc.exited;
	return { stdout, exitCode };
};

async function readPollerState(stateFile: string): Promise<PollerState> {
	try {
		const file = Bun.file(stateFile);
		if (await file.exists()) {
			return JSON.parse(await file.text()) as PollerState;
		}
	} catch {
		// Ignore parse errors — start fresh
	}
	return { dispatched: {} };
}

async function writePollerState(stateFile: string, state: PollerState): Promise<void> {
	await Bun.write(stateFile, JSON.stringify(state, null, 2));
}

/**
 * Fetch issues with the given label from GitHub.
 * Optionally scoped to a specific owner/repo via `--repo`.
 */
async function fetchReadyIssues(
	readyLabel: string,
	cwd: string,
	owner?: string,
	repo?: string,
	gh: GhRunner = defaultGhRunner,
): Promise<GhRawIssue[]> {
	const args = [
		"issue",
		"list",
		"--label",
		readyLabel,
		"--state",
		"open",
		"--json",
		GH_JSON_FIELDS,
	];
	if (owner && repo) {
		args.push("--repo", `${owner}/${repo}`);
	}
	const { stdout, exitCode } = await gh(args, cwd);
	if (exitCode !== 0) {
		throw new AgentError(`gh issue list failed (exit ${exitCode})`);
	}
	const trimmed = stdout.trim();
	if (trimmed === "" || trimmed === "[]") return [];
	return JSON.parse(trimmed) as GhRawIssue[];
}

/**
 * Prune dispatched entries that are no longer active on GitHub.
 * An issue is considered inactive when it no longer has the activeLabel.
 */
async function pruneDispatched(
	state: PollerState,
	activeLabel: string,
	cwd: string,
	owner?: string,
	repo?: string,
	gh: GhRunner = defaultGhRunner,
): Promise<void> {
	if (Object.keys(state.dispatched).length === 0) return;

	const args = ["issue", "list", "--label", activeLabel, "--state", "open", "--json", "number"];
	if (owner && repo) {
		args.push("--repo", `${owner}/${repo}`);
	}
	const { stdout, exitCode } = await gh(args, cwd);
	if (exitCode !== 0) return; // Best-effort; skip pruning on error

	let activeIssues: Array<{ number: number }>;
	try {
		const trimmed = stdout.trim();
		activeIssues = trimmed === "" || trimmed === "[]" ? [] : JSON.parse(trimmed);
	} catch {
		return;
	}

	const activeSet = new Set(activeIssues.map((i) => String(i.number)));
	for (const issueId of Object.keys(state.dispatched)) {
		if (!activeSet.has(issueId)) {
			delete state.dispatched[issueId];
		}
	}
}

/**
 * Claim a GitHub issue: swap readyLabel → activeLabel.
 */
async function claimIssue(
	issueNumber: number,
	readyLabel: string,
	activeLabel: string,
	cwd: string,
	owner?: string,
	repo?: string,
	gh: GhRunner = defaultGhRunner,
): Promise<void> {
	const repoArgs = owner && repo ? ["--repo", `${owner}/${repo}`] : [];

	const { exitCode: removeExit } = await gh(
		["issue", "edit", String(issueNumber), "--remove-label", readyLabel, ...repoArgs],
		cwd,
	);
	if (removeExit !== 0) {
		throw new AgentError(
			`gh issue edit --remove-label failed for issue #${issueNumber} (exit ${removeExit})`,
		);
	}

	const { exitCode: addExit } = await gh(
		["issue", "edit", String(issueNumber), "--add-label", activeLabel, ...repoArgs],
		cwd,
	);
	if (addExit !== 0) {
		throw new AgentError(
			`gh issue edit --add-label failed for issue #${issueNumber} (exit ${addExit})`,
		);
	}
}

/**
 * Run a single poll tick.
 *
 * 1. Prune completed issues from dispatched state
 * 2. Fetch ready issues from GitHub
 * 3. Filter already-dispatched issues
 * 4. Claim and dispatch up to `maxConcurrent - activeCount` new issues
 *
 * @param pollerConfig - GitHub poller configuration
 * @param projectRoot  - Project root (for state file and mail.db)
 * @param cwd          - Working directory for gh commands
 * @param gh           - Injectable gh runner (defaults to real gh CLI)
 */
export async function runPollerTick(
	pollerConfig: GitHubPollerConfig,
	projectRoot: string,
	cwd: string,
	gh: GhRunner = defaultGhRunner,
): Promise<PollerTickResult> {
	const stateFile = join(projectRoot, ".overstory", "autopull-state.json");
	const state = await readPollerState(stateFile);
	const errors: string[] = [];

	// Prune completed issues so the active count reflects reality
	await pruneDispatched(
		state,
		pollerConfig.activeLabel,
		cwd,
		pollerConfig.owner,
		pollerConfig.repo,
		gh,
	);

	const activeCount = Object.keys(state.dispatched).length;
	if (activeCount >= pollerConfig.maxConcurrent) {
		return { dispatched: 0, skipped: 0, errors };
	}

	// Fetch ready issues
	let readyIssues: GhRawIssue[];
	try {
		readyIssues = await fetchReadyIssues(
			pollerConfig.readyLabel,
			cwd,
			pollerConfig.owner,
			pollerConfig.repo,
			gh,
		);
	} catch (err) {
		errors.push(`Failed to fetch issues: ${err instanceof Error ? err.message : String(err)}`);
		return { dispatched: 0, skipped: 0, errors };
	}

	// Filter already-dispatched
	const newIssues = readyIssues.filter((issue) => !state.dispatched[String(issue.number)]);
	const capacity = pollerConfig.maxConcurrent - activeCount;
	const toDispatch = newIssues.slice(0, capacity);
	const skipped = newIssues.length - toDispatch.length;

	if (toDispatch.length === 0) {
		await writePollerState(stateFile, state);
		return { dispatched: 0, skipped, errors };
	}

	const mailDbPath = join(projectRoot, ".overstory", "mail.db");
	const mailStore = createMailStore(mailDbPath);
	const mailClient = createMailClient(mailStore);
	let dispatched = 0;

	try {
		for (const issue of toDispatch) {
			const issueNumStr = String(issue.number);
			const taskId = `gh-${issue.number}`;

			// Claim on GitHub
			try {
				await claimIssue(
					issue.number,
					pollerConfig.readyLabel,
					pollerConfig.activeLabel,
					cwd,
					pollerConfig.owner,
					pollerConfig.repo,
					gh,
				);
			} catch (err) {
				errors.push(
					`Failed to claim #${issue.number}: ${err instanceof Error ? err.message : String(err)}`,
				);
				continue;
			}

			// Send dispatch mail to coordinator
			mailClient.send({
				from: "github-autopull",
				to: "coordinator",
				subject: `Auto-dispatch: ${issue.title}`,
				body: [
					`GitHub issue #${issue.number}: ${issue.title}`,
					issue.body ? `\nDescription:\n${issue.body}` : "",
				].join(""),
				type: "dispatch",
				priority: "normal",
				payload: JSON.stringify({
					taskId,
					githubIssueId: issue.number,
					title: issue.title,
					readyLabel: pollerConfig.readyLabel,
					activeLabel: pollerConfig.activeLabel,
				}),
			});

			state.dispatched[issueNumStr] = {
				taskId,
				dispatchedAt: new Date().toISOString(),
			};

			dispatched++;
		}
	} finally {
		mailClient.close();
	}

	await writePollerState(stateFile, state);
	return { dispatched, skipped, errors };
}

/**
 * Run the GitHub poller daemon.
 *
 * Reads config from projectRoot, polls on each tick at pollIntervalMs intervals.
 * Handles SIGTERM/SIGINT for clean shutdown.
 */
export async function runPollerDaemon(projectRoot: string): Promise<void> {
	const config = await loadConfig(projectRoot);
	const pollerConfig = config.taskTracker.github;

	if (!pollerConfig) {
		process.stderr.write(
			"[autopull] No github poller config found in taskTracker.github. Exiting.\n",
		);
		process.exit(1);
	}

	if (!config.taskTracker.enabled) {
		process.stderr.write("[autopull] Task tracker is disabled. Exiting.\n");
		process.exit(0);
	}

	process.stderr.write(
		`[autopull] Daemon started. pollIntervalMs=${pollerConfig.pollIntervalMs} readyLabel=${pollerConfig.readyLabel} maxConcurrent=${pollerConfig.maxConcurrent}\n`,
	);

	let running = true;
	process.once("SIGTERM", () => {
		running = false;
		process.stderr.write("[autopull] Received SIGTERM, shutting down.\n");
	});
	process.once("SIGINT", () => {
		running = false;
	});

	while (running) {
		try {
			const result = await runPollerTick(pollerConfig, projectRoot, projectRoot);
			if (result.dispatched > 0) {
				process.stderr.write(
					`[autopull] Tick: dispatched=${result.dispatched} skipped=${result.skipped}\n`,
				);
			}
			for (const err of result.errors) {
				process.stderr.write(`[autopull] Error: ${err}\n`);
			}
		} catch (err) {
			process.stderr.write(
				`[autopull] Tick error: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}

		if (running) {
			await Bun.sleep(pollerConfig.pollIntervalMs);
		}
	}

	process.stderr.write("[autopull] Daemon stopped.\n");
}

// Entry point when run as a standalone script
if (import.meta.main) {
	const args = process.argv.slice(2);
	const projectRootIdx = args.indexOf("--project-root");
	const projectRoot = projectRootIdx >= 0 ? args[projectRootIdx + 1] : process.cwd();

	if (!projectRoot) {
		process.stderr.write("Usage: bun run github-poller.ts --project-root <path>\n");
		process.exit(1);
	}

	runPollerDaemon(projectRoot).catch((err) => {
		process.stderr.write(`[autopull] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(1);
	});
}
