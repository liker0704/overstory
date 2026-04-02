/**
 * Mission lifecycle operations — barrel re-export.
 *
 * Handles start, stop, pause, resume, complete, update, answer, and
 * related state transitions for missions. Implementation is split across
 * focused modules; this file re-exports the public API surface.
 */

export type { MissionCommandDeps } from "./lifecycle-types.ts";

export {
	adviseGraphTransition,
	resolveCurrentMissionId,
	resolveMissionRoleStates,
	toSummary,
} from "./lifecycle-helpers.ts";

export { suspendMission } from "./lifecycle-suspend.ts";

export { missionStop, missionComplete } from "./lifecycle-terminate.ts";

export { missionStart, missionResumeAll } from "./lifecycle-start.ts";

export {
	missionUpdate,
	missionAnswer,
	missionPause,
	missionExtractLearnings,
} from "./lifecycle-ops.ts";
