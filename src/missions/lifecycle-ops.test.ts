/**
 * Tests for mission lifecycle ops: missionUpdate.
 *
 * Uses real SQLite + temp dirs. No mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missionUpdate } from "./lifecycle-ops.ts";
import { createMissionStore } from "./store.ts";

let tempDir: string;
let overstoryDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "ov-lifecycle-ops-test-"));
	overstoryDir = join(tempDir, ".overstory");
	await Bun.write(join(overstoryDir, ".keep"), "");
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

/** Create a mission store, insert a test mission, and write the pointer file. */
async function setupMission(id: string, slug: string, objective: string) {
	const dbPath = join(overstoryDir, "sessions.db");
	const store = createMissionStore(dbPath);
	store.create({ id, slug, objective });
	store.close();

	// Write the active-mission pointer so resolveCurrentMissionId finds it
	await Bun.write(join(overstoryDir, "current-mission.txt"), `${id}\n`);
}

// ============================================================
// missionUpdate
// ============================================================

describe("missionUpdate", () => {
	test("updates slug when --slug provided and mission is active", async () => {
		await setupMission("m-001", "original-slug", "original objective");

		await missionUpdate(overstoryDir, { slug: "new-slug" });

		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			const mission = store.getById("m-001");
			expect(mission?.slug).toBe("new-slug");
		} finally {
			store.close();
		}
	});

	test("updates objective when --objective provided", async () => {
		await setupMission("m-002", "my-mission", "old objective");

		await missionUpdate(overstoryDir, { objective: "new objective" });

		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			const mission = store.getById("m-002");
			expect(mission?.objective).toBe("new objective");
		} finally {
			store.close();
		}
	});

	test("updates both slug and objective when both provided", async () => {
		await setupMission("m-003", "orig-slug", "orig objective");

		await missionUpdate(overstoryDir, { slug: "updated-slug", objective: "updated objective" });

		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			const mission = store.getById("m-003");
			expect(mission?.slug).toBe("updated-slug");
			expect(mission?.objective).toBe("updated objective");
		} finally {
			store.close();
		}
	});

	test("uses provided missionId instead of reading pointer file", async () => {
		// Create two missions; pointer points to m-005
		await setupMission("m-004", "slug-four", "objective four");
		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		store.create({ id: "m-005", slug: "slug-five", objective: "objective five" });
		store.close();
		// Pointer points to m-005
		await Bun.write(join(overstoryDir, "current-mission.txt"), "m-005\n");

		// But we explicitly target m-004 via missionId
		await missionUpdate(overstoryDir, { slug: "targeted-slug", missionId: "m-004" });

		const verifyStore = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			expect(verifyStore.getById("m-004")?.slug).toBe("targeted-slug");
			// m-005 should be unchanged
			expect(verifyStore.getById("m-005")?.slug).toBe("slug-five");
		} finally {
			verifyStore.close();
		}
	});

	test("sets exitCode=1 and returns early when neither slug nor objective provided", async () => {
		await setupMission("m-006", "slug-six", "objective six");

		// Reset exitCode before the call
		process.exitCode = 0;
		await missionUpdate(overstoryDir, {});
		expect(process.exitCode).toBe(1);

		// Cleanup exitCode so subsequent tests are not affected
		process.exitCode = 0;
	});

	test("sets exitCode=1 when no active mission pointer exists", async () => {
		// No pointer file written — resolveCurrentMissionId returns null
		process.exitCode = 0;
		await missionUpdate(overstoryDir, { slug: "any-slug" });
		expect(process.exitCode).toBe(1);

		process.exitCode = 0;
	});
});
