/**
 * Mission-mail bridge.
 *
 * Syncs mission pending-input state from incoming mail messages and
 * validates mission_finding payloads. Extracted from commands/mail.ts
 * to decouple mission concerns from the mail CLI command.
 */

import { join } from "node:path";
import { ValidationError } from "../errors.ts";
import type { MailMessageType, MissionFindingPayload } from "../types.ts";
import { recordMissionEvent } from "./events.ts";
import { resolveActiveMissionContext } from "./runtime-context.ts";
import { createMissionStore } from "./store.ts";

const MISSION_PENDING_SENDERS = new Set([
	"mission-analyst",
	"execution-director",
	"coordinator-mission",
	"coordinator",
]);

export async function syncMissionPendingInputFromMail(
	cwd: string,
	msg: {
		id: string;
		from: string;
		to: string;
		type: MailMessageType;
		subject: string;
	},
): Promise<void> {
	if (msg.to !== "operator" || msg.type !== "question" || !MISSION_PENDING_SENDERS.has(msg.from)) {
		return;
	}

	const overstoryDir = join(cwd, ".overstory");
	const dbPath = join(overstoryDir, "sessions.db");
	const missionStore = createMissionStore(dbPath);
	try {
		const missionContext = await resolveActiveMissionContext(overstoryDir);
		let mission = missionContext ? missionStore.getById(missionContext.missionId) : null;
		if (!mission) {
			mission = missionStore.getActive();
		}
		if (!mission) {
			return;
		}

		missionStore.freeze(mission.id, "question", msg.id);
		recordMissionEvent({
			overstoryDir,
			mission,
			agentName: msg.from,
			data: {
				kind: "pending_input",
				detail: `${msg.from} asked operator: ${msg.subject}`,
				threadId: msg.id,
			},
		});
		recordMissionEvent({
			overstoryDir,
			mission,
			agentName: msg.from,
			data: { kind: "state_change", from: mission.state, to: "frozen" },
		});
	} finally {
		missionStore.close();
	}
}

export function parseMissionFindingPayload(rawPayload: string | undefined): MissionFindingPayload {
	if (!rawPayload) {
		throw new ValidationError(
			"mission_finding mail to mission-analyst requires --payload with MissionFindingPayload JSON",
			{ field: "payload", value: rawPayload },
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawPayload);
	} catch {
		throw new ValidationError("--payload must be valid JSON", {
			field: "payload",
			value: rawPayload,
		});
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ValidationError("mission_finding payload must be a JSON object", {
			field: "payload",
			value: rawPayload,
		});
	}

	const payload = parsed as Record<string, unknown>;
	if (typeof payload.workstreamId !== "string" || payload.workstreamId.trim().length === 0) {
		throw new ValidationError("mission_finding payload.workstreamId must be a non-empty string", {
			field: "payload.workstreamId",
			value: payload.workstreamId,
		});
	}
	if (typeof payload.category !== "string" || payload.category.trim().length === 0) {
		throw new ValidationError("mission_finding payload.category must be a non-empty string", {
			field: "payload.category",
			value: payload.category,
		});
	}
	if (typeof payload.summary !== "string" || payload.summary.trim().length === 0) {
		throw new ValidationError("mission_finding payload.summary must be a non-empty string", {
			field: "payload.summary",
			value: payload.summary,
		});
	}
	if (
		!Array.isArray(payload.affectedWorkstreams) ||
		!payload.affectedWorkstreams.every((value) => typeof value === "string")
	) {
		throw new ValidationError("mission_finding payload.affectedWorkstreams must be a string[]", {
			field: "payload.affectedWorkstreams",
			value: payload.affectedWorkstreams,
		});
	}

	return {
		workstreamId: payload.workstreamId,
		category: payload.category as MissionFindingPayload["category"],
		summary: payload.summary,
		affectedWorkstreams: payload.affectedWorkstreams as string[],
	};
}
