/**
 * Eval runner: orchestrates an eval run end-to-end against a fixture repo.
 *
 * Steps: setup fixture → ov init → apply config overrides → startup actions →
 * start coordinator → poll for completion → collect metrics → evaluate assertions.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EvalScenarioError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { createMergeQueue } from "../merge/queue.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { createSessionStore } from "../sessions/store.ts";
import { evaluateAssertions } from "./assertions.ts";
import type { EvalMetrics, EvalResult, EvalRunConfig } from "./types.ts";

/** Run the ov CLI with the given args, returning stdout text and exit code. */
async function runOv(
	args: string[],
	cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["ov", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { stdout, stderr, exitCode };
}

/** Create a minimal git repo with an initial commit in the given directory. */
async function initGitRepo(repoPath: string): Promise<void> {
	const spawnGit = async (args: string[]) => {
		const proc = Bun.spawn(["git", ...args], { cwd: repoPath, stdout: "pipe", stderr: "pipe" });
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			throw new EvalScenarioError(`git ${args[0] ?? ""} failed: ${stderr}`);
		}
	};
	await spawnGit(["init"]);
	await spawnGit(["config", "user.email", "eval@overstory.local"]);
	await spawnGit(["config", "user.name", "Overstory Eval"]);
	// Create an initial commit so the repo has a HEAD
	const readmeFile = join(repoPath, "README.md");
	await Bun.write(readmeFile, "# Eval fixture\n");
	await spawnGit(["add", "."]);
	await spawnGit(["commit", "-m", "chore: initial eval fixture"]);
}

/** Deep-merge config overrides into the fixture .overstory/config.yaml. */
async function applyConfigOverrides(
	fixtureRoot: string,
	overrides: Record<string, unknown>,
): Promise<void> {
	const configPath = join(fixtureRoot, ".overstory", "config.yaml");
	if (!existsSync(configPath)) return;

	const text = await Bun.file(configPath).text();

	function toYamlLines(obj: Record<string, unknown>, indent = ""): string {
		const lines: string[] = [];
		for (const [key, val] of Object.entries(obj)) {
			if (val !== null && typeof val === "object" && !Array.isArray(val)) {
				lines.push(`${indent}${key}:`);
				lines.push(toYamlLines(val as Record<string, unknown>, `${indent}  `));
			} else if (Array.isArray(val)) {
				lines.push(`${indent}${key}:`);
				for (const item of val) {
					lines.push(`${indent}  - ${JSON.stringify(item)}`);
				}
			} else {
				lines.push(`${indent}${key}: ${JSON.stringify(val)}`);
			}
		}
		return lines.join("\n");
	}

	const overrideYaml = toYamlLines(overrides);
	const merged = `${text.trimEnd()}\n# eval config overrides\n${overrideYaml}\n`;
	await Bun.write(configPath, merged);
}

/** Run a single startup action command in the fixture repo. */
async function runStartupAction(command: string, cwd: string): Promise<void> {
	const parts = command.split(/\s+/);
	const cmd = parts[0];
	if (!cmd) return;
	const proc = Bun.spawn(parts, { cwd, stdout: "pipe", stderr: "pipe" });
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new EvalScenarioError(`Startup action failed: ${command}\n${stderr}`);
	}
}

/** Poll ov coordinator check-complete until done or timeout. */
async function waitForCompletion(
	fixtureRoot: string,
	timeoutMs: number,
): Promise<{ complete: boolean; timedOut: boolean }> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await runOv(
			["coordinator", "check-complete", "--json", "--project", fixtureRoot],
			fixtureRoot,
		);
		if (result.exitCode === 0) {
			try {
				const parsed = JSON.parse(result.stdout) as { complete?: boolean };
				if (parsed.complete === true) {
					return { complete: true, timedOut: false };
				}
			} catch {
				// ignore JSON parse errors, keep polling
			}
		}
		// Wait 5 seconds before next poll
		await new Promise<void>((resolve) => setTimeout(resolve, 5000));
	}
	return { complete: false, timedOut: true };
}

