/**
 * CLI command: ov review <subcommand> [options]
 *
 * Deterministic quality review of agent sessions, handoffs, and spec files.
 * Data sources: SessionStore, EventStore, MailStore, checkpoint files, spec files.
 * Results stored in .overstory/reviews.db via ReviewStore.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { createEventStore } from "../events/store.ts";
import { jsonOutput } from "../json.ts";
import { color } from "../logging/color.ts";
import { renderHeader, separator } from "../logging/theme.ts";
import { createMailStore } from "../mail/store.ts";
import { generateMissionReview } from "../missions/review.ts";
import { createMissionStore } from "../missions/store.ts";
import { analyzeHandoff } from "../review/analyzers/handoff.ts";
import { analyzeSession } from "../review/analyzers/session.ts";
import { analyzeSpec } from "../review/analyzers/spec.ts";
import { checkAndMarkStale } from "../review/staleness.ts";
import { createReviewStore } from "../review/store.ts";
import type { ReviewRecord } from "../review/types.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { SessionCheckpoint } from "../types.ts";

// === Formatting Helpers ===

function padRight(str: string, width: number): string {
	return str.length >= width ? str : str + " ".repeat(width - str.length);
}

function padLeft(str: string, width: number): string {
	return str.length >= width ? str : " ".repeat(width - str.length) + str;
}

function colorScore(score: number): string {
	const s = String(score);
	if (score >= 70) return color.green(s);
	if (score >= 40) return color.yellow(s);
	return color.red(s);
}

async function loadCheckpointForAgent(
	overstoryDir: string,
	agentName: string,
): Promise<SessionCheckpoint | null> {
	const checkpointPath = join(overstoryDir, "agents", agentName, "checkpoint.json");
	const file = Bun.file(checkpointPath);
	if (!(await file.exists())) return null;
	try {
		return (await file.json()) as SessionCheckpoint;
	} catch {
		return null;
	}
}

// === Subcommand: sessions ===

interface ReviewSessionsOpts {
	recent?: string;
	json?: boolean;
}

async function executeReviewSessions(opts: ReviewSessionsOpts): Promise<void> {
	const json = opts.json ?? false;
	const limit = opts.recent ? Number.parseInt(opts.recent, 10) : 10;

	const config = await loadConfig(process.cwd());
	const overstoryDir = join(config.project.root, ".overstory");

	const reviewStore = createReviewStore(join(overstoryDir, "reviews.db"));
	const { store: sessionStore } = openSessionStore(overstoryDir);
	const eventStore = createEventStore(join(overstoryDir, "events.db"));
	const mailStore = createMailStore(join(overstoryDir, "mail.db"));

	try {
		const allSessions = sessionStore.getAll().slice(0, limit);

		if (allSessions.length === 0) {
			if (json) {
				jsonOutput("review", { sessions: [] });
			} else {
				process.stdout.write("No sessions found.\n");
			}
			return;
		}

		const records: ReviewRecord[] = [];

		for (const session of allSessions) {
			const checkpoint = await loadCheckpointForAgent(overstoryDir, session.agentName);
			const events = eventStore.getByAgent(session.agentName);
			const errors = events.filter((e) => e.level === "error");
			const allMail = mailStore.getAll({ from: session.agentName });
			const receivedMail = mailStore.getAll({ to: session.agentName });
			const nudgeCount = receivedMail.filter(
				(m) => m.subject.toLowerCase().includes("nudge") || m.body.toLowerCase().includes("nudge"),
			).length;

			const startMs = new Date(session.startedAt).getTime();
			const endMs = new Date(session.lastActivity).getTime();

			const reviewInput = {
				session,
				checkpoint,
				eventCount: events.length,
				errorCount: errors.length,
				nudgeCount,
				mailSent: allMail.length,
				mailReceived: receivedMail.length,
				durationMs: Math.max(0, endMs - startMs),
			};

			const insertRecord = analyzeSession(reviewInput);
			const record = reviewStore.insert(insertRecord);
			records.push(record);
		}

		if (json) {
			jsonOutput("review", { sessions: records });
			return;
		}

		const w = process.stdout.write.bind(process.stdout);
		w(`${renderHeader(`Review: Sessions (${records.length})`)}\n`);
		w(
			`${padRight("Agent", 24)}${padRight("State", 12)}` +
				`${padLeft("Score", 7)}${padLeft("Clarity", 9)}${padLeft("Action", 9)}` +
				`${padLeft("Compl", 7)}${padLeft("S/N", 6)}${padLeft("Correct", 9)}${padLeft("Coord", 7)}\n`,
		);
		w(`${color.dim(separator())}\n`);

		for (const record of records) {
			const dim = (key: string) => record.dimensions.find((d) => d.dimension === key)?.score ?? 0;
			w(
				`${padRight(record.subjectId, 24)}` +
					`${padRight(allSessions.find((s) => s.agentName === record.subjectId)?.state ?? "", 12)}` +
					`${padLeft(colorScore(record.overallScore), 7)}` +
					`${padLeft(colorScore(dim("clarity")), 9)}` +
					`${padLeft(colorScore(dim("actionability")), 9)}` +
					`${padLeft(colorScore(dim("completeness")), 7)}` +
					`${padLeft(colorScore(dim("signal-to-noise")), 6)}` +
					`${padLeft(colorScore(dim("correctness-confidence")), 9)}` +
					`${padLeft(colorScore(dim("coordination-fit")), 7)}\n`,
			);
		}

		w(`${color.dim(separator())}\n`);
	} finally {
		reviewStore.close();
		sessionStore.close();
		eventStore.close();
		mailStore.close();
	}
}

// === Subcommand: session (single) ===

interface ReviewSessionOpts {
	json?: boolean;
}

async function executeReviewSession(sessionId: string, opts: ReviewSessionOpts): Promise<void> {
	const json = opts.json ?? false;

	const config = await loadConfig(process.cwd());
	const overstoryDir = join(config.project.root, ".overstory");

	const reviewStore = createReviewStore(join(overstoryDir, "reviews.db"));
	const { store: sessionStore } = openSessionStore(overstoryDir);
	const eventStore = createEventStore(join(overstoryDir, "events.db"));
	const mailStore = createMailStore(join(overstoryDir, "mail.db"));

	try {
		const session =
			sessionStore.getByName(sessionId) ?? sessionStore.getAll().find((s) => s.id === sessionId);

		if (!session) {
			if (json) {
				jsonOutput("review", { error: `Session not found: ${sessionId}` });
			} else {
				process.stdout.write(`Session not found: ${sessionId}\n`);
			}
			return;
		}

		const checkpoint = await loadCheckpointForAgent(overstoryDir, session.agentName);
		const events = eventStore.getByAgent(session.agentName);
		const errors = events.filter((e) => e.level === "error");
		const allMail = mailStore.getAll({ from: session.agentName });
		const receivedMail = mailStore.getAll({ to: session.agentName });
		const nudgeCount = receivedMail.filter(
			(m) => m.subject.toLowerCase().includes("nudge") || m.body.toLowerCase().includes("nudge"),
		).length;

		const startMs = new Date(session.startedAt).getTime();
		const endMs = new Date(session.lastActivity).getTime();

		const insertRecord = analyzeSession({
			session,
			checkpoint,
			eventCount: events.length,
			errorCount: errors.length,
			nudgeCount,
			mailSent: allMail.length,
			mailReceived: receivedMail.length,
			durationMs: Math.max(0, endMs - startMs),
		});
		const record = reviewStore.insert(insertRecord);

		if (json) {
			jsonOutput("review", { session: record });
			return;
		}

		const w = process.stdout.write.bind(process.stdout);
		w(`${renderHeader(`Review: ${session.agentName}`)}\n`);
		w(`Overall score: ${colorScore(record.overallScore)}/100\n`);
		w(`${color.dim(separator())}\n`);

		for (const dim of record.dimensions) {
			w(`${padRight(dim.dimension, 26)}${colorScore(dim.score)}/100  ${color.dim(dim.details)}\n`);
		}

		if (record.notes.length > 0) {
			w(`\n${color.yellow("Notes:")}\n`);
			for (const note of record.notes) {
				w(`  • ${note}\n`);
			}
		}
	} finally {
		reviewStore.close();
		sessionStore.close();
		eventStore.close();
		mailStore.close();
	}
}

// === Subcommand: handoffs ===

interface ReviewHandoffsOpts {
	recent?: string;
	json?: boolean;
}

async function executeReviewHandoffs(opts: ReviewHandoffsOpts): Promise<void> {
	const json = opts.json ?? false;
	const limit = opts.recent ? Number.parseInt(opts.recent, 10) : 10;

	const config = await loadConfig(process.cwd());
	const overstoryDir = join(config.project.root, ".overstory");
	const agentsDir = join(overstoryDir, "agents");

	const reviewStore = createReviewStore(join(overstoryDir, "reviews.db"));

	try {
		let agentDirs: string[] = [];
		try {
			agentDirs = await readdir(agentsDir);
		} catch {
			// agents dir may not exist yet
		}

		const records: ReviewRecord[] = [];
		let processed = 0;

		for (const agentName of agentDirs) {
			if (processed >= limit) break;

			const checkpointPath = join(agentsDir, agentName, "checkpoint.json");
			const file = Bun.file(checkpointPath);
			if (!(await file.exists())) continue;

			let checkpoint: SessionCheckpoint;
			try {
				checkpoint = (await file.json()) as SessionCheckpoint;
			} catch {
				continue;
			}

			const handoff = {
				fromSessionId: checkpoint.sessionId,
				toSessionId: null,
				checkpoint,
				reason: "manual" as const,
				handoffAt: checkpoint.timestamp,
			};

			const insertRecord = analyzeHandoff({ handoff, checkpoint });
			const record = reviewStore.insert(insertRecord);
			records.push(record);
			processed++;
		}

		if (json) {
			jsonOutput("review", { handoffs: records });
			return;
		}

		const w = process.stdout.write.bind(process.stdout);
		w(`${renderHeader(`Review: Handoffs (${records.length})`)}\n`);

		if (records.length === 0) {
			w(`${color.dim("No handoff checkpoints found.")}\n`);
			return;
		}

		w(
			`${padRight("Agent", 24)}${padLeft("Score", 7)}${padLeft("Clarity", 9)}` +
				`${padLeft("Action", 9)}${padLeft("Compl", 7)}${padLeft("S/N", 6)}\n`,
		);
		w(`${color.dim(separator())}\n`);

		for (const record of records) {
			const dim = (key: string) => record.dimensions.find((d) => d.dimension === key)?.score ?? 0;
			const agentLabel = record.subjectId.split(":")[0] ?? record.subjectId;
			w(
				`${padRight(agentLabel, 24)}` +
					`${padLeft(colorScore(record.overallScore), 7)}` +
					`${padLeft(colorScore(dim("clarity")), 9)}` +
					`${padLeft(colorScore(dim("actionability")), 9)}` +
					`${padLeft(colorScore(dim("completeness")), 7)}` +
					`${padLeft(colorScore(dim("signal-to-noise")), 6)}\n`,
			);
		}
		w(`${color.dim(separator())}\n`);
	} finally {
		reviewStore.close();
	}
}

// === Subcommand: specs ===

interface ReviewSpecsOpts {
	json?: boolean;
}

async function executeReviewSpecs(opts: ReviewSpecsOpts): Promise<void> {
	const json = opts.json ?? false;

	const config = await loadConfig(process.cwd());
	const overstoryDir = join(config.project.root, ".overstory");
	const specsDir = join(overstoryDir, "specs");

	const reviewStore = createReviewStore(join(overstoryDir, "reviews.db"));

	try {
		let specFiles: string[] = [];
		try {
			const entries = await readdir(specsDir);
			specFiles = entries.filter((f) => f.endsWith(".md"));
		} catch {
			// specs dir may not exist
		}

		const records: ReviewRecord[] = [];

		for (const filename of specFiles) {
			const specPath = join(specsDir, filename);
			const file = Bun.file(specPath);
			let content: string;
			try {
				content = await file.text();
			} catch {
				continue;
			}

			const insertRecord = analyzeSpec({ specPath: filename, content });
			const record = reviewStore.insert(insertRecord);
			records.push(record);
		}

		if (json) {
			jsonOutput("review", { specs: records });
			return;
		}

		const w = process.stdout.write.bind(process.stdout);
		w(`${renderHeader(`Review: Specs (${records.length})`)}\n`);

		if (records.length === 0) {
			w(`${color.dim("No spec files found in .overstory/specs/")}\n`);
			return;
		}

		w(
			`${padRight("Spec", 30)}${padLeft("Score", 7)}${padLeft("Clarity", 9)}` +
				`${padLeft("Action", 9)}${padLeft("Compl", 7)}${padLeft("Coord", 7)}\n`,
		);
		w(`${color.dim(separator())}\n`);

		for (const record of records) {
			const dim = (key: string) => record.dimensions.find((d) => d.dimension === key)?.score ?? 0;
			w(
				`${padRight(record.subjectId, 30)}` +
					`${padLeft(colorScore(record.overallScore), 7)}` +
					`${padLeft(colorScore(dim("clarity")), 9)}` +
					`${padLeft(colorScore(dim("actionability")), 9)}` +
					`${padLeft(colorScore(dim("completeness")), 7)}` +
					`${padLeft(colorScore(dim("coordination-fit")), 7)}\n`,
			);

			if (record.notes.length > 0) {
				for (const note of record.notes) {
					w(`  ${color.dim(`• ${note}`)}\n`);
				}
			}
		}
		w(`${color.dim(separator())}\n`);
	} finally {
		reviewStore.close();
	}
}

// === Subcommand: missions ===

interface ReviewMissionsOpts {
	recent?: string;
	json?: boolean;
}

async function executeReviewMissions(opts: ReviewMissionsOpts): Promise<void> {
	const json = opts.json ?? false;
	const limit = opts.recent ? Number.parseInt(opts.recent, 10) : 10;

	const config = await loadConfig(process.cwd());
	const overstoryDir = join(config.project.root, ".overstory");
	const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));

	try {
		const missions = missionStore
			.list({ limit: limit * 3 })
			.filter((mission) => mission.state !== "active" && mission.state !== "frozen")
			.slice(0, limit);

		if (missions.length === 0) {
			if (json) {
				jsonOutput("review", { missions: [] });
			} else {
				process.stdout.write("No completed or stopped missions found.\n");
			}
			return;
		}

		const reviews = missions.map((mission) => generateMissionReview({ overstoryDir, mission }));

		if (json) {
			jsonOutput("review", {
				missions: reviews.map((review) => ({
					mission: review.mission,
					record: review.record,
				})),
			});
			return;
		}

		const w = process.stdout.write.bind(process.stdout);
		w(`${renderHeader(`Review: Missions (${reviews.length})`)}\n`);
		w(
			`${padRight("Mission", 24)}${padRight("State", 12)}` +
				`${padLeft("Score", 7)}${padLeft("Clarity", 9)}${padLeft("Action", 9)}` +
				`${padLeft("Compl", 7)}${padLeft("S/N", 6)}${padLeft("Correct", 9)}${padLeft("Coord", 7)}\n`,
		);
		w(`${color.dim(separator())}\n`);

		for (const { mission, record } of reviews) {
			const dim = (key: string) => record.dimensions.find((d) => d.dimension === key)?.score ?? 0;
			w(
				`${padRight(mission.slug, 24)}` +
					`${padRight(mission.state, 12)}` +
					`${padLeft(colorScore(record.overallScore), 7)}` +
					`${padLeft(colorScore(dim("clarity")), 9)}` +
					`${padLeft(colorScore(dim("actionability")), 9)}` +
					`${padLeft(colorScore(dim("completeness")), 7)}` +
					`${padLeft(colorScore(dim("signal-to-noise")), 6)}` +
					`${padLeft(colorScore(dim("correctness-confidence")), 9)}` +
					`${padLeft(colorScore(dim("coordination-fit")), 7)}\n`,
			);
		}
		w(`${color.dim(separator())}\n`);
	} finally {
		missionStore.close();
	}
}

// === Subcommand: mission (single) ===

interface ReviewMissionOpts {
	json?: boolean;
}

async function executeReviewMission(idOrSlug: string, opts: ReviewMissionOpts): Promise<void> {
	const json = opts.json ?? false;

	const config = await loadConfig(process.cwd());
	const overstoryDir = join(config.project.root, ".overstory");
	const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));

	try {
		let mission = missionStore.getById(idOrSlug);
		if (!mission) {
			mission = missionStore.getBySlug(idOrSlug);
		}

		if (!mission) {
			if (json) {
				jsonOutput("review", { error: `Mission not found: ${idOrSlug}` });
			} else {
				process.stdout.write(`Mission not found: ${idOrSlug}\n`);
			}
			return;
		}

		const review = generateMissionReview({ overstoryDir, mission });
		if (json) {
			jsonOutput("review", { mission: review.mission, record: review.record, input: review.input });
			return;
		}

		const w = process.stdout.write.bind(process.stdout);
		w(`${renderHeader(`Review: ${mission.slug}`)}\n`);
		w(`Overall score: ${colorScore(review.record.overallScore)}/100\n`);
		w(`State: ${mission.state} / ${mission.phase}\n`);
		w(`${color.dim(separator())}\n`);

		for (const dim of review.record.dimensions) {
			w(`${padRight(dim.dimension, 26)}${colorScore(dim.score)}/100  ${color.dim(dim.details)}\n`);
		}

		if (review.record.notes.length > 0) {
			w(`\n${color.yellow("Notes:")}\n`);
			for (const note of review.record.notes) {
				w(`  • ${note}\n`);
			}
		}
	} finally {
		missionStore.close();
	}
}

// === Subcommand: stale ===

interface ReviewStaleOpts {
	json?: boolean;
}

async function executeReviewStale(opts: ReviewStaleOpts): Promise<void> {
	const json = opts.json ?? false;

	const config = await loadConfig(process.cwd());
	const overstoryDir = join(config.project.root, ".overstory");
	const repoRoot = config.project.root;

	const reviewStore = createReviewStore(join(overstoryDir, "reviews.db"));

	try {
		const changes = await checkAndMarkStale(repoRoot, reviewStore);

		if (json) {
			jsonOutput("review", { stale: changes });
			return;
		}

		const w = process.stdout.write.bind(process.stdout);
		w(`${renderHeader("Review: Staleness Check")}\n`);

		let anyChanges = false;
		for (const change of changes) {
			if (change.changedPaths.length > 0) {
				anyChanges = true;
				w(`${color.yellow(change.subjectType)}: ${change.changedPaths.length} file(s) changed\n`);
				for (const f of change.changedPaths) {
					w(`  ${color.dim(`• ${f}`)}\n`);
				}
			} else {
				w(`${color.green(change.subjectType)}: no changes detected\n`);
			}
		}

		if (!anyChanges) {
			w(`\n${color.green("All review surfaces are up to date.")}\n`);
		}
	} finally {
		reviewStore.close();
	}
}

// === Command Factory ===

export function createReviewCommand(): Command {
	const review = new Command("review").description(
		"Deterministic quality review of sessions, handoffs, and specs",
	);

	review
		.command("sessions")
		.description("Review recent completed sessions")
		.option("--recent <n>", "Number of sessions to review (default: 10)")
		.option("--json", "Output as JSON")
		.action(async (opts: ReviewSessionsOpts) => {
			await executeReviewSessions(opts);
		});

	review
		.command("session <session-id>")
		.description("Review a single session by agent name or session ID")
		.option("--json", "Output as JSON")
		.action(async (sessionId: string, opts: ReviewSessionOpts) => {
			await executeReviewSession(sessionId, opts);
		});

	review
		.command("handoffs")
		.description("Review recent session handoffs")
		.option("--recent <n>", "Number of handoffs to review (default: 10)")
		.option("--json", "Output as JSON")
		.action(async (opts: ReviewHandoffsOpts) => {
			await executeReviewHandoffs(opts);
		});

	review
		.command("specs")
		.description("Review all spec files in .overstory/specs/")
		.option("--json", "Output as JSON")
		.action(async (opts: ReviewSpecsOpts) => {
			await executeReviewSpecs(opts);
		});

	review
		.command("missions")
		.description("Review recent completed or stopped missions")
		.option("--recent <n>", "Number of missions to review (default: 10)")
		.option("--json", "Output as JSON")
		.action(async (opts: ReviewMissionsOpts) => {
			await executeReviewMissions(opts);
		});

	review
		.command("mission <mission-id-or-slug>")
		.description("Review a single mission by mission ID or slug")
		.option("--json", "Output as JSON")
		.action(async (missionIdOrSlug: string, opts: ReviewMissionOpts) => {
			await executeReviewMission(missionIdOrSlug, opts);
		});

	review
		.command("stale")
		.description("Check and mark stale reviews based on changed surfaces")
		.option("--json", "Output as JSON")
		.action(async (opts: ReviewStaleOpts) => {
			await executeReviewStale(opts);
		});

	return review;
}
