import { jsonOutput } from "../json.ts";
import type { QuickstartOptions, QuickstartStep, StepResult, StepStatus } from "./types.ts";

export interface EngineDeps {
	buildSteps: (options: QuickstartOptions) => QuickstartStep[];
	printWelcome: () => void;
	printStep: (index: number, total: number, title: string) => void;
	printStepResult: (status: StepStatus, message: string) => void;
	printSummary: (results: StepResult[]) => void;
}

async function loadDefaultDeps(): Promise<EngineDeps> {
	// steps.ts is built by sibling builder and resolved after merge
	const stepsPath = "./steps.ts";
	const [stepsModule, { printWelcome, printStep, printStepResult, printSummary }] =
		await Promise.all([
			import(stepsPath) as Promise<{ buildSteps: (opts: QuickstartOptions) => QuickstartStep[] }>,
			import("./prompts.ts"),
		]);
	return {
		buildSteps: stepsModule.buildSteps,
		printWelcome,
		printStep,
		printStepResult,
		printSummary,
	};
}

export async function runQuickstart(
	options: QuickstartOptions,
	deps?: Partial<EngineDeps>,
): Promise<void> {
	const resolved: EngineDeps =
		deps && Object.keys(deps).length === 5
			? (deps as EngineDeps)
			: { ...(await loadDefaultDeps()), ...deps };

	resolved.printWelcome();

	const steps = resolved.buildSteps(options);
	const total = steps.length;
	const results: StepResult[] = [];

	for (let i = 0; i < steps.length; i++) {
		const step = steps[i];
		if (!step) continue;

		if (step.skip) {
			results.push({ status: "skipped", message: step.title });
			continue;
		}

		const checkStatus = await step.check();
		if (checkStatus === "complete") {
			resolved.printStepResult("complete", `${step.title} (already done)`);
			results.push({ status: "complete", message: step.title });
			continue;
		}

		resolved.printStep(i + 1, total, step.title);

		const result = await step.run();
		resolved.printStepResult(result.status, result.message ?? step.title);

		if (options.verbose && result.details) {
			for (const detail of result.details) {
				process.stdout.write(`  ${detail}\n`);
			}
		}

		if (result.status === "failed" && step.id === "prerequisites") {
			process.stderr.write("Prerequisites failed — aborting quickstart.\n");
			results.push(result);
			return;
		}

		results.push(result);
	}

	resolved.printSummary(results);

	if (options.json) {
		jsonOutput("quickstart", { steps: results });
	}
}
