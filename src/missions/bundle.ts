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

import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
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

// === Row type for raw review queries ===

interface ReviewRow {
	id: string;
	subject_type: string;
	subject_id: string;
	timestamp: string;
	dimensions: string;
	overall_score: number;
	notes: string;
	reviewer_source: string;
	stale: number;
	stale_since: string | null;
	stale_reason: string | null;
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

	// events.jsonl
	const eventsDbPath = join(overstoryDir, "events.db");
	const eventsDbFile = Bun.file(eventsDbPath);
	if ((await eventsDbFile.exists()) && mission.runId) {
		const eventStore = createEventStore(eventsDbPath);
		try {
			const events = eventStore.getByRun(mission.runId);
			await Bun.write(
				join(outputDir, "events.jsonl"),
				events.map((e) => JSON.stringify(e)).join("\n"),
			);
		} finally {
			eventStore.close();
		}
	} else {
		await Bun.write(join(outputDir, "events.jsonl"), "");
	}
	filesWritten.push("events.jsonl");

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

	// review.json — optional; only written when mission-subject reviews exist
	const reviewsDbPath = join(overstoryDir, "reviews.db");
	const reviewsDbFile = Bun.file(reviewsDbPath);
	if (await reviewsDbFile.exists()) {
		let reviewDb: Database | null = null;
		try {
			reviewDb = new Database(reviewsDbPath, { readonly: true });
			reviewDb.exec("PRAGMA busy_timeout=5000");
			const rows = reviewDb
				.prepare<ReviewRow, { $subject_id: string }>(
					`SELECT * FROM reviews WHERE subject_type = 'mission' AND subject_id = $subject_id`,
				)
				.all({ $subject_id: missionId });
			if (rows.length > 0) {
				await Bun.write(join(outputDir, "review.json"), JSON.stringify(rows, null, 2));
				filesWritten.push("review.json");
			}
		} catch {
			// reviews.db may not have the reviews table yet — skip gracefully
		} finally {
			reviewDb?.close();
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
