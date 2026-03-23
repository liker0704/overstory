import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import type { MergeEntry } from "../merge/types.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import { createSurfaceCache, runCompatGate } from "./gate.ts";
import type {
	CompatConfig,
	CompatibilityResult,
	TypeSurface,
} from "./types.ts";

// --- Test fixtures ---

function makeSurface(
	ref: string,
	symbols: TypeSurface["symbols"] = [],
): TypeSurface {
	return { ref, symbols, extractedAt: new Date().toISOString() };
}

function makeCompatResult(compatible: boolean): CompatibilityResult {
	return {
		compatible,
		changes: compatible
			? []
			: [
					{
						kind: "removed",
						symbol: {
							name: "MyFunc",
							kind: "function",
							signature: "(x: number) => void",
							filePath: "src/foo.ts",
							line: 1,
						},
						severity: "breaking",
					},
				],
		branchA: "main",
		branchB: "feature",
		summary: compatible
			? "No changes detected."
			: "1 breaking change. Surfaces are incompatible.",
		staticOnly: true,
		analyzedAt: new Date().toISOString(),
	};
}

function makeEntry(filesModified: string[] = ["src/foo.ts"]): MergeEntry {
	return {
		branchName: "overstory/agent/task-123",
		taskId: "task-123",
		agentName: "agent",
		filesModified,
		enqueuedAt: new Date().toISOString(),
		status: "pending",
		resolvedTier: null,
		compatReportPath: null,
	};
}

const DEFAULT_CONFIG: CompatConfig = {
	enabled: true,
	skipPatterns: [],
	aiThreshold: 3,
	strictMode: false,
};

/** Noop deps: no git, mock surface extraction and analysis. */
function makeDeps(compatible = true) {
	return {
		extractSurface: async (_r: string, ref: string, _p: string[]) =>
			makeSurface(ref),
		analyze: async () => makeCompatResult(compatible),
		gitRevParse: async () => "abc123sha",
	};
}

// ---

