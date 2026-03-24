import { describe, expect, it, mock } from "bun:test";
import type { EngineDeps } from "./engine.ts";
import { runQuickstart } from "./engine.ts";
import type { QuickstartOptions, QuickstartStep, StepResult } from "./types.ts";

function makeStep(overrides: Partial<QuickstartStep> = {}): QuickstartStep {
	return {
		id: "test-step",
		title: "Test Step",
		description: "A test step",
		check: async () => "pending",
		run: async () => ({ status: "complete", message: "done" }),
		...overrides,
	};
}

function makeDeps(overrides: Partial<EngineDeps> = {}): EngineDeps {
	return {
		buildSteps: () => [],
		printWelcome: mock(() => {}),
		printStep: mock(() => {}),
		printStepResult: mock(() => {}),
		printSummary: mock(() => {}),
		...overrides,
	};
}

describe("runQuickstart", () => {
	it("calls printWelcome at start", async () => {
		const deps = makeDeps();
		await runQuickstart({}, deps);
		expect(deps.printWelcome).toHaveBeenCalledTimes(1);
	});

	it("calls printSummary at end", async () => {
		const deps = makeDeps();
		await runQuickstart({}, deps);
		expect(deps.printSummary).toHaveBeenCalledTimes(1);
	});

	it("runs steps in order", async () => {
		const order: string[] = [];
		const steps: QuickstartStep[] = [
			makeStep({
				id: "a",
				run: async () => {
					order.push("a");
					return { status: "complete" };
				},
			}),
			makeStep({
				id: "b",
				run: async () => {
					order.push("b");
					return { status: "complete" };
				},
			}),
			makeStep({
				id: "c",
				run: async () => {
					order.push("c");
					return { status: "complete" };
				},
			}),
		];
		const deps = makeDeps({ buildSteps: () => steps });
		await runQuickstart({}, deps);
		expect(order).toEqual(["a", "b", "c"]);
	});

	it("skips steps where check() returns complete", async () => {
		const runFn = mock(async (): Promise<StepResult> => ({ status: "complete" }));
		const steps: QuickstartStep[] = [
			makeStep({ id: "done", check: async () => "complete", run: runFn }),
		];
		const deps = makeDeps({ buildSteps: () => steps });
		await runQuickstart({}, deps);
		expect(runFn).not.toHaveBeenCalled();
		expect(deps.printStepResult).toHaveBeenCalledWith("complete", "Test Step (already done)");
	});

	it("skips steps with skip=true", async () => {
		const runFn = mock(async (): Promise<StepResult> => ({ status: "complete" }));
		const steps: QuickstartStep[] = [makeStep({ id: "skip-me", skip: true, run: runFn })];
		const deps = makeDeps({ buildSteps: () => steps });
		await runQuickstart({}, deps);
		expect(runFn).not.toHaveBeenCalled();
		expect(deps.printStep).not.toHaveBeenCalled();
	});

	it("aborts on prerequisites step failure", async () => {
		const afterFn = mock(async (): Promise<StepResult> => ({ status: "complete" }));
		const steps: QuickstartStep[] = [
			makeStep({
				id: "prerequisites",
				run: async () => ({ status: "failed", message: "missing tools" }),
			}),
			makeStep({ id: "after", run: afterFn }),
		];
		const deps = makeDeps({ buildSteps: () => steps });
		await runQuickstart({}, deps);
		expect(afterFn).not.toHaveBeenCalled();
	});

	it("continues on non-prerequisites failure", async () => {
		const afterFn = mock(async (): Promise<StepResult> => ({ status: "complete" }));
		const steps: QuickstartStep[] = [
			makeStep({ id: "optional-step", run: async () => ({ status: "failed", message: "failed" }) }),
			makeStep({ id: "after", run: afterFn }),
		];
		const deps = makeDeps({ buildSteps: () => steps });
		await runQuickstart({}, deps);
		expect(afterFn).toHaveBeenCalled();
	});

	it("calls printStep with correct index and total", async () => {
		const steps: QuickstartStep[] = [
			makeStep({ id: "step1", title: "Step One" }),
			makeStep({ id: "step2", title: "Step Two" }),
		];
		const deps = makeDeps({ buildSteps: () => steps });
		await runQuickstart({}, deps);
		expect(deps.printStep).toHaveBeenCalledWith(1, 2, "Step One");
		expect(deps.printStep).toHaveBeenCalledWith(2, 2, "Step Two");
	});

	it("calls printStepResult with result status and message", async () => {
		const steps: QuickstartStep[] = [
			makeStep({
				id: "step1",
				title: "My Step",
				run: async () => ({ status: "complete", message: "all good" }),
			}),
		];
		const deps = makeDeps({ buildSteps: () => steps });
		await runQuickstart({}, deps);
		expect(deps.printStepResult).toHaveBeenCalledWith("complete", "all good");
	});

	it("falls back to step title when result has no message", async () => {
		const steps: QuickstartStep[] = [
			makeStep({ id: "step1", title: "My Step", run: async () => ({ status: "complete" }) }),
		];
		const deps = makeDeps({ buildSteps: () => steps });
		await runQuickstart({}, deps);
		expect(deps.printStepResult).toHaveBeenCalledWith("complete", "My Step");
	});

	it("prints details when verbose is set", async () => {
		const writeSpy = mock((_s: string) => {});
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = writeSpy as unknown as typeof process.stdout.write;

		const steps: QuickstartStep[] = [
			makeStep({
				id: "step1",
				run: async () => ({ status: "complete", message: "done", details: ["line 1", "line 2"] }),
			}),
		];
		const deps = makeDeps({ buildSteps: () => steps });

		try {
			await runQuickstart({ verbose: true }, deps);
		} finally {
			process.stdout.write = original;
		}

		const calls = writeSpy.mock.calls.map((c) => c[0] as string);
		expect(calls.some((c) => c.includes("line 1"))).toBe(true);
		expect(calls.some((c) => c.includes("line 2"))).toBe(true);
	});

	it("does not print details when verbose is not set", async () => {
		const writeSpy = mock((_s: string) => {});
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = writeSpy as unknown as typeof process.stdout.write;

		const steps: QuickstartStep[] = [
			makeStep({
				id: "step1",
				run: async () => ({ status: "complete", message: "done", details: ["secret detail"] }),
			}),
		];
		const deps = makeDeps({ buildSteps: () => steps });

		try {
			await runQuickstart({}, deps);
		} finally {
			process.stdout.write = original;
		}

		const calls = writeSpy.mock.calls.map((c) => c[0] as string);
		expect(calls.every((c) => !c.includes("secret detail"))).toBe(true);
	});

	it("passes options to buildSteps", async () => {
		const buildFn = mock((_opts: QuickstartOptions): QuickstartStep[] => []);
		const opts: QuickstartOptions = { yes: true, verbose: false };
		const deps = makeDeps({ buildSteps: buildFn });
		await runQuickstart(opts, deps);
		expect(buildFn).toHaveBeenCalledWith(opts);
	});
});
