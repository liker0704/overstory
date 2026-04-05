/**
 * Auto-advance handlers for unused mission phases (align, decide).
 *
 * These phases exist in the graph but are not currently used in production
 * missions. The handlers immediately advance to the next phase.
 */

import type { HandlerRegistry } from "../types.ts";

export const autoAdvanceHandlers: HandlerRegistry = {
	"align-auto-advance": async () => ({ trigger: "phase_advance" }),
	"decide-auto-advance": async () => ({ trigger: "phase_advance" }),
};
