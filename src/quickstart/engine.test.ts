import { describe, expect, it } from "bun:test";
import type { EngineDeps } from "./engine.ts";
import { runQuickstart } from "./engine.ts";
import type { QuickstartOptions, QuickstartStep, StepResult, StepStatus } from "./types.ts";

function makeStep(
	id: string,
	overrides?: Partial<QuickstartStep & { checkStatus?: StepStatus; runResult?: StepResult }>,
): QuickstartStep {
	const checkStatus: StepStatus = overrides?.checkStatus ?? "pending";
	const runResult: StepResult = overrides?.runResult ?? { status: "complete", message: id };
	return {
		id,
		title: `Step ${id}`,
		description: `Description for ${id}`,
		check: async () => checkStatus,
		run: async () => runResult,
		skip: overrides?.skip,
	};
}

function makeDeps(steps: QuickstartStep[]): {
	deps: EngineDeps;
	welcomed: boolean[];
	printed: Array<{ index: number; total: number; title: string }>;
	results: Array<{ status: StepStatus; message: string }>;
	summaryResults: StepResult[][];
} {
	const welcomed: boolean[] = [];
	const printed: Array<{ index: number; total: number; title: string }> = [];
	const results: Array<{ status: StepStatus; message: string }> = [];
	const summaryResults: StepResult[][] = [];

	const deps: EngineDeps = {
		buildSteps: (_opts: QuickstartOptions) => steps,
		printWelcome: () => welcomed.push(true),
		printStep: (index, total, title) => printed.push({ index, total, title }),
		printStepResult: (status, message) => results.push({ status, message }),
		printSummary: (r) => summaryResults.push(r),
	};

	return { deps, welcomed, printed, results, summaryResults };
}

describe("runQuickstart", () => {
	it("runs all steps in order", async () => {
		const steps = [makeStep("a"), makeStep("b"), makeStep("c")];
		const { deps, welcomed, printed, summaryResults } = makeDeps(steps);

		await runQuickstart({}, deps);

		expect(welcomed).toHaveLength(1);
		expect(printed.map((p) => p.title)).toEqual(["Step a", "Step b", "Step c"]);
		expect(summaryResults).toHaveLength(1);
	});

	it("skips steps where check() returns complete", async () => {
		const steps = [makeStep("a", { checkStatus: "complete" }), makeStep("b")];
		const { deps, printed, results } = makeDeps(steps);

		await runQuickstart({}, deps);

		// Only step b should be printed (step a was already done)
		expect(printed.map((p) => p.title)).toEqual(["Step b"]);
		// Step a gets a printStepResult with 'complete'
		expect(results[0]).toEqual({ status: "complete", message: "Step a (already done)" });
	});

	it("skips steps with skip=true", async () => {
		const steps = [makeStep("a", { skip: true }), makeStep("b")];
		const { deps, printed, summaryResults } = makeDeps(steps);

		await runQuickstart({}, deps);

		expect(printed.map((p) => p.title)).toEqual(["Step b"]);
		const summary = summaryResults[0];
		expect(summary).toBeDefined();
		expect(summary?.[0]?.status).toBe("skipped");
	});

	it("aborts on prerequisites failure", async () => {
		const steps = [
			makeStep("prerequisites", { runResult: { status: "failed", message: "missing tools" } }),
			makeStep("b"),
		];
		const { deps, printed, summaryResults } = makeDeps(steps);

		await runQuickstart({}, deps);

		// Only prerequisites step ran; b was not reached
		expect(printed.map((p) => p.title)).toEqual(["Step prerequisites"]);
		// printSummary was NOT called (aborted before it)
		expect(summaryResults).toHaveLength(0);
	});

	it("continues on non-critical failure", async () => {
		const steps = [
			makeStep("a", { runResult: { status: "failed", message: "oops" } }),
			makeStep("b"),
		];
		const { deps, printed, summaryResults } = makeDeps(steps);

		await runQuickstart({}, deps);

		expect(printed.map((p) => p.title)).toEqual(["Step a", "Step b"]);
		expect(summaryResults).toHaveLength(1);
	});

	it("calls printWelcome once", async () => {
		const { deps, welcomed } = makeDeps([]);
		await runQuickstart({}, deps);
		expect(welcomed).toHaveLength(1);
	});

	it("calls printSummary with all results", async () => {
		const steps = [makeStep("a"), makeStep("b")];
		const { deps, summaryResults } = makeDeps(steps);

		await runQuickstart({}, deps);

		expect(summaryResults).toHaveLength(1);
		expect(summaryResults[0]).toHaveLength(2);
	});

	it("prints details when verbose and details present", async () => {
		const lines: string[] = [];
		const origWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = (chunk: string | Uint8Array) => {
			if (typeof chunk === "string") lines.push(chunk);
			return true;
		};

		const steps = [
			makeStep("a", {
				runResult: { status: "complete", message: "done", details: ["detail1", "detail2"] },
			}),
		];
		const { deps } = makeDeps(steps);

		try {
			await runQuickstart({ verbose: true }, deps);
		} finally {
			process.stdout.write = origWrite;
		}

		const detailLines = lines.filter((l) => l.startsWith("  detail"));
		expect(detailLines).toHaveLength(2);
	});

	it("does not print details when not verbose", async () => {
		const lines: string[] = [];
		const origWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = (chunk: string | Uint8Array) => {
			if (typeof chunk === "string") lines.push(chunk);
			return true;
		};

		const steps = [
			makeStep("a", {
				runResult: { status: "complete", message: "done", details: ["detail1"] },
			}),
		];
		const { deps } = makeDeps(steps);

		try {
			await runQuickstart({ verbose: false }, deps);
		} finally {
			process.stdout.write = origWrite;
		}

		const detailLines = lines.filter((l) => l.startsWith("  detail"));
		expect(detailLines).toHaveLength(0);
	});
});
