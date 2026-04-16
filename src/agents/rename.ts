/**
 * Rename a running mission-scoped agent in-place.
 *
 * Called from `ov mission update --slug` when the mission slug changes after
 * agents have been spawned. Keeps tmux, SQLite, directories, and mail inboxes
 * in sync so the running agent keeps processing mail under its new identity.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";

export interface RenameAgentOpts {
	oldName: string;
	newName: string;
	oldTmuxSession: string | null;
	newTmuxSession: string | null;
	overstoryDir: string;
}

export interface RenameAgentResult {
	tmuxRenamed: boolean;
	sessionRowUpdated: boolean;
	mailRowsUpdated: number;
	agentDirMoved: boolean;
	logsDirMoved: boolean;
}

/**
 * Rename an agent. Idempotent: all steps check existence before acting.
 * Operations that fail individually (e.g. tmux session missing) are logged
 * to the result but don't abort the rename — other state still gets updated.
 */
export async function renameAgent(opts: RenameAgentOpts): Promise<RenameAgentResult> {
	const result: RenameAgentResult = {
		tmuxRenamed: false,
		sessionRowUpdated: false,
		mailRowsUpdated: 0,
		agentDirMoved: false,
		logsDirMoved: false,
	};

	if (opts.oldName === opts.newName) return result;

	// 1. tmux session rename
	if (opts.oldTmuxSession && opts.newTmuxSession && opts.oldTmuxSession !== opts.newTmuxSession) {
		try {
			const proc = Bun.spawn(
				["tmux", "rename-session", "-t", opts.oldTmuxSession, opts.newTmuxSession],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const exit = await proc.exited;
			if (exit === 0) result.tmuxRenamed = true;
		} catch {
			// tmux may not be available or session may not exist; non-fatal
		}
	}

	// 2. sessions.db — update agent_name (UNIQUE) + agent_state_log (historical)
	const sessionsDbPath = join(opts.overstoryDir, "sessions.db");
	if (existsSync(sessionsDbPath)) {
		const db = new Database(sessionsDbPath);
		try {
			db.exec("PRAGMA journal_mode=WAL");
			db.exec("PRAGMA busy_timeout=5000");
			const sessionUpdate = db
				.prepare("UPDATE sessions SET agent_name = ? WHERE agent_name = ?")
				.run(opts.newName, opts.oldName);
			result.sessionRowUpdated = sessionUpdate.changes > 0;
			// agent_state_log is updated for history consistency; nothing reads it in hot paths
			db.prepare("UPDATE agent_state_log SET agent_name = ? WHERE agent_name = ?").run(
				opts.newName,
				opts.oldName,
			);
		} finally {
			db.close();
		}
	}

	// 3. mail.db — both inbox (to_agent) and outbox (from_agent) references
	const mailDbPath = join(opts.overstoryDir, "mail.db");
	if (existsSync(mailDbPath)) {
		const db = new Database(mailDbPath);
		try {
			db.exec("PRAGMA journal_mode=WAL");
			db.exec("PRAGMA busy_timeout=5000");
			const toUpdate = db
				.prepare("UPDATE messages SET to_agent = ? WHERE to_agent = ?")
				.run(opts.newName, opts.oldName);
			const fromUpdate = db
				.prepare("UPDATE messages SET from_agent = ? WHERE from_agent = ?")
				.run(opts.newName, opts.oldName);
			result.mailRowsUpdated = toUpdate.changes + fromUpdate.changes;
		} finally {
			db.close();
		}
	}

	// 4. Agent dir rename
	const agentDir = join(opts.overstoryDir, "agents", opts.oldName);
	const newAgentDir = join(opts.overstoryDir, "agents", opts.newName);
	if (existsSync(agentDir) && !existsSync(newAgentDir)) {
		try {
			await rename(agentDir, newAgentDir);
			result.agentDirMoved = true;
		} catch {
			// Concurrent access or permission issue; keep old dir to avoid losing state
		}
	}

	// 5. Logs dir rename
	const logsDir = join(opts.overstoryDir, "logs", opts.oldName);
	const newLogsDir = join(opts.overstoryDir, "logs", opts.newName);
	if (existsSync(logsDir) && !existsSync(newLogsDir)) {
		try {
			await rename(logsDir, newLogsDir);
			result.logsDirMoved = true;
		} catch {
			// Non-fatal
		}
	}

	return result;
}

/**
 * Replace occurrences of old names with new names inside an agent's
 * mission-context.md. Used when the mission slug changes — the context
 * may reference sibling agent names (e.g. "Coordinator agent: coordinator-foo")
 * that must be rewritten to match the new slug.
 */
export async function patchContextReferences(
	agentDir: string,
	renames: ReadonlyArray<{ oldName: string; newName: string }>,
): Promise<boolean> {
	const contextPath = join(agentDir, "mission-context.md");
	const file = Bun.file(contextPath);
	if (!(await file.exists())) return false;

	let content = await file.text();
	let changed = false;
	for (const { oldName, newName } of renames) {
		if (oldName === newName) continue;
		// Use word-boundary matching via a regex to avoid substring collisions
		// like rewriting "coordinator-foo-extra" when renaming "coordinator-foo".
		const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		// Reject hyphen/word-char neighbors so "coordinator-foo" does not match
		// inside "coordinator-foo-extra" (regex \b treats "-" as a boundary).
		const pattern = new RegExp(`(?<![-\\w])${escaped}(?![-\\w])`, "g");
		const next = content.replace(pattern, newName);
		if (next !== content) {
			content = next;
			changed = true;
		}
	}

	if (changed) {
		await Bun.write(contextPath, content);
	}
	return changed;
}
