/**
 * Shared types for mission lifecycle operations.
 */

import type { nudgeAgent } from "../commands/nudge.ts";
import type { stopCommand } from "../commands/stop.ts";
import type { startExecutionDirector, stopMissionRole } from "./roles.ts";
import { startMissionAnalyst, startMissionCoordinator } from "./roles.ts";

export interface MissionCommandDeps {
	startMissionCoordinator?: typeof startMissionCoordinator;
	startMissionAnalyst?: typeof startMissionAnalyst;
	startExecutionDirector?: typeof startExecutionDirector;
	stopMissionRole?: typeof stopMissionRole;
	stopAgentCommand?: typeof stopCommand;
	ensureCanonicalWorkstreamTasks?: typeof import("./workstreams.ts").ensureCanonicalWorkstreamTasks;
	nudgeAgent?: typeof nudgeAgent;
}
