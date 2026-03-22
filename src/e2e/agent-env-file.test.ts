import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	buildBashFileGuardScript,
	buildBashPathBoundaryScript,
	buildPathBoundaryGuardScript,
	buildTrackerCloseGuardScript,
} from "../agents/hooks-deployer.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import { removeAgentEnvFile, writeAgentEnvFile } from "../worktree/tmux.ts";

/**
 * E2E test: agent env file write/read/cleanup lifecycle.
 *
 * Validates that:
 * - writeAgentEnvFile creates `.claude/.agent-env` with correct exports
 * - Hook guard scripts can source the file to recover env vars
 * - removeAgentEnvFile cleans up correctly
 * - Guards block when env file provides agent context (no process env vars)
 * - Guards pass through when no env file exists (user's own session)
 *
 * Uses real filesystem and real shell execution. No mocks.
 */

const TEST_SESSION_ID = "test-session-001";

describe("E2E: agent env file lifecycle", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		await mkdir(join(tempDir, ".claude"), { recursive: true });
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	describe("writeAgentEnvFile / removeAgentEnvFile", () => {
		test("creates .claude/.agent-env with export lines", async () => {
			const env = {
				OVERSTORY_AGENT_NAME: "test-builder",
				OVERSTORY_WORKTREE_PATH: "/tmp/test-worktree",
				OVERSTORY_TASK_ID: "task-42",
			};

			await writeAgentEnvFile(tempDir, env);

			const filePath = join(tempDir, ".claude", ".agent-env");
			expect(existsSync(filePath)).toBe(true);

			const content = await Bun.file(filePath).text();
			expect(content).toContain('export OVERSTORY_AGENT_NAME="test-builder"');
			expect(content).toContain('export OVERSTORY_WORKTREE_PATH="/tmp/test-worktree"');
			expect(content).toContain('export OVERSTORY_TASK_ID="task-42"');
		});

		test("removeAgentEnvFile deletes the file", async () => {
			const env = {
				OVERSTORY_AGENT_NAME: "test-agent",
				OVERSTORY_RUNTIME_SESSION_ID: TEST_SESSION_ID,
			};
			await writeAgentEnvFile(tempDir, env);

			const filePath = join(tempDir, ".claude", `.agent-env.${TEST_SESSION_ID}`);
			expect(existsSync(filePath)).toBe(true);

			removeAgentEnvFile(tempDir, TEST_SESSION_ID);
			expect(existsSync(filePath)).toBe(false);
		});

		test("removeAgentEnvFile is safe on missing file", () => {
			// Should not throw
			removeAgentEnvFile(tempDir);
			removeAgentEnvFile(join(tempDir, "nonexistent"));
		});

		test("overwrites existing env file on re-create", async () => {
			await writeAgentEnvFile(tempDir, { OVERSTORY_AGENT_NAME: "old-agent" });
			await writeAgentEnvFile(tempDir, { OVERSTORY_AGENT_NAME: "new-agent" });

			const content = await Bun.file(join(tempDir, ".claude", ".agent-env")).text();
			expect(content).toContain("new-agent");
			expect(content).not.toContain("old-agent");
		});
	});

	describe("ENV_GUARD file fallback in hook scripts", () => {
		/**
		 * Helper: run a hook guard script in a shell with NO OVERSTORY_* env vars,
		 * but with .claude/.agent-env present. The guard should source the file.
		 */
		async function runGuardScript(
			script: string,
			cwd: string,
			stdin?: string,
		): Promise<{ stdout: string; exitCode: number }> {
			const proc = Bun.spawn(["sh", "-c", script], {
				cwd,
				stdin: stdin ? new TextEncoder().encode(stdin) : undefined,
				stdout: "pipe",
				stderr: "pipe",
				env: {
					// Minimal env — no OVERSTORY_AGENT_NAME, simulating lost env after compaction
					PATH: process.env.PATH,
					HOME: process.env.HOME,
					OVERSTORY_RUNTIME_SESSION_ID: TEST_SESSION_ID,
				},
			});
			const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
			return { stdout: stdout.trim(), exitCode };
		}

		test("guard sources .agent-env and activates when file exists", async () => {
			// Write env file simulating an agent session
			await writeAgentEnvFile(tempDir, {
				OVERSTORY_AGENT_NAME: "test-scout",
				OVERSTORY_WORKTREE_PATH: tempDir,
				OVERSTORY_RUNTIME_SESSION_ID: TEST_SESSION_ID,
			});

			// Use buildBashFileGuardScript which includes ENV_GUARD
			// It should block dangerous commands when agent context is recovered from file
			const script = buildBashFileGuardScript("scout", "test-scout");
			const input = JSON.stringify({ command: "rm -rf /tmp/something" });

			const result = await runGuardScript(script, tempDir, input);
			// Should output a block decision
			expect(result.stdout).toContain('"decision":"block"');
		});

		test("guard exits silently when no env file and no env var", async () => {
			// No .agent-env file, no OVERSTORY_AGENT_NAME env var
			// Guard should exit 0 (no-op for user's own session)
			const script = buildBashFileGuardScript("scout", "test-scout");
			const input = JSON.stringify({ command: "rm -rf /tmp/something" });

			const result = await runGuardScript(script, tempDir, input);
			// Should NOT output a block — guard exited early
			expect(result.stdout).not.toContain("block");
			expect(result.exitCode).toBe(0);
		});

		test("path boundary guard recovers worktree path from env file", async () => {
			await writeAgentEnvFile(tempDir, {
				OVERSTORY_AGENT_NAME: "test-builder",
				OVERSTORY_WORKTREE_PATH: tempDir,
				OVERSTORY_RUNTIME_SESSION_ID: TEST_SESSION_ID,
			});

			const script = buildPathBoundaryGuardScript("file_path");
			// File path OUTSIDE the worktree — should be blocked
			const input = JSON.stringify({ file_path: "/etc/passwd" });

			const result = await runGuardScript(script, tempDir, input);
			expect(result.stdout).toContain("Path boundary violation");
		});

		test("path boundary guard allows files inside worktree", async () => {
			await writeAgentEnvFile(tempDir, {
				OVERSTORY_AGENT_NAME: "test-builder",
				OVERSTORY_WORKTREE_PATH: tempDir,
				OVERSTORY_RUNTIME_SESSION_ID: TEST_SESSION_ID,
			});

			const script = buildPathBoundaryGuardScript("file_path");
			const input = JSON.stringify({ file_path: `${tempDir}/src/main.ts` });

			const result = await runGuardScript(script, tempDir, input);
			expect(result.stdout).not.toContain("block");
		});

		test("tracker close guard recovers task ID from env file", async () => {
			await writeAgentEnvFile(tempDir, {
				OVERSTORY_AGENT_NAME: "test-worker",
				OVERSTORY_TASK_ID: "my-task-123",
				OVERSTORY_RUNTIME_SESSION_ID: TEST_SESSION_ID,
			});

			const script = buildTrackerCloseGuardScript();

			// Wrong task ID — should block
			const blockInput = JSON.stringify({ command: "sd close wrong-task" });
			const blockResult = await runGuardScript(script, tempDir, blockInput);
			expect(blockResult.stdout).toContain("block");

			// Correct task ID — should allow
			const allowInput = JSON.stringify({ command: "sd close my-task-123" });
			const allowResult = await runGuardScript(script, tempDir, allowInput);
			expect(allowResult.stdout).not.toContain("block");
		});

		test("bash path boundary guard recovers from env file", async () => {
			await writeAgentEnvFile(tempDir, {
				OVERSTORY_AGENT_NAME: "test-builder",
				OVERSTORY_WORKTREE_PATH: tempDir,
				OVERSTORY_RUNTIME_SESSION_ID: TEST_SESSION_ID,
			});

			const script = buildBashPathBoundaryScript();

			// sed -i targeting file outside worktree — should block
			const blockInput = JSON.stringify({ command: `sed -i 's/a/b/' /etc/hosts` });
			const blockResult = await runGuardScript(script, tempDir, blockInput);
			expect(blockResult.stdout).toContain("block");

			// sed -i targeting file inside worktree — should allow
			const allowInput = JSON.stringify({
				command: `sed -i 's/a/b/' ${tempDir}/src/main.ts`,
			});
			const allowResult = await runGuardScript(script, tempDir, allowInput);
			expect(allowResult.stdout).not.toContain("block");
		});
	});

	describe("full lifecycle: write → guard → cleanup → guard", () => {
		test("guards activate with env file, deactivate after cleanup", async () => {
			const script = buildBashFileGuardScript("scout", "test-scout");
			const input = JSON.stringify({ command: "touch /tmp/file" });

			// Phase 1: No env file — guard is no-op
			const before = await runGuardInDir(script, tempDir, input);
			expect(before.stdout).not.toContain("block");

			// Phase 2: Write env file — guard activates
			await writeAgentEnvFile(tempDir, {
				OVERSTORY_AGENT_NAME: "test-scout",
				OVERSTORY_RUNTIME_SESSION_ID: TEST_SESSION_ID,
			});
			const during = await runGuardInDir(script, tempDir, input);
			expect(during.stdout).toContain('"decision":"block"');

			// Phase 3: Remove env file — guard deactivates
			removeAgentEnvFile(tempDir, TEST_SESSION_ID);
			const after = await runGuardInDir(script, tempDir, input);
			expect(after.stdout).not.toContain("block");
		});
	});
});

/** Run a guard script with no OVERSTORY_* env vars. */
async function runGuardInDir(
	script: string,
	cwd: string,
	stdin: string,
): Promise<{ stdout: string; exitCode: number }> {
	const proc = Bun.spawn(["sh", "-c", script], {
		cwd,
		stdin: new TextEncoder().encode(stdin),
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			OVERSTORY_RUNTIME_SESSION_ID: TEST_SESSION_ID,
		},
	});
	const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	return { stdout: stdout.trim(), exitCode };
}
