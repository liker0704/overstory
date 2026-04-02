/**
 * CLI command: ov mission <subcommand>
 *
 * Long-running objective tracking for overstory mission mode.
 * This file contains only Commander subcommand registration and argument
 * parsing. Domain logic lives in src/missions/ modules.
 */

import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { missionRefreshBriefsCommand } from "../missions/brief-refresh.ts";
import { missionBundle } from "../missions/bundle.ts";
import {
	missionAnswer,
	missionComplete,
	missionExtractLearnings,
	missionPause,
	missionResumeAll,
	missionStart,
	missionStop,
	missionUpdate,
} from "../missions/lifecycle.ts";
import {
	missionArtifacts,
	missionGraph,
	missionList,
	missionOutput,
	missionShow,
	missionStatus,
} from "../missions/render.ts";
import { resolveMissionByIdOrSlug } from "../missions/runtime-context.ts";
import { createMissionStore } from "../missions/store.ts";
import { missionHandoff, missionResume } from "../missions/workstream-control.ts";

export { missionRefreshBriefsCommand } from "../missions/brief-refresh.ts";
// Re-export for backward compatibility (consumed by tests)
export {
	type MissionCommandDeps,
	missionAnswer,
	missionComplete,
	missionExtractLearnings,
	missionPause,
	missionResumeAll,
	missionStart,
	missionStop,
	missionUpdate,
	resolveCurrentMissionId,
} from "../missions/lifecycle.ts";
export { missionHandoff, missionResume } from "../missions/workstream-control.ts";

interface MissionDefaultOpts {
	json?: boolean;
}

function resolveExplicitMission(
	overstoryDir: string,
	missionFlag: string | undefined,
): string | undefined {
	if (!missionFlag) return undefined;
	const store = createMissionStore(join(overstoryDir, "sessions.db"));
	try {
		return resolveMissionByIdOrSlug(missionFlag, store);
	} finally {
		store.close();
	}
}

