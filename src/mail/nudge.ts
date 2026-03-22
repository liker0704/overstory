/**
 * Pending nudge marker management.
 *
 * Instead of sending tmux keys (which corrupt tool I/O), auto-nudge writes
 * a JSON marker file per agent. The `mail check --inject` flow reads and
 * clears these markers, prepending a priority banner to the injected output.
 *
 * Extracted from commands/mail.ts.
 */

import { join } from "node:path";
import type { MailMessage, MailMessageType } from "../types.ts";
import { canonicalizeMailAgentName, expandMailAgentNames } from "./identity.ts";

/**
 * Protocol message types that require immediate recipient attention.
 * These trigger auto-nudge regardless of priority level.
 */
export const AUTO_NUDGE_TYPES: ReadonlySet<MailMessageType> = new Set([
	"worker_done",
	"merge_ready",
	"error",
	"escalation",
	"merge_failed",
]);

/**
 * Check if a message type/priority combination should trigger a pending nudge.
 */
export function shouldAutoNudge(type: MailMessageType, priority: MailMessage["priority"]): boolean {
	return priority === "urgent" || priority === "high" || AUTO_NUDGE_TYPES.has(type);
}

/**
 * Check if a message type should trigger an immediate tmux dispatch nudge.
 * Dispatch nudges target newly spawned agents at the welcome screen.
 */
export function isDispatchNudge(type: MailMessageType): boolean {
	return type === "dispatch";
}

/** Directory where pending nudge markers are stored. */
function pendingNudgeDir(cwd: string): string {
	return join(cwd, ".overstory", "pending-nudges");
}

/** Shape of a pending nudge marker file. */
export interface PendingNudge {
	from: string;
	reason: string;
	subject: string;
	messageId: string;
	createdAt: string;
}

/**
 * Write a pending nudge marker for an agent.
 *
 * Creates `.overstory/pending-nudges/{agent}.json` so that the next
 * `mail check --inject` call surfaces a priority banner for this message.
 * Overwrites any existing marker (only the latest nudge matters).
 */
export async function writePendingNudge(
	cwd: string,
	agentName: string,
	nudge: Omit<PendingNudge, "createdAt">,
): Promise<void> {
	const dir = pendingNudgeDir(cwd);
	const { mkdir } = await import("node:fs/promises");
	await mkdir(dir, { recursive: true });

	const marker: PendingNudge = {
		...nudge,
		createdAt: new Date().toISOString(),
	};
	const filePath = join(dir, `${canonicalizeMailAgentName(agentName)}.json`);
	await Bun.write(filePath, `${JSON.stringify(marker, null, "\t")}\n`);
}

/**
 * Read and clear pending nudge markers for an agent.
 *
 * Returns the pending nudge (if any) and removes the marker file.
 * Called by `mail check --inject` to prepend a priority banner.
 */
export async function readAndClearPendingNudge(
	cwd: string,
	agentName: string,
): Promise<PendingNudge | null> {
	for (const mailboxName of expandMailAgentNames(agentName)) {
		const filePath = join(pendingNudgeDir(cwd), `${mailboxName}.json`);
		const file = Bun.file(filePath);
		if (!(await file.exists())) {
			continue;
		}
		try {
			const text = await file.text();
			const nudge = JSON.parse(text) as PendingNudge;
			const { unlink } = await import("node:fs/promises");
			await unlink(filePath);
			return nudge;
		} catch {
			// Corrupt or race condition — clear it and move on
			try {
				const { unlink } = await import("node:fs/promises");
				await unlink(filePath);
			} catch {
				// Already gone
			}
		}
	}
	return null;
}
