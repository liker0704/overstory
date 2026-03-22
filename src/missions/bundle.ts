/**
 * Mission result bundle export.
 *
 * Materializes a mission's runtime data (events, sessions, metrics, reviews)
 * to a structured directory under the mission's artifact root.
 *
 * Output: .overstory/missions/<missionId>/results/
 *   manifest.json   — inventory of generated files + metadata
 *   summary.json    — mission fields snapshot
 *   events.jsonl    — line-delimited events filtered by mission runId
 *   sessions.json   — agent sessions filtered by mission runId
 *   metrics.json    — cost/token metrics for the mission run
 *   review.json     — mission-subject reviews (only if records exist)
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { createReviewStore } from "../review/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { buildNarrative, renderNarrative } from "./narrative.ts";
import { createMissionStore } from "./store.ts";

// === Types ===

export interface BundleManifest {
	missionId: string;
	slug: string;
	objective: string;
	state: string;
	generatedAt: string;
	files: string[];
}

export interface BundleOptions {
	overstoryDir: string;
	dbPath: string;
	missionId: string;
	force?: boolean;
}

export interface BundleResult {
	outputDir: string;
	manifest: BundleManifest;
	filesWritten: string[];
}

// === Export function ===

/**
 * Export a result bundle for a mission to disk.
 *
 * Writes files to join(overstoryDir, 'missions', missionId, 'results').
 * Returns early (no rewrite) if the existing bundle is fresh relative to
 * the mission's updatedAt timestamp — unless force is set.
 */
export async function exportBundle(opts: BundleOptions): Promise<BundleResult> {
	const { overstoryDir, dbPath, missionId, force } = opts;

	// Load mission record
	const missionStore = createMissionStore(dbPath);
	let mission: Awaited<ReturnType<typeof missionStore.getById>>;
	try {
		mission = missionStore.getById(missionId);
	} finally {
		missionStore.close();
	}

	if (!mission) {
		throw new Error(`Mission not found: ${missionId}`);
	}

	const outputDir = join(overstoryDir, "missions", missionId, "results");
	await mkdir(outputDir, { recursive: true });

	// Freshness check — skip if manifest is up to date
	if (!force) {
		const manifestPath = join(outputDir, "manifest.json");
		const manifestFile = Bun.file(manifestPath);
		if (await manifestFile.exists()) {
			const existing = (await manifestFile.json()) as BundleManifest;
			const bundleIsFresh = existing.generatedAt >= mission.updatedAt;
			if (bundleIsFresh) {
				return { outputDir, manifest: existing, filesWritten: [] };
			}
		}
	}

	const filesWritten: string[] = [];

	// summary.json
	const summary = {
		id: mission.id,
		slug: mission.slug,
		objective: mission.objective,
		state: mission.state,
		phase: mission.phase,
		createdAt: mission.createdAt,
		updatedAt: mission.updatedAt,
		reopenCount: mission.reopenCount,
		runId: mission.runId,
	};
	await Bun.write(join(outputDir, "summary.json"), JSON.stringify(summary, null, 2));
	filesWritten.push("summary.json");

	// events.jsonl + narrative.{json,md}
	const eventsDbPath = join(overstoryDir, "events.db");
	const eventsDbFile = Bun.file(eventsDbPath);
	let events: ReturnType<ReturnType<typeof createEventStore>["getByRun"]> = [];
	if ((await eventsDbFile.exists()) && mission.runId) {
		const eventStore = createEventStore(eventsDbPath);
		try {
			events = eventStore.getByRun(mission.runId);
		} finally {
			eventStore.close();
		}
	}
	await Bun.write(join(outputDir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"));
	filesWritten.push("events.jsonl");

	const narrative = buildNarrative(mission, events);
	await Bun.write(join(outputDir, "narrative.json"), JSON.stringify(narrative, null, 2));
	filesWritten.push("narrative.json");
	await Bun.write(join(outputDir, "narrative.md"), `${renderNarrative(narrative)}\n`);
	filesWritten.push("narrative.md");

	// sessions.json
	const { store: sessionStore } = openSessionStore(overstoryDir);
	let sessions: unknown[] = [];
	try {
		sessions = mission.runId ? sessionStore.getByRun(mission.runId) : sessionStore.getAll();
	} finally {
		sessionStore.close();
	}
	await Bun.write(join(outputDir, "sessions.json"), JSON.stringify(sessions, null, 2));
	filesWritten.push("sessions.json");

	// metrics.json
	const metricsDbPath = join(overstoryDir, "metrics.db");
	const metricsDbFile = Bun.file(metricsDbPath);
	if ((await metricsDbFile.exists()) && mission.runId) {
		const metricsStore = createMetricsStore(metricsDbPath);
		try {
			const metrics = metricsStore.getSessionsByRun(mission.runId);
			await Bun.write(join(outputDir, "metrics.json"), JSON.stringify(metrics, null, 2));
		} finally {
			metricsStore.close();
		}
	} else {
		await Bun.write(join(outputDir, "metrics.json"), JSON.stringify([], null, 2));
	}
	filesWritten.push("metrics.json");

	// review.json — optional; export the latest mission review when available
	const reviewsDbPath = join(overstoryDir, "reviews.db");
	const reviewsDbFile = Bun.file(reviewsDbPath);
	if (await reviewsDbFile.exists()) {
		const reviewStore = createReviewStore(reviewsDbPath);
		try {
			const latest = reviewStore.getLatest("mission", missionId);
			if (latest) {
				await Bun.write(join(outputDir, "review.json"), JSON.stringify(latest, null, 2));
				filesWritten.push("review.json");
			}
		} finally {
			reviewStore.close();
		}
	}

	// manifest.json — written last so files list is complete (includes itself)
	const manifest: BundleManifest = {
		missionId: mission.id,
		slug: mission.slug,
		objective: mission.objective,
		state: mission.state,
		generatedAt: new Date().toISOString(),
		files: [...filesWritten, "manifest.json"],
	};
	await Bun.write(join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2));
	filesWritten.push("manifest.json");

	return { outputDir, manifest, filesWritten };
}

// === ov mission bundle (CLI handler) ===

interface BundleOpts {
	missionId?: string;
	force?: boolean;
	json?: boolean;
}

export async function missionBundle(overstoryDir: string, opts: BundleOpts): Promise<void> {
	const { jsonError, jsonOutput } = await import("../json.ts");
	const { printError, printHint, printSuccess } = await import("../logging/color.ts");
	const { resolveCurrentMissionId } = await import("./lifecycle.ts");

	const dbPath = join(overstoryDir, "sessions.db");

	let missionId = opts.missionId ?? null;
	if (!missionId) {
		missionId = await resolveCurrentMissionId(overstoryDir);
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
		} else if (result.filesWritten.length === 0) {
			printHint("Bundle is already up to date");
			process.stdout.write(`  Path: ${result.outputDir}\n`);
		} else {
			printSuccess("Bundle exported", result.outputDir);
			for (const file of result.filesWritten) {
				process.stdout.write(`  ${file}\n`);
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
