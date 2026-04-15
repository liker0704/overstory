/**
 * Mission operational commands: update, answer, pause, extract-learnings.
 */

import { dirname, join } from "node:path";
import { loadConfig } from "../config.ts";
import { jsonError, jsonOutput } from "../json.ts";
import { accent, printError, printHint, printSuccess, printWarning } from "../logging/color.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import type { Mission } from "../types.ts";
import { recordMissionEvent } from "./events.ts";
import {
	resolveCurrentMissionId,
	resolveMissionRoleStates,
	toSummary,
} from "./lifecycle-helpers.ts";
import type { MissionCommandDeps } from "./lifecycle-types.ts";
import {
	ensureMissionRoleResponsive,
	nudgeMissionRoleBestEffort,
	pendingMissionQuestionSender,
	sendMissionControlMail,
} from "./messaging.ts";
import { pauseWorkstream } from "./pause.ts";
import { createMissionStore } from "./store.ts";
import { getMissionWorkstream } from "./workstream-control.ts";

function openMailClient(overstoryDir: string) {
	return createMailClient(createMailStore(join(overstoryDir, "mail.db")));
}

async function readAnswerBody(opts: { body?: string; file?: string }): Promise<string | null> {
	if (opts.body !== undefined) {
		const body = opts.body.trim();
		return body.length > 0 ? body : null;
	}
	if (opts.file !== undefined) {
		const file = Bun.file(opts.file);
		if (!(await file.exists())) {
			throw new Error(`Answer file not found: ${opts.file}`);
		}
		const body = (await file.text()).trim();
		return body.length > 0 ? body : null;
	}
	return null;
}

// === ov mission update ===

interface UpdateOpts {
	slug?: string;
	objective?: string;
	json?: boolean;
}

interface RoleRename {
	oldName: string;
	newName: string;
	oldTmux: string | null;
	newTmux: string | null;
}

/**
 * Derive rename plans for each mission-scoped role bound on the mission row.
 * Only includes roles whose current agent name actually differs from the
 * slug-derived target — a role spawned under the new slug already needs no
 * change even if its session id is bound.
 */
function planRoleRenames(
	current: {
		slug: string;
		coordinatorSessionId: string | null;
		analystSessionId: string | null;
		executionDirectorSessionId: string | null;
		architectSessionId: string | null;
	},
	newSlug: string,
	sessionAgentNames: (sessionId: string) => string | null,
): RoleRename[] {
	const plans: RoleRename[] = [];
	const roles: Array<{ sessionId: string | null; prefix: string; tmuxPrefix: string }> = [
		{
			sessionId: current.coordinatorSessionId,
			prefix: "coordinator",
			tmuxPrefix: "ov-coordinator",
		},
		{ sessionId: current.analystSessionId, prefix: "mission-analyst", tmuxPrefix: "ov-analyst" },
		{
			sessionId: current.executionDirectorSessionId,
			prefix: "execution-director",
			tmuxPrefix: "ov-ed",
		},
		{ sessionId: current.architectSessionId, prefix: "architect", tmuxPrefix: "ov-architect" },
	];
	for (const role of roles) {
		if (!role.sessionId) continue;
		const actualName = sessionAgentNames(role.sessionId);
		if (!actualName) continue;
		const newName = `${role.prefix}-${newSlug}`;
		if (actualName === newName) continue;
		plans.push({
			oldName: actualName,
			newName,
			oldTmux: `${role.tmuxPrefix}-${current.slug}`,
			newTmux: `${role.tmuxPrefix}-${newSlug}`,
		});
	}
	return plans;
}

