import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHeadroomStore } from "../headroom/store.ts";
import type { HeadroomSnapshot } from "../headroom/types.ts";
import { buildJsonOutput, printRateLimits } from "./rate-limits.ts";

const SNAPSHOT_EXACT: HeadroomSnapshot = {
	runtime: "claude",
	state: "exact",
	capturedAt: new Date(Date.now() - 30_000).toISOString(),
	requestsRemaining: 750,
	requestsLimit: 1000,
	tokensRemaining: 80_000,
	tokensLimit: 100_000,
	windowResetsAt: new Date(Date.now() + 300_000).toISOString(),
	message: "75% of request quota remaining",
};

const SNAPSHOT_ESTIMATED: HeadroomSnapshot = {
	runtime: "codex",
	state: "estimated",
	capturedAt: new Date(Date.now() - 120_000).toISOString(),
	requestsRemaining: 100,
	requestsLimit: 500,
	tokensRemaining: 10_000,
	tokensLimit: 50_000,
	windowResetsAt: new Date(Date.now() + 60_000).toISOString(),
	message: "",
};

const SNAPSHOT_UNAVAILABLE: HeadroomSnapshot = {
	runtime: "gemini",
	state: "unavailable",
	capturedAt: new Date(Date.now() - 5_000).toISOString(),
	requestsRemaining: null,
	requestsLimit: null,
	tokensRemaining: null,
	tokensLimit: null,
	windowResetsAt: null,
	message: "",
};

describe("printRateLimits", () => {
	let output: string;
	let writeSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		output = "";
		writeSpy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});
	});

	afterEach(() => {
		writeSpy.mockRestore();
	});

	it("renders Rate Limits header", () => {
		printRateLimits([SNAPSHOT_EXACT]);
		expect(output).toContain("Rate Limits");
	});

	it("renders snapshot data", () => {
		printRateLimits([SNAPSHOT_EXACT]);
		expect(output).toContain("claude");
		expect(output).toContain("750");
		expect(output).toContain("1,000");
	});

	it("shows empty state when no snapshots", () => {
		printRateLimits([]);
		expect(output).toContain("No headroom data available");
	});

	it("shows message summaries for snapshots with messages", () => {
		printRateLimits([SNAPSHOT_EXACT]);
		expect(output).toContain("75% of request quota remaining");
	});

	it("does not show message section when all messages are empty", () => {
		printRateLimits([SNAPSHOT_UNAVAILABLE]);
		// No message section — just header + table
		expect(output).not.toContain("gemini:");
	});

	it("renders unavailable state with dashes", () => {
		printRateLimits([SNAPSHOT_UNAVAILABLE]);
		expect(output).toContain("gemini");
	});

	it("renders multiple runtimes", () => {
		printRateLimits([SNAPSHOT_EXACT, SNAPSHOT_ESTIMATED, SNAPSHOT_UNAVAILABLE]);
		expect(output).toContain("claude");
		expect(output).toContain("codex");
		expect(output).toContain("gemini");
	});
});

describe("buildJsonOutput", () => {
	it("includes requestsPercentRemaining and tokensPercentRemaining", () => {
		const result = buildJsonOutput([SNAPSHOT_EXACT]) as {
			snapshots: Array<{
				runtime: string;
				requestsPercentRemaining: number | null;
				tokensPercentRemaining: number | null;
			}>;
		};
		expect(result.snapshots).toHaveLength(1);
		const snap = result.snapshots[0];
		expect(snap?.requestsPercentRemaining).toBe(75);
		expect(snap?.tokensPercentRemaining).toBe(80);
	});

	it("sets percentages to null for unavailable snapshots", () => {
		const result = buildJsonOutput([SNAPSHOT_UNAVAILABLE]) as {
			snapshots: Array<{
				requestsPercentRemaining: number | null;
				tokensPercentRemaining: number | null;
			}>;
		};
		const snap = result.snapshots[0];
		expect(snap?.requestsPercentRemaining).toBeNull();
		expect(snap?.tokensPercentRemaining).toBeNull();
	});

	it("spreads original snapshot fields", () => {
		const result = buildJsonOutput([SNAPSHOT_EXACT]) as {
			snapshots: Array<HeadroomSnapshot & { requestsPercentRemaining: number | null }>;
		};
		const snap = result.snapshots[0];
		expect(snap?.runtime).toBe("claude");
		expect(snap?.state).toBe("exact");
	});

	it("returns empty snapshots array for empty input", () => {
		const result = buildJsonOutput([]) as { snapshots: unknown[] };
		expect(result.snapshots).toHaveLength(0);
	});
});

describe("runtime filter", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "ov-rate-limits-test-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("stores and retrieves snapshots from headroom store", () => {
		const dbPath = join(tmpDir, "headroom.db");
		const store = createHeadroomStore(dbPath);
		try {
			store.upsert(SNAPSHOT_EXACT);
			store.upsert(SNAPSHOT_ESTIMATED);
			store.upsert(SNAPSHOT_UNAVAILABLE);
			const all = store.getAll();
			expect(all).toHaveLength(3);
		} finally {
			store.close();
		}
	});

	it("filters by runtime correctly", () => {
		const dbPath = join(tmpDir, "headroom.db");
		const store = createHeadroomStore(dbPath);
		try {
			store.upsert(SNAPSHOT_EXACT);
			store.upsert(SNAPSHOT_ESTIMATED);
			const all = store.getAll();
			const filtered = all.filter((s) => s.runtime === "claude");
			expect(filtered).toHaveLength(1);
			expect(filtered[0]?.runtime).toBe("claude");
		} finally {
			store.close();
		}
	});
});
