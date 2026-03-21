import { existsSync } from "node:fs";
import type {
	ComponentRestoreStatus,
	ReconciliationReport,
	ReconciliationStatus,
	SwarmSnapshot,
} from "./types.ts";

/** Injectable deps for testing — allows mocking tmux without running it. */
export interface ReconcileDeps {
	checkTmuxSession(sessionName: string): Promise<boolean>;
}

const defaultDeps: ReconcileDeps = {
	async checkTmuxSession(sessionName: string): Promise<boolean> {
		const proc = Bun.spawn(["tmux", "has-session", "-t", sessionName], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		return exitCode === 0;
	},
};

/** Check if a PID is alive using signal 0. Returns null if pid is null. */
function checkPid(pid: number | null): boolean | null {
	if (pid === null) return null;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function agentComponentStatus(
	tmuxAlive: boolean,
	worktreeExists: boolean,
): ComponentRestoreStatus {
	if (tmuxAlive && worktreeExists) return "restored";
	if (!tmuxAlive && !worktreeExists) return "missing";
	return "degraded";
}

function computeOverallStatus(
	components: ReconciliationReport["components"],
): ReconciliationStatus {
	const active = components.filter((c) => c.status !== "skipped");
	if (active.length === 0) return "restored";
	if (active.every((c) => c.status === "restored")) return "restored";
	return "partial";
}

/**
 * Reconcile a SwarmSnapshot against live external state (tmux, worktrees, PIDs).
 *
 * For each non-completed agent session in the snapshot, checks whether the
 * tmux session is alive and the worktree path exists on disk. Returns a
 * ReconciliationReport describing what is alive vs. missing.
 */
export async function reconcileSnapshot(
	snapshot: SwarmSnapshot,
	bundleId: string,
	deps: ReconcileDeps = defaultDeps,
): Promise<ReconciliationReport> {
	const activeSessions = snapshot.sessions.filter((s) => s.state !== "completed");

	const components: ReconciliationReport["components"] = [];
	const operatorActions: string[] = [];

	if (activeSessions.length === 0) {
		components.push({
			name: "agents",
			status: "skipped",
			details: "No active sessions in snapshot",
		});
	} else {
		const results = await Promise.all(
			activeSessions.map(async (session) => {
				const tmuxAlive = await deps.checkTmuxSession(session.tmuxSession);
				const worktreeExists = existsSync(session.worktreePath);
				const pid = checkPid(session.pid);
				return { session, tmuxAlive, worktreeExists, pid };
			}),
		);

		for (const { session, tmuxAlive, worktreeExists, pid } of results) {
			const status = agentComponentStatus(tmuxAlive, worktreeExists);

			const parts = [
				`tmux:${tmuxAlive ? "alive" : "gone"}`,
				`worktree:${worktreeExists ? "exists" : "missing"}`,
			];
			if (pid !== null) parts.push(`pid:${pid ? "alive" : "gone"}`);

			components.push({
				name: `agent:${session.agentName}`,
				status,
				details: parts.join(", "),
			});

			if (status === "missing") {
				operatorActions.push(
					`Re-spawn missing agent: ov sling <task-id> --name ${session.agentName}`,
				);
			} else if (status === "degraded") {
				operatorActions.push(`Inspect degraded agent: ov inspect ${session.agentName}`);
			}
		}
	}

	return {
		bundleId,
		restoredAt: new Date().toISOString(),
		components,
		overallStatus: computeOverallStatus(components),
		operatorActions,
	};
}
