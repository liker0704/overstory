/**
 * Mission review generation on top of the deterministic review infrastructure.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createMetricsStore } from "../metrics/store.ts";
import { createReviewStore } from "../review/store.ts";
import type { ReviewRecord } from "../review/types.ts";
import { analyzeMission, type MissionReviewInput } from "../review/analyzers/mission.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { Mission } from "../types.ts";
import { getMissionArtifactPaths } from "./context.ts";
import { loadMissionEvents } from "./events.ts";
import { buildNarrative } from "./narrative.ts";

export interface GeneratedMissionReview {
	mission: Mission;
	record: ReviewRecord;
	input: MissionReviewInput;
}

export function buildMissionReviewInput(
	overstoryDir: string,
	mission: Mission,
): MissionReviewInput {
	const events = loadMissionEvents(overstoryDir, mission);
	const { store: sessionStore } = openSessionStore(overstoryDir);
	try {
		const sessions = mission.runId ? sessionStore.getByRun(mission.runId) : [];
		const completedSessionCount = sessions.filter((session) => session.state === "completed").length;
		const agentCount = new Set(sessions.map((session) => session.agentName)).size;
		const manifestPath = mission.artifactRoot
			? join(mission.artifactRoot, "results", "manifest.json")
			: null;
		const hasBundleExport = manifestPath ? existsSync(manifestPath) : false;
		const metricsDbPath = join(overstoryDir, "metrics.db");
		let metricsCount = 0;
		if (mission.runId && existsSync(metricsDbPath)) {
			const metricsStore = createMetricsStore(metricsDbPath);
			try {
				metricsCount = metricsStore.getSessionsByRun(mission.runId).length;
			} finally {
				metricsStore.close();
			}
		}

		const artifactPaths = mission.artifactRoot ? getMissionArtifactPaths(mission) : null;
		const requiredArtifacts = artifactPaths
			? [
					artifactPaths.missionMd,
					artifactPaths.decisionsMd,
					artifactPaths.openQuestionsMd,
					artifactPaths.currentStateMd,
					artifactPaths.researchSummaryMd,
					artifactPaths.workstreamsJson,
				]
			: [];
		const artifactFileCount = requiredArtifacts.filter((path) => existsSync(path)).length;
		const narrative = buildNarrative(mission, events);
		const startedAt = mission.startedAt ?? mission.createdAt;
		const endedAt = mission.completedAt ?? mission.updatedAt;

		return {
			mission,
			eventCount: events.length,
			errorCount: events.filter((event) => event.level === "error").length,
			agentCount,
			completedSessionCount,
			totalSessionCount: sessions.length,
			hasBundleExport,
			artifactFileCount,
			metricsCount,
			narrativeEntryCount: narrative.events.length,
			durationMs: Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime()),
		};
	} finally {
		sessionStore.close();
	}
}

export function generateMissionReview(opts: {
	overstoryDir: string;
	mission: Mission;
}): GeneratedMissionReview {
	const input = buildMissionReviewInput(opts.overstoryDir, opts.mission);
	const reviewStore = createReviewStore(join(opts.overstoryDir, "reviews.db"));
	try {
		const record = reviewStore.insert(analyzeMission(input));
		return { mission: opts.mission, record, input };
	} finally {
		reviewStore.close();
	}
}
