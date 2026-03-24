import { jsonOutput } from "../json.ts";
import { printStep, printStepResult, printSummary, printWelcome } from "./prompts.ts";
import { buildSteps } from "./steps.ts";
import type { QuickstartOptions, QuickstartStep, StepResult, StepStatus } from "./types.ts";

export interface EngineDeps {
	buildSteps: (options: QuickstartOptions) => QuickstartStep[];
	printWelcome: () => void;
	printStep: (index: number, total: number, title: string) => void;
	printStepResult: (status: StepStatus, message: string) => void;
	printSummary: (results: StepResult[]) => void;
}

export async function runQuickstart(
	options: QuickstartOptions,
	deps?: Partial<EngineDeps>,
): Promise<void> {
	const resolved: EngineDeps = {
		buildSteps,
		printWelcome,
		printStep,
		printStepResult,
		printSummary,
		...deps,
	};

	resolved.printWelcome();

	const steps = resolved.buildSteps(options);
	const total = steps.length;
	const results: StepResult[] = [];

	for (let i = 0; i < steps.length; i++) {
		const step = steps[i];
		if (step === undefined) continue;

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
			process.stderr.write(
				`Prerequisite check failed. Fix the issues above and re-run 'ov quickstart'.\n`,
			);
			return;
		}

		results.push(result);
	}

	resolved.printSummary(results);

	if (options.json) {
		jsonOutput("quickstart", { steps: results });
	}
}