export function createMissionCommand(): Command {
	const cmd = new Command("mission").description(
		"Manage long-running missions (objectives, phases, user input)",
	);

	cmd.option("--json", "Output as JSON").action(async (opts: MissionDefaultOpts) => {
		const cwd = process.cwd();
		const config = await loadConfig(cwd);
		const overstoryDir = join(config.project.root, ".overstory");
		await missionStatus(overstoryDir, opts.json ?? false);
	});

	cmd
		.command("start")
		.description("Create a new mission (run + pointer files + artifact root)")
		.option("--slug <slug>", "Short identifier for the mission (e.g. auth-rewrite)")
		.option("--objective <objective>", "Mission objective (what to accomplish)")
		.option("--attach", "Attach to coordinator tmux session after start")
		.option("--no-attach", "Do not attach to coordinator tmux session")
		.option("--json", "Output as JSON")
		.action(
			async (opts: { slug?: string; objective?: string; attach?: boolean; json?: boolean }) => {
				const cwd = process.cwd();
				const config = await loadConfig(cwd);
				const overstoryDir = join(config.project.root, ".overstory");
				const attach = opts.attach ?? (opts.json ? false : process.stdout.isTTY === true);
				await missionStart(overstoryDir, config.project.root, { ...opts, attach });
			},
		);

	cmd
		.command("status")
		.description("Show active mission summary")
		.option("--json", "Output as JSON")
		.action(async (opts: MissionDefaultOpts) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionStatus(overstoryDir, opts.json ?? false);
		});

	cmd
		.command("update")
		.description("Update the active mission's slug or objective")
		.option("--slug <slug>", "New short identifier")
		.option("--objective <objective>", "New mission objective")
		.option("--mission <id-or-slug>", "Target a specific mission")
		.option("--json", "Output as JSON")
		.action(
			async (opts: { slug?: string; objective?: string; mission?: string; json?: boolean }) => {
				const cwd = process.cwd();
				const config = await loadConfig(cwd);
				const overstoryDir = join(config.project.root, ".overstory");
				const resolved = resolveExplicitMission(overstoryDir, opts.mission);
				await missionUpdate(overstoryDir, { ...opts, missionId: resolved });
			},
		);

	cmd
		.command("output")
		.description("Mission-centric output with event narrative")
		.option("--json", "Output as JSON")
		.action(async (opts: MissionDefaultOpts) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionOutput(overstoryDir, opts.json ?? false);
		});

	cmd
		.command("answer")
		.description("Respond to the pending mission question packet")
		.option("--body <text>", "Your answer or response text")
		.option("--file <path>", "Path to a file containing your answer")
		.option("--mission <id-or-slug>", "Target a specific mission")
		.option("--json", "Output as JSON")
		.action(async (opts: { body?: string; file?: string; mission?: string; json?: boolean }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			const missionId = resolveExplicitMission(overstoryDir, opts.mission);
			await missionAnswer(overstoryDir, { ...opts, missionId });
		});

	cmd
		.command("artifacts")
		.description("Print artifact root and known paths for the active mission")
		.option("--json", "Output as JSON")
		.action(async (opts: MissionDefaultOpts) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionArtifacts(overstoryDir, opts.json ?? false);
		});

	cmd
		.command("handoff")
		.description("Start execution director and hand off dispatchable workstreams")
		.option("--mission <id-or-slug>", "Target a specific mission")
		.option("--json", "Output as JSON")
		.action(async (opts: MissionDefaultOpts & { mission?: string }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			const missionId = resolveExplicitMission(overstoryDir, opts.mission);
			await missionHandoff(overstoryDir, config.project.root, opts.json ?? false, {}, missionId);
		});

	cmd
		.command("pause")
		.description("Pause a mission workstream without changing runtime agent state")
		.argument("<workstream-id>", "Mission workstream ID")
		.option("--reason <text>", "Operator-visible pause reason")
		.option("--mission <id-or-slug>", "Target a specific mission")
		.option("--json", "Output as JSON")
		.action(
			async (workstreamId: string, opts: { reason?: string; mission?: string; json?: boolean }) => {
				const cwd = process.cwd();
				const config = await loadConfig(cwd);
				const overstoryDir = join(config.project.root, ".overstory");
				const missionId = resolveExplicitMission(overstoryDir, opts.mission);
				await missionPause(overstoryDir, workstreamId, { ...opts, missionId });
			},
		);

	cmd
		.command("resume")
		.description("Resume a suspended mission or a paused workstream")
		.argument("[workstream-id]", "Workstream ID (omit to resume entire suspended mission)")
		.option("--mission <id-or-slug>", "Target a specific mission")
		.option("--json", "Output as JSON")
		.action(
			async (workstreamId: string | undefined, opts: MissionDefaultOpts & { mission?: string }) => {
				const cwd = process.cwd();
				const config = await loadConfig(cwd);
				const overstoryDir = join(config.project.root, ".overstory");
				const missionId = resolveExplicitMission(overstoryDir, opts.mission);
				if (workstreamId) {
					await missionResume(
						overstoryDir,
						config.project.root,
						workstreamId,
						opts.json ?? false,
						{},
						missionId,
					);
				} else {
					await missionResumeAll(overstoryDir, config.project.root, opts.json ?? false, missionId);
				}
			},
		);

	cmd
		.command("refresh-briefs")
		.description("Refresh brief revisions, mark stale specs, and pause affected workstreams")
		.option("--workstream <id>", "Refresh a single workstream instead of the full mission plan")
		.option("--mission <id-or-slug>", "Target a specific mission")
		.option("--json", "Output as JSON")
		.action(async (opts: { workstream?: string; mission?: string; json?: boolean }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			const missionId = resolveExplicitMission(overstoryDir, opts.mission);
			await missionRefreshBriefsCommand(overstoryDir, config.project.root, opts, {}, missionId);
		});

	cmd
		.command("complete")
		.description("Complete the active mission, export bundle, and clear pointers")
		.option("--mission <id-or-slug>", "Target a specific mission")
		.option("--json", "Output as JSON")
		.action(async (opts: MissionDefaultOpts & { mission?: string }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			const missionId = resolveExplicitMission(overstoryDir, opts.mission);
			await missionComplete(overstoryDir, config.project.root, opts.json ?? false, {}, missionId);
		});

	cmd
		.command("stop")
		.description("Suspend the active mission (preserves state for resume)")
		.option("--kill", "Full teardown — no resume possible")
		.option("--mission <id-or-slug>", "Target a specific mission")
		.option("--json", "Output as JSON")
		.action(async (opts: MissionDefaultOpts & { kill?: boolean; mission?: string }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			const missionId = resolveExplicitMission(overstoryDir, opts.mission);
			await missionStop(
				overstoryDir,
				config.project.root,
				opts.json ?? false,
				opts.kill ?? false,
				{},
				missionId,
			);
		});

	cmd
		.command("list")
		.description("List all missions")
		.option("--json", "Output as JSON")
		.action(async (opts: MissionDefaultOpts) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionList(overstoryDir, opts.json ?? false);
		});

	cmd
		.command("show")
		.description("Show details for a specific mission")
		.argument("<id-or-slug>", "Mission ID or slug")
		.option("--json", "Output as JSON")
		.action(async (idOrSlug: string, opts: MissionDefaultOpts) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionShow(overstoryDir, idOrSlug, opts.json ?? false);
		});

	cmd
		.command("bundle")
		.description("Export a result bundle (summary, events, narrative, review) for a mission")
		.option("--mission <id-or-slug>", "Mission ID or slug (defaults to active mission)")
		.option("--force", "Force regeneration even if bundle is fresh")
		.option("--json", "Output as JSON")
		.action(async (opts: { mission?: string; force?: boolean; json?: boolean }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			const missionId = resolveExplicitMission(overstoryDir, opts.mission);
			await missionBundle(overstoryDir, { ...opts, missionId });
		});

	cmd
		.command("extract-learnings")
		.description("Extract mulch learnings from a completed mission bundle")
		.argument("[id-or-slug]", "Mission ID or slug (defaults to most recent completed)")
		.option("--force", "Re-extract even if already extracted")
		.option("--json", "Output as JSON")
		.action(async (idOrSlug: string | undefined, opts: { force?: boolean; json?: boolean }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionExtractLearnings(overstoryDir, config.project.root, idOrSlug, opts);
		});

	cmd
		.command("graph")
		.description("Show the mission workflow graph and current position")
		.option("--format <type>", "Output format: text, mermaid, json", "text")
		.option("--json", "Output as JSON")
		.action(async (opts: { format?: string; json?: boolean }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			const format = (opts.format ?? "text") as "text" | "mermaid" | "json";
			await missionGraph(overstoryDir, opts.json ?? false, format);
		});

	cmd
		.command("holdout")
		.description("Run holdout validation checks against a mission")
		.option("--mission <id-or-slug>", "Target a specific mission (default: active)")
		.option("--level <level>", "Maximum check level to run (1, 2, or 3)", "2")
		.option("--json", "Output as JSON")
		.action(async (opts: { mission?: string; level?: string; json?: boolean }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			const dbPath = join(overstoryDir, "sessions.db");

			const { createMissionStore } = await import("../missions/store.ts");
			const missionStore = createMissionStore(dbPath);
			try {
				let mission: import("../types.ts").Mission | null | undefined;
				const resolvedId = resolveExplicitMission(overstoryDir, opts.mission);
				if (resolvedId) {
					mission = missionStore.getById(resolvedId);
				} else {
					mission = missionStore.getActive();
				}
				if (!mission) {
					console.error(
						opts.mission ? `Mission not found: ${opts.mission}` : "No active mission",
					);
					process.exitCode = 1;
					return;
				}

				const { runMissionHoldout } = await import("../missions/holdout.ts");
				const maxLevel = Number(opts.level ?? "2") as 1 | 2 | 3;
				const result = await runMissionHoldout({
					overstoryDir,
					projectRoot: config.project.root,
					missionId: mission.id,
					maxLevel,
				});

				if (opts.json) {
					console.log(JSON.stringify(result, null, 2));
				} else {
					console.log(`Holdout validation: ${result.passed ? "PASSED" : "FAILED"}`);
					console.log(`Duration: ${result.duration}ms`);
					console.log("");
					for (const check of result.checks) {
						const icon =
							check.status === "pass"
								? "v"
								: check.status === "fail"
									? "x"
									: check.status === "warn"
										? "!"
										: "o";
						console.log(`  ${icon} [L${check.level}] ${check.name}: ${check.message}`);
						if (check.details && check.status === "fail") {
							for (const d of check.details) {
								console.log(`      ${d}`);
							}
						}
					}
				}
				if (!result.passed) {
					process.exitCode = 1;
				}
			} finally {
				missionStore.close();
			}
		});

	// workstream-complete subcommand (uses lazy import for the command builder)
	cmd
		.command("workstream-complete")
		.argument("<workstream-id>", "Workstream ID to mark as completed")
		.option("--mission <id>", "Mission ID (defaults to active mission)")
		.option("--json", "JSON output")
		.description("Mark a workstream as completed (operator escape hatch)")
		.action(async (workstreamId: string, opts: { mission?: string; json?: boolean }) => {
			const { createWorkstreamCompleteCommand } = await import(
				"./mission-workstream-complete.ts"
			);
			// Delegate to the standalone command's action
			const cmd = createWorkstreamCompleteCommand();
			await cmd.parseAsync([workstreamId, ...(opts.mission ? ["--mission", opts.mission] : []), ...(opts.json ? ["--json"] : [])], { from: "user" });
		});

	return cmd;
}