export async function missionUpdate(
	overstoryDir: string,
	opts: UpdateOpts & { missionId?: string },
): Promise<void> {
	const json = opts.json ?? false;

	if (!opts.slug && !opts.objective) {
		if (json) {
			jsonError("mission update", "At least one of --slug or --objective is required");
		} else {
			printError("Nothing to update", "Provide --slug and/or --objective");
		}
		process.exitCode = 1;
		return;
	}

	const missionId = opts.missionId ?? (await resolveCurrentMissionId(overstoryDir));
	if (!missionId) {
		if (json) {
			jsonError("mission update", "No active mission");
		} else {
			printError("No active mission", "Start one with: ov mission start");
		}
		process.exitCode = 1;
		return;
	}

	const dbPath = join(overstoryDir, "sessions.db");
	const missionStore = createMissionStore(dbPath);
	const renameResults: Array<{ plan: RoleRename; applied: boolean }> = [];
	try {
		if (opts.slug) {
			const current = missionStore.getById(missionId);
			let plans: RoleRename[] = [];
			if (current && current.slug !== opts.slug) {
				const { createSessionStore } = await import("../sessions/store.ts");
				const sessionStore = createSessionStore(dbPath);
				try {
					plans = planRoleRenames(current, opts.slug, (id) => {
						const session = sessionStore.getById(id);
						return session?.agentName ?? null;
					});
				} finally {
					sessionStore.close();
				}
			}
			missionStore.updateSlug(missionId, opts.slug);

			if (plans.length > 0) {
				const { renameAgent, patchContextReferences } = await import("../agents/rename.ts");
				for (const plan of plans) {
					await renameAgent({
						oldName: plan.oldName,
						newName: plan.newName,
						oldTmuxSession: plan.oldTmux,
						newTmuxSession: plan.newTmux,
						overstoryDir,
					});
					renameResults.push({ plan, applied: true });
				}
				// Rewrite sibling references inside each agent's mission-context.md
				// so analyst's context points to the new coordinator name, etc.
				const allRenames = plans.map((p) => ({ oldName: p.oldName, newName: p.newName }));
				for (const plan of plans) {
					const agentDir = join(overstoryDir, "agents", plan.newName);
					await patchContextReferences(agentDir, allRenames);
				}
			}
		}
		if (opts.objective) {
			missionStore.updateObjective(missionId, opts.objective);
		}

		const updated = missionStore.getById(missionId);
		if (json) {
			jsonOutput("mission update", {
				id: missionId,
				slug: updated?.slug,
				objective: updated?.objective,
			});
		} else {
			printSuccess("Mission updated");
			if (opts.slug) console.log(`  Slug: ${accent(opts.slug)}`);
			if (opts.objective) console.log(`  Objective: ${opts.objective}`);
			for (const { plan } of renameResults) {
				console.log(`  Renamed: ${plan.oldName} → ${accent(plan.newName)}`);
			}
		}
	} finally {
		missionStore.close();
	}
}

// === ov mission answer ===

interface AnswerOpts {
	body?: string;
	file?: string;
	json?: boolean;
	missionId?: string;
}

