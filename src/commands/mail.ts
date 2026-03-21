/**
 * CLI command: overstory mail send/check/list/read/reply
 *
 * Parses CLI args via Commander.js and delegates to the mail client.
 * Supports --inject for hook context injection, --json for machine output,
 * and various filters for listing messages.
 */

import { join } from "node:path";
import { Command } from "commander";
import { resolveProjectRoot } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { jsonOutput } from "../json.ts";
import { accent, printHint, printSuccess } from "../logging/color.ts";
import { isGroupAddress, resolveGroupAddress } from "../mail/broadcast.ts";
import { createMailClient } from "../mail/client.ts";
import { canonicalizeMailAgentName, expandMailAgentNames } from "../mail/identity.ts";
import { createMailStore } from "../mail/store.ts";
import { recordMissionEvent } from "../missions/events.ts";
import { validateMissionIngress } from "../missions/ingress.ts";
import { resolveActiveMissionContext } from "../missions/runtime-context.ts";
import { createMissionStore } from "../missions/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import {
	MAIL_DELIVERY_STATES,
	MAIL_MESSAGE_TYPES,
	type MailDeliveryState,
	type MailMessage,
	type MailMessageType,
	type MissionFindingPayload,
} from "../types.ts";

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
 * Exported for testability.
 */
export function shouldAutoNudge(type: MailMessageType, priority: MailMessage["priority"]): boolean {
	return priority === "urgent" || priority === "high" || AUTO_NUDGE_TYPES.has(type);
}

/**
 * Check if a message type should trigger an immediate tmux dispatch nudge.
 * Dispatch nudges target newly spawned agents at the welcome screen.
 * Exported for testability.
 */
export function isDispatchNudge(type: MailMessageType): boolean {
	return type === "dispatch";
}

/** Format a single message for human-readable output. */
function formatMessage(msg: MailMessage): string {
	const readMarker = msg.read ? " " : "*";
	const priorityTag = msg.priority !== "normal" ? ` [${msg.priority.toUpperCase()}]` : "";
	const lines: string[] = [
		`${readMarker} ${accent(msg.id)}  From: ${accent(msg.from)} → To: ${accent(msg.to)}${priorityTag}`,
		`  Subject: ${msg.subject}  (${msg.type})`,
		`  ${msg.body}`,
	];
	if (msg.payload !== null) {
		lines.push(`  Payload: ${msg.payload}`);
	}
	if (msg.state !== "queued" && msg.state !== "acked") {
		lines.push(`  State: ${msg.state} (attempt ${msg.attempt})`);
	}
	if (msg.failReason) {
		const reason =
			msg.failReason.length > 500 ? `${msg.failReason.slice(0, 500)}…` : msg.failReason;
		lines.push(`  Reason: ${reason}`);
	}
	lines.push(`  ${msg.createdAt}`);
	return lines.join("\n");
}

/**
 * Open a mail store connected to the project's mail.db.
 * The cwd must already be resolved to the canonical project root.
 */
function openStore(cwd: string) {
	const dbPath = join(cwd, ".overstory", "mail.db");
	return createMailStore(dbPath);
}

// === Pending Nudge Markers ===
//
// Instead of sending tmux keys (which corrupt tool I/O), auto-nudge writes
// a JSON marker file per agent. The `mail check --inject` flow reads and
// clears these markers, prepending a priority banner to the injected output.

/** Directory where pending nudge markers are stored. */
function pendingNudgeDir(cwd: string): string {
	return join(cwd, ".overstory", "pending-nudges");
}

/** Shape of a pending nudge marker file. */
interface PendingNudge {
	from: string;
	reason: string;
	subject: string;
	messageId: string;
	createdAt: string;
}

const MISSION_PENDING_SENDERS = new Set([
	"mission-analyst",
	"execution-director",
	"coordinator-mission",
	"coordinator",
]);

