import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { getMissionArtifactPaths } from "../missions/context.ts";
import {
	DEFAULT_MISSION_GRAPH,
	getAvailableTransitions,
	renderGraphPosition,
	toMermaid,
	validateTransition,
} from "../missions/graph.ts";
import { readSpecMeta } from "../missions/spec-meta.ts";
import { createMissionStore } from "../missions/store.ts";
import { loadWorkstreamsFile } from "../missions/workstreams.ts";
import { createRunStore, createSessionStore } from "../sessions/store.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import type { AgentSession } from "../types.ts";
import {
	type MissionCommandDeps,
	missionAnswer,
	missionComplete,
	missionHandoff,
	missionRefreshBriefsCommand,
	missionResume,
	missionStart,
	missionStop,
	missionUpdate,
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
	nudged: Array<{ agentName: string; message: string }>;
} {
	const started: string[] = [];
	const stopped: string[] = [];
	const nudged: Array<{ agentName: string; message: string }> = [];
	const dbPath = join(overstoryDirPath, "sessions.db");

	function upsertSession(
		agentName: string,
		capability: string,
		missionId: string,
		runId: string,
		overrides: Partial<AgentSession> = {},
	): AgentSession {
		const now = new Date().toISOString();
		return {
			id: overrides.id ?? `sess-${agentName}`,
			agentName,
			capability,
			runtime: "claude",
			worktreePath: overrides.worktreePath ?? projectRoot,
			branchName: overrides.branchName ?? "main",
			taskId: overrides.taskId ?? missionId,
			tmuxSession: overrides.tmuxSession ?? `ov-${agentName}`,
			state: overrides.state ?? "working",
			pid: overrides.pid ?? 1000 + started.length,
			parentAgent: overrides.parentAgent ?? null,
			depth: overrides.depth ?? 0,
			runId,
			startedAt: now,
			lastActivity: now,
			escalationLevel: 0,
			stalledSince: null,
			rateLimitedSince: null,
			runtimeSessionId: null,
			transcriptPath: overrides.transcriptPath ?? null,
			originalRuntime: null,
			statusLine: null,
			...overrides,
		};
	}

	function markCompleted(agentName: string): { sessionKilled: boolean; sessionId: string } {
		const sessionStore = createSessionStore(dbPath);
		try {
			const existing = sessionStore.getByName(agentName);
			if (existing) {
				sessionStore.updateState(agentName, "completed");
			}
			return {
				sessionKilled: existing !== null,
				sessionId: existing?.id ?? `sess-${agentName}`,
			};
		} finally {
			sessionStore.close();
		}
	}

	async function startRole(
		agentName: "coordinator" | "mission-analyst" | "execution-director",
		opts: { missionId: string; existingRunId: string },
	) {
		started.push(agentName);
		const capability = agentName === "coordinator" ? "coordinator-mission" : agentName;
		const session = upsertSession(agentName, capability, opts.missionId, opts.existingRunId);
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
		nudged,
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
		startMissionCoordinator: async (opts) => startRole("coordinator", opts),
		startMissionAnalyst: async (opts) => startRole("mission-analyst", opts),
		startExecutionDirector: async (opts) => startRole("execution-director", opts),
		stopMissionRole: async (agentName) => {
			stopped.push(agentName);
			const result = markCompleted(agentName);
			return {
				...result,
				runCompleted: false,
			};
		},
		stopAgentCommand: async (agentName) => {
			stopped.push(agentName);
			markCompleted(agentName);
		},
		nudgeAgent: async (_projectRoot, agentName, message) => {
			nudged.push({ agentName, message: message ?? "" });
			return { delivered: true };
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
		if (!mission) throw new Error("expected mission");
		expect(mission?.slug).toBe("auth-refresh");
		expect(deps.started).toEqual(["coordinator", "mission-analyst"]);
		// No nudge on initial start — SessionStart hook activates roles directly
		expect(await Bun.file(join(overstoryDir, "current-mission.txt")).exists()).toBe(true);
		expect(await Bun.file(join(overstoryDir, "current-run.txt")).exists()).toBe(true);

		const paths = getMissionArtifactPaths(mission);
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
		missionStore.freeze(mission.id, "clarification", questionId);
		await missionAnswer(overstoryDir, { body: "Use the login entrypoint", json: true }, deps);

		const repliesToAnalyst = mailStore.getAll({ from: "operator", to: "mission-analyst" });
		expect(repliesToAnalyst.some((message) => message.threadId === questionId)).toBe(true);
		expect(missionStore.getById(mission.id)?.pendingUserInput).toBe(false);
		expect(missionStore.getById(mission.id)?.reopenCount).toBe(1);
		expect(deps.nudged.some((entry) => entry.agentName === "mission-analyst")).toBe(true);

		await missionHandoff(overstoryDir, tempDir, true, deps);
		expect(deps.started).toEqual(["coordinator", "mission-analyst", "execution-director"]);
		expect(deps.nudged.some((entry) => entry.agentName === "execution-director")).toBe(true);

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
		await missionRefreshBriefsCommand(
			overstoryDir,
			tempDir,
			{
				workstream: "ws-auth",
				json: true,
			},
			deps,
		);

		const refreshedMission = missionStore.getById(mission.id);
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

		await missionResume(overstoryDir, tempDir, "ws-auth", true, deps);
		expect(missionStore.getById(mission.id)?.pausedWorkstreamIds).toEqual([]);
		expect((await readSpecMeta(tempDir, "task-auth"))?.status).toBe("current");

		await missionComplete(overstoryDir, tempDir, true, deps);

		const completedMission = missionStore.getById(mission.id);
		expect(completedMission?.state).toBe("completed");
		expect(completedMission?.phase).toBe("done");
		expect(deps.stopped).toEqual(["coordinator", "mission-analyst", "execution-director"]);
		expect(await Bun.file(join(overstoryDir, "current-mission.txt")).exists()).toBe(false);
		expect(await Bun.file(join(overstoryDir, "current-run.txt")).exists()).toBe(false);

		const runStore = createRunStore(join(overstoryDir, "sessions.db"));
		try {
			expect(runStore.getRun(mission.runId ?? "")?.status).toBe("completed");
		} finally {
			runStore.close();
		}

		expect(await Bun.file(join(paths.resultsDir, "manifest.json")).exists()).toBe(true);
		expect(await Bun.file(join(paths.resultsDir, "review.json")).exists()).toBe(true);

		mailStore.close();
		missionStore.close();
	});

	test("mission answer restarts mission-analyst when the pending role session was marked completed", async () => {
		const deps = makeRoleDeps(tempDir, overstoryDir);

		await missionStart(
			overstoryDir,
			tempDir,
			{ slug: "restart-analyst", objective: "Recover the pending mission analyst", json: true },
			deps,
		);

		const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
		const mission = missionStore.getActive();
		expect(mission).not.toBeNull();
		if (!mission) throw new Error("expected mission");

		const mailStore = createMailStore(join(overstoryDir, "mail.db"));
		const mailClient = createMailClient(mailStore);
		const questionId = mailClient.send({
			from: "mission-analyst",
			to: "operator",
			subject: "Need clarification",
			body: "Please confirm the recovery path",
			type: "question",
		});
		missionStore.freeze(mission.id, "question", questionId);

		const sessionStore = createSessionStore(join(overstoryDir, "sessions.db"));
		try {
			sessionStore.updateState("mission-analyst", "completed");
		} finally {
			sessionStore.close();
		}

		await missionAnswer(overstoryDir, { body: "Restart and continue", json: true }, deps);

		expect(deps.started).toEqual(["coordinator", "mission-analyst", "mission-analyst"]);
		expect(missionStore.getById(mission.id)?.pendingUserInput).toBe(false);
		expect(missionStore.getById(mission.id)?.analystSessionId).toBe("sess-mission-analyst");

		missionStore.close();
		mailClient.close();
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
		if (!mission) throw new Error("expected mission");

		const paths = getMissionArtifactPaths(mission);
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
		await missionRefreshBriefsCommand(
			overstoryDir,
			tempDir,
			{
				workstream: "ws-auth",
				json: true,
			},
			deps,
		);

		const refreshedMission = missionStore.getById(mission.id);
		expect(refreshedMission?.pausedWorkstreamIds).toContain("ws-auth");
		expect(await readSpecMeta(tempDir, "task-auth")).toBeNull();

		await missionResume(overstoryDir, tempDir, "ws-auth", true, deps);
		expect(process.exitCode).toBe(1);
		process.exitCode = 0;

		await specWriteCommand("task-auth", {
			body: "# Auth spec v2",
			agent: "lead-auth",
			workstreamId: "ws-auth",
			briefPath: relative(tempDir, briefPath),
		});

		await missionResume(overstoryDir, tempDir, "ws-auth", true, deps);
		expect(missionStore.getById(mission.id)?.pausedWorkstreamIds).toEqual([]);

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
		if (!mission) throw new Error("expected mission");

		const paths = getMissionArtifactPaths(mission);
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

		// Freeze the mission (required before handoff)
		missionStore.freeze(mission.id, "approval", null);
		missionStore.unfreeze(mission.id);

		await Bun.write(join(overstoryDir, "current-mission.txt"), "");
		await Bun.write(join(overstoryDir, "current-run.txt"), "");

		await missionHandoff(overstoryDir, tempDir, true, deps);

		expect((await Bun.file(join(overstoryDir, "current-mission.txt")).text()).trim()).toBe(
			mission.id,
		);
		expect((await Bun.file(join(overstoryDir, "current-run.txt")).text()).trim()).toBe(
			mission.runId ?? "",
		);
		expect(deps.started).toEqual(["coordinator", "mission-analyst", "execution-director"]);

		missionStore.close();
	});

	test("mission start and handoff drain stale unread root-role mail before reuse", async () => {
		const deps = makeRoleDeps(tempDir, overstoryDir);
		const staleMailStore = createMailStore(join(overstoryDir, "mail.db"));
		const staleMailClient = createMailClient(staleMailStore);
		const staleAnalystId = staleMailClient.send({
			from: "operator",
			to: "mission-analyst",
			subject: "Old analyst mail",
			body: "stale analyst message",
			type: "status",
		});

		await missionStart(
			overstoryDir,
			tempDir,
			{ slug: "mail-drain", objective: "Drain stale root-role mail", json: true },
			deps,
		);

		expect(staleMailStore.getById(staleAnalystId)?.read).toBe(true);

		const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
		const mission = missionStore.getActive();
		expect(mission).not.toBeNull();
		if (!mission) throw new Error("expected mission");

		const paths = getMissionArtifactPaths(mission);
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

		// Freeze the mission (required before handoff)
		missionStore.freeze(mission.id, "approval", null);
		missionStore.unfreeze(mission.id);

		const staleDirectorId = staleMailClient.send({
			from: "lead-auth",
			to: "execution-director",
			subject: "Old execution director mail",
			body: "stale execution-director message",
			type: "status",
		});

		await missionHandoff(overstoryDir, tempDir, true, deps);

		expect(staleMailStore.getById(staleDirectorId)?.read).toBe(true);

		staleMailClient.close();
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
		if (!mission) throw new Error("expected mission");

		const paths = getMissionArtifactPaths(mission);
		await missionStop(overstoryDir, tempDir, true, true, deps);

		const stoppedMission = missionStore.getById(mission.id);
		expect(stoppedMission?.state).toBe("stopped");
		expect(await Bun.file(join(paths.resultsDir, "manifest.json")).exists()).toBe(true);
		expect(await Bun.file(join(paths.resultsDir, "review.json")).exists()).toBe(true);
		expect(await Bun.file(join(overstoryDir, "current-mission.txt")).exists()).toBe(false);
		expect(await Bun.file(join(overstoryDir, "current-run.txt")).exists()).toBe(false);

		const runStore = createRunStore(join(overstoryDir, "sessions.db"));
		try {
			expect(runStore.getRun(mission.runId ?? "")?.status).toBe("stopped");
		} finally {
			runStore.close();
		}

		missionStore.close();
	});

	test("mission stop also completes descendant agent sessions from the same mission run", async () => {
		const deps = makeRoleDeps(tempDir, overstoryDir);

		await missionStart(
			overstoryDir,
			tempDir,
			{ slug: "stop-descendants", objective: "Verify mission descendant cleanup", json: true },
			deps,
		);

		const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
		const mission = missionStore.getActive();
		expect(mission).not.toBeNull();
		if (!mission) throw new Error("expected mission");

		const sessionStore = createSessionStore(join(overstoryDir, "sessions.db"));
		try {
			sessionStore.upsert({
				id: "sess-docs-smoke-lead",
				agentName: "docs-smoke-lead",
				capability: "lead",
				runtime: "claude",
				worktreePath: join(tempDir, ".overstory", "worktrees", "docs-smoke-lead"),
				branchName: "overstory/docs-smoke-lead/task-1",
				taskId: "task-1",
				tmuxSession: "overstory-overstory-docs-smoke-lead",
				state: "working",
				pid: 4242,
				parentAgent: "execution-director",
				depth: 1,
				runId: mission.runId,
				startedAt: "2026-03-13T00:00:00.000Z",
				lastActivity: "2026-03-13T00:00:00.000Z",
				escalationLevel: 0,
				stalledSince: null,
				rateLimitedSince: null,
				runtimeSessionId: null,
				transcriptPath: null,
				originalRuntime: null,
				statusLine: null,
			});
		} finally {
			sessionStore.close();
		}

		await missionStop(overstoryDir, tempDir, true, true, deps);

		const verifySessionStore = createSessionStore(join(overstoryDir, "sessions.db"));
		try {
			expect(verifySessionStore.getByName("docs-smoke-lead")?.state).toBe("completed");
		} finally {
			verifySessionStore.close();
		}
		expect(deps.stopped).toEqual([
			"coordinator",
			"mission-analyst",
			"execution-director",
			"docs-smoke-lead",
		]);

		missionStore.close();
	});

	test("handoff rejects when mission has never been frozen", async () => {
		const deps = makeRoleDeps(tempDir, overstoryDir);

		await missionStart(
			overstoryDir,
			tempDir,
			{ slug: "no-freeze", objective: "Test freeze guard", json: true },
			deps,
		);

		const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
		const mission = missionStore.getActive();
		expect(mission).not.toBeNull();
		if (!mission) throw new Error("expected mission");

		const paths = getMissionArtifactPaths(mission);
		await Bun.write(
			paths.workstreamsJson,
			`${JSON.stringify(
				{
					version: 1,
					workstreams: [
						{
							id: "ws-test",
							taskId: "task-test",
							objective: "Test workstream",
							fileScope: ["src/test.ts"],
							dependsOn: [],
							briefPath: "plan/ws-test.md",
							status: "planned",
						},
					],
				},
				null,
				2,
			)}\n`,
		);
		const briefPath = join(paths.planDir, "ws-test.md");
		await Bun.write(briefPath, "# Test brief\n");

		// Handoff without freeze should fail
		process.exitCode = 0;
		await missionHandoff(overstoryDir, tempDir, true, deps);
		expect(process.exitCode).toBe(1);

		// Now freeze and unfreeze (simulating question→answer flow)
		const mailStore = createMailStore(join(overstoryDir, "mail.db"));
		const mailClient = createMailClient(mailStore);
		const questionId = mailClient.send({
			from: "mission-analyst",
			to: "operator",
			subject: "Confirm scope",
			body: "Is this correct?",
			type: "question",
		});
		missionStore.freeze(mission.id, "clarification", questionId);
		await missionAnswer(overstoryDir, { body: "Yes, proceed", json: true }, deps);

		const afterAnswer = missionStore.getById(mission.id);
		expect(afterAnswer?.firstFreezeAt).not.toBeNull();
		expect(afterAnswer?.pendingUserInput).toBe(false);
		expect(afterAnswer?.state).toBe("active");

		// Handoff after freeze should succeed
		process.exitCode = 0;
		await missionHandoff(overstoryDir, tempDir, true, deps);
		expect(deps.started).toContain("execution-director");
		expect(missionStore.getById(mission.id)?.phase).toBe("execute");

		mailStore.close();
		missionStore.close();
	});

	test("mission start without slug/objective uses placeholders, update sets real values", async () => {
		const deps = makeRoleDeps(tempDir, overstoryDir);

		// Start with no slug or objective
		await missionStart(overstoryDir, tempDir, { json: true }, deps);

		const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
		const mission = missionStore.getActive();
		expect(mission).not.toBeNull();
		if (!mission) throw new Error("expected mission");
		expect(mission?.slug).toMatch(/^mission-\d+$/);
		expect(mission?.objective).toBe("Pending — coordinator will clarify with operator");
		expect(deps.started).toEqual(["coordinator", "mission-analyst"]);

		// Verify dispatch mail tells coordinator to discover objective
		const mailStore = createMailStore(join(overstoryDir, "mail.db"));
		const dispatchMail = mailStore.getAll({ to: "coordinator" }).find((m) => m.type === "dispatch");
		expect(dispatchMail?.body).toContain("No objective was provided at start");
		expect(dispatchMail?.body).toContain("ov mission update");

		// Update slug and objective
		await missionUpdate(overstoryDir, {
			slug: "auth-rewrite",
			objective: "Rewrite the authentication system",
			json: true,
		});

		const updated = missionStore.getById(mission.id);
		expect(updated?.slug).toBe("auth-rewrite");
		expect(updated?.objective).toBe("Rewrite the authentication system");

		// Update only objective
		await missionUpdate(overstoryDir, {
			objective: "Rewrite auth with OAuth2 support",
			json: true,
		});
		expect(missionStore.getById(mission.id)?.objective).toBe("Rewrite auth with OAuth2 support");
		expect(missionStore.getById(mission.id)?.slug).toBe("auth-rewrite");

		// Update with no args should fail
		process.exitCode = 0;
		await missionUpdate(overstoryDir, { json: true });
		expect(process.exitCode).toBe(1);

		mailStore.close();
		missionStore.close();
	});

	test("mission graph: currentNode is tracked through lifecycle", async () => {
		const deps = makeRoleDeps(tempDir, overstoryDir);

		// Start mission → should be at understand:active
		await missionStart(
			overstoryDir,
			tempDir,
			{ slug: "graph-test", objective: "Test graph tracking", json: true },
			deps,
		);

		const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
		const mission = missionStore.getActive();
		expect(mission).not.toBeNull();
		if (!mission) throw new Error("expected mission");
		expect(mission.phase).toBe("understand");
		expect(mission.state).toBe("active");

		// Manually update currentNode to verify store works
		missionStore.updateCurrentNode(mission.id, "understand:active");
		const updated = missionStore.getById(mission.id);
		expect(updated?.currentNode).toBe("understand:active");

		// Advance phase and update node
		missionStore.updatePhase(mission.id, "align");
		missionStore.updateCurrentNode(mission.id, "align:active");
		const afterAdvance = missionStore.getById(mission.id);
		expect(afterAdvance?.phase).toBe("align");
		expect(afterAdvance?.currentNode).toBe("align:active");

		// Freeze and update node
		missionStore.freeze(mission.id, "question", null);
		missionStore.updateCurrentNode(mission.id, "align:frozen");
		const afterFreeze = missionStore.getById(mission.id);
		expect(afterFreeze?.state).toBe("frozen");
		expect(afterFreeze?.currentNode).toBe("align:frozen");

		// Unfreeze and update node
		missionStore.unfreeze(mission.id);
		missionStore.updateCurrentNode(mission.id, "align:active");
		const afterUnfreeze = missionStore.getById(mission.id);
		expect(afterUnfreeze?.state).toBe("active");
		expect(afterUnfreeze?.currentNode).toBe("align:active");

		missionStore.close();
	});

	test("mission graph: currentNode is set to understand:active on start", async () => {
		const deps = makeRoleDeps(tempDir, overstoryDir);

		await missionStart(
			overstoryDir,
			tempDir,
			{ slug: "graph-init", objective: "Test initial node", json: true },
			deps,
		);

		const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
		const mission = missionStore.getActive();
		expect(mission).not.toBeNull();
		if (!mission) throw new Error("expected mission");
		expect(mission.currentNode).toBe("understand:active");

		missionStore.close();
	});

	test("mission graph: currentNode survives stop and reload", async () => {
		const deps = makeRoleDeps(tempDir, overstoryDir);

		await missionStart(
			overstoryDir,
			tempDir,
			{ slug: "graph-persist", objective: "Test persistence", json: true },
			deps,
		);

		const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
		const mission = missionStore.getActive();
		expect(mission).not.toBeNull();
		if (!mission) throw new Error("expected mission");

		missionStore.updateCurrentNode(mission.id, "plan:active");
		missionStore.close();

		// Reopen store and verify currentNode persisted
		const missionStore2 = createMissionStore(join(overstoryDir, "sessions.db"));
		const reloaded = missionStore2.getById(mission.id);
		expect(reloaded?.currentNode).toBe("plan:active");

		missionStore2.close();
	});

	test("mission graph: validateTransition detects illegal phase skip", () => {
		// Legal: understand → align
		const legal = validateTransition(
			DEFAULT_MISSION_GRAPH,
			"understand",
			"active",
			"align",
			"active",
		);
		expect(legal.valid).toBe(true);

		// Illegal: understand → execute (skip phases)
		const illegal = validateTransition(
			DEFAULT_MISSION_GRAPH,
			"understand",
			"active",
			"execute",
			"active",
		);
		expect(illegal.valid).toBe(false);
	});

	test("mission graph: getAvailableTransitions returns correct edges", () => {
		const edges = getAvailableTransitions(DEFAULT_MISSION_GRAPH, "execute", "active");
		const triggers = edges.map((e) => e.trigger);

		// execute:active should have: complete, freeze, suspend, stop, fail
		expect(triggers).toContain("complete");
		expect(triggers).toContain("freeze");
		expect(triggers).toContain("suspend");
		expect(triggers).toContain("stop");
	});

	test("mission graph: renderGraphPosition highlights current phase", () => {
		const output = renderGraphPosition(DEFAULT_MISSION_GRAPH, "execute", "active");
		expect(output).toContain("[execute]");
		expect(output).not.toContain("[understand]");
		expect(output).not.toContain("[plan]");
	});

	test("mission graph: toMermaid produces valid output", () => {
		const output = toMermaid(DEFAULT_MISSION_GRAPH, "plan", "frozen");
		expect(output).toContain("graph LR");
		expect(output).toContain("-->|freeze|");
		expect(output).toContain("style plan_frozen");
	});
});
