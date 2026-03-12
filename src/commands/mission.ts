/**
 * CLI command: ov mission <subcommand>
 *
 * Long-running objective tracking for overstory mission mode.
 *
 * Subcommands:
 *   start     Create a new mission (run + pointer files + artifact root)
 *   status    Show active mission summary
 *   output    Mission-centric output
 *   answer    Respond to pending input (unfreeze mission)
 *   artifacts Print artifact root and known paths
 *   stop      Terminalize mission and clear pointer files
 *   list      List all missions
 *   show      Show details for a specific mission
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { jsonError, jsonOutput } from "../json.ts";
import {
	accent,
	color,
	printError,
	printHint,
	printSuccess,
	printWarning,
} from "../logging/color.ts";
import { renderHeader, renderSubHeader, separator } from "../logging/theme.ts";
import { startMissionAnalyst, stopMissionRole } from "../missions/roles.ts";
import { createMissionStore } from "../missions/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { createRunStore } from "../sessions/store.ts";
import type { InsertMission, Mission, MissionSummary } from "../types.ts";

/** Path to current-mission.txt pointer file. */
function currentMissionPath(overstoryDir: string): string {
	return join(overstoryDir, "current-mission.txt");
}

/** Path to current-run.txt pointer file. */
function currentRunPath(overstoryDir: string): string {
	return join(overstoryDir, "current-run.txt");
}

