import { describe, expect, test } from "bun:test";
import { buildSteps } from "./steps.ts";
import type { QuickstartOptions } from "./types.ts";

const defaultOpts: QuickstartOptions = { yes: false, verbose: false };

function makeSpawnMock(
	handler: (cmd: string[]) => { stdoutData?: string; stderrData?: string; exitCode?: number },
): typeof Bun.spawn {
	return ((cmd: string[]) => {
		const { stdoutData = "", stderrData = "", exitCode = 0 } = handler(cmd as string[]);
		const enc = new TextEncoder();
		return {
			stdout: new ReadableStream({
				start(ctrl) {
					if (stdoutData) ctrl.enqueue(enc.encode(stdoutData));
					ctrl.close();
				},
			}),
			stderr: new ReadableStream({
				start(ctrl) {
					if (stderrData) ctrl.enqueue(enc.encode(stderrData));
					ctrl.close();
				},
			}),
			exited: Promise.resolve(exitCode),
		};
	}) as unknown as typeof Bun.spawn;
}

describe("buildSteps", () => {
	test("returns 9 steps with correct ids", () => {
		const steps = buildSteps(defaultOpts);
		expect(steps).toHaveLength(9);
		const ids = steps.map((s) => s.id);
		expect(ids).toEqual([
			"prerequisites",
			"init",
			"hooks",
			"runtime",
			"sample-task",
			"spawn-scout",
			"monitor",
			"review",
			"cleanup",
		]);
	});

	test("each step has required fields", () => {
		const steps = buildSteps(defaultOpts);
		for (const step of steps) {
			expect(typeof step.id).toBe("string");
			expect(typeof step.title).toBe("string");
			expect(typeof step.description).toBe("string");
			expect(typeof step.check).toBe("function");
			expect(typeof step.run).toBe("function");
		}
	});
});

describe("prerequisites step", () => {
	test("returns complete when doctor finds no failing checks", async () => {
		const origSpawn = Bun.spawn;
		const mockStdout = JSON.stringify({
			checks: [
				{ name: "bun", status: "pass" },
				{ name: "git", status: "pass" },
			],
		});

		Bun.spawn = makeSpawnMock(() => ({ stdoutData: mockStdout }));

		const steps = buildSteps(defaultOpts);
		const prereq = steps.find((s) => s.id === "prerequisites")!;
		const result = await prereq.run();

		Bun.spawn = origSpawn;
		expect(result.status).toBe("complete");
	});

	test("returns failed when doctor finds failing checks", async () => {
		const origSpawn = Bun.spawn;
		const mockStdout = JSON.stringify({
			checks: [
				{ name: "tmux", status: "fail" },
				{ name: "git", status: "pass" },
			],
		});

		Bun.spawn = makeSpawnMock(() => ({ stdoutData: mockStdout }));

		const steps = buildSteps(defaultOpts);
		const prereq = steps.find((s) => s.id === "prerequisites")!;
		const result = await prereq.run();

		Bun.spawn = origSpawn;
		expect(result.status).toBe("failed");
		expect(result.message).toContain("tmux");
	});
});

describe("runtime step", () => {
	test("--yes mode returns failed when no runtime (ANTHROPIC_API_KEY unset)", async () => {
		const origKey = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;

		const steps = buildSteps({ yes: true, verbose: false });
		const runtimeStep = steps.find((s) => s.id === "runtime")!;
		const result = await runtimeStep.run();

		if (origKey !== undefined) {
			process.env.ANTHROPIC_API_KEY = origKey;
		}

		expect(result.status).toBe("failed");
		expect(result.message).toContain("ANTHROPIC_API_KEY");
	});

	test("returns complete when ANTHROPIC_API_KEY is set", async () => {
		const origKey = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "test-key";

		const steps = buildSteps({ yes: true });
		const runtimeStep = steps.find((s) => s.id === "runtime")!;
		const result = await runtimeStep.run();

		if (origKey !== undefined) {
			process.env.ANTHROPIC_API_KEY = origKey;
		} else {
			delete process.env.ANTHROPIC_API_KEY;
		}

		expect(result.status).toBe("complete");
	});
});

describe("sample-task step", () => {
	test("uses placeholder id when tracker commands fail", async () => {
		const origSpawn = Bun.spawn;

		// All spawned commands fail — tracker create returns error, fallback to placeholder
		Bun.spawn = makeSpawnMock(() => ({ exitCode: 1 }));

		const steps = buildSteps({ yes: true });
		const sampleStep = steps.find((s) => s.id === "sample-task")!;
		const result = await sampleStep.run();

		Bun.spawn = origSpawn;

		expect(result.status).toBe("complete");
		const taskId = result.details?.[0];
		expect(taskId).toBe("quickstart-sample");
	});
});

describe("monitor step", () => {
	test("returns complete with timeout message when agents persist beyond timeout", async () => {
		const origSpawn = Bun.spawn;
		const origSleep = Bun.sleep;
		const origDateNow = Date.now;

		const activeStatusJson = JSON.stringify({ agents: [{ state: "running" }] });
		Bun.spawn = makeSpawnMock(() => ({ stdoutData: activeStatusJson }));

		// Fast-forward time past 10 minutes on first sleep
		let elapsed = 0;
		Date.now = () => origDateNow() + elapsed;
		// @ts-ignore — override Bun.sleep for test
		Bun.sleep = async () => {
			elapsed += 11 * 60 * 1000;
		};

		const steps = buildSteps({ yes: true });
		const monitorStep = steps.find((s) => s.id === "monitor")!;
		const result = await monitorStep.run();

		Bun.spawn = origSpawn;
		// @ts-ignore
		Bun.sleep = origSleep;
		Date.now = origDateNow;

		// Timeout is partial success, not failure
		expect(result.status).toBe("complete");
		expect(result.message).toContain("Timed out");
	});
});

describe("cleanup step", () => {
	test("skips ov stop when no active agents", async () => {
		const origSpawn = Bun.spawn;
		const stopCalls: string[][] = [];

		const noAgentsJson = JSON.stringify({ agents: [] });
		Bun.spawn = makeSpawnMock((cmd) => {
			if (cmd.includes("stop")) stopCalls.push(cmd);
			if (cmd.includes("status")) return { stdoutData: noAgentsJson };
			return {};
		});

		const steps = buildSteps({ yes: true });
		const cleanupStep = steps.find((s) => s.id === "cleanup")!;
		const result = await cleanupStep.run();

		Bun.spawn = origSpawn;

		expect(result.status).toBe("complete");
		expect(stopCalls).toHaveLength(0);
	});
});
