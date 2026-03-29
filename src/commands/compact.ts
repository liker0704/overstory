/**
 * CLI command: ov compact [domain] [--analyze] [--apply] [--auto] [--dry-run]
 *
 * Compact mulch expertise records — merge related entries, consolidate
 * tactical notes, and enforce governance limits.
 */

import { loadConfig } from "../config.ts";
import { jsonOutput } from "../json.ts";
import { printError, printSuccess } from "../logging/color.ts";
import { createMulchClient } from "../mulch/client.ts";

interface CompactOpts {
	analyze?: boolean;
	apply?: boolean;
	auto?: boolean;
	dryRun?: boolean;
	minGroup?: number;
	maxRecords?: number;
	yes?: boolean;
	json?: boolean;
}

export async function compactCommand(domain: string | undefined, opts: CompactOpts): Promise<void> {
	const config = await loadConfig(process.cwd());

	if (!config.mulch.enabled) {
		printError("Mulch is not enabled in config");
		process.exitCode = 1;
		return;
	}

	const mulch = createMulchClient(config.project.root);
	const result = await mulch.compact(domain, {
		analyze: opts.analyze,
		apply: opts.apply,
		auto: opts.auto,
		dryRun: opts.dryRun,
		minGroup: opts.minGroup,
		maxRecords: opts.maxRecords,
		yes: opts.yes,
	});

	if (opts.json) {
		jsonOutput("compact", result as unknown as Record<string, unknown>);
		return;
	}

	if (result.compacted && result.compacted.length > 0) {
		const totalReduced = result.compacted.reduce((sum, c) => sum + (c.before - c.after), 0);
		printSuccess(
			`Compacted: ${totalReduced} record(s) merged across ${result.compacted.length} group(s)`,
		);
	} else if (result.message) {
		printSuccess(result.message);
	} else {
		printSuccess("Nothing to compact");
	}
}
