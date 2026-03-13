import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { getMissionArtifactPaths } from "../missions/context.ts";
import { readSpecMeta } from "../missions/spec-meta.ts";
import { createMissionStore } from "../missions/store.ts";
import { loadWorkstreamsFile } from "../missions/workstreams.ts";
import { createRunStore, createSessionStore } from "../sessions/store.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import type { AgentSession } from "../types.ts";
import {
	missionAnswer,
	missionComplete,
	missionHandoff,
	missionRefreshBriefsCommand,
	missionResume,
	missionStart,
	missionStop,
	type MissionCommandDeps,
} from "./mission.ts";
import { specWriteCommand } from "./spec.ts";

let tempDir: string;
let overstoryDir: string;
let originalCwd: string;
let originalExitCode: typeof process.exitCode;
let originalStdoutWrite: typeof process.stdout.write;
let originalStderrWrite: typeof process.stderr.write;

function writeConfig(root: string): Promise<number> {
	return Bun.write(
		join(root, ".overstory", "config.yaml"),
		[
			"project:",
			"  name: mission-e2e",
			`  root: ${root}`,
			"  canonicalBranch: main",
			"agents:",
			"  manifestPath: .overstory/agent-manifest.json",
			"  baseDir: .overstory/agent-defs",
			"",
		].join("\n"),
	);
}

function makeRoleDeps(
	projectRoot: string,
	overstoryDirPath: string,
): MissionCommandDeps & {
	started: string[];
	stopped: string[];
} {
	const started: string[] = [];
	const stopped: string[] = [];
	const dbPath = join(overstoryDirPath, "sessions.db");

	function upsertSession(
		agentName: "mission-analyst" | "execution-director",
		missionId: string,
		runId: string,
	): AgentSession {
		const now = new Date().toISOString();
		return {
			id: `sess-${agentName}`,
			agentName,
			capability: agentName,
			runtime: "claude",
			worktreePath: projectRoot,
			branchName: "main",
			taskId: missionId,
			tmuxSession: `ov-${agentName}`,
			state: "working",
			pid: 1000 + started.length,
			parentAgent: null,
			depth: 0,
			runId,
			startedAt: now,
			lastActivity: now,
			escalationLevel: 0,
			stalledSince: null,
			rateLimitedSince: null,
			runtimeSessionId: null,
			transcriptPath: null,
			originalRuntime: null,
		};
	}

	async function startRole(
		agentName: "mission-analyst" | "execution-director",
		opts: { missionId: string; existingRunId: string },
	) {
		started.push(agentName);
		const session = upsertSession(agentName, opts.missionId, opts.existingRunId);
		const sessionStore = createSessionStore(dbPath);
		try {
			sessionStore.upsert(session);
		} finally {
			sessionStore.close();
		}
		const runStore = createRunStore(dbPath);
		try {
			runStore.incrementAgentCount(opts.existingRunId);
		} finally {
			runStore.close();
		}
		return { session, runId: opts.existingRunId, pid: session.pid ?? 0 };
	}

	return {
		started,
		stopped,
		ensureCanonicalWorkstreamTasks: async (filePath) => {
			const validation = await loadWorkstreamsFile(filePath);
			if (!validation.valid || !validation.workstreams) {
				throw new Error(validation.errors[0]?.message ?? "invalid workstreams file");
			}
			return {
				workstreams: validation.workstreams.workstreams,
				results: validation.workstreams.workstreams.map((workstream) => ({
					workstreamId: workstream.id,
					taskId: workstream.taskId,
					canonicalTaskId: workstream.taskId,
					created: false,
				})),
			};
		},
		startMissionAnalyst: async (opts) => startRole("mission-analyst", opts),
		startExecutionDirector: async (opts) => startRole("execution-director", opts),
		stopMissionRole: async (agentName) => {
			stopped.push(agentName);
			const sessionStore = createSessionStore(dbPath);
			try {
				const existing = sessionStore.getByName(agentName);
				if (existing) {
					sessionStore.updateState(agentName, "completed");
				}
				return {
					sessionKilled: existing !== null,
					sessionId: existing?.id ?? `sess-${agentName}`,
					runCompleted: false,
				};
			} finally {
				sessionStore.close();
			}
		},
	};
}

