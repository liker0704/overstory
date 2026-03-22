/**
 * Mission messaging helpers.
 *
 * Sends dispatch and control mail, nudges mission roles, drains agent
 * inboxes, and checks pending question senders. Extracted from
 * commands/mission.ts to separate messaging logic from CLI plumbing.
 */

import { join } from "node:path";
import { createMailClient } from "../mail/client.ts";
import { canonicalizeMailAgentName } from "../mail/identity.ts";
import { createMailStore } from "../mail/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { recordMissionEvent } from "./events.ts";
import {
	buildMissionRoleBeacon,
	materializeMissionRolePrompt,
} from "./context.ts";
import {
	startExecutionDirector,
	startMissionAnalyst,
	startMissionCoordinator,
} from "./roles.ts";
import { createMissionStore } from "./store.ts";
import type { Mission, MissionStore } from "../types.ts";
import { nudgeAgent } from "../commands/nudge.ts";

export interface MissionCommandDeps {
	startMissionCoordinator?: typeof startMissionCoordinator;
	startMissionAnalyst?: typeof startMissionAnalyst;
	startExecutionDirector?: typeof startExecutionDirector;
	stopMissionRole?: typeof import("./roles.ts").stopMissionRole;
	stopAgentCommand?: typeof import("../commands/stop.ts").stopCommand;
	ensureCanonicalWorkstreamTasks?: typeof import("./workstreams.ts").ensureCanonicalWorkstreamTasks;
	nudgeAgent?: typeof nudgeAgent;
}

function openMailClient(overstoryDir: string) {
	return createMailClient(createMailStore(join(overstoryDir, "mail.db")));
}

export function drainAgentInbox(overstoryDir: string, agentName: string): number {
	const client = openMailClient(overstoryDir);
	try {
		return client.check(agentName).length;
	} finally {
		client.close();
	}
}

export async function sendMissionDispatchMail(opts: {
	overstoryDir: string;
	to: string;
	subject: string;
	body: string;
}): Promise<string> {
	const client = openMailClient(opts.overstoryDir);
	try {
		return client.send({
			from: "operator",
			to: opts.to,
			subject: opts.subject,
			body: opts.body,
			type: "dispatch",
		});
	} finally {
		client.close();
	}
}

export async function sendMissionControlMail(opts: {
	overstoryDir: string;
	to: string;
	subject: string;
	body: string;
	type?: "status" | "dispatch";
}): Promise<string> {
	const client = openMailClient(opts.overstoryDir);
	try {
		return client.send({
			from: "operator",
			to: opts.to,
			subject: opts.subject,
			body: opts.body,
			type: opts.type ?? "status",
		});
	} finally {
		client.close();
	}
}

export async function nudgeMissionRoleBestEffort(
	projectRoot: string,
	agentName: string,
	message: string,
	deps: MissionCommandDeps = {},
): Promise<void> {
	try {
		await (deps.nudgeAgent ?? nudgeAgent)(projectRoot, agentName, message, true);
	} catch {
		// Best-effort wake-up only.
	}
}

export async function pendingMissionQuestionSender(
	overstoryDir: string,
	messageId: string,
): Promise<string | null> {
	const store = createMailStore(join(overstoryDir, "mail.db"));
	try {
		return store.getById(messageId)?.from ?? null;
	} finally {
		store.close();
	}
}

export async function ensureMissionRoleResponsive(opts: {
	projectRoot: string;
	overstoryDir: string;
	mission: Mission;
	roleName: string;
	threadId: string;
	replyId: string;
	deps?: MissionCommandDeps;
}): Promise<void> {
	const { projectRoot, overstoryDir, mission, roleName, threadId, replyId, deps = {} } = opts;
	const nudgeMessage = `Operator replied in thread ${threadId} (${replyId}). Check mail and continue the mission.`;

	const effectiveRoleName = canonicalizeMailAgentName(roleName);

	if (
		effectiveRoleName !== "coordinator" &&
		effectiveRoleName !== "mission-analyst" &&
		effectiveRoleName !== "execution-director"
	) {
		return;
	}

	const { store } = openSessionStore(overstoryDir);
	let sessionState: string | null = null;
	try {
		sessionState = store.getByName(effectiveRoleName)?.state ?? null;
	} finally {
		store.close();
	}

	if (sessionState && sessionState !== "completed" && sessionState !== "zombie") {
		await nudgeMissionRoleBestEffort(projectRoot, effectiveRoleName, nudgeMessage, deps);
		return;
	}

	if (!mission.runId) {
		return;
	}

	const roleLabels: Record<string, string> = {
		coordinator: "Mission Coordinator",
		"mission-analyst": "Mission Analyst",
		"execution-director": "Execution Director",
	};
	const capabilities: Record<string, string> = {
		coordinator: "coordinator-mission",
		"mission-analyst": "mission-analyst",
		"execution-director": "execution-director",
	};
	const roleLabel = roleLabels[effectiveRoleName] ?? effectiveRoleName;
	const capability = capabilities[effectiveRoleName] ?? effectiveRoleName;

	const prompt = await materializeMissionRolePrompt({
		overstoryDir,
		agentName: effectiveRoleName,
		capability,
		roleLabel,
		mission,
	});
	const beacon = [
		buildMissionRoleBeacon({
			agentName: effectiveRoleName,
			missionId: mission.id,
			contextPath: prompt.contextPath,
		}),
		`Operator replied in thread ${threadId}. Check mail and continue the mission.`,
	].join(" ");

	let startRole: typeof startMissionCoordinator;
	if (effectiveRoleName === "coordinator") {
		startRole = deps.startMissionCoordinator ?? startMissionCoordinator;
	} else if (effectiveRoleName === "mission-analyst") {
		startRole = deps.startMissionAnalyst ?? startMissionAnalyst;
	} else {
		startRole = deps.startExecutionDirector ?? startExecutionDirector;
	}
	const result = await startRole({
		missionId: mission.id,
		projectRoot,
		overstoryDir,
		existingRunId: mission.runId,
		appendSystemPromptFile: prompt.promptPath,
		beacon,
	});

	const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
	try {
		if (effectiveRoleName === "coordinator") {
			missionStore.bindCoordinatorSession(mission.id, result.session.id);
		} else if (effectiveRoleName === "mission-analyst") {
			missionStore.bindSessions(mission.id, { analystSessionId: result.session.id });
		} else {
			missionStore.bindSessions(mission.id, { executionDirectorSessionId: result.session.id });
		}
	} finally {
		missionStore.close();
	}

	recordMissionEvent({
		overstoryDir,
		mission,
		agentName: "operator",
		data: { kind: "role_started", detail: `${effectiveRoleName} restarted after operator reply` },
	});
}
