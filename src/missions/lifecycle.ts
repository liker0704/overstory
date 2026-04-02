/**
 * Mission lifecycle operations — barrel re-export.
 *
 * Handles start, stop, pause, resume, complete, update, answer, and
 * related state transitions for missions. Implementation is split across
 * focused modules; this file re-exports the public API surface.
 */

export {
	resolveCurrentMissionId,
	resolveMissionRoleStates,
	toSummary,
} from "./lifecycle-helpers.ts";
export {
	missionAnswer,
	missionExtractLearnings,
	missionPause,
	missionUpdate,
} from "./lifecycle-ops.ts";
export { missionResumeAll, missionStart } from "./lifecycle-start.ts";
export { suspendMission } from "./lifecycle-suspend.ts";
export { missionComplete, missionStop } from "./lifecycle-terminate.ts";
export type { MissionCommandDeps } from "./lifecycle-types.ts";