export async function missionAnswer(
	overstoryDir: string,
	opts: AnswerOpts,
	deps: MissionCommandDeps = {},
): Promise<void> {
	const missionId = opts.missionId ?? (await resolveCurrentMissionId(overstoryDir));
	if (!missionId) {
		if (opts.json) {
			jsonError("mission answer", "No active mission");
		} else {
			printError("No active mission");
		}
		process.exitCode = 1;
		return;
	}

	let body: string | null;
	try {
		body = await readAnswerBody(opts);
	} catch (err) {
		if (opts.json) {
			jsonError("mission answer", String(err));
		} else {
			printError("Failed to read answer", String(err));
		}
		process.exitCode = 1;
		return;
	}
	if (!body) {
		if (opts.json) {
			jsonError("mission answer", "Provide a non-empty --body or --file");
		} else {
			printError("Provide a non-empty --body or --file");
		}
		process.exitCode = 1;
		return;
	}

	const dbPath = join(overstoryDir, "sessions.db");
	const projectRoot = dirname(overstoryDir);
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

		if (!mission.pendingUserInput || !mission.pendingInputThreadId) {
			if (opts.json) {
				jsonError("mission answer", "Mission is not waiting for a question packet");
			} else {
				printError("Mission is not waiting for a question packet");
			}
			process.exitCode = 1;
			return;
		}

		const client = openMailClient(overstoryDir);
		let replyId: string;
		const pendingThreadId = mission.pendingInputThreadId;
		const pendingSender = await pendingMissionQuestionSender(overstoryDir, pendingThreadId);
		try {
			replyId = client.reply(pendingThreadId, body, "operator").id;
		} finally {
			client.close();
		}

		missionStore.unfreeze(missionId);
		recordMissionEvent({
			overstoryDir,
			mission,
			agentName: "operator",
			data: {
				kind: "user_answer",
				detail: `Operator replied in thread ${pendingThreadId}`,
				threadId: pendingThreadId,
				replyId,
			},
		});
		recordMissionEvent({
			overstoryDir,
			mission,
			agentName: "operator",
			data: { kind: "state_change", from: "frozen", to: "active" },
		});
		const refreshedMission = missionStore.getById(missionId) ?? mission;
		if (pendingSender) {
			await ensureMissionRoleResponsive({
				projectRoot,
				overstoryDir,
				mission: refreshedMission,
				roleName: pendingSender,
				threadId: pendingThreadId,
				replyId,
				deps,
			});
		}

		if (opts.json) {
			jsonOutput("mission answer", { missionId, answered: true, replyId, body });
		} else {
			printSuccess("Mission answer delivered", mission.slug);
			process.stdout.write(`  Reply:   ${replyId}\n`);
		}
	} finally {
		missionStore.close();
	}
}

// === ov mission pause ===

interface PauseOpts {
	reason?: string;
	json?: boolean;
	missionId?: string;
}

export async function missionPause(
	overstoryDir: string,
	workstreamId: string,
	opts: PauseOpts,
	deps: MissionCommandDeps = {},
): Promise<void> {
	const missionId = opts.missionId ?? (await resolveCurrentMissionId(overstoryDir));
	if (!missionId) {
		if (opts.json) {
			jsonError("mission pause", "No active mission");
		} else {
			printError("No active mission");
		}
		process.exitCode = 1;
		return;
	}

	const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
	const projectRoot = dirname(overstoryDir);
	try {
		const mission = missionStore.getById(missionId);
		if (!mission) {
			if (opts.json) {
				jsonError("mission pause", `Mission ${missionId} not found`);
			} else {
				printError("Mission not found in store", missionId);
			}
			process.exitCode = 1;
			return;
		}

		let workstreamObjective = workstreamId;
		try {
			const { workstream } = await getMissionWorkstream(mission, workstreamId);
			workstreamObjective = workstream.objective;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (opts.json) {
				jsonError("mission pause", message);
			} else {
				printError("Mission pause failed", message);
			}
			process.exitCode = 1;
			return;
		}

		const result = pauseWorkstream(missionStore, mission.id, workstreamId, opts.reason);
		const refreshedMission = missionStore.getById(mission.id) ?? mission;
		recordMissionEvent({
			overstoryDir,
			mission: refreshedMission,
			agentName: "operator",
			data: {
				kind: "workstream_paused",
				detail: `Paused ${workstreamId}${opts.reason ? `: ${opts.reason}` : ""}`,
				workstreamId,
				alreadyPaused: result.alreadyPaused,
				reason: opts.reason ?? null,
			},
		});

		let controlMessageId: string | null = null;
		const roles = resolveMissionRoleStates(overstoryDir, refreshedMission);
		if (roles.executionDirector === "running") {
			controlMessageId = await sendMissionControlMail({
				overstoryDir,
				to: "execution-director",
				subject: `Mission control: pause ${workstreamId}`,
				body: [
					`Mission ID: ${refreshedMission.id}`,
					`Workstream: ${workstreamId}`,
					`Objective: ${workstreamObjective}`,
					`Reason: ${refreshedMission.pauseReason ?? opts.reason ?? "operator pause"}`,
					`Paused workstreams: ${refreshedMission.pausedWorkstreamIds.join(", ")}`,
				].join("\n"),
			});
			await nudgeMissionRoleBestEffort(
				projectRoot,
				"execution-director",
				`Mission pause control for ${workstreamId}. Check mail and update execution.`,
				deps,
			);
			recordMissionEvent({
				overstoryDir,
				mission: refreshedMission,
				agentName: "operator",
				data: {
					kind: "control_mail",
					detail: `Pause control sent to execution-director (${controlMessageId})`,
					workstreamId,
					to: "execution-director",
				},
			});
		}

		if (opts.json) {
			jsonOutput("mission pause", {
				mission: toSummary(refreshedMission),
				workstreamId,
				alreadyPaused: result.alreadyPaused,
				controlMessageId,
			});
		} else {
			printSuccess("Mission workstream paused", workstreamId);
			process.stdout.write(`  Objective:   ${workstreamObjective}\n`);
			process.stdout.write(`  Already set: ${result.alreadyPaused ? "yes" : "no"}\n`);
			process.stdout.write(
				`  Paused:      ${refreshedMission.pausedWorkstreamIds.length} workstreams\n`,
			);
			if (refreshedMission.pauseReason) {
				process.stdout.write(`  Reason:      ${refreshedMission.pauseReason}\n`);
			}
			if (controlMessageId) {
				process.stdout.write(`  Control:     ${controlMessageId}\n`);
			}
		}
	} finally {
		missionStore.close();
	}
}