async function syncMissionPendingInputFromMail(
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

function parseMissionFindingPayload(rawPayload: string | undefined): MissionFindingPayload {
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
	if (typeof payload["workstreamId"] !== "string" || payload["workstreamId"].trim().length === 0) {
		throw new ValidationError("mission_finding payload.workstreamId must be a non-empty string", {
			field: "payload.workstreamId",
			value: payload["workstreamId"],
		});
	}
	if (typeof payload["category"] !== "string" || payload["category"].trim().length === 0) {
		throw new ValidationError("mission_finding payload.category must be a non-empty string", {
			field: "payload.category",
			value: payload["category"],
		});
	}
	if (typeof payload["summary"] !== "string" || payload["summary"].trim().length === 0) {
		throw new ValidationError("mission_finding payload.summary must be a non-empty string", {
			field: "payload.summary",
			value: payload["summary"],
		});
	}
	if (
		!Array.isArray(payload["affectedWorkstreams"]) ||
		!payload["affectedWorkstreams"].every((value) => typeof value === "string")
	) {
		throw new ValidationError("mission_finding payload.affectedWorkstreams must be a string[]", {
			field: "payload.affectedWorkstreams",
			value: payload["affectedWorkstreams"],
		});
	}

	return {
		workstreamId: payload["workstreamId"],
		category: payload["category"] as MissionFindingPayload["category"],
		summary: payload["summary"],
		affectedWorkstreams: payload["affectedWorkstreams"] as string[],
	};
}

/**
 * Write a pending nudge marker for an agent.
 *
 * Creates `.overstory/pending-nudges/{agent}.json` so that the next
 * `mail check --inject` call surfaces a priority banner for this message.
 * Overwrites any existing marker (only the latest nudge matters).
 */
async function writePendingNudge(
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
async function readAndClearPendingNudge(
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

/**
 * Nudge an agent via tmux send-keys if it is currently idle at the prompt.
 *
 * File-based pending nudge markers only surface on the next `UserPromptSubmit`
 * hook cycle — but idle agents never fire that hook. This function detects
 * idle state via pane content and sends a direct tmux nudge when appropriate.
 * Non-fatal: all errors are silently swallowed.
 */
async function nudgeIfIdle(cwd: string, agentName: string, message: string): Promise<void> {
	try {
		const { resolveTargetSession } = await import("./nudge.ts");
		const tmuxSession = await resolveTargetSession(cwd, agentName);
		if (!tmuxSession) return;

		const { capturePaneContent, detectAgentState, getPaneWidth, getPaneActivity } = await import(
			"../worktree/tmux.ts"
		);
		const paneContent = await capturePaneContent(tmuxSession);
		if (!paneContent) return;

		const state = detectAgentState(paneContent);

		let shouldNudge = state === "idle";

		// Fallback for small panes (phone access): content detection returns
		// "unknown" because status bar text is truncated. Use pane_activity
		// timestamp instead — if no output for 30s, treat as idle.
		if (state === "unknown") {
			const width = await getPaneWidth(tmuxSession);
			if (width !== null && width <= 80) {
				const activity = await getPaneActivity(tmuxSession);
				if (activity !== null) {
					const idleSeconds = Math.floor(Date.now() / 1000) - activity;
					shouldNudge = idleSeconds >= 5;
				}
			}
		}

		if (shouldNudge) {
			const { nudgeAgent } = await import("./nudge.ts");
			await nudgeAgent(cwd, agentName, message, true);
		}
	} catch (err) {
		// Non-fatal: file-based nudge is the primary mechanism.
		// Log to stderr so failures are diagnosable.
		process.stderr.write(`[nudge] nudgeIfIdle failed for ${agentName}: ${err}\n`);
	}
}

// === Mail Check Debounce ===
//
// Prevents excessive mail checking by tracking the last check timestamp per agent.
// When --debounce flag is provided, mail check will skip if called within the
// debounce window.

/**
 * Path to the mail check debounce state file.
 */
function mailCheckStatePath(cwd: string): string {
	return join(cwd, ".overstory", "mail-check-state.json");
}

/**
 * Check if a mail check for this agent is within the debounce window.
 *
 * @param cwd - Project root directory
 * @param agentName - Agent name
 * @param debounceMs - Debounce interval in milliseconds
 * @returns true if the last check was within the debounce window
 */
async function isMailCheckDebounced(
	cwd: string,
	agentName: string,
	debounceMs: number,
): Promise<boolean> {
	const statePath = mailCheckStatePath(cwd);
	const file = Bun.file(statePath);
	if (!(await file.exists())) {
		return false;
	}
	try {
		const text = await file.text();
		const state = JSON.parse(text) as Record<string, number>;
		const lastCheck = state[canonicalizeMailAgentName(agentName)];
		if (lastCheck === undefined) {
			return false;
		}
		return Date.now() - lastCheck < debounceMs;
	} catch {
		return false;
	}
}

/**
 * Record a mail check timestamp for debounce tracking.
 *
 * @param cwd - Project root directory
 * @param agentName - Agent name
 */
async function recordMailCheck(cwd: string, agentName: string): Promise<void> {
	const statePath = mailCheckStatePath(cwd);
	let state: Record<string, number> = {};
	const file = Bun.file(statePath);
	if (await file.exists()) {
		try {
			const text = await file.text();
			state = JSON.parse(text) as Record<string, number>;
		} catch {
			// Corrupt state file — start fresh
		}
	}
	state[canonicalizeMailAgentName(agentName)] = Date.now();
	await Bun.write(statePath, `${JSON.stringify(state, null, "\t")}\n`);
}

/**
 * Open a mail client connected to the project's mail.db.
 * The cwd must already be resolved to the canonical project root.
 */
function openClient(cwd: string) {
	const store = openStore(cwd);
	const client = createMailClient(store);
	return client;
}

// === Typed option interfaces for each subcommand ===

interface SendOpts {
	to: string;
	subject: string;
	body: string;
	from?: string;
	agent?: string;
	type?: string;
	priority?: string;
	payload?: string;
	json?: boolean;
}

interface CheckOpts {
	agent?: string;
	inject?: boolean;
	json?: boolean;
	debounce?: string;
}

interface ListOpts {
	from?: string;
	to?: string;
	agent?: string;
	unread?: boolean;
	state?: string;
	json?: boolean;
}

interface ReplyOpts {
	body: string;
	from?: string;
	agent?: string;
	json?: boolean;
}

interface PurgeOpts {
	all?: boolean;
	days?: string;
	agent?: string;
	json?: boolean;
}

/** overstory mail send */
async function handleSend(opts: SendOpts, cwd: string): Promise<void> {
	const { to, subject, body } = opts;
	const from = canonicalizeMailAgentName(opts.agent ?? opts.from ?? "orchestrator");
	const rawPayload = opts.payload;
	const VALID_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

	const rawType = opts.type ?? "status";
	const rawPriority = opts.priority ?? "normal";

	if (!MAIL_MESSAGE_TYPES.includes(rawType as MailMessage["type"])) {
		throw new ValidationError(
			`Invalid --type "${rawType}". Must be one of: ${MAIL_MESSAGE_TYPES.join(", ")}`,
			{ field: "type", value: rawType },
		);
	}
	if (!VALID_PRIORITIES.includes(rawPriority as MailMessage["priority"])) {
		throw new ValidationError(
			`Invalid --priority "${rawPriority}". Must be one of: ${VALID_PRIORITIES.join(", ")}`,
			{ field: "priority", value: rawPriority },
		);
	}

	const type = rawType as MailMessage["type"];
	const priority = rawPriority as MailMessage["priority"];

	// Validate JSON payload if provided
	let payload: string | undefined;
	let missionFindingPayload: MissionFindingPayload | null = null;
	if (rawPayload !== undefined) {
		try {
			JSON.parse(rawPayload);
			payload = rawPayload;
		} catch {
			throw new ValidationError("--payload must be valid JSON", {
				field: "payload",
				value: rawPayload,
			});
		}
	}

	const validateMissionFindingRecipients = (recipients: string[]): void => {
		if (type !== "mission_finding" || !recipients.includes("mission-analyst")) {
			return;
		}

		missionFindingPayload ??= parseMissionFindingPayload(rawPayload);
		const ingress = validateMissionIngress(missionFindingPayload);
		if (!ingress.valid) {
			throw new ValidationError(
				`Mission finding does not qualify for mission-level ingress: ${ingress.reason}`,
				{
					field: "payload.category",
					value: missionFindingPayload.category,
				},
			);
		}
	};

	// Handle broadcast messages (group addresses)
	if (isGroupAddress(to)) {
		const overstoryDir = join(cwd, ".overstory");
		const { store: sessionStore } = openSessionStore(overstoryDir);

		try {
			const activeSessions = sessionStore.getActive();
			const recipients = resolveGroupAddress(to, activeSessions, from).map((recipient) =>
				canonicalizeMailAgentName(recipient),
			);
			validateMissionFindingRecipients(recipients);

			const client = openClient(cwd);

			try {
				// Atomic broadcast: insert all messages in a single transaction
				const messageIds = client.sendBroadcast({
					from,
					to: recipients,
					subject,
					body,
					type,
					priority,
					payload,
				});

				// Per-recipient side effects (mission sync, events, nudges)
				// EventStore opened once for all recipients
				let runId: string | null = null;
				try {
					const runIdPath = join(cwd, ".overstory", "current-run.txt");
					const runIdFile = Bun.file(runIdPath);
					if (await runIdFile.exists()) {
						const text = await runIdFile.text();
						const trimmed = text.trim();
						if (trimmed.length > 0) {
							runId = trimmed;
						}
					}
				} catch {
					// runId read failure is non-fatal
				}

				const eventsDbPath = join(cwd, ".overstory", "events.db");
				let eventStore: ReturnType<typeof createEventStore> | null = null;
				try {
					eventStore = createEventStore(eventsDbPath);
				} catch {
					// EventStore open failure is non-fatal
				}

				try {
					for (let i = 0; i < recipients.length; i++) {
						const recipient = recipients[i];
						const id = messageIds[i];
						if (!recipient || !id) continue;

						await syncMissionPendingInputFromMail(cwd, {
							id,
							from,
							to: recipient,
							type,
							subject,
						});

						// Record mail_sent event (fire-and-forget)
						try {
							eventStore?.insert({
								runId,
								agentName: from,
								sessionId: null,
								eventType: "mail_sent",
								toolName: null,
								toolArgs: null,
								toolDurationMs: null,
								level: "info",
								data: JSON.stringify({
									to: recipient,
									subject,
									type,
									priority,
									messageId: id,
									broadcast: true,
								}),
							});
						} catch {
							// Event recording failure is non-fatal
						}

						// Auto-nudge for each individual message
						if (shouldAutoNudge(type as MailMessageType, priority as MailMessage["priority"])) {
							const nudgeReason = AUTO_NUDGE_TYPES.has(type) ? type : `${priority} priority`;
							await writePendingNudge(cwd, recipient, {
								from,
								reason: nudgeReason,
								subject,
								messageId: id,
							});
							await nudgeIfIdle(cwd, recipient, `[MAIL] ${subject}`);
						}
					}
				} finally {
					eventStore?.close();
				}
				// Output broadcast summary
				if (opts.json) {
					jsonOutput("mail send", { messageIds, recipientCount: recipients.length });
				} else {
					process.stdout.write(
						`Broadcast sent to ${recipients.length} recipient${recipients.length === 1 ? "" : "s"} (${to})\n`,
					);
					for (let i = 0; i < recipients.length; i++) {
						const recipient = recipients[i];
						const msgId = messageIds[i];
						process.stdout.write(`   → ${accent(recipient)} (${accent(msgId)})\n`);
					}
				}
			} finally {
				client.close();
			}

			return; // Early return — broadcast handled
		} finally {
			sessionStore.close();
		}
	}

	const canonicalTo = canonicalizeMailAgentName(to);
	validateMissionFindingRecipients([canonicalTo]);

	// Single-recipient message (existing logic)
	const client = openClient(cwd);
	try {
		const id = client.send({ from, to: canonicalTo, subject, body, type, priority, payload });
		await syncMissionPendingInputFromMail(cwd, {
			id,
			from,
			to: canonicalTo,
			type,
			subject,
		});

		// Record mail_sent event to EventStore (fire-and-forget)
		try {
			const eventsDbPath = join(cwd, ".overstory", "events.db");
			const eventStore = createEventStore(eventsDbPath);
			try {
				let runId: string | null = null;
				const runIdPath = join(cwd, ".overstory", "current-run.txt");
				const runIdFile = Bun.file(runIdPath);
				if (await runIdFile.exists()) {
					const text = await runIdFile.text();
					const trimmed = text.trim();
					if (trimmed.length > 0) {
						runId = trimmed;
					}
				}
				eventStore.insert({
					runId,
					agentName: from,
					sessionId: null,
					eventType: "mail_sent",
					toolName: null,
					toolArgs: null,
					toolDurationMs: null,
					level: "info",
					data: JSON.stringify({ to: canonicalTo, subject, type, priority, messageId: id }),
				});
			} finally {
				eventStore.close();
			}
		} catch {
			// Event recording failure is non-fatal
		}

		if (opts.json) {
			jsonOutput("mail send", { id });
		} else {
			printSuccess("Sent message", id);
		}

		// Auto-nudge: write a pending nudge marker instead of sending tmux keys.
		// Direct tmux sendKeys during tool execution corrupts the agent's I/O,
		// causing SIGKILL (exit 137) and "request interrupted" errors (overstory-ii1o).
		// The message is already in the DB — the UserPromptSubmit hook's
		// `mail check --inject` will surface it on the next prompt cycle.
		// The pending nudge marker ensures the message gets a priority banner.
		// Pending nudge marker: priority banner for urgent/high/protocol messages.
		// Surfaces on the next UserPromptSubmit hook cycle via `mail check --inject`.
		const shouldNudge = priority === "urgent" || priority === "high" || AUTO_NUDGE_TYPES.has(type);
		if (shouldNudge) {
			const nudgeReason = AUTO_NUDGE_TYPES.has(type) ? type : `${priority} priority`;
			await writePendingNudge(cwd, canonicalTo, {
				from,
				reason: nudgeReason,
				subject,
				messageId: id,
			});
			if (!opts.json) {
				process.stdout.write(
					`Queued nudge for "${canonicalTo}" (${nudgeReason}, delivered on next prompt)\n`,
				);
			}
		}

		// Always poke idle agents — if they're sitting at the prompt they won't
		// fire UserPromptSubmit, so the pending marker alone can't reach them.
		await nudgeIfIdle(cwd, canonicalTo, `[MAIL] ${subject}`);

		// For dispatch messages, also send an immediate tmux nudge.
		// Dispatch targets newly spawned agents that may be idle at the welcome
		// screen where file-based nudges can't reach (no hook fires on idle agents).
		// The I/O corruption concern (overstory-ii1o) only applies during active
		// tool execution — newly spawned agents are idle, so sendKeys is safe.
		if (type === "dispatch") {
			try {
				const { nudgeAgent } = await import("./nudge.ts");
				const nudgeMessage = `[DISPATCH] ${subject}: ${body.slice(0, 500)}`;
				// Small delay to let the agent's TUI stabilize after sling
				await Bun.sleep(3_000);
				await nudgeAgent(cwd, canonicalTo, nudgeMessage, true); // force=true to skip debounce
			} catch {
				// Non-fatal: the file-based nudge is the fallback
			}
		}

		// Reviewer coverage check for merge_ready (advisory warning)
		if (type === "merge_ready") {
			try {
				const overstoryDir = join(cwd, ".overstory");
				const { store: sessionStore } = openSessionStore(overstoryDir);
				try {
					const allSessions = sessionStore.getAll();
					const myBuilders = allSessions.filter(
						(s) => s.parentAgent === from && s.capability === "builder",
					);
					const myReviewers = allSessions.filter(
						(s) => s.parentAgent === from && s.capability === "reviewer",
					);
					if (myBuilders.length > 0 && myReviewers.length === 0) {
						process.stderr.write(
							`\nWarning: merge_ready sent but NO reviewer sessions found for "${from}".\n` +
								`${myBuilders.length} builder(s) completed without review. This violates the review-before-merge requirement.\n` +
								`Spawn reviewers for each builder before merge. See REVIEW_SKIP in agents/lead.md.\n\n`,
						);
					} else if (myReviewers.length > 0 && myReviewers.length < myBuilders.length) {
						process.stderr.write(
							`\nNote: Only ${myReviewers.length} reviewer(s) for ${myBuilders.length} builder(s). Ensure all builder work is review-verified.\n\n`,
						);
					}
				} finally {
					sessionStore.close();
				}
			} catch {
				// Reviewer check failure is non-fatal — do not block mail send
			}
		}
	} finally {
		client.close();
	}
}

/** overstory mail check */
async function handleCheck(opts: CheckOpts, cwd: string): Promise<void> {
	const agent = canonicalizeMailAgentName(opts.agent ?? "orchestrator");
	const inject = opts.inject ?? false;
	const json = opts.json ?? false;
	const debounceFlag = opts.debounce;

	// Parse debounce interval if provided
	let debounceMs: number | undefined;
	if (debounceFlag !== undefined) {
		const parsed = Number.parseInt(debounceFlag, 10);
		if (Number.isNaN(parsed) || parsed < 0) {
			throw new ValidationError(
				`--debounce must be a non-negative integer (milliseconds), got: ${debounceFlag}`,
				{ field: "debounce", value: debounceFlag },
			);
		}
		debounceMs = parsed;
	}

	// Check debounce if enabled
	if (debounceMs !== undefined) {
		const debounced = await isMailCheckDebounced(cwd, agent, debounceMs);
		if (debounced) {
			// Silent skip — no output when debounced
			return;
		}
	}

	const client = openClient(cwd);
	try {
		if (inject) {
			// Check for pending nudge markers (written by auto-nudge instead of tmux keys)
			const pendingNudge = await readAndClearPendingNudge(cwd, agent);
			const output = client.checkInject(agent);

			// Prepend a priority banner if there's a pending nudge
			if (pendingNudge) {
				const banner = `PRIORITY: ${pendingNudge.reason} message from ${pendingNudge.from} — "${pendingNudge.subject}"\n\n`;
				process.stdout.write(banner);
			}

			if (output.length > 0) {
				process.stdout.write(output);
			}
		} else {
			const messages = client.check(agent);

			if (json) {
				jsonOutput("mail check", { messages });
			} else if (messages.length === 0) {
				printHint("No new messages");
			} else {
				process.stdout.write(
					`${messages.length} new message${messages.length === 1 ? "" : "s"}:\n\n`,
				);
				for (const msg of messages) {
					process.stdout.write(`${formatMessage(msg)}\n\n`);
				}
			}
		}

		// Record this check for debounce tracking (only if debounce is enabled)
		if (debounceMs !== undefined) {
			await recordMailCheck(cwd, agent);
		}
	} finally {
		client.close();
	}
}

/** overstory mail list */
function handleList(opts: ListOpts, cwd: string): void {
	const from = opts.from;
	// --to takes precedence over --agent (agent is an alias for recipient filtering)
	const to = opts.to ?? opts.agent;
	const unread = opts.unread ? true : undefined;
	const json = opts.json ?? false;

	let state: MailDeliveryState | undefined;
	if (opts.state !== undefined) {
		if (!MAIL_DELIVERY_STATES.includes(opts.state as MailDeliveryState)) {
			throw new ValidationError(
				`Invalid state '${opts.state}'. Valid states: ${MAIL_DELIVERY_STATES.join(", ")}`,
				{ field: "state", value: opts.state },
			);
		}
		state = opts.state as MailDeliveryState;
	}

	const client = openClient(cwd);
	try {
		const messages = client.list({ from, to, unread, state });

		if (json) {
			jsonOutput("mail list", { messages });
		} else if (messages.length === 0) {
			printHint("No messages found");
		} else {
			for (const msg of messages) {
				process.stdout.write(`${formatMessage(msg)}\n\n`);
			}
			process.stdout.write(
				`Total: ${messages.length} message${messages.length === 1 ? "" : "s"}\n`,
			);
		}
	} finally {
		client.close();
	}
}

/** overstory mail read */
function handleRead(id: string, cwd: string): void {
	const client = openClient(cwd);
	try {
		const { alreadyRead } = client.markRead(id);
		if (alreadyRead) {
			printHint(`Message ${accent(id)} was already read`);
		} else {
			printSuccess("Marked as read", id);
		}
	} finally {
		client.close();
	}
}

/** overstory mail reply */
async function handleReply(id: string, opts: ReplyOpts, cwd: string): Promise<void> {
	const body = opts.body;
	const from = canonicalizeMailAgentName(opts.agent ?? opts.from ?? "orchestrator");

	const client = openClient(cwd);
	let reply: MailMessage;
	try {
		reply = client.reply(id, body, from);

		if (opts.json) {
			jsonOutput("mail reply", { id: reply.id });
		} else {
			printSuccess("Reply sent", reply.id);
		}
	} finally {
		client.close();
	}

	// Pending nudge marker for urgent/high/protocol replies.
	if (shouldAutoNudge(reply.type, reply.priority)) {
		const nudgeReason = AUTO_NUDGE_TYPES.has(reply.type)
			? reply.type
			: `${reply.priority} priority`;
		await writePendingNudge(cwd, reply.to, {
			from,
			reason: nudgeReason,
			subject: reply.subject,
			messageId: reply.id,
		});
		if (!opts.json) {
			process.stdout.write(
				`Queued nudge for "${reply.to}" (${nudgeReason}, delivered on next prompt)\n`,
			);
		}
	}

	// Always poke idle agents on any reply.
	await nudgeIfIdle(cwd, reply.to, `[MAIL] ${reply.subject}`);

	if (isDispatchNudge(reply.type)) {
		try {
			const { nudgeAgent } = await import("./nudge.ts");
			const nudgeMessage = `[DISPATCH] ${reply.subject}: ${body.slice(0, 500)}`;
			await Bun.sleep(3_000);
			await nudgeAgent(cwd, reply.to, nudgeMessage, true);
		} catch {
			// Non-fatal: the file-based nudge is the fallback
		}
	}
}

/** overstory mail purge */
function handlePurge(opts: PurgeOpts, cwd: string): void {
	const all = opts.all ?? false;
	const daysStr = opts.days;
	const agent = opts.agent;
	const json = opts.json ?? false;

	if (!all && daysStr === undefined && agent === undefined) {
		throw new ValidationError(
			"mail purge requires at least one filter: --all, --days <n>, or --agent <name>",
			{ field: "purge" },
		);
	}

	let olderThanMs: number | undefined;
	if (daysStr !== undefined) {
		const days = Number.parseInt(daysStr, 10);
		if (Number.isNaN(days) || days <= 0) {
			throw new ValidationError("--days must be a positive integer", {
				field: "days",
				value: daysStr,
			});
		}
		olderThanMs = days * 24 * 60 * 60 * 1000;
	}

	const store = openStore(cwd);
	try {
		const purged = store.purge({ all, olderThanMs, agent });

		if (json) {
			jsonOutput("mail purge", { purged });
		} else {
			printSuccess(`Purged ${purged} message(s)`);
		}
	} finally {
		store.close();
	}
}

interface DlqOpts {
	agent?: string;
	limit?: string;
	json?: boolean;
}

/** overstory mail dlq */
function handleDlq(opts: DlqOpts, cwd: string): void {
	const MAX_DLQ_LIMIT = 1000;
	const limit = opts.limit !== undefined ? Number.parseInt(opts.limit, 10) : 100;
	if (Number.isNaN(limit) || limit <= 0) {
		throw new ValidationError("--limit must be a positive integer", {
			field: "limit",
			value: opts.limit,
		});
	}
	if (limit > MAX_DLQ_LIMIT) {
		throw new ValidationError(`--limit cannot exceed ${MAX_DLQ_LIMIT}`, {
			field: "limit",
			value: opts.limit,
		});
	}
	const json = opts.json ?? false;

	const client = openClient(cwd);
	try {
		const messages = client.getDlq({ agent: opts.agent, limit });

		if (json) {
			jsonOutput("mail dlq", { messages, count: messages.length });
		} else if (messages.length === 0) {
			printHint("Dead-letter queue is empty");
		} else {
			for (const msg of messages) {
				process.stdout.write(`${formatMessage(msg)}\n\n`);
			}
			process.stdout.write(
				`Total: ${messages.length} dead-lettered message${messages.length === 1 ? "" : "s"}\n`,
			);
		}
	} finally {
		client.close();
	}
}

interface RetryOpts {
	all?: boolean;
	limit?: string;
	json?: boolean;
}

/** overstory mail retry */
function handleRetry(id: string | undefined, opts: RetryOpts, cwd: string): void {
	if (!id && !opts.all) {
		throw new ValidationError("Specify a message ID or --all", {
			field: "retry",
		});
	}
	const json = opts.json ?? false;

	const client = openClient(cwd);
	try {
		if (id) {
			client.replayDlq(id);
			if (json) {
				jsonOutput("mail retry", { replayed: 1, ids: [id] });
			} else {
				printSuccess("Replayed message", id);
			}
		} else {
			const limit = opts.limit !== undefined ? Number.parseInt(opts.limit, 10) : 50;
			if (Number.isNaN(limit) || limit <= 0) {
				throw new ValidationError("--limit must be a positive integer", {
					field: "limit",
					value: opts.limit,
				});
			}
			const dlqMessages = client.getDlq({ limit });
			const ids = dlqMessages.map((m) => m.id);
			const replayed = client.replayDlqBatch(ids);
			if (json) {
				jsonOutput("mail retry", { replayed, ids });
			} else {
				printSuccess(`Replayed ${replayed} message(s) from dead-letter queue`);
			}
		}
	} finally {
		client.close();
	}
}

/**
 * Entry point for `overstory mail <subcommand> [args...]`.
 *
 * Subcommands: send, check, list, read, reply, purge, dlq, retry.
 * Uses Commander.js for subcommand routing and option parsing.
 */
export async function mailCommand(args: string[]): Promise<void> {
	// Resolve the actual project root (handles git worktrees).
	// Mail commands may run from agent worktrees via hooks, so we must
	// resolve up to the main project root where .overstory/mail.db lives.
	const root = await resolveProjectRoot(process.cwd());

	const program = new Command();
	program.name("ov mail").description("Agent messaging system").exitOverride();

	program
		.command("send")
		.description("Send a message")
		.requiredOption("--to <agent>", "Recipient agent name")
		.requiredOption("--subject <text>", "Message subject")
		.requiredOption("--body <text>", "Message body")
		.option("--from <name>", "Sender name")
		.option("--agent <name>", "Alias for --from")
		.option("--type <type>", "Message type", "status")
		.option("--priority <level>", "Priority level", "normal")
		.option("--payload <json>", "Structured JSON payload")
		.option("--json", "Output as JSON")
		.exitOverride()
		.action(async (opts: SendOpts) => {
			await handleSend(opts, root);
		});

	program
		.command("check")
		.description("Check inbox (unread messages)")
		.option("--agent <name>", "Agent name")
		.option("--inject", "Inject format for hook context")
		.option("--json", "Output as JSON")
		.option("--debounce <ms>", "Debounce interval in milliseconds")
		.exitOverride()
		.action(async (opts: CheckOpts) => {
			await handleCheck(opts, root);
		});

	program
		.command("list")
		.description("List messages with filters")
		.option("--from <name>", "Filter by sender")
		.option("--to <name>", "Filter by recipient")
		.option("--agent <name>", "Alias for --to (filter by recipient)")
		.option("--unread", "Show only unread messages")
		.option("--state <state>", "Filter by delivery state (queued|claimed|acked|failed|dead_letter)")
		.option("--json", "Output as JSON")
		.exitOverride()
		.action((opts: ListOpts) => {
			handleList(opts, root);
		});

	program
		.command("read")
		.description("Mark a message as read")
		.argument("<message-id>", "Message ID")
		.exitOverride()
		.action((id: string) => {
			handleRead(id, root);
		});

	program
		.command("reply")
		.description("Reply to a message")
		.argument("<message-id>", "Message ID to reply to")
		.requiredOption("--body <text>", "Reply body")
		.option("--from <name>", "Sender name")
		.option("--agent <name>", "Alias for --from")
		.option("--json", "Output as JSON")
		.exitOverride()
		.action(async (id: string, opts: ReplyOpts) => {
			await handleReply(id, opts, root);
		});

	program
		.command("purge")
		.description("Delete old messages")
		.option("--all", "Purge all messages")
		.option("--days <n>", "Purge messages older than N days")
		.option("--agent <name>", "Purge messages for specific agent")
		.option("--json", "Output as JSON")
		.exitOverride()
		.action((opts: PurgeOpts) => {
			handlePurge(opts, root);
		});

	program
		.command("dlq")
		.description("List dead-lettered messages")
		.option("--agent <name>", "Filter by recipient agent")
		.option("--limit <n>", "Maximum messages to show")
		.option("--json", "Output as JSON")
		.exitOverride()
		.action((opts: DlqOpts) => {
			handleDlq(opts, root);
		});

	program
		.command("retry")
		.description("Replay messages from dead-letter queue")
		.argument("[id]", "Message ID to replay (or use --all)")
		.option("--all", "Replay all dead-lettered messages")
		.option("--limit <n>", "Max messages to replay with --all (default: 50)")
		.option("--json", "Output as JSON")
		.exitOverride()
		.action((id: string | undefined, opts: RetryOpts) => {
			handleRetry(id, opts, root);
		});

	await program.parseAsync(["node", "overstory-mail", ...args]);
}