/** Read metrics from the fixture's SQLite databases. Returns counts and aggregates. */
function collectMetrics(fixtureRoot: string, durationMs: number): EvalMetrics {
	const ovDir = join(fixtureRoot, ".overstory");

	// Sessions
	let totalAgents = 0;
	let completedAgents = 0;
	let zombieCount = 0;
	let stallCount = 0;
	let runtimeSwaps = 0;

	const sessionsDbPath = join(ovDir, "sessions.db");
	if (existsSync(sessionsDbPath)) {
		try {
			const sessionStore = createSessionStore(sessionsDbPath);
			try {
				const all = sessionStore.getAll();
				totalAgents = all.length;
				completedAgents = all.filter((s) => s.state === "completed").length;
				zombieCount = all.filter((s) => s.state === "zombie").length;
				stallCount = all.filter((s) => s.state === "stalled").length;
				runtimeSwaps = all.filter((s) => s.originalRuntime !== null).length;
			} finally {
				sessionStore.close();
			}
		} catch {
			// DB may not be readable
		}
	}

	// Metrics (tokens/cost/duration)
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let estimatedCostUsd = 0;
	let medianSessionDurationMs = 0;

	const metricsDbPath = join(ovDir, "metrics.db");
	if (existsSync(metricsDbPath)) {
		try {
			const metricsStore = createMetricsStore(metricsDbPath);
			try {
				const sessions = metricsStore.getRecentSessions(1000);
				for (const s of sessions) {
					totalInputTokens += s.inputTokens ?? 0;
					totalOutputTokens += s.outputTokens ?? 0;
					estimatedCostUsd += s.estimatedCostUsd ?? 0;
				}
				const durations = sessions
					.map((s) => s.durationMs)
					.filter((d): d is number => d > 0)
					.sort((a, b) => a - b);
				if (durations.length > 0) {
					const mid = Math.floor(durations.length / 2);
					medianSessionDurationMs =
						durations.length % 2 === 1
							? (durations[mid] ?? 0)
							: ((durations[mid - 1] ?? 0) + (durations[mid] ?? 0)) / 2;
				}
			} finally {
				metricsStore.close();
			}
		} catch {
			// DB may not exist
		}
	}

	// Merge queue
	let mergeSuccessCount = 0;
	let mergeConflictCount = 0;
	let mergeQueuePending = 0;

	const mergeDbPath = join(ovDir, "merge-queue.db");
	if (existsSync(mergeDbPath)) {
		try {
			const mergeQueue = createMergeQueue(mergeDbPath);
			try {
				const all = mergeQueue.list();
				mergeQueuePending = all.filter((e) => e.status === "pending").length;
				mergeSuccessCount = all.filter((e) => e.status === "merged").length;
				mergeConflictCount = all.filter((e) => e.status === "conflict").length;
			} finally {
				mergeQueue.close();
			}
		} catch {
			// DB may not exist
		}
	}

	// Events — count nudge events (custom events with nudge in data)
	let nudgesSent = 0;

	const eventsDbPath = join(ovDir, "events.db");
	if (existsSync(eventsDbPath)) {
		try {
			const eventStore = createEventStore(eventsDbPath);
			try {
				const allEvents = eventStore.getTimeline({
					since: "2000-01-01T00:00:00Z",
					limit: 10000,
				});
				nudgesSent = allEvents.filter(
					(e) => e.eventType === "custom" && (e.data ?? "").includes("nudge"),
				).length;
			} finally {
				eventStore.close();
			}
		} catch {
			// DB may not exist
		}
	}

	const tasksCompleted = completedAgents;
	const stallRate = totalAgents > 0 ? stallCount / totalAgents : 0;

	return {
		totalAgents,
		completedAgents,
		zombieCount,
		stallCount,
		stallRate,
		mergeSuccessCount,
		mergeConflictCount,
		mergeQueuePending,
		tasksCompleted,
		durationMs,
		nudgesSent,
		totalInputTokens,
		totalOutputTokens,
		estimatedCostUsd,
		runtimeSwaps,
		medianSessionDurationMs,
	};
}

/**
 * Run an eval scenario end-to-end.
 * Creates a fixture repo, runs the coordinator, collects metrics, evaluates assertions.
 */
export async function runEval(config: EvalRunConfig): Promise<EvalResult> {
	const startedAt = new Date().toISOString();
	const fixtureRoot = config.fixtureRepoPath;

	try {
		// Step 1: Setup fixture repo
		if (config.scenario.repoTemplatePath) {
			const proc = Bun.spawn(["cp", "-r", `${config.scenario.repoTemplatePath}/.`, fixtureRoot], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			if (exitCode !== 0) {
				throw new EvalScenarioError("Failed to copy repo template to fixture");
			}
		} else {
			await initGitRepo(fixtureRoot);
		}

		// Step 2: Init overstory in the fixture
		const initResult = await runOv(
			["init", "--yes", "--skip-mulch", "--skip-seeds", "--skip-canopy", "--project", fixtureRoot],
			fixtureRoot,
		);
		if (initResult.exitCode !== 0) {
			throw new EvalScenarioError(`ov init failed in fixture: ${initResult.stderr}`);
		}

		// Step 3: Apply config overrides
		if (Object.keys(config.scenario.configOverrides).length > 0) {
			await applyConfigOverrides(
				fixtureRoot,
				config.scenario.configOverrides as Record<string, unknown>,
			);
		}

		// Step 4: Run startup actions
		for (const action of config.scenario.startupActions) {
			await runStartupAction(action.command, fixtureRoot);
		}

		// Step 5: Start coordinator
		const coordResult = await runOv(
			["coordinator", "start", "--no-attach", "--project", fixtureRoot],
			fixtureRoot,
		);
		if (coordResult.exitCode !== 0) {
			throw new EvalScenarioError(`ov coordinator start failed: ${coordResult.stderr}`);
		}

		// Step 6: Wait for completion
		const timeoutMs = config.timeoutMs ?? config.scenario.timeoutMs;
		const { complete, timedOut } = await waitForCompletion(fixtureRoot, timeoutMs);

		if (timedOut && !complete) {
			// Collect partial metrics on timeout
		}

		// Step 7: Compute duration and collect metrics
		const completedAt = new Date().toISOString();
		const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
		const metrics = collectMetrics(fixtureRoot, durationMs);

		// Step 8: Evaluate assertions
		const assertions = evaluateAssertions(config.scenario.assertions, metrics);

		const passed = assertions.every((a) => a.passed);

		// Step 9: Build EvalResult
		const result: EvalResult = {
			runId: config.runId,
			scenarioName: config.scenario.name,
			scenarioPath: config.scenarioPath,
			startedAt,
			completedAt,
			durationMs,
			passed,
			timedOut,
			metrics,
			assertions,
			fixtureRoot,
		};

		return result;
	} finally {
		// Step 10: Cleanup — stop coordinator, remove fixture dir
		try {
			await runOv(["coordinator", "stop", "--project", fixtureRoot], fixtureRoot);
		} catch {
			// ignore stop errors
		}

		try {
			rmSync(fixtureRoot, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
}
