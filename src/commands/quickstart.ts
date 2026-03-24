import { Command } from "commander";
import { runQuickstart } from "../quickstart/engine.ts";

export function createQuickstartCommand(): Command {
	return new Command("quickstart")
		.description("Guided first-run wizard for new users")
		.option("--yes", "Auto-accept all prompts")
		.option("--verbose", "Show full command output")
		.option("--json", "Output results as JSON")
		.action(async (opts) => {
			await quickstartCommand(opts);
		});
}

export async function quickstartCommand(opts: {
	yes?: boolean;
	verbose?: boolean;
	json?: boolean;
}): Promise<void> {
	await runQuickstart({ yes: opts.yes, verbose: opts.verbose, json: opts.json });
}
