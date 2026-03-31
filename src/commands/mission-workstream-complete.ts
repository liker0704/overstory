/**
 * CLI command: ov mission workstream-complete <workstream-id>
 *
 * Operator escape hatch to manually mark a workstream as completed.
 * Primarily used when the engine's automatic detection fails or for testing.
 */

import { join } from "node:path";
import { Command } from "commander";
import { createMissionStore } from "../missions/store.ts";
import { updateWorkstreamStatus } from "../missions/workstreams.ts";

export function createWorkstreamCompleteCommand(): Command {
	return new Command("workstream-complete")
		.argument("<workstream-id>", "Workstream ID to mark as completed")
		.option("--mission <id>", "Mission ID (defaults to active mission)")
		.option("--json", "JSON output")
		.description("Mark a workstream as completed (operator escape hatch)")
		.action(async (workstreamId: string, opts: { mission?: string; json?: boolean }) => {
			const overstoryDir = join(process.cwd(), ".overstory");
			const dbPath = join(overstoryDir, "sessions.db");
			const store = createMissionStore(dbPath);

			try {
				const mission = opts.mission ? store.getById(opts.mission) : store.getActive();

				if (!mission) {
					if (opts.json) {
						process.stdout.write(JSON.stringify({ error: "No active mission found" }) + "\n");
					} else {
						process.stderr.write("Error: No active mission found\n");
					}
					process.exitCode = 1;
					return;
				}

				// Access underlying DB for workstream_status table
				const { Database } = await import("bun:sqlite");
				const db = new Database(dbPath);
				db.exec("PRAGMA journal_mode=WAL");
				db.exec("PRAGMA busy_timeout=5000");

				try {
					updateWorkstreamStatus(db, mission.id, workstreamId, "completed", "operator");

					if (opts.json) {
						process.stdout.write(
							JSON.stringify({
								missionId: mission.id,
								workstreamId,
								status: "completed",
								updatedBy: "operator",
							}) + "\n",
						);
					} else {
						process.stdout.write(
							`Workstream '${workstreamId}' marked as completed in mission '${mission.slug}'\n`,
						);
					}
				} finally {
					db.close();
				}
			} finally {
				store.close();
			}
		});
}
