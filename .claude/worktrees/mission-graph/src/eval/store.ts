/**
 * Eval artifact store: writes eval run results to disk.
 *
 * Artifacts are written to <projectRoot>/.overstory/eval-runs/<runId>/.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import { createSessionStore } from "../sessions/store.ts";
import type { EvalArtifacts, EvalResult } from "./types.ts";

/**
 * Write eval run artifacts for the given result.
 * Returns an EvalArtifacts object with paths to each written file.
 */
export async function writeArtifacts(
	result: EvalResult,
	projectRoot: string,
): Promise<EvalArtifacts> {
	const dir = join(projectRoot, ".overstory", "eval-runs", result.runId);
	mkdirSync(dir, { recursive: true });

	// manifest.json
	const manifestData = {
		runId: result.runId,
		scenarioName: result.scenarioName,
		scenarioPath: result.scenarioPath,
		startedAt: result.startedAt,
		completedAt: result.completedAt,
		durationMs: result.durationMs,
		passed: result.passed,
	};
	const manifest = join(dir, "manifest.json");
	await Bun.write(manifest, JSON.stringify(manifestData, null, 2));

	// summary.json — full EvalResult
	const summary = join(dir, "summary.json");
	await Bun.write(summary, JSON.stringify(result, null, 2));

	// assertions.json
	const assertions = join(dir, "assertions.json");
	await Bun.write(assertions, JSON.stringify(result.assertions, null, 2));

	// metrics.json
	const metrics = join(dir, "metrics.json");
	await Bun.write(metrics, JSON.stringify(result.metrics, null, 2));

	// sessions.json — raw sessions from fixture sessions.db
	let sessionsData: unknown[] = [];
	if (result.fixtureRoot) {
		const sessionsDbPath = join(result.fixtureRoot, ".overstory", "sessions.db");
		const dbFile = Bun.file(sessionsDbPath);
		if (await dbFile.exists()) {
			try {
				const store = createSessionStore(sessionsDbPath);
				try {
					sessionsData = store.getAll();
				} finally {
					store.close();
				}
			} catch {
				// DB may not be readable
			}
		}
	}
	const sessions = join(dir, "sessions.json");
	await Bun.write(sessions, JSON.stringify(sessionsData, null, 2));

	// events.jsonl — raw events from fixture events.db, one JSON line per event
	let eventsLines = "";
	if (result.fixtureRoot) {
		const eventsDbPath = join(result.fixtureRoot, ".overstory", "events.db");
		const dbFile = Bun.file(eventsDbPath);
		if (await dbFile.exists()) {
			try {
				const store = createEventStore(eventsDbPath);
				try {
					const eventsData = store.getTimeline({ since: "2000-01-01T00:00:00Z", limit: 100000 });
					eventsLines = eventsData.map((e) => JSON.stringify(e)).join("\n");
					if (eventsLines.length > 0) eventsLines += "\n";
				} finally {
					store.close();
				}
			} catch {
				// DB may not be readable
			}
		}
	}
	const events = join(dir, "events.jsonl");
	await Bun.write(events, eventsLines);

	return {
		dir,
		manifest,
		summary,
		assertions,
		metrics,
		sessions,
		events,
	};
}
