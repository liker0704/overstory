/**
 * GitHub Issues tracker adapter.
 *
 * Implements the unified TrackerClient interface by calling the `gh` CLI directly
 * via Bun.spawn. GitHub Issues returns clean JSON arrays/objects, no envelope needed.
 */

import { AgentError } from "../errors.ts";
import type { TrackerClient, TrackerIssue } from "./types.ts";

const GH_JSON_FIELDS = "number,title,state,labels,assignees,body";

/**
 * Run a gh command and return its output.
 */
async function runGh(
	args: string[],
	cwd: string,
	context: string,
): Promise<{ stdout: string; stderr: string }> {
	const proc = Bun.spawn(["gh", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new AgentError(`gh ${context} failed (exit ${exitCode}): ${stderr.trim()}`);
	}
	return { stdout, stderr };
}

/**
 * Parse JSON from gh output. gh --json output is clean JSON arrays/objects.
 */
function parseGhJson<T>(stdout: string, context: string): T {
	const trimmed = stdout.trim();
	if (trimmed === "") {
		throw new AgentError(`Empty output from gh ${context}`);
	}
	try {
		return JSON.parse(trimmed) as T;
	} catch {
		throw new AgentError(
			`Failed to parse JSON output from gh ${context}: ${trimmed.slice(0, 200)}`,
		);
	}
}

/** Raw GitHub issue shape from gh --json. */
interface GhRawIssue {
	number: number;
	title: string;
	state: string;
	labels: Array<{ name: string }>;
	assignees: Array<{ login: string }>;
	body: string;
}

function normalizeIssue(raw: GhRawIssue): TrackerIssue {
	const labelNames = raw.labels.map((l) => l.name);

	const priorityLabel = labelNames.find((n) => n.startsWith("priority:"));
	const priority = priorityLabel ? Number(priorityLabel.slice("priority:".length)) : 3;

	const typeLabel = labelNames.find((n) => n.startsWith("type:"));
	const type = typeLabel ? typeLabel.slice("type:".length) : "task";

	return {
		id: String(raw.number),
		title: raw.title,
		status: raw.state === "OPEN" ? "open" : "closed",
		priority,
		type,
		assignee: raw.assignees[0]?.login,
		description: raw.body || undefined,
		blocks: undefined,
		blockedBy: undefined,
	};
}

/**
 * Create a TrackerClient backed by the GitHub Issues (gh) CLI.
 *
 * @param cwd - Working directory for gh commands
 */
export function createGitHubTracker(cwd: string): TrackerClient {
	return {
		async ready() {
			const { stdout } = await runGh(
				["issue", "list", "--label", "ov-ready", "--state", "open", "--json", GH_JSON_FIELDS],
				cwd,
				"ready",
			);
			const issues = parseGhJson<GhRawIssue[]>(stdout, "ready");
			return issues.map(normalizeIssue);
		},

		async show(id) {
			const { stdout } = await runGh(
				["issue", "view", id, "--json", GH_JSON_FIELDS],
				cwd,
				`show ${id}`,
			);
			const issue = parseGhJson<GhRawIssue>(stdout, `show ${id}`);
			return normalizeIssue(issue);
		},

		async create(title, options) {
			const args = ["issue", "create", "--title", title];
			if (options?.description) {
				args.push("--body", options.description);
			}
			if (options?.type) {
				args.push("--label", `type:${options.type}`);
			}
			if (options?.priority !== undefined) {
				args.push("--label", `priority:${options.priority}`);
			}
			const { stdout } = await runGh(args, cwd, "create");
			// gh issue create outputs the issue URL, e.g. https://github.com/org/repo/issues/42
			const url = stdout.trim();
			const match = url.match(/\/issues\/(\d+)$/);
			if (!match?.[1]) {
				throw new AgentError(`gh create did not return a recognizable issue URL: ${url}`);
			}
			return match[1];
		},

		async claim(id) {
			await runGh(
				["issue", "edit", id, "--remove-label", "ov-ready"],
				cwd,
				`claim remove-label ${id}`,
			);
			await runGh(["issue", "edit", id, "--add-label", "ov-active"], cwd, `claim add-label ${id}`);
		},

		async close(id, reason) {
			const args = ["issue", "close", id];
			if (reason) {
				args.push("--comment", reason);
			}
			await runGh(args, cwd, `close ${id}`);
		},

		async list(options) {
			const args = ["issue", "list", "--json", GH_JSON_FIELDS];
			if (options?.status) {
				args.push("--state", options.status);
			}
			if (options?.limit !== undefined) {
				args.push("--limit", String(options.limit));
			}
			const { stdout } = await runGh(args, cwd, "list");
			const issues = parseGhJson<GhRawIssue[]>(stdout, "list");
			return issues.map(normalizeIssue);
		},

		async sync() {
			// GitHub Issues are cloud-native — no sync needed.
		},
	};
}
