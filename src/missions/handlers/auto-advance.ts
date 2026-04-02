/**
 * Auto-advance handlers for placeholder mission phases (align, decide).
 *
 * These phases exist in the graph as placeholders for future governance workflows:
 * - **align**: Will gate on operator confirmation of constraints and scope boundaries
 * - **decide**: Will gate on explicit scope decisions before planning begins
 *
 * Currently both auto-advance immediately via `phase_advance` trigger,
 * effectively making the real lifecycle: understand → plan → execute → done.
 * The phases are retained in the graph, types, and SQLite schema because
 * removal would require a coordinated migration across multiple layers.
 *
 * See: docs/ov-mission.md sections on phase design for original intent.
 */

import type { HandlerRegistry } from "../types.ts";

export const autoAdvanceHandlers: HandlerRegistry = {
	"align-auto-advance": async () => ({ trigger: "phase_advance" }),
	"decide-auto-advance": async () => ({ trigger: "phase_advance" }),
};
