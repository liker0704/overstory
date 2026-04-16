import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchContextReferences, renameAgent } from "./rename.ts";

let tempDir: string;
let overstoryDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "ov-rename-test-"));
	overstoryDir = join(tempDir, ".overstory");
	await mkdir(overstoryDir, { recursive: true });
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

function seedSessionsDb(): Database {
	const db = new Database(join(overstoryDir, "sessions.db"));
	db.exec(`
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			agent_name TEXT NOT NULL UNIQUE,
			state TEXT NOT NULL
		);
		CREATE TABLE agent_state_log (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			agent_name TEXT NOT NULL,
			from_state TEXT,
			to_state TEXT NOT NULL
		);
	`);
	db.prepare("INSERT INTO sessions (id, agent_name, state) VALUES (?, ?, ?)").run(
		"sess-1",
		"coordinator-old",
		"working",
	);
	db.prepare("INSERT INTO agent_state_log (agent_name, from_state, to_state) VALUES (?, ?, ?)").run(
		"coordinator-old",
		"booting",
		"working",
	);
	return db;
}

function seedMailDb(): Database {
	const db = new Database(join(overstoryDir, "mail.db"));
	db.exec(`
		CREATE TABLE messages (
			id TEXT PRIMARY KEY,
			from_agent TEXT NOT NULL,
			to_agent TEXT NOT NULL,
			body TEXT NOT NULL
		);
	`);
	const insert = db.prepare(
		"INSERT INTO messages (id, from_agent, to_agent, body) VALUES (?, ?, ?, ?)",
	);
	insert.run("m1", "operator", "coordinator-old", "inbox");
	insert.run("m2", "coordinator-old", "mission-analyst-foo", "outbox");
	return db;
}

describe("renameAgent", () => {
	test("updates sessions.agent_name and agent_state_log", async () => {
		const db = seedSessionsDb();
		db.close();

		const result = await renameAgent({
			oldName: "coordinator-old",
			newName: "coordinator-new",
			oldTmuxSession: null,
			newTmuxSession: null,
			overstoryDir,
		});

		expect(result.sessionRowUpdated).toBe(true);

		const verify = new Database(join(overstoryDir, "sessions.db"));
		const session = verify
			.prepare<{ agent_name: string }, []>("SELECT agent_name FROM sessions WHERE id='sess-1'")
			.get();
		expect(session?.agent_name).toBe("coordinator-new");
		const log = verify
			.prepare<{ count: number }, []>(
				"SELECT COUNT(*) as count FROM agent_state_log WHERE agent_name='coordinator-new'",
			)
			.get();
		expect(log?.count).toBe(1);
		verify.close();
	});

	test("updates mail.messages to_agent and from_agent", async () => {
		seedSessionsDb().close();
		seedMailDb().close();

		const result = await renameAgent({
			oldName: "coordinator-old",
			newName: "coordinator-new",
			oldTmuxSession: null,
			newTmuxSession: null,
			overstoryDir,
		});

		expect(result.mailRowsUpdated).toBe(2);

		const verify = new Database(join(overstoryDir, "mail.db"));
		const inbox = verify
			.prepare<{ count: number }, []>(
				"SELECT COUNT(*) as count FROM messages WHERE to_agent='coordinator-new'",
			)
			.get();
		const outbox = verify
			.prepare<{ count: number }, []>(
				"SELECT COUNT(*) as count FROM messages WHERE from_agent='coordinator-new'",
			)
			.get();
		expect(inbox?.count).toBe(1);
		expect(outbox?.count).toBe(1);
		verify.close();
	});

	test("moves agent and logs directories", async () => {
		seedSessionsDb().close();
		const agentDir = join(overstoryDir, "agents", "coordinator-old");
		const logsDir = join(overstoryDir, "logs", "coordinator-old");
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "identity.yaml"), "name: coordinator-old\n");
		await mkdir(logsDir, { recursive: true });
		await writeFile(join(logsDir, "session.log"), "log content");

		const result = await renameAgent({
			oldName: "coordinator-old",
			newName: "coordinator-new",
			oldTmuxSession: null,
			newTmuxSession: null,
			overstoryDir,
		});

		expect(result.agentDirMoved).toBe(true);
		expect(result.logsDirMoved).toBe(true);
		expect(existsSync(join(overstoryDir, "agents", "coordinator-old"))).toBe(false);
		expect(existsSync(join(overstoryDir, "agents", "coordinator-new"))).toBe(true);
		expect(existsSync(join(overstoryDir, "logs", "coordinator-new", "session.log"))).toBe(true);
	});

	test("is a no-op when oldName === newName", async () => {
		const result = await renameAgent({
			oldName: "coordinator-same",
			newName: "coordinator-same",
			oldTmuxSession: null,
			newTmuxSession: null,
			overstoryDir,
		});
		expect(result.sessionRowUpdated).toBe(false);
		expect(result.mailRowsUpdated).toBe(0);
	});

	test("tolerates missing databases gracefully", async () => {
		const result = await renameAgent({
			oldName: "ghost",
			newName: "ghost-renamed",
			oldTmuxSession: null,
			newTmuxSession: null,
			overstoryDir,
		});
		expect(result.sessionRowUpdated).toBe(false);
		expect(result.mailRowsUpdated).toBe(0);
		expect(result.agentDirMoved).toBe(false);
	});
});

describe("patchContextReferences", () => {
	test("replaces old agent names with new ones using word-boundary match", async () => {
		const agentDir = join(overstoryDir, "agents", "mission-analyst-bar");
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "mission-context.md"),
			[
				"- Coordinator agent: `coordinator-foo`",
				"- Execution director: `execution-director-foo`",
				"This line mentions coordinator-foo-extra which should NOT match.",
			].join("\n"),
		);

		const changed = await patchContextReferences(agentDir, [
			{ oldName: "coordinator-foo", newName: "coordinator-baz" },
			{ oldName: "execution-director-foo", newName: "execution-director-baz" },
		]);

		expect(changed).toBe(true);
		const content = await readFile(join(agentDir, "mission-context.md"), "utf-8");
		expect(content).toContain("coordinator-baz");
		expect(content).toContain("execution-director-baz");
		// word-boundary check — coordinator-foo-extra must survive
		expect(content).toContain("coordinator-foo-extra");
		expect(content).not.toMatch(/coordinator-foo[^-]/);
	});

	test("returns false when no context file exists", async () => {
		const changed = await patchContextReferences(join(overstoryDir, "agents", "missing"), [
			{ oldName: "a", newName: "b" },
		]);
		expect(changed).toBe(false);
	});
});
