/**
 * Quickstart wizard step definitions.
 *
 * Each step is built via buildSteps() and contains check/run logic.
 */

import { loadConfig } from "../config.ts";
import { printHint, printWarning } from "../logging/color.ts";
import { areHooksInstalled, areDependenciesAvailable, hasActiveAgents, isInitialized, isRuntimeAvailable } from "./detect.ts";
import { askYesNo } from "./prompts.ts";
import type { QuickstartOptions, QuickstartStep, StepResult } from "./types.ts";

async function runCommand(
	cmd: string[],
	opts?: { cwd?: string },
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	const proc = Bun.spawn(cmd, { cwd: opts?.cwd ?? process.cwd(), stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	return { ok: exitCode === 0, stdout, stderr };
}

export function buildSteps(options: QuickstartOptions): QuickstartStep[] {
	const { yes = false, verbose = false } = options;
	const projectRoot = process.cwd();

	/** Step 1: prerequisites */
	const prerequisites: QuickstartStep = {
		id: "prerequisites",
		title: "Check prerequisites",
		description: "Verify required CLI dependencies are installed",
		check: async () => {
			const { ok } = await areDependenciesAvailable();
			return ok ? "complete" : "pending";
		},
		run: async (): Promise<StepResult> => {
			const result = await runCommand(["ov", "doctor", "--category", "dependencies", "--json"]);
			if (!result.ok) {
				return { status: "failed", message: "Doctor command failed", details: [result.stderr] };
			}
			try {
				const parsed = JSON.parse(result.stdout) as {
					checks: Array<{ name: string; status: "pass" | "warn" | "fail" }>;
				};
				const failing = parsed.checks.filter((c) => c.status === "fail").map((c) => c.name);
				if (failing.length > 0) {
					return {
						status: "failed",
						message: `Missing critical dependencies: ${failing.join(", ")}`,
						details: failing.map((n) => `  - ${n}`),
					};
				}
				return { status: "complete", message: "All dependencies available" };
			} catch {
				return { status: "failed", message: "Failed to parse doctor output" };
			}
		},
	};

	/** Step 2: init */
	const init: QuickstartStep = {
		id: "init",
		title: "Initialize overstory",
		description: "Run ov init to set up .overstory/ in this project",
		check: async () => {
			return (await isInitialized(projectRoot)) ? "complete" : "pending";
		},
		run: async (): Promise<StepResult> => {
			if (await isInitialized(projectRoot)) {
				return { status: "skipped", message: "Already initialized" };
			}
			const result = await runCommand(["ov", "init", "--yes"]);
			if (!result.ok) {
				return { status: "failed", message: "ov init failed", details: [result.stderr] };
			}
			if (verbose) {
				process.stdout.write(result.stdout);
			}
			return { status: "complete", message: "Initialized .overstory/" };
		},
	};

	/** Step 3: hooks */
	const hooks: QuickstartStep = {
		id: "hooks",
		title: "Install hooks",
		description: "Install Claude Code hooks for agent orchestration",
		check: async () => {
			return (await areHooksInstalled(projectRoot)) ? "complete" : "pending";
		},
		run: async (): Promise<StepResult> => {
			if (await areHooksInstalled(projectRoot)) {
				return { status: "skipped", message: "Hooks already installed" };
			}
			const result = await runCommand(["ov", "hooks", "install"]);
			if (!result.ok) {
				return { status: "failed", message: "hooks install failed", details: [result.stderr] };
			}
			if (verbose) {
				process.stdout.write(result.stdout);
			}
			return { status: "complete", message: "Hooks installed" };
		},
	};

	/** Step 4: runtime */
	const runtime: QuickstartStep = {
		id: "runtime",
		title: "Check runtime",
		description: "Verify ANTHROPIC_API_KEY is available",
		check: async () => {
			return (await isRuntimeAvailable()) ? "complete" : "pending";
		},
		run: async (): Promise<StepResult> => {
			if (await isRuntimeAvailable()) {
				return { status: "complete", message: "Runtime available" };
			}
			if (yes) {
				return {
					status: "failed",
					message: "ANTHROPIC_API_KEY not set",
					details: ["Set ANTHROPIC_API_KEY environment variable and retry."],
				};
			}
			printWarning("ANTHROPIC_API_KEY is not set", "agents cannot start without it");
			printHint("Set ANTHROPIC_API_KEY=<your-key> and try again");
			const retry = await askYesNo("Retry after setting key?", false);
			if (retry) {
				if (await isRuntimeAvailable()) {
					return { status: "complete", message: "Runtime available" };
				}
				return { status: "failed", message: "ANTHROPIC_API_KEY still not set" };
			}
			return { status: "skipped", message: "Skipped — runtime not available" };
		},
	};

	/** Step 5: sample-task */
	const sampleTask: QuickstartStep = {
		id: "sample-task",
		title: "Create sample task",
		description: "Create a quickstart sample task in the tracker",
		check: async () => "pending",
		run: async (): Promise<StepResult> => {
			let taskId = "quickstart-sample";
			let backend: string | undefined;

			try {
				const config = await loadConfig(projectRoot);
				backend = config.taskTracker.enabled ? config.taskTracker.backend : undefined;
			} catch {
				backend = undefined;
			}

			if (backend === "seeds" || backend === "auto") {
				const result = await runCommand([
					"sd",
					"create",
					"quickstart-sample",
					"--title",
					"Quickstart sample task",
				]);
				if (result.ok) {
					const match = result.stdout.match(/([a-z0-9-]+(?:-\d+)?)/);
					if (match?.[1]) {
						taskId = match[1];
					}
				} else {
					printWarning("Could not create seeds task, using placeholder ID");
				}
			} else if (backend === "beads") {
				const result = await runCommand([
					"bd",
					"create",
					"quickstart-sample",
					"--title",
					"Quickstart sample task",
				]);
				if (result.ok) {
					const match = result.stdout.match(/([a-z0-9-]+(?:-\d+)?)/);
					if (match?.[1]) {
						taskId = match[1];
					}
				} else {
					printWarning("Could not create beads task, using placeholder ID");
				}
			}

			return {
				status: "complete",
				message: `Task ready: ${taskId}`,
				details: [taskId],
			};
		},
	};

	/** Step 6: spawn-scout */
	const spawnScout: QuickstartStep = {
		id: "spawn-scout",
		title: "Spawn scout agent",
		description: "Launch a scout agent to explore the codebase",
		check: async () => {
			return (await hasActiveAgents()) ? "complete" : "pending";
		},
		run: async (): Promise<StepResult> => {
			const result = await runCommand([
				"ov",
				"sling",
				"quickstart-sample",
				"--capability",
				"scout",
				"--name",
				"quickstart-scout",
				"--skip-task-check",
			]);
			if (!result.ok) {
				return { status: "failed", message: "Failed to spawn scout", details: [result.stderr] };
			}
			if (verbose) {
				process.stdout.write(result.stdout);
			}
			return { status: "complete", message: "Scout agent spawned" };
		},
	};

	/** Step 7: monitor */
	const monitor: QuickstartStep = {
		id: "monitor",
		title: "Monitor agent",
		description: "Wait for the scout agent to complete (10 min timeout)",
		check: async () => {
			return (await hasActiveAgents()) ? "pending" : "complete";
		},
		run: async (): Promise<StepResult> => {
			const timeoutMs = 10 * 60 * 1000;
			const pollMs = 10 * 1000;
			const startTime = Date.now();

			while (Date.now() - startTime < timeoutMs) {
				const elapsed = Math.floor((Date.now() - startTime) / 1000);
				process.stdout.write(`\r  Elapsed: ${elapsed}s — polling agent status...`);

				const active = await hasActiveAgents();
				if (!active) {
					process.stdout.write("\n");
					return { status: "complete", message: "Agent finished" };
				}

				if (verbose) {
					await runCommand(["ov", "status"]).then((r) => {
						if (r.ok) process.stdout.write(r.stdout);
					});
				}

				await Bun.sleep(pollMs);
			}

			process.stdout.write("\n");
			printWarning("Monitor timed out after 10 minutes", "agent may still be running");
			return {
				status: "complete",
				message: "Timed out — agent may still be running",
				details: ["Use `ov status` to check agent progress", "Use `ov attach` to follow logs"],
			};
		},
	};

	/** Step 8: review */
	const review: QuickstartStep = {
		id: "review",
		title: "Review results",
		description: "Show agent status and exploration results",
		check: async () => "pending",
		run: async (): Promise<StepResult> => {
			const result = await runCommand(["ov", "status"]);
			if (result.ok && verbose) {
				process.stdout.write(result.stdout);
			}
			printHint("Use `ov inspect quickstart-scout` to see full agent output");
			printHint("Use `ov logs --agent quickstart-scout` to tail agent logs");
			return { status: "complete", message: "Review complete" };
		},
	};

	/** Step 9: cleanup */
	const cleanup: QuickstartStep = {
		id: "cleanup",
		title: "Cleanup",
		description: "Stop agent and clean up worktrees",
		check: async () => "pending",
		run: async (): Promise<StepResult> => {
			const confirmed = yes || (await askYesNo("Clean up scout agent and worktrees?", true));
			if (!confirmed) {
				return { status: "skipped", message: "Cleanup skipped" };
			}

			const active = await hasActiveAgents();
			if (active) {
				const stopResult = await runCommand(["ov", "stop", "quickstart-scout"]);
				if (!stopResult.ok && verbose) {
					printWarning("Could not stop agent", stopResult.stderr.trim());
				}
			}

			await runCommand(["ov", "worktree", "clean"]);

			// Close tracker task if we have a real one
			try {
				const config = await loadConfig(projectRoot);
				if (config.taskTracker.enabled) {
					const backend = config.taskTracker.backend;
					const cmd = backend === "beads" ? "bd" : "sd";
					await runCommand([cmd, "close", "quickstart-sample", "--reason", "quickstart complete"]);
				}
			} catch {
				// ignore tracker errors
			}

			return { status: "complete", message: "Cleanup done" };
		},
	};

	return [prerequisites, init, hooks, runtime, sampleTask, spawnScout, monitor, review, cleanup];
}
