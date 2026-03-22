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
import {
	missionArtifacts,
	missionGraph,
	missionList,
	missionOutput,
	missionShow,
	missionStatus,
} from "../missions/render.ts";
import { missionResume } from "../missions/workstream-control.ts";
import { missionHandoff } from "../missions/workstream-control.ts";

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
export { missionRefreshBriefsCommand } from "../missions/brief-refresh.ts";

interface MissionDefaultOpts {
	json?: boolean;
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
		.option("--json", "Output as JSON")
		.action(async (opts: { slug?: string; objective?: string; json?: boolean }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionUpdate(overstoryDir, opts);
		});

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
		.option("--json", "Output as JSON")
		.action(async (opts: { body?: string; file?: string; json?: boolean }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionAnswer(overstoryDir, opts);
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
		.option("--json", "Output as JSON")
		.action(async (opts: MissionDefaultOpts) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionHandoff(overstoryDir, config.project.root, opts.json ?? false);
		});

	cmd
		.command("pause")
		.description("Pause a mission workstream without changing runtime agent state")
		.argument("<workstream-id>", "Mission workstream ID")
		.option("--reason <text>", "Operator-visible pause reason")
		.option("--json", "Output as JSON")
		.action(async (workstreamId: string, opts: { reason?: string; json?: boolean }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionPause(overstoryDir, workstreamId, opts);
		});

	cmd
		.command("resume")
		.description("Resume a suspended mission or a paused workstream")
		.argument("[workstream-id]", "Workstream ID (omit to resume entire suspended mission)")
		.option("--json", "Output as JSON")
		.action(async (workstreamId: string | undefined, opts: MissionDefaultOpts) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			if (workstreamId) {
				await missionResume(overstoryDir, config.project.root, workstreamId, opts.json ?? false);
			} else {
				await missionResumeAll(overstoryDir, config.project.root, opts.json ?? false);
			}
		});

	cmd
		.command("refresh-briefs")
		.description("Refresh brief revisions, mark stale specs, and pause affected workstreams")
		.option("--workstream <id>", "Refresh a single workstream instead of the full mission plan")
		.option("--json", "Output as JSON")
		.action(async (opts: { workstream?: string; json?: boolean }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionRefreshBriefsCommand(overstoryDir, config.project.root, opts);
		});

	cmd
		.command("complete")
		.description("Complete the active mission, export bundle, and clear pointers")
		.option("--json", "Output as JSON")
		.action(async (opts: MissionDefaultOpts) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionComplete(overstoryDir, config.project.root, opts.json ?? false);
		});

	cmd
		.command("stop")
		.description("Suspend the active mission (preserves state for resume)")
		.option("--kill", "Full teardown — no resume possible")
		.option("--json", "Output as JSON")
		.action(async (opts: MissionDefaultOpts & { kill?: boolean }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionStop(overstoryDir, config.project.root, opts.json ?? false, opts.kill ?? false);
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
		.option("--mission-id <id>", "Mission ID (defaults to active mission)")
		.option("--force", "Force regeneration even if bundle is fresh")
		.option("--json", "Output as JSON")
		.action(async (opts: { missionId?: string; force?: boolean; json?: boolean }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionBundle(overstoryDir, opts);
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

	return cmd;
}