/** Read current mission ID from pointer file, or null. */
async function readCurrentMissionId(overstoryDir: string): Promise<string | null> {
	const file = Bun.file(currentMissionPath(overstoryDir));
	if (!(await file.exists())) return null;
	const text = await file.text();
	const trimmed = text.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/** Convert Mission to MissionSummary. */
function toSummary(mission: Mission): MissionSummary {
	return {
		id: mission.id,
		slug: mission.slug,
		objective: mission.objective,
		state: mission.state,
		phase: mission.phase,
		pendingUserInput: mission.pendingUserInput,
		createdAt: mission.createdAt,
		updatedAt: mission.updatedAt,
	};
}

// === ov mission start ===

interface StartOpts {
	slug?: string;
	objective?: string;
	json?: boolean;
}

async function missionStart(
	overstoryDir: string,
	projectRoot: string,
	opts: StartOpts,
): Promise<void> {
	if (!opts.objective) {
		printError("--objective is required");
		process.exitCode = 1;
		return;
	}
	if (!opts.slug) {
		printError("--slug is required");
		process.exitCode = 1;
		return;
	}

	const dbPath = join(overstoryDir, "sessions.db");
	const missionStore = createMissionStore(dbPath);
	try {
		// Enforce one active mission invariant
		const existing = missionStore.getActive();
		if (existing) {
			if (opts.json) {
				jsonError("mission start", `Active mission already exists: ${existing.id}`);
			} else {
				printError("An active mission already exists", existing.slug);
				printHint("Stop it first with: ov mission stop");
			}
			process.exitCode = 1;
			return;
		}

		// Create mission-owned run
		const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-mission`;
		const runStore = createRunStore(dbPath);
		try {
			runStore.createRun({
				id: runId,
				startedAt: new Date().toISOString(),
				coordinatorSessionId: null,
				coordinatorName: null,
				status: "active",
			});
		} finally {
			runStore.close();
		}

		// Create artifact root directory
		const missionId = `mission-${Date.now()}-${opts.slug}`;
		const artifactRoot = join(overstoryDir, "missions", missionId);
		await mkdir(artifactRoot, { recursive: true });

		const insertMission: InsertMission = {
			id: missionId,
			slug: opts.slug,
			objective: opts.objective,
			runId,
			artifactRoot,
		};
		const mission = missionStore.create(insertMission);

		// Start mission-analyst role linked to the mission's run
		await startMissionAnalyst({
			missionId,
			projectRoot,
			overstoryDir,
			existingRunId: runId,
		});

		// Write pointer files
		await Bun.write(currentMissionPath(overstoryDir), missionId);
		await Bun.write(currentRunPath(overstoryDir), runId);

		if (opts.json) {
			jsonOutput("mission start", { mission: toSummary(mission), runId });
		} else {
			printSuccess("Mission started", mission.slug);
			process.stdout.write(`  ID:          ${accent(mission.id)}\n`);
			process.stdout.write(`  Objective:   ${mission.objective}\n`);
			process.stdout.write(`  Run:         ${runId}\n`);
			process.stdout.write(`  Artifacts:   ${artifactRoot}\n`);
		}
	} finally {
		missionStore.close();
	}
}

// === ov mission status ===

async function missionStatus(overstoryDir: string, json: boolean): Promise<void> {
	const missionId = await readCurrentMissionId(overstoryDir);
	if (!missionId) {
		if (json) {
			jsonOutput("mission status", { mission: null, message: "No active mission" });
		} else {
			printHint("No active mission");
		}
		return;
	}

	const dbPath = join(overstoryDir, "sessions.db");
	const missionStore = createMissionStore(dbPath);
	try {
		const mission = missionStore.getById(missionId);
		if (!mission) {
			if (json) {
				jsonOutput("mission status", { mission: null, message: `Mission ${missionId} not found` });
			} else {
				printError("Mission not found in store", missionId);
			}
			process.exitCode = 1;
			return;
		}

		if (json) {
			jsonOutput("mission status", { mission: toSummary(mission) });
			return;
		}

		process.stdout.write(`${renderHeader("Mission Status")}\n`);
		process.stdout.write(`  ID:           ${accent(mission.id)}\n`);
		process.stdout.write(`  Slug:         ${mission.slug}\n`);
		process.stdout.write(`  Objective:    ${mission.objective}\n`);
		process.stdout.write(`  State:        ${mission.state}\n`);
		process.stdout.write(`  Phase:        ${mission.phase}\n`);
		if (mission.pendingUserInput) {
			process.stdout.write(
				`  Pending:      ${mission.pendingInputKind ?? "input"} (thread: ${mission.pendingInputThreadId ?? "none"})\n`,
			);
		}
		process.stdout.write(`  Reopen count: ${mission.reopenCount}\n`);
		if (mission.artifactRoot) {
			process.stdout.write(`  Artifacts:    ${mission.artifactRoot}\n`);
		}
		if (mission.runId) {
			process.stdout.write(`  Run:          ${mission.runId}\n`);
		}
		process.stdout.write(`  Created:      ${mission.createdAt}\n`);
		process.stdout.write(`  Updated:      ${mission.updatedAt}\n`);
	} finally {
		missionStore.close();
	}
}

// === ov mission output ===

async function missionOutput(overstoryDir: string, json: boolean): Promise<void> {
	const missionId = await readCurrentMissionId(overstoryDir);
	if (!missionId) {
		if (json) {
			jsonOutput("mission output", { mission: null, message: "No active mission" });
		} else {
			printHint("No active mission");
		}
		return;
	}

	const dbPath = join(overstoryDir, "sessions.db");
	const missionStore = createMissionStore(dbPath);
	try {
		const mission = missionStore.getById(missionId);
		if (!mission) {
			if (json) {
				jsonOutput("mission output", { mission: null });
			} else {
				printError("Mission not found in store", missionId);
			}
			process.exitCode = 1;
			return;
		}

		// Resolve role session states
		let analystRunning = false;
		let executionDirectorRunning = false;
		try {
			const { store: sessionStore } = openSessionStore(overstoryDir);
			try {
				const allSessions = sessionStore.getAll();
				if (mission.analystSessionId) {
					const s = allSessions.find((x) => x.id === mission.analystSessionId);
					if (s && s.state !== "completed" && s.state !== "zombie") {
						analystRunning = true;
					}
				}
				if (mission.executionDirectorSessionId) {
					const s = allSessions.find((x) => x.id === mission.executionDirectorSessionId);
					if (s && s.state !== "completed" && s.state !== "zombie") {
						executionDirectorRunning = true;
					}
				}
			} finally {
				sessionStore.close();
			}
		} catch {
			// session store unavailable
		}

		if (json) {
			jsonOutput("mission output", {
				mission: toSummary(mission),
				artifactRoot: mission.artifactRoot,
				pausedWorkstreamIds: mission.pausedWorkstreamIds,
				roles: {
					analyst: { sessionId: mission.analystSessionId, running: analystRunning },
					executionDirector: {
						sessionId: mission.executionDirectorSessionId,
						running: executionDirectorRunning,
					},
				},
			});
			return;
		}

		const w = process.stdout.write.bind(process.stdout);
		w(`${renderHeader("Mission Output")}\n`);
		w(`  ID:           ${accent(mission.id)}\n`);
		w(`  Slug:         ${mission.slug}\n`);
		w(`  Objective:    ${mission.objective}\n`);
		w(`  State:        ${mission.state} / ${mission.phase}\n`);
		const pending = mission.pendingUserInput ? (mission.pendingInputKind ?? "input") : "none";
		w(`  Pending:      ${pending}\n`);
		w(`  Reopens:      ${mission.reopenCount}\n`);
		w(`  First freeze: ${mission.firstFreezeAt ?? "never"}\n`);
		w("\n");

		w(`${renderSubHeader("Workstreams")}\n`);
		const paused =
			mission.pausedWorkstreamIds.length > 0 ? mission.pausedWorkstreamIds.join(", ") : "none";
		w(`  Paused: ${paused}\n`);
		w("\n");

		w(`${renderSubHeader("Roles")}\n`);
		const analystStatus = analystRunning ? color.green("running") : color.dim("not started");
		const edStatus = executionDirectorRunning ? color.green("running") : color.dim("not started");
		w(`  Analyst:            ${analystStatus}\n`);
		w(`  Execution Director: ${edStatus}\n`);
	} finally {
		missionStore.close();
	}
}

// === ov mission answer ===

interface AnswerOpts {
	body?: string;
	json?: boolean;
}

async function missionAnswer(overstoryDir: string, opts: AnswerOpts): Promise<void> {
	const missionId = await readCurrentMissionId(overstoryDir);
	if (!missionId) {
		if (opts.json) {
			jsonError("mission answer", "No active mission");
		} else {
			printError("No active mission");
		}
		process.exitCode = 1;
		return;
	}

	const dbPath = join(overstoryDir, "sessions.db");
	const missionStore = createMissionStore(dbPath);
	try {
		const mission = missionStore.getById(missionId);
		if (!mission) {
			if (opts.json) {
				jsonError("mission answer", `Mission ${missionId} not found`);
			} else {
				printError("Mission not found in store", missionId);
			}
			process.exitCode = 1;
			return;
		}

		if (!mission.pendingUserInput) {
			if (opts.json) {
				jsonError("mission answer", "Mission is not waiting for user input");
			} else {
				printError("Mission is not waiting for user input");
			}
			process.exitCode = 1;
			return;
		}

		missionStore.unfreeze(missionId);

		if (opts.json) {
			jsonOutput("mission answer", { missionId, answered: true, body: opts.body ?? null });
		} else {
			printSuccess("Mission unfrozen", mission.slug);
			if (opts.body) {
				process.stdout.write(`  Answer: ${opts.body}\n`);
			}
		}
	} finally {
		missionStore.close();
	}
}

// === ov mission artifacts ===

async function missionArtifacts(overstoryDir: string, json: boolean): Promise<void> {
	const missionId = await readCurrentMissionId(overstoryDir);
	if (!missionId) {
		if (json) {
			jsonOutput("mission artifacts", { mission: null, message: "No active mission" });
		} else {
			printHint("No active mission");
		}
		return;
	}

	const dbPath = join(overstoryDir, "sessions.db");
	const missionStore = createMissionStore(dbPath);
	try {
		const mission = missionStore.getById(missionId);
		if (!mission || !mission.artifactRoot) {
			if (json) {
				jsonOutput("mission artifacts", { artifactRoot: null });
			} else {
				printHint("No artifact root for this mission");
			}
			return;
		}

		const root = mission.artifactRoot;
		const knownPaths = {
			root,
			missionMd: join(root, "mission.md"),
			decisionsMs: join(root, "decisions.md"),
			openQuestions: join(root, "open-questions.md"),
			researchSummary: join(root, "research", "_summary.md"),
			workstreams: join(root, "plan", "workstreams.json"),
		};

		if (json) {
			jsonOutput("mission artifacts", { artifactRoot: root, paths: knownPaths });
			return;
		}

		process.stdout.write(`${renderHeader("Mission Artifacts")}\n`);
		process.stdout.write(`  Root:           ${root}\n`);
		process.stdout.write(`  mission.md:     ${knownPaths.missionMd}\n`);
		process.stdout.write(`  decisions.md:   ${knownPaths.decisionsMs}\n`);
		process.stdout.write(`  open-questions: ${knownPaths.openQuestions}\n`);
		process.stdout.write(`  workstreams:    ${knownPaths.workstreams}\n`);
	} finally {
		missionStore.close();
	}
}

// === ov mission stop ===

async function missionStop(
	overstoryDir: string,
	projectRoot: string,
	json: boolean,
): Promise<void> {
	const missionId = await readCurrentMissionId(overstoryDir);
	if (!missionId) {
		if (json) {
			jsonError("mission stop", "No active mission to stop");
		} else {
			printError("No active mission to stop");
		}
		process.exitCode = 1;
		return;
	}

	const dbPath = join(overstoryDir, "sessions.db");
	const missionStore = createMissionStore(dbPath);
	try {
		const mission = missionStore.getById(missionId);
		if (!mission) {
			if (json) {
				jsonError("mission stop", `Mission ${missionId} not found`);
			} else {
				printError("Mission not found in store", missionId);
			}
			process.exitCode = 1;
			return;
		}

		// Stop mission roles (agents may not be running — ignore errors)
		for (const roleName of ["mission-analyst", "execution-director"]) {
			try {
				await stopMissionRole(roleName, { projectRoot, overstoryDir });
			} catch {
				// Agent may not be running — non-fatal
			}
		}

		// Terminalize the mission
		missionStore.updateState(missionId, "cancelled");

		// Terminalize mission-owned run as stopped
		if (mission.runId) {
			const runStore = createRunStore(dbPath);
			try {
				runStore.completeRun(mission.runId, "stopped");
			} finally {
				runStore.close();
			}
		}

		// Export result bundle (non-fatal)
		let bundlePath: string | null = null;
		try {
			const { exportBundle } = await import("../missions/bundle.ts");
			const bundleResult = await exportBundle({ overstoryDir, dbPath, missionId });
			bundlePath = bundleResult.outputDir;
			if (!json) printSuccess("Bundle exported", bundleResult.outputDir);
		} catch (err) {
			if (!json) printWarning("Bundle export failed", String(err));
		}

		// Clear pointer files
		const { unlink } = await import("node:fs/promises");
		for (const path of [currentMissionPath(overstoryDir), currentRunPath(overstoryDir)]) {
			try {
				await unlink(path);
			} catch {
				// File may already be gone
			}
		}

		if (json) {
			jsonOutput("mission stop", { missionId, slug: mission.slug, state: "cancelled", bundlePath });
		} else {
			printSuccess("Mission stopped", mission.slug);
		}
	} finally {
		missionStore.close();
	}
}

// === ov mission list ===

async function missionList(overstoryDir: string, json: boolean): Promise<void> {
	const dbPath = join(overstoryDir, "sessions.db");
	const dbFile = Bun.file(dbPath);
	if (!(await dbFile.exists())) {
		if (json) {
			jsonOutput("mission list", { missions: [] });
		} else {
			printHint("No missions recorded yet");
		}
		return;
	}

	const missionStore = createMissionStore(dbPath);
	try {
		const missions = missionStore.list();

		if (json) {
			jsonOutput("mission list", { missions: missions.map(toSummary) });
			return;
		}

		if (missions.length === 0) {
			printHint("No missions recorded yet");
			return;
		}

		process.stdout.write(`${renderHeader("Missions")}\n`);
		process.stdout.write(`${"ID".padEnd(18)} ${"State".padEnd(12)} ${"Phase".padEnd(10)} Slug\n`);
		process.stdout.write(`${separator()}\n`);
		for (const mission of missions) {
			const id = accent(mission.id.slice(0, 16).padEnd(18));
			const state = mission.state.padEnd(12);
			const phase = mission.phase.padEnd(10);
			const pending = mission.pendingUserInput ? " [PENDING]" : "";
			process.stdout.write(`${id} ${state} ${phase} ${mission.slug}${pending}\n`);
		}
	} finally {
		missionStore.close();
	}
}

// === ov mission show ===

async function missionShow(overstoryDir: string, idOrSlug: string, json: boolean): Promise<void> {
	const dbPath = join(overstoryDir, "sessions.db");
	const missionStore = createMissionStore(dbPath);
	try {
		let mission = missionStore.getById(idOrSlug);
		if (!mission) {
			mission = missionStore.getBySlug(idOrSlug);
		}
		if (!mission) {
			if (json) {
				jsonError("mission show", `Mission not found: ${idOrSlug}`);
			} else {
				printError("Mission not found", idOrSlug);
			}
			process.exitCode = 1;
			return;
		}

		if (json) {
			jsonOutput("mission show", { mission });
			return;
		}

		process.stdout.write(`${renderHeader("Mission")}\n`);
		process.stdout.write(`  ID:           ${accent(mission.id)}\n`);
		process.stdout.write(`  Slug:         ${mission.slug}\n`);
		process.stdout.write(`  Objective:    ${mission.objective}\n`);
		process.stdout.write(`  State:        ${mission.state}\n`);
		process.stdout.write(`  Phase:        ${mission.phase}\n`);
		process.stdout.write(`  Reopen count: ${mission.reopenCount}\n`);
		if (mission.firstFreezeAt) {
			process.stdout.write(`  First freeze: ${mission.firstFreezeAt}\n`);
		}
		if (mission.pendingUserInput) {
			process.stdout.write(
				`  Pending:      ${mission.pendingInputKind ?? "input"} (thread: ${mission.pendingInputThreadId ?? "none"})\n`,
			);
		}
		if (mission.pausedWorkstreamIds.length > 0) {
			process.stdout.write(`  Paused:       ${mission.pausedWorkstreamIds.join(", ")}\n`);
		}
		if (mission.artifactRoot) {
			process.stdout.write(`  Artifacts:    ${mission.artifactRoot}\n`);
		}
		if (mission.runId) {
			process.stdout.write(`  Run:          ${mission.runId}\n`);
		}
		process.stdout.write(`  Created:      ${mission.createdAt}\n`);
		process.stdout.write(`  Updated:      ${mission.updatedAt}\n`);
	} finally {
		missionStore.close();
	}
}

// === ov mission bundle ===

interface BundleOpts {
	missionId?: string;
	force?: boolean;
	json?: boolean;
}

async function missionBundle(overstoryDir: string, opts: BundleOpts): Promise<void> {
	const dbPath = join(overstoryDir, "sessions.db");

	// Resolve mission ID: explicit flag or active mission
	let missionId = opts.missionId ?? null;
	if (!missionId) {
		missionId = await readCurrentMissionId(overstoryDir);
	}
	if (!missionId) {
		if (opts.json) {
			jsonError("mission bundle", "No active mission and no --mission-id provided");
		} else {
			printError("No active mission and no --mission-id provided");
		}
		process.exitCode = 1;
		return;
	}

	const { exportBundle } = await import("../missions/bundle.ts");
	try {
		const result = await exportBundle({
			overstoryDir,
			dbPath,
			missionId,
			force: opts.force,
		});

		if (opts.json) {
			jsonOutput("mission bundle", {
				outputDir: result.outputDir,
				manifest: result.manifest,
				filesWritten: result.filesWritten,
			});
		} else {
			if (result.filesWritten.length === 0) {
				printHint("Bundle is already up to date");
				process.stdout.write(`  Path: ${result.outputDir}\n`);
			} else {
				printSuccess("Bundle exported", result.outputDir);
				for (const f of result.filesWritten) {
					process.stdout.write(`  ${f}\n`);
				}
			}
		}
	} catch (err) {
		if (opts.json) {
			jsonError("mission bundle", String(err));
		} else {
			printError("Bundle export failed", String(err));
		}
		process.exitCode = 1;
	}
}

// === Command factory ===

interface MissionDefaultOpts {
	json?: boolean;
}

export function createMissionCommand(): Command {
	const cmd = new Command("mission").description(
		"Manage long-running missions (objectives, phases, user input)",
	);

	// Default action: show status of active mission
	cmd.option("--json", "Output as JSON").action(async (opts: MissionDefaultOpts) => {
		const cwd = process.cwd();
		const config = await loadConfig(cwd);
		const overstoryDir = join(config.project.root, ".overstory");
		await missionStatus(overstoryDir, opts.json ?? false);
	});

	// ov mission start
	cmd
		.command("start")
		.description("Create a new mission (creates run + pointer files + artifact root)")
		.requiredOption("--slug <slug>", "Short identifier for the mission (e.g. auth-rewrite)")
		.requiredOption("--objective <objective>", "Mission objective (what to accomplish)")
		.option("--json", "Output as JSON")
		.action(async (opts: { slug: string; objective: string; json?: boolean }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionStart(overstoryDir, config.project.root, opts);
		});

	// ov mission status
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

	// ov mission output
	cmd
		.command("output")
		.description("Mission-centric output (state, artifacts, paused workstreams)")
		.option("--json", "Output as JSON")
		.action(async (opts: MissionDefaultOpts) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionOutput(overstoryDir, opts.json ?? false);
		});

	// ov mission answer
	cmd
		.command("answer")
		.description("Respond to pending input (unfreeze the active mission)")
		.option("--body <text>", "Your answer or response text")
		.option("--json", "Output as JSON")
		.action(async (opts: { body?: string; json?: boolean }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionAnswer(overstoryDir, opts);
		});

	// ov mission artifacts
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

	// ov mission stop
	cmd
		.command("stop")
		.description("Stop and terminalize the active mission (clears pointer files)")
		.option("--json", "Output as JSON")
		.action(async (opts: MissionDefaultOpts) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionStop(overstoryDir, config.project.root, opts.json ?? false);
		});

	// ov mission list
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

	// ov mission show <id-or-slug>
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

	// ov mission bundle
	cmd
		.command("bundle")
		.description("Export a result bundle (events, sessions, metrics) for a mission")
		.option("--mission-id <id>", "Mission ID (defaults to active mission)")
		.option("--force", "Force regeneration even if bundle is fresh")
		.option("--json", "Output as JSON")
		.action(async (opts: { missionId?: string; force?: boolean; json?: boolean }) => {
			const cwd = process.cwd();
			const config = await loadConfig(cwd);
			const overstoryDir = join(config.project.root, ".overstory");
			await missionBundle(overstoryDir, opts);
		});

	return cmd;
}
