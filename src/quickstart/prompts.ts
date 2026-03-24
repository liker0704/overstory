import { createInterface } from "node:readline";
import chalk from "chalk";
import { brand, color, muted } from "../logging/color.ts";
import type { StepResult, StepStatus } from "./types.ts";

/**
 * Ask a yes/no question on the terminal.
 *
 * Returns `defaultYes` without prompting when stdin is not a TTY
 * (process.stdin.isTTY can be undefined in piped mode — strict equality check).
 */
export async function askYesNo(question: string, defaultYes = false): Promise<boolean> {
	if (process.stdin.isTTY !== true) {
		return defaultYes;
	}

	const hint = defaultYes ? "[Y/n]" : "[y/N]";
	const rl = createInterface({ input: process.stdin, output: process.stdout });

	return new Promise((resolve) => {
		rl.question(`${question} ${muted(hint)} `, (answer) => {
			rl.close();
			const lower = answer.trim().toLowerCase();
			if (lower === "") return resolve(defaultYes);
			if (lower === "y" || lower === "yes") return resolve(true);
			if (lower === "n" || lower === "no") return resolve(false);
			resolve(defaultYes);
		});
	});
}

/**
 * Print a step header line: [index/total] Title
 *
 * Uses brand color for the bracket counter and bold for the title.
 */
export function printStep(index: number, total: number, title: string): void {
	const counter = brand(`[${index}/${total}]`);
	process.stdout.write(`${counter} ${color.bold(title)}\n`);
}

/**
 * Print the result line for a completed step.
 *
 * - complete → green checkmark
 * - skipped  → muted circle
 * - failed   → red cross
 * - pending  → dim dot
 */
export function printStepResult(status: StepStatus, message: string): void {
	switch (status) {
		case "complete":
			process.stdout.write(`${chalk.green("\u2713")} ${chalk.green(message)}\n`);
			break;
		case "skipped":
			process.stdout.write(`${muted("\u25cb")} ${muted(message)}\n`);
			break;
		case "failed":
			process.stdout.write(`${chalk.red("\u2717")} ${chalk.red(message)}\n`);
			break;
		case "pending":
			process.stdout.write(`${chalk.dim("\u00b7")} ${chalk.dim(message)}\n`);
			break;
	}
}

/** Print the welcome banner with overstory branding. */
export function printWelcome(): void {
	process.stdout.write(`\n${brand.bold("  overstory")}\n`);
	process.stdout.write(`${muted("  Multi-agent orchestration for Claude Code")}\n\n`);
}

/** Print a final summary line counting complete/skipped/failed steps. */
export function printSummary(results: StepResult[]): void {
	const complete = results.filter((r) => r.status === "complete").length;
	const skipped = results.filter((r) => r.status === "skipped").length;
	const failed = results.filter((r) => r.status === "failed").length;

	const parts: string[] = [];
	if (complete > 0) parts.push(chalk.green(`${complete} complete`));
	if (skipped > 0) parts.push(muted(`${skipped} skipped`));
	if (failed > 0) parts.push(chalk.red(`${failed} failed`));

	const summary = parts.length > 0 ? parts.join(", ") : muted("no steps");
	process.stdout.write(`\n${brand("\u2192")} ${summary}\n`);
}
