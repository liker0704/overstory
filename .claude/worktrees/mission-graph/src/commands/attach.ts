/**
 * CLI command: ov attach [agent-name]
 *
 * Attach to a running agent's tmux session.
 * If no agent name given, lists active agents to pick from.
 */

import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { printWarning } from "../logging/color.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { attachOrSwitch, listSessions } from "../worktree/tmux.ts";

export function createAttachCommand(): Command {
	return new Command("attach")
		.description("Attach to a running agent's tmux session")
		.argument("[agent-name]", "Agent to attach to")
		.action(async (agentName: string | undefined) => {
			await attachCommand(agentName);
		});
}

async function attachCommand(agentName: string | undefined): Promise<void> {
	const config = await loadConfig(process.cwd());
	const root = config.project.root;
	const overstoryDir = `${root}/.overstory`;

	const { store } = openSessionStore(overstoryDir);
	try {
		const aliveTmux = new Set((await listSessions()).map((s) => s.name));
		const sessions = store.getAll().filter((s) => aliveTmux.has(s.tmuxSession));

		if (sessions.length === 0) {
			printWarning("No running agents found.");
			return;
		}

		if (!agentName) {
			// List active agents
			const pad = (str: string, len: number) => str.padEnd(len);
			console.log("Running agents:\n");
			console.log(`  ${pad("Agent", 30)} ${pad("Capability", 14)} ${pad("Runtime", 10)} State`);
			for (const s of sessions) {
				console.log(
					`  ${pad(s.agentName, 30)} ${pad(s.capability, 14)} ${pad(s.runtime ?? "claude", 10)} ${s.state}`,
				);
			}
			console.log(`\nUsage: ov attach <agent-name>`);
			return;
		}

		const session = sessions.find((s) => s.agentName === agentName);
		if (!session) {
			// Try partial match
			const matches = sessions.filter((s) => s.agentName.includes(agentName));
			if (matches.length === 1 && matches[0]) {
				attachTmux(matches[0].tmuxSession);
				return;
			}
			if (matches.length > 1) {
				printWarning(`Multiple agents match '${agentName}':`);
				for (const m of matches) {
					console.log(`  ${m.agentName}`);
				}
				return;
			}
			printWarning(`No running agent '${agentName}'. Use 'ov attach' to list.`);
			return;
		}

		attachTmux(session.tmuxSession);
	} finally {
		store.close();
	}
}

function attachTmux(tmuxSession: string): void {
	attachOrSwitch(tmuxSession);
}