describe("runCompatGate", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "compat-gate-test-"));
	});

	afterEach(async () => {
		await cleanupTempDir(tmpDir);
	});

	test("gate disabled → always admit", async () => {
		const config: CompatConfig = { ...DEFAULT_CONFIG, enabled: false };
		const decision = await runCompatGate("/repo", makeEntry(), "main", config, {
			_deps: {
				extractSurface: async () => {
					throw new Error("should not be called");
				},
				analyze: async () => {
					throw new Error("should not be called");
				},
				gitRevParse: async () => {
					throw new Error("should not be called");
				},
			},
		});
		expect(decision.action).toBe("admit");
		expect(decision.reason).toBe("compat gate disabled");
	});

	test("all files match skip patterns → admit without analysis", async () => {
		const config: CompatConfig = {
			...DEFAULT_CONFIG,
			skipPatterns: [".overstory/**", ".seeds/**"],
		};
		const entry = makeEntry([".overstory/config.yaml", ".seeds/task.md"]);
		const decision = await runCompatGate("/repo", entry, "main", config, {
			_deps: {
				extractSurface: async () => {
					throw new Error("should not be called");
				},
				analyze: async () => {
					throw new Error("should not be called");
				},
				gitRevParse: async () => {
					throw new Error("should not be called");
				},
			},
		});
		expect(decision.action).toBe("admit");
		expect(decision.reason).toBe("all modified files match skip patterns");
	});

	test("compatible branches → admit", async () => {
		const decision = await runCompatGate(
			"/repo",
			makeEntry(),
			"main",
			DEFAULT_CONFIG,
			{
				_deps: makeDeps(true),
			},
		);
		expect(decision.action).toBe("admit");
		expect(decision.result.compatible).toBe(true);
	});

	test("incompatible branches in strict mode → reject", async () => {
		const config: CompatConfig = { ...DEFAULT_CONFIG, strictMode: true };
		const decision = await runCompatGate("/repo", makeEntry(), "main", config, {
			_deps: makeDeps(false),
		});
		expect(decision.action).toBe("reject");
		expect(decision.result.compatible).toBe(false);
	});

	test("incompatible branches in non-strict mode → defer", async () => {
		const decision = await runCompatGate(
			"/repo",
			makeEntry(),
			"main",
			DEFAULT_CONFIG,
			{
				_deps: makeDeps(false),
			},
		);
		expect(decision.action).toBe("defer");
		expect(decision.result.compatible).toBe(false);
	});

	test("partial skip pattern match does not skip analysis", async () => {
		// Only one of two files matches skip pattern → analysis proceeds
		const config: CompatConfig = {
			...DEFAULT_CONFIG,
			skipPatterns: [".overstory/**"],
		};
		const entry = makeEntry([".overstory/config.yaml", "src/index.ts"]);
		let analyzeWasCalled = false;
		const decision = await runCompatGate("/repo", entry, "main", config, {
			_deps: {
				...makeDeps(true),
				analyze: async () => {
					analyzeWasCalled = true;
					return makeCompatResult(true);
				},
			},
		});
		expect(analyzeWasCalled).toBe(true);
		expect(decision.action).toBe("admit");
	});

	test("canonical surface cache hit on second call", async () => {
		const surfaceCache = createSurfaceCache();
		let extractCallCount = 0;
		const deps = {
			...makeDeps(true),
			extractSurface: async (_r: string, ref: string, _p: string[]) => {
				extractCallCount++;
				return makeSurface(ref);
			},
		};

		// First call: canonical + branch = 2 extract calls
		await runCompatGate(
			"/repo",
			makeEntry(["src/a.ts"]),
			"main",
			DEFAULT_CONFIG,
			{
				surfaceCache,
				_deps: deps,
			},
		);
		expect(extractCallCount).toBe(2); // canonical + branch

		// Second call: canonical should come from cache, only branch extracted
		const entry2 = {
			...makeEntry(["src/b.ts"]),
			branchName: "overstory/agent/task-456",
		};
		await runCompatGate("/repo", entry2, "main", DEFAULT_CONFIG, {
			surfaceCache,
			_deps: deps,
		});
		expect(extractCallCount).toBe(3); // +1 for branch only
	});

	test("gate decision event emitted to events.db", async () => {
		const eventsDbPath = join(tmpDir, "events.db");
		const preStore = createEventStore(eventsDbPath);
		preStore.close();

		const decision = await runCompatGate(
			"/repo",
			makeEntry(),
			"main",
			DEFAULT_CONFIG,
			{
				eventsDbPath,
				_deps: makeDeps(true),
			},
		);

		const db = new Database(eventsDbPath, { readonly: true });
		const rows = db
			.prepare(
				"SELECT event_type, level, data FROM events WHERE event_type = 'custom'",
			)
			.all() as Array<{ event_type: string; level: string; data: string }>;
		db.close();

		expect(rows.length).toBeGreaterThan(0);
		const row = rows[0];
		expect(row).toBeDefined();
		if (row) {
			expect(row.event_type).toBe("custom");
			expect(row.level).toBe("info");
			const parsed = JSON.parse(row.data) as { action: string };
			expect(parsed.action).toBe(decision.action);
		}
	});

	test("reject action emits warn level event", async () => {
		const eventsDbPath = join(tmpDir, "events-warn.db");
		const preStore = createEventStore(eventsDbPath);
		preStore.close();

		await runCompatGate(
			"/repo",
			makeEntry(),
			"main",
			{ ...DEFAULT_CONFIG, strictMode: true },
			{
				eventsDbPath,
				_deps: makeDeps(false),
			},
		);

		const db = new Database(eventsDbPath, { readonly: true });
		const rows = db
			.prepare("SELECT level FROM events WHERE event_type = 'custom'")
			.all() as Array<{ level: string }>;
		db.close();

		expect(rows.length).toBeGreaterThan(0);
		const row = rows[0];
		if (row) {
			expect(row.level).toBe("warn");
		}
	});
});
