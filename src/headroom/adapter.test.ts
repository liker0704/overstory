import { describe, expect, test } from "bun:test";
import type { AgentRuntime } from "../runtimes/types.ts";
import { pollHeadroom } from "./adapter.ts";
import type { HeadroomSnapshot, HeadroomStore } from "./types.ts";

function makeSnapshot(runtime: string, overrides?: Partial<HeadroomSnapshot>): HeadroomSnapshot {
	return {
		runtime,
		state: "exact",
		capturedAt: new Date().toISOString(),
		requestsRemaining: 100,
		requestsLimit: 1000,
		tokensRemaining: 50000,
		tokensLimit: 100000,
		windowResetsAt: null,
		message: "test",
		...overrides,
	};
}

function makeMockStore(): HeadroomStore & { upserted: HeadroomSnapshot[] } {
	const upserted: HeadroomSnapshot[] = [];
	return {
		upserted,
		upsert(snapshot: HeadroomSnapshot) {
			upserted.push(snapshot);
		},
		get() {
			return null;
		},
		getAll() {
			return [];
		},
		pruneOlderThan() {
			return 0;
		},
		close() {},
	};
}

function makeMockRuntime(id: string, snapshot?: HeadroomSnapshot): AgentRuntime {
	const base = {
		id,
		stability: "stable" as const,
		instructionPath: ".claude/CLAUDE.md",
		buildSpawnCommand: () => "",
		buildPrintCommand: () => [],
		deployConfig: async () => {},
		detectReady: () => ({ phase: "ready" as const }),
		parseTranscript: async () => null,
		getTranscriptDir: () => null,
		buildEnv: () => ({}),
	};
	if (snapshot) {
		return { ...base, queryHeadroom: async () => snapshot };
	}
	return base;
}

describe("pollHeadroom", () => {
	test("calls queryHeadroom on runtimes that implement it", async () => {
		const snapshot = makeSnapshot("claude");
		const store = makeMockStore();
		const rt = makeMockRuntime("claude", snapshot);

		const results = await pollHeadroom({ store, runtimes: [rt] });
		expect(results).toHaveLength(1);
		expect(results[0]?.runtime).toBe("claude");
	});

	test("skips runtimes without queryHeadroom", async () => {
		const store = makeMockStore();
		const rt = makeMockRuntime("codex"); // no queryHeadroom

		const results = await pollHeadroom({ store, runtimes: [rt] });
		expect(results).toHaveLength(0);
		expect(store.upserted).toHaveLength(0);
	});

	test("upserts results into store", async () => {
		const snapshot = makeSnapshot("claude");
		const store = makeMockStore();
		const rt = makeMockRuntime("claude", snapshot);

		await pollHeadroom({ store, runtimes: [rt] });
		expect(store.upserted).toHaveLength(1);
		expect(store.upserted[0]?.runtime).toBe("claude");
	});

	test("handles individual runtime errors gracefully", async () => {
		const store = makeMockStore();
		const failRt: AgentRuntime = {
			...makeMockRuntime("fail"),
			queryHeadroom: async () => {
				throw new Error("boom");
			},
		};
		const goodSnapshot = makeSnapshot("claude");
		const goodRt = makeMockRuntime("claude", goodSnapshot);

		const results = await pollHeadroom({ store, runtimes: [failRt, goodRt] });
		expect(results).toHaveLength(1);
		expect(results[0]?.runtime).toBe("claude");
	});

	test("handles empty runtimes array", async () => {
		const store = makeMockStore();
		const results = await pollHeadroom({ store, runtimes: [] });
		expect(results).toHaveLength(0);
	});

	test("queries multiple runtimes in parallel", async () => {
		const store = makeMockStore();
		const rt1 = makeMockRuntime("claude", makeSnapshot("claude"));
		const rt2 = makeMockRuntime("pi", makeSnapshot("pi"));

		const results = await pollHeadroom({ store, runtimes: [rt1, rt2] });
		expect(results).toHaveLength(2);
		expect(store.upserted).toHaveLength(2);
	});
});
