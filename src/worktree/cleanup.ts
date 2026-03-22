import { join } from "node:path";
import { removeWorktree } from "./manager.ts";

export interface CleanupOptions {
	root: string;
	agentName: string;
	force?: boolean;
}

/**
 * Clean up a failed agent's worktree before respawning.
 * Fire-and-forget: never throws. Logs errors internally.
 */
export async function cleanupWorktreeForRespawn(options: CleanupOptions): Promise<boolean> {
	const worktreePath = join(options.root, ".overstory", "worktrees", options.agentName);
	try {
		await removeWorktree(options.root, worktreePath, { force: true, forceBranch: false });
		return true;
	} catch {
		return false;
	}
}
