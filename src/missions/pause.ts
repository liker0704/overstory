/**
 * Mission-layer workstream pause/resume.
 *
 * Manages the pausedWorkstreamIds list on a Mission without modifying
 * the mission state or phase. Pause/resume are metadata operations only.
 */

import type { Mission, MissionStore } from "../types.ts";

// === Types ===

export interface PauseResult {
	missionId: string;
	workstreamId: string;
	/** True if the workstream was already paused before this call. */
	alreadyPaused: boolean;
	/** Number of paused workstreams after this operation. */
	pausedWorkstreamCount: number;
}

export interface ResumeResult {
	missionId: string;
	workstreamId: string;
	/** True if the workstream was not paused before this call. */
	wasNotPaused: boolean;
	/** Number of paused workstreams after this operation. */
	pausedWorkstreamCount: number;
}

// === Pure helpers ===

/**
 * Return the number of paused workstreams for a mission.
 */
export function getPausedWorkstreamCount(mission: Mission): number {
	return mission.pausedWorkstreamIds.length;
}

/**
 * Return whether a specific workstream is paused.
 */
export function isWorkstreamPaused(mission: Mission, workstreamId: string): boolean {
	return mission.pausedWorkstreamIds.includes(workstreamId);
}

// === Store-backed operations ===

/**
 * Pause a workstream within a mission.
 *
 * Adds workstreamId to mission.pausedWorkstreamIds if not already present.
 * Throws if the mission is not found.
 */
export function pauseWorkstream(
	store: MissionStore,
	missionId: string,
	workstreamId: string,
	_reason?: string,
): PauseResult {
	const mission = store.getById(missionId);
	if (mission === null) {
		throw new Error(`Mission not found: ${missionId}`);
	}

	const alreadyPaused = mission.pausedWorkstreamIds.includes(workstreamId);

	if (!alreadyPaused) {
		store.updatePausedWorkstreams(missionId, [...mission.pausedWorkstreamIds, workstreamId]);
	}

	const pausedWorkstreamCount = alreadyPaused
		? mission.pausedWorkstreamIds.length
		: mission.pausedWorkstreamIds.length + 1;

	return { missionId, workstreamId, alreadyPaused, pausedWorkstreamCount };
}

/**
 * Resume a paused workstream within a mission.
 *
 * Removes workstreamId from mission.pausedWorkstreamIds if present.
 * Throws if the mission is not found.
 */
export function resumeWorkstream(
	store: MissionStore,
	missionId: string,
	workstreamId: string,
): ResumeResult {
	const mission = store.getById(missionId);
	if (mission === null) {
		throw new Error(`Mission not found: ${missionId}`);
	}

	const wasNotPaused = !mission.pausedWorkstreamIds.includes(workstreamId);

	if (!wasNotPaused) {
		store.updatePausedWorkstreams(
			missionId,
			mission.pausedWorkstreamIds.filter((id) => id !== workstreamId),
		);
	}

	const pausedWorkstreamCount = wasNotPaused
		? mission.pausedWorkstreamIds.length
		: mission.pausedWorkstreamIds.length - 1;

	return { missionId, workstreamId, wasNotPaused, pausedWorkstreamCount };
}
