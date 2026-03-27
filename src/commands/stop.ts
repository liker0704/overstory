/**
 * CLI command: ov stop <agent-name>
 *
 * Explicitly terminates a running agent by:
 * 1. Looking up the agent session by name
 * 2a. For TUI agents: killing its tmux session (if alive)
 * 2b. For headless agents (tmuxSession === ''): sending SIGTERM to the process tree
 * 3. Marking it as completed in the SessionStore
 * 4. Optionally removing its worktree and branch (--clean-worktree)
 *
 * Completed agents: ov stop <name> without --clean-worktree throws a helpful error
 * when no stale runtime is still alive. If a completed agent still has a live tmux
 * session or headless PID, stop reclaims that stale runtime before returning.
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { AgentError, ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { printSuccess, printWarning } from "../logging/color.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { removeWorktree } from "../worktree/manager.ts";
import {
	isProcessAlive,
	isSessionAlive,
	killProcessTree,
	killSession,
	removeAgentEnvFile,
} from "../worktree/tmux.ts";

export interface StopOptions {
	force?: boolean;
	cleanWorktree?: boolean;
	json?: boolean;
}

/** Dependency injection for testing. Uses real implementations when omitted. */
export interface StopDeps {
	_tmux?: {
		isSessionAlive: (name: string) => Promise<boolean>;
		killSession: (name: string) => Promise<void>;
	};
	_worktree?: {
		remove: (
			repoRoot: string,
			path: string,
			options?: { force?: boolean; forceBranch?: boolean },
		) => Promise<void>;
	};
	_process?: {
		isAlive: (pid: number) => boolean;
		killTree: (pid: number) => Promise<void>;
	};
	_git?: {
		deleteBranch: (repoRoot: string, branch: string) => Promise<boolean>;
	};
}

/** Delete a git branch (best-effort, non-fatal). */
async function deleteBranchBestEffort(repoRoot: string, branch: string): Promise<boolean> {
	try {
		const proc = Bun.spawn(["git", "branch", "-D", branch], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		return exitCode === 0;
	} catch {
		return false;
	}
}

/**
 * Entry point for `ov stop <agent-name>`.
 *
 * @param agentName - Name of the agent to stop
 * @param opts - Command options
 * @param deps - Optional dependency injection for testing (tmux, worktree, process, git)
 */
export async function stopCommand(
	agentName: string,
	opts: StopOptions,
	deps: StopDeps = {},
): Promise<void> {
	if (!agentName || agentName.trim().length === 0) {
		throw new ValidationError("Missing required argument: <agent-name>", {
			field: "agentName",
			value: "",
		});
	}

	const json = opts.json ?? false;
	const force = opts.force ?? false;
	const cleanWorktree = opts.cleanWorktree ?? false;

	const tmux = deps._tmux ?? { isSessionAlive, killSession };
	const worktree = deps._worktree ?? { remove: removeWorktree };
	const proc = deps._process ?? { isAlive: isProcessAlive, killTree: killProcessTree };
	const git = deps._git ?? { deleteBranch: deleteBranchBestEffort };

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;
	const overstoryDir = join(projectRoot, ".overstory");

	const { store } = openSessionStore(overstoryDir);
	try {
		const session = store.getByName(agentName);
		if (!session) {
			throw new AgentError(`Agent "${agentName}" not found`, { agentName });
		}

		const isZombie = session.state === "zombie";
		const isAlreadyCompleted = session.state === "completed";
		const isHeadless = session.tmuxSession === "" && session.pid !== null;
		let staleRuntimeAlive = false;
		if (isHeadless && session.pid !== null) {
			staleRuntimeAlive = proc.isAlive(session.pid);
		} else if (session.tmuxSession.length > 0) {
			staleRuntimeAlive = await tmux.isSessionAlive(session.tmuxSession);
		}

		// Completed agents without --clean-worktree still error unless a stale
		// runtime needs reclaiming.
		if (isAlreadyCompleted && !cleanWorktree && !staleRuntimeAlive) {
			throw new AgentError(
				`Agent "${agentName}" is already completed. Use --clean-worktree to remove its worktree.`,
				{ agentName },
			);
		}

		let tmuxKilled = false;
		let pidKilled = false;

		if (!isAlreadyCompleted || staleRuntimeAlive || isZombie) {
			if (isHeadless && session.pid !== null) {
				// Headless agent: kill via process tree instead of tmux
				if (staleRuntimeAlive) {
					await proc.killTree(session.pid);
					pidKilled = true;
				}
			} else {
				// TUI agent: kill via tmux session
				if (staleRuntimeAlive) {
					await tmux.killSession(session.tmuxSession);
					tmuxKilled = true;
				}
			}

			// Clean up agent env file (used by hooks for env var recovery)
			removeAgentEnvFile(session.worktreePath);

			// Mark session as completed
			store.updateState(agentName, "completed");
			store.updateLastActivity(agentName);

			// Record successful stop in resilience circuit breaker
			try {
				const { createResilienceStore } = await import("../resilience/store.ts");
				const { recordSuccess } = await import("../resilience/circuit-breaker.ts");
				const resStore = createResilienceStore(join(overstoryDir, "resilience.db"));
				try {
					recordSuccess(resStore, session.capability);
				} finally {
					resStore.close();
				}
			} catch { /* resilience recording is non-fatal */ }
		}

		// Optionally remove worktree and branch (best-effort, non-fatal)
		let worktreeRemoved = false;
		let branchDeleted = false;
		if (cleanWorktree) {
			if (session.worktreePath) {
				try {
					await worktree.remove(projectRoot, session.worktreePath, {
						force,
						forceBranch: false,
					});
					worktreeRemoved = true;
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					if (!json) printWarning("Failed to remove worktree", msg);
				}
			}

			// Delete the branch after removing the worktree (best-effort, non-fatal)
			if (session.branchName) {
				try {
					branchDeleted = await git.deleteBranch(projectRoot, session.branchName);
				} catch {
					branchDeleted = false;
				}
			}
		}

		if (json) {
			jsonOutput("stop", {
				stopped: true,
				agentName,
				sessionId: session.id,
				capability: session.capability,
				tmuxKilled,
				pidKilled,
				worktreeRemoved,
				branchDeleted,
				force,
				wasZombie: isZombie,
				wasCompleted: isAlreadyCompleted,
			});
		} else {
			printSuccess("Agent stopped", agentName);
			if (!isAlreadyCompleted) {
				if (isHeadless) {
					if (pidKilled) {
						process.stdout.write(`  Process tree killed: PID ${session.pid}\n`);
					} else {
						process.stdout.write(`  Process was already dead (PID ${session.pid})\n`);
					}
				} else {
					if (tmuxKilled) {
						process.stdout.write(`  Tmux session killed: ${session.tmuxSession}\n`);
					} else {
						process.stdout.write(`  Tmux session was already dead\n`);
					}
				}
			}
			if (isZombie) {
				process.stdout.write(`  Zombie agent cleaned up (state → completed)\n`);
			}
			if (isAlreadyCompleted && !staleRuntimeAlive) {
				process.stdout.write(`  Agent was already completed (skipped kill)\n`);
			} else if (isAlreadyCompleted && staleRuntimeAlive) {
				process.stdout.write(`  Reclaimed stale runtime from completed session\n`);
			}
			if (cleanWorktree && worktreeRemoved) {
				process.stdout.write(`  Worktree removed: ${session.worktreePath}\n`);
			}
			if (cleanWorktree && branchDeleted) {
				process.stdout.write(`  Branch deleted: ${session.branchName}\n`);
			}
		}
	} finally {
		store.close();
	}
}