// === ov mission extract-learnings ===

export async function missionExtractLearnings(
	overstoryDir: string,
	projectRoot: string,
	idOrSlug: string | undefined,
	opts: { force?: boolean; json?: boolean },
): Promise<void> {
	const dbPath = join(overstoryDir, "sessions.db");
	const missionStore = createMissionStore(dbPath);

	try {
		let mission: ReturnType<typeof missionStore.getById>;

		if (idOrSlug) {
			mission = missionStore.getById(idOrSlug) ?? missionStore.getBySlug(idOrSlug);
		} else {
			const completed = missionStore.list({ state: "completed", limit: 1 });
			const stopped = missionStore.list({ state: "stopped", limit: 1 });
			const candidates = [...completed, ...stopped].sort((a, b) =>
				b.updatedAt > a.updatedAt ? 1 : -1,
			);
			mission = candidates[0] ?? null;
		}

		if (!mission) {
			if (opts.json) {
				jsonError("extract-learnings", "No matching mission found");
			} else {
				printError("No matching mission found");
			}
			process.exitCode = 1;
			return;
		}

		if (mission.learningsExtracted && !opts.force) {
			if (opts.json) {
				jsonOutput("extract-learnings", {
					missionId: mission.id,
					slug: mission.slug,
					skipped: true,
					reason: "already extracted",
				});
			} else {
				printHint(`Learnings already extracted for ${mission.slug}. Use --force to re-extract.`);
			}
			return;
		}

		const bundlePath = join(overstoryDir, "missions", mission.id, "results");
		const summaryFile = Bun.file(join(bundlePath, "summary.json"));
		if (!(await summaryFile.exists())) {
			if (opts.json) {
				jsonError(
					"extract-learnings",
					`No bundle found at ${bundlePath}. Run 'ov mission bundle' first.`,
				);
			} else {
				printError(`No bundle found at ${bundlePath}. Run 'ov mission bundle' first.`);
			}
			process.exitCode = 1;
			return;
		}

		const { extractMissionLearnings } = await import("./learnings.ts");
		const artifactRoot = mission.artifactRoot ?? join(overstoryDir, "missions", mission.id);
		const result = await extractMissionLearnings({
			bundlePath,
			artifactRoot,
			projectRoot,
			missionSlug: mission.slug,
		});
		missionStore.markLearningsExtracted(mission.id);

		if (opts.json) {
			jsonOutput("extract-learnings", {
				missionId: mission.id,
				slug: mission.slug,
				...result,
			});
		} else {
			printSuccess(
				`Learnings extracted for ${mission.slug}`,
				`${result.recordsSucceeded}/${result.recordsAttempted} records`,
			);
			for (const err of result.errors) {
				printWarning("Warning", err);
			}
		}
	} finally {
		missionStore.close();
	}
}
