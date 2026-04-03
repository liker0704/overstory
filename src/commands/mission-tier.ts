/**
 * CLI command: ov mission tier <set|show>
 *
 * Manage mission complexity tier. The coordinator calls `tier set` after
 * assessing complexity. Supports upward escalation (direct→planned→full).
 */

import { join } from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { materializeMissionRolePrompt } from "../missions/context.ts";
import { ensureMissionAnalyst } from "../missions/roles.ts";
import { createMissionStore } from "../missions/store.ts";
import { MISSION_TIERS } from "../missions/types.ts";
import { createSessionStore } from "../sessions/store.ts";
import type { MissionTier } from "../types.ts";
import { sendKeys } from "../worktree/tmux.ts";
import { stopCommand } from "./stop.ts";

export function createMissionTierCommand(): Command {
	const cmd = new Command("tier").description("Manage mission complexity tier");

	cmd
		.command("show")
		.description("Display the current mission tier")
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			const store = createMissionStore(join(overstoryDir, "sessions.db"));
			try {
				const mission = store.getActive();
				if (!mission) {
					if (opts.json) {
						console.log(JSON.stringify({ error: "No active mission" }));
					} else {
						console.error(chalk.red("No active mission"));
					}
					process.exitCode = 1;
					return;
				}
				if (opts.json) {
					console.log(JSON.stringify({ tier: mission.tier, missionId: mission.id }));
				} else {
					console.log(
						`Tier: ${mission.tier ? chalk.cyan(mission.tier) : chalk.yellow("null (assessing)")}`,
					);
				}
			} finally {
				store.close();
			}
		});

	cmd
		.command("set")
		.argument("<tier>", `Tier to set (${MISSION_TIERS.join("|")})`)
		.description("Set mission tier (coordinator calls this after assessment)")
		.option("--json", "Output as JSON")
		.action(async (tierArg: string, opts: { json?: boolean }) => {
			await tierSetCommand(tierArg, opts);
		});

	return cmd;
}

async function tierSetCommand(tierArg: string, opts: { json?: boolean }): Promise<void> {
	// 1. Validate tier value
	if (!MISSION_TIERS.includes(tierArg as MissionTier)) {
		console.error(
			chalk.red(`Invalid tier: ${tierArg}. Must be one of: ${MISSION_TIERS.join(", ")}`),
		);
		process.exitCode = 1;
		return;
	}
	const newTier = tierArg as MissionTier;

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const overstoryDir = join(config.project.root, ".overstory");
	const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));

	try {
		// 2. Load active mission
		const mission = missionStore.getActive();
		if (!mission) {
			console.error(chalk.red("No active mission"));
			process.exitCode = 1;
			return;
		}

		const previousTier = mission.tier;

		// 3. If escalation — kill active leads OUTSIDE transaction (async ops)
		if (previousTier !== null) {
			const sessionStore = createSessionStore(join(overstoryDir, "sessions.db"));
			try {
				const runSessions = mission.runId ? sessionStore.getByRun(mission.runId) : [];
				const leadSessions = runSessions.filter(
					(s) =>
						(s.capability === "lead" || s.capability === "lead-mission") &&
						s.state !== "completed" &&
						s.state !== "zombie",
				);
				if (leadSessions.length > 0) {
					await Promise.all(
						leadSessions.map((s) =>
							stopCommand(s.agentName, {
								json: false,
								force: false,
								cleanWorktree: true,
							}).catch(() => {
								// Best effort — lead may already be dead
							}),
						),
					);
				}
			} finally {
				sessionStore.close();
			}
		}

		// 4. Wrap all DB mutations in a single transaction
		missionStore.transaction(() => {
			// 4a. updateTier — direction enforcement inside store
			missionStore.updateTier(mission.id, newTier, process.env.OVERSTORY_AGENT_NAME ?? "operator");

			// 4b-c. Clear stale state if escalation
			if (previousTier !== null) {
				missionStore.clearGateStates(mission.id);
				missionStore.clearCheckpoints(mission.id);
			}

			// 4d-e. Compute and set start node + phase
			const startPhase = newTier === "direct" ? "execute" : "understand";
			const startNode = `${startPhase}:active`;
			missionStore.updatePhase(mission.id, startPhase as "execute" | "understand");
			missionStore.updateCurrentNode(mission.id, startNode);
		});

		// 5. After transaction — spawn roles and send prompt

		// 6. Lazy-spawn analyst if needed
		if (newTier === "planned" || newTier === "full") {
			const freshMissionForAnalyst = missionStore.getById(mission.id);
			if (freshMissionForAnalyst) {
				await ensureMissionAnalyst(freshMissionForAnalyst, overstoryDir, cwd);
			}
		}

		// 7. Generate tier-specific prompt
		const coordAgentName = mission.slug ? `coordinator-${mission.slug}` : "coordinator";
		const tierCapability =
			newTier === "full" ? "coordinator-mission" : `coordinator-mission-${newTier}`;

		const siblingNames: Record<string, string> = {};
		if (newTier === "planned") {
			const analystName = mission.slug ? `mission-analyst-${mission.slug}` : "mission-analyst";
			siblingNames["Mission Analyst agent"] = analystName;
		} else if (newTier === "full") {
			const analystName = mission.slug ? `mission-analyst-${mission.slug}` : "mission-analyst";
			const edName = mission.slug ? `execution-director-${mission.slug}` : "execution-director";
			siblingNames["Mission Analyst agent"] = analystName;
			siblingNames["Execution Director agent"] = edName;
		}

		const freshMission = missionStore.getById(mission.id);
		if (!freshMission) {
			console.error(chalk.red("Mission not found after tier update"));
			process.exitCode = 1;
			return;
		}

		const prompt = await materializeMissionRolePrompt({
			overstoryDir,
			agentName: coordAgentName,
			capability: tierCapability,
			roleLabel: "Mission Coordinator",
			mission: freshMission,
			siblingNames,
		});

		// 8. Resolve coordinator tmux session name (verified from roles.ts:137-139)
		const coordTmux = mission.slug ? `ov-coordinator-${mission.slug}` : "ov-mission-coordinator";

		// 9. Send prompt path to coordinator via tmux send-keys
		await sendKeys(
			coordTmux,
			`[SYSTEM] Tier set to ${newTier}. Read your new instructions: ${prompt.promptPath}`,
		);

		// 10. Output result
		if (opts.json) {
			console.log(
				JSON.stringify({
					missionId: mission.id,
					previousTier,
					tier: newTier,
					startNode: `${newTier === "direct" ? "execute" : "understand"}:active`,
					promptPath: prompt.promptPath,
				}),
			);
		} else {
			console.log(chalk.green(`✓ Mission tier set to ${chalk.bold(newTier)}`));
			if (previousTier) {
				console.log(chalk.dim(`  Escalated from ${previousTier}`));
			}
			console.log(chalk.dim(`  Prompt: ${prompt.promptPath}`));
		}
	} finally {
		missionStore.close();
	}
}
