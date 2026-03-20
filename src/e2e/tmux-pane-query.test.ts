import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	capturePaneContent,
	detectAgentState,
	getPaneActivity,
	getPaneWidth,
} from "../worktree/tmux.ts";

/**
 * E2E test: tmux pane width/activity queries against a real tmux session.
 *
 * Validates that getPaneWidth() and getPaneActivity() return correct values
 * from real tmux sessions, including after resize operations. This tests the
 * small-pane fallback path used when phone-sized clients shrink agent panes.
 *
 * Requires tmux to be installed. Uses real tmux — no mocks.
 */

const TEST_SESSION = "overstory-test-pane-query";

/** Run a tmux command, return stdout. Throws on failure. */
async function tmuxRun(...args: string[]): Promise<string> {
	const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`tmux ${args[0]} failed: ${stderr}`);
	}
	return stdout.trim();
}

async function tmuxAvailable(): Promise<boolean> {
	try {
		const proc = Bun.spawn(["tmux", "-V"], { stdout: "pipe", stderr: "pipe" });
		return (await proc.exited) === 0;
	} catch {
		return false;
	}
}

describe("E2E: tmux pane width/activity queries", () => {
	let skip = false;

	beforeAll(async () => {
		if (!(await tmuxAvailable())) {
			skip = true;
			return;
		}

		// Kill any leftover test session
		try {
			await tmuxRun("kill-session", "-t", TEST_SESSION);
		} catch {
			// OK — didn't exist
		}

		// Create a detached session
		try {
			await tmuxRun("new-session", "-d", "-s", TEST_SESSION, "-x", "170", "-y", "40");
		} catch {
			skip = true;
		}
	});

	afterAll(async () => {
		if (!skip) {
			try {
				await tmuxRun("kill-session", "-t", TEST_SESSION);
			} catch {
				// OK
			}
		}
	});

	test("getPaneWidth returns a numeric width", async () => {
		if (skip) return;

		const width = await getPaneWidth(TEST_SESSION);
		expect(width).toBeNumber();
		// Detached session should respect -x 170, but if other clients are
		// attached to the tmux server, `window-size` policy may shrink it.
		// Just verify it's a reasonable positive number.
		expect(width).toBeGreaterThan(0);
	});

	test("getPaneWidth returns small value after resize", async () => {
		if (skip) return;

		await tmuxRun("resize-window", "-t", TEST_SESSION, "-x", "40", "-y", "20");
		await Bun.sleep(50);

		const width = await getPaneWidth(TEST_SESSION);
		expect(width).toBeNumber();
		expect(width).toBeLessThanOrEqual(80);

		// Restore
		await tmuxRun("resize-window", "-t", TEST_SESSION, "-x", "170", "-y", "40");
	});

	test("getPaneActivity returns a recent epoch timestamp", async () => {
		if (skip) return;

		// Generate output to update window_activity
		await tmuxRun("send-keys", "-t", TEST_SESSION, "echo pane-activity-test", "Enter");
		await Bun.sleep(300);

		const activity = await getPaneActivity(TEST_SESSION);
		expect(activity).toBeNumber();
		expect(activity).toBeGreaterThan(0);

		// Should be within the last 10 seconds
		const nowEpoch = Math.floor(Date.now() / 1000);
		expect(nowEpoch - activity!).toBeLessThan(10);
	});

	test("getPaneActivity timestamp stays roughly stable without new output", async () => {
		if (skip) return;

		// Wait for any shell prompt redraw to settle
		await Bun.sleep(1500);

		const before = await getPaneActivity(TEST_SESSION);
		expect(before).toBeNumber();

		// Wait without producing output
		await Bun.sleep(2000);

		const after = await getPaneActivity(TEST_SESSION);
		expect(after).toBeNumber();
		// Allow up to 2s drift (shell prompt redraw may bump the timestamp once)
		expect(after! - before!).toBeLessThanOrEqual(2);
	});

	test("getPaneWidth returns null for nonexistent session", async () => {
		const width = await getPaneWidth("overstory-nonexistent-xyz");
		expect(width).toBeNull();
	});

	test("getPaneActivity returns null for nonexistent session", async () => {
		const activity = await getPaneActivity("overstory-nonexistent-xyz");
		expect(activity).toBeNull();
	});

	test("small pane + no status bar → unknown state, fallback data available", async () => {
		if (skip) return;

		// Resize to phone-like dimensions
		await tmuxRun("resize-window", "-t", TEST_SESSION, "-x", "40", "-y", "15");
		await Bun.sleep(50);

		// Plain shell has no Claude Code status bar → "unknown"
		const content = await capturePaneContent(TEST_SESSION);
		if (content) {
			expect(detectAgentState(content)).toBe("unknown");
		}

		// Verify fallback data is available for nudgeIfIdle:
		// 1. Width is small (triggers fallback path)
		const width = await getPaneWidth(TEST_SESSION);
		expect(width).toBeNumber();
		expect(width).toBeLessThanOrEqual(80);

		// 2. window_activity timestamp is available
		const activity = await getPaneActivity(TEST_SESSION);
		expect(activity).toBeNumber();
		expect(activity).toBeGreaterThan(0);

		// Restore
		await tmuxRun("resize-window", "-t", TEST_SESSION, "-x", "170", "-y", "40");
	});
});