beforeEach(async () => {
	tempDir = await createTempGitRepo();
	overstoryDir = join(tempDir, ".overstory");
	await mkdir(overstoryDir, { recursive: true });
	await writeConfig(tempDir);

	originalCwd = process.cwd();
	process.chdir(tempDir);

	originalExitCode = process.exitCode;
	process.exitCode = 0;
	originalStdoutWrite = process.stdout.write;
	originalStderrWrite = process.stderr.write;
	process.stdout.write = (() => true) as typeof process.stdout.write;
	process.stderr.write = (() => true) as typeof process.stderr.write;
});

afterEach(async () => {
	process.chdir(originalCwd);
	process.exitCode = originalExitCode ?? 0;
	process.stdout.write = originalStdoutWrite;
	process.stderr.write = originalStderrWrite;
	await cleanupTempDir(tempDir);
});

describe("mission command e2e", () => {
	test("supports mission start, clarification answer, execution handoff, brief refresh, resume, and completion", async () => {
		const deps = makeRoleDeps(tempDir, overstoryDir);

		await missionStart(
			overstoryDir,
			tempDir,
			{ slug: "auth-refresh", objective: "Stabilize auth mission", json: true },
			deps,
		);

		const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
		const mission = missionStore.getActive();
		expect(mission).not.toBeNull();
		expect(mission?.slug).toBe("auth-refresh");
		expect(deps.started).toEqual(["mission-analyst"]);
		expect(await Bun.file(join(overstoryDir, "current-mission.txt")).exists()).toBe(true);
		expect(await Bun.file(join(overstoryDir, "current-run.txt")).exists()).toBe(true);

		const paths = getMissionArtifactPaths(mission!);
		await Bun.write(
			paths.workstreamsJson,
			`${JSON.stringify(
				{
					version: 1,
					workstreams: [
						{
							id: "ws-auth",
							taskId: "task-auth",
							objective: "Refresh authentication flow",
							fileScope: ["src/auth.ts"],
							dependsOn: [],
							briefPath: "plan/ws-auth.md",
							status: "planned",
						},
					],
				},
				null,
				2,
			)}\n`,
		);
		const briefPath = join(paths.planDir, "ws-auth.md");
		await Bun.write(briefPath, "# Auth brief v1\n");

		await specWriteCommand("task-auth", {
			body: "# Auth spec v1",
			agent: "lead-auth",
			workstreamId: "ws-auth",
			briefPath: relative(tempDir, briefPath),
		});

		const mailStore = createMailStore(join(overstoryDir, "mail.db"));
		const mailClient = createMailClient(mailStore);
		const questionId = mailClient.send({
			from: "mission-analyst",
			to: "operator",
			subject: "Need clarification",
			body: "Confirm the auth entrypoint",
			type: "question",
		});
		missionStore.freeze(mission!.id, "clarification", questionId);
		await missionAnswer(overstoryDir, { body: "Use the login entrypoint", json: true });

		const repliesToAnalyst = mailStore.getAll({ from: "operator", to: "mission-analyst" });
		expect(repliesToAnalyst.some((message) => message.threadId === questionId)).toBe(true);
		expect(missionStore.getById(mission!.id)?.pendingUserInput).toBe(false);
		expect(missionStore.getById(mission!.id)?.reopenCount).toBe(1);

		await missionHandoff(overstoryDir, tempDir, true, deps);
		expect(deps.started).toEqual(["mission-analyst", "execution-director"]);

		const handoffMessage = mailStore
			.getAll({ to: "execution-director" })
			.find((message) => message.type === "execution_handoff");
		expect(handoffMessage).not.toBeUndefined();
		const handoffPayload = JSON.parse(handoffMessage?.payload ?? "{}") as {
			dispatchCommands?: Array<{ workstreamId: string; args: string[]; command: string }>;
			handoffs?: Array<{ workstreamId: string; taskId: string }>;
		};
		expect(handoffPayload.handoffs?.[0]?.workstreamId).toBe("ws-auth");
		expect(handoffPayload.dispatchCommands?.[0]?.workstreamId).toBe("ws-auth");
		expect(handoffPayload.dispatchCommands?.[0]?.command).toContain("ov sling task-auth");
		expect(handoffPayload.dispatchCommands?.[0]?.command).toContain("--capability lead");
		expect(handoffPayload.dispatchCommands?.[0]?.command).toContain(briefPath);

		await Bun.write(briefPath, "# Auth brief v2\n");
		await missionRefreshBriefsCommand(overstoryDir, tempDir, {
			workstream: "ws-auth",
			json: true,
		});

		const refreshedMission = missionStore.getById(mission!.id);
		expect(refreshedMission?.pausedWorkstreamIds).toContain("ws-auth");
		expect((await readSpecMeta(tempDir, "task-auth"))?.status).toBe("stale");

		const refreshControl = mailStore
			.getAll({ to: "execution-director" })
			.find((message) => message.subject.includes("regenerate stale specs"));
		expect(refreshControl?.body).toContain("Action required: coordinate the owning leads");
		expect(refreshControl?.body).toContain("ov spec write task-auth");

		await specWriteCommand("task-auth", {
			body: "# Auth spec v2",
			agent: "lead-auth",
			workstreamId: "ws-auth",
			briefPath: relative(tempDir, briefPath),
		});

		await missionResume(overstoryDir, tempDir, "ws-auth", true);
		expect(missionStore.getById(mission!.id)?.pausedWorkstreamIds).toEqual([]);
		expect((await readSpecMeta(tempDir, "task-auth"))?.status).toBe("current");

		await missionComplete(overstoryDir, tempDir, true, deps);

		const completedMission = missionStore.getById(mission!.id);
		expect(completedMission?.state).toBe("completed");
		expect(completedMission?.phase).toBe("done");
		expect(deps.stopped).toEqual(["mission-analyst", "execution-director"]);
		expect(await Bun.file(join(overstoryDir, "current-mission.txt")).exists()).toBe(false);
		expect(await Bun.file(join(overstoryDir, "current-run.txt")).exists()).toBe(false);

		const runStore = createRunStore(join(overstoryDir, "sessions.db"));
		try {
			expect(runStore.getRun(mission!.runId ?? "")?.status).toBe("completed");
		} finally {
			runStore.close();
		}

		expect(await Bun.file(join(paths.resultsDir, "manifest.json")).exists()).toBe(true);
		expect(await Bun.file(join(paths.resultsDir, "review.json")).exists()).toBe(true);

		mailStore.close();
		missionStore.close();
	});

	test("refresh-briefs with missing meta still pauses the workstream and blocks resume until spec regeneration", async () => {
		const deps = makeRoleDeps(tempDir, overstoryDir);

		await missionStart(
			overstoryDir,
			tempDir,
			{ slug: "missing-meta", objective: "Handle missing mission spec metadata", json: true },
			deps,
		);

		const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
		const mission = missionStore.getActive();
		expect(mission).not.toBeNull();

		const paths = getMissionArtifactPaths(mission!);
		await Bun.write(
			paths.workstreamsJson,
			`${JSON.stringify(
				{
					version: 1,
					workstreams: [
						{
							id: "ws-auth",
							taskId: "task-auth",
							objective: "Refresh authentication flow",
							fileScope: ["src/auth.ts"],
							dependsOn: [],
							briefPath: "plan/ws-auth.md",
							status: "planned",
						},
					],
				},
				null,
				2,
			)}\n`,
		);
		const briefPath = join(paths.planDir, "ws-auth.md");
		await Bun.write(briefPath, "# Auth brief v1\n");

		await missionHandoff(overstoryDir, tempDir, true, deps);
		await Bun.write(briefPath, "# Auth brief v2\n");
		await missionRefreshBriefsCommand(overstoryDir, tempDir, {
			workstream: "ws-auth",
			json: true,
		});

		const refreshedMission = missionStore.getById(mission!.id);
		expect(refreshedMission?.pausedWorkstreamIds).toContain("ws-auth");
		expect((await readSpecMeta(tempDir, "task-auth"))).toBeNull();

		await missionResume(overstoryDir, tempDir, "ws-auth", true);
		expect(process.exitCode).toBe(1);
		process.exitCode = 0;

		await specWriteCommand("task-auth", {
			body: "# Auth spec v2",
			agent: "lead-auth",
			workstreamId: "ws-auth",
			briefPath: relative(tempDir, briefPath),
		});

		await missionResume(overstoryDir, tempDir, "ws-auth", true);
		expect(missionStore.getById(mission!.id)?.pausedWorkstreamIds).toEqual([]);

		missionStore.close();
	});

	test("handoff recovers lost mission and run pointers from MissionStore durable state", async () => {
		const deps = makeRoleDeps(tempDir, overstoryDir);

		await missionStart(
			overstoryDir,
			tempDir,
			{ slug: "pointer-recovery", objective: "Recover mission runtime pointers", json: true },
			deps,
		);

		const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
		const mission = missionStore.getActive();
		expect(mission).not.toBeNull();

		const paths = getMissionArtifactPaths(mission!);
		await Bun.write(
			paths.workstreamsJson,
			`${JSON.stringify(
				{
					version: 1,
					workstreams: [
						{
							id: "ws-auth",
							taskId: "task-auth",
							objective: "Refresh authentication flow",
							fileScope: ["src/auth.ts"],
							dependsOn: [],
							briefPath: "plan/ws-auth.md",
							status: "planned",
						},
					],
				},
				null,
				2,
			)}\n`,
		);
		const briefPath = join(paths.planDir, "ws-auth.md");
		await Bun.write(briefPath, "# Auth brief v1\n");
		await specWriteCommand("task-auth", {
			body: "# Auth spec v1",
			agent: "lead-auth",
			workstreamId: "ws-auth",
			briefPath: relative(tempDir, briefPath),
		});

		await Bun.write(join(overstoryDir, "current-mission.txt"), "");
		await Bun.write(join(overstoryDir, "current-run.txt"), "");

		await missionHandoff(overstoryDir, tempDir, true, deps);

		expect((await Bun.file(join(overstoryDir, "current-mission.txt")).text()).trim()).toBe(mission!.id);
		expect((await Bun.file(join(overstoryDir, "current-run.txt")).text()).trim()).toBe(
			mission!.runId ?? "",
		);
		expect(deps.started).toEqual(["mission-analyst", "execution-director"]);

		missionStore.close();
	});

	test("mission stop exports result bundle and review for stopped terminal state", async () => {
		const deps = makeRoleDeps(tempDir, overstoryDir);

		await missionStart(
			overstoryDir,
			tempDir,
			{ slug: "stop-flow", objective: "Verify stopped mission terminalization", json: true },
			deps,
		);

		const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
		const mission = missionStore.getActive();
		expect(mission).not.toBeNull();

		const paths = getMissionArtifactPaths(mission!);
		await missionStop(overstoryDir, tempDir, true, deps);

		const stoppedMission = missionStore.getById(mission!.id);
		expect(stoppedMission?.state).toBe("stopped");
		expect(await Bun.file(join(paths.resultsDir, "manifest.json")).exists()).toBe(true);
		expect(await Bun.file(join(paths.resultsDir, "review.json")).exists()).toBe(true);
		expect(await Bun.file(join(overstoryDir, "current-mission.txt")).exists()).toBe(false);
		expect(await Bun.file(join(overstoryDir, "current-run.txt")).exists()).toBe(false);

		const runStore = createRunStore(join(overstoryDir, "sessions.db"));
		try {
			expect(runStore.getRun(mission!.runId ?? "")?.status).toBe("stopped");
		} finally {
			runStore.close();
		}

		missionStore.close();
	});
});
