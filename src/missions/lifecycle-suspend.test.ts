/**
 * Tests for suspendMission().
 *
 * Strategy: tmux operations (isSessionAlive, killSession, killProcessTree) will
 * fail gracefully in CI — no tmux available. We focus on DB state changes and
 * error-free execution when no sessions exist.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suspendMission } from "./lifecycle-suspend.ts";
import { createMissionStore } from "./store.ts";
import { makeMission } from "./test-mocks.ts";

let tempDir: string;
let overstoryDir: string;
let projectRoot: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "ov-lifecycle-suspend-test-"));
	overstoryDir = join(tempDir, ".overstory");
	projectRoot = tempDir;
	// Create the overstory dir (needed for event store and session store)
	await Bun.write(join(overstoryDir, ".keep"), "");
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

/** Insert a mission into the real SQLite store and return it. */
function setupMission(id: string, slug: string) {
	const dbPath = join(overstoryDir, "sessions.db");
	const store = createMissionStore(dbPath);
	try {
		store.create({ id, slug, objective: "test objective" });
		store.start(id);
	} finally {
		store.close();
	}
}

describe("suspendMission", () => {
	test("sets mission state to suspended in the DB", async () => {
		setupMission("m-sus-001", "test-suspend");

		const dbPath = join(overstoryDir, "sessions.db");
		const store = createMissionStore(dbPath);
		let mission;
		try {
			mission = store.getById("m-sus-001");
		} finally {
			store.close();
		}
		expect(mission).not.toBeNull();

		await suspendMission({
			overstoryDir,
			projectRoot,
			mission: mission!,
			json: true, // suppress console output
		});

		const verifyStore = createMissionStore(dbPath);
		try {
			const updated = verifyStore.getById("m-sus-001");
			expect(updated?.state).toBe("suspended");
		} finally {
			verifyStore.close();
		}
	});

	test("handles missing tmux sessions gracefully (no throw)", async () => {
		setupMission("m-sus-002", "no-tmux-mission");

		const dbPath = join(overstoryDir, "sessions.db");
		const store = createMissionStore(dbPath);
		let mission;
		try {
			mission = store.getById("m-sus-002");
		} finally {
			store.close();
		}

		// A mission with no runId has no descendant sessions to kill.
		// The role-kill loop will call isSessionAlive on named roles but
		// those won't exist — the loop continues without throwing.
		const mission2 = makeMission({ id: "m-sus-002", slug: "no-tmux-mission", runId: null });

		await expect(
			suspendMission({
				overstoryDir,
				projectRoot,
				mission: mission2,
				json: true,
			}),
		).resolves.toBeUndefined();
	});
});
