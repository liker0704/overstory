import { describe, expect, it } from "bun:test";
import { domainCoveragePolicy } from "./domain-coverage.ts";
import type { MulchSignals, TemporalSignals } from "./types.ts";

function makeSignals(
	domains: MulchSignals["domains"],
	collectedAt: string = new Date().toISOString(),
): TemporalSignals {
	return {
		recentSessions: [],
		recentMessages: [],
		recentEvents: [],
		collectedAt,
		mulchSignals: {
			domains,
			staleCounts: [],
			recordsWithOutcomes: [],
		},
	};
}

describe("domainCoveragePolicy", () => {
	it("returns [] when no mulchSignals", () => {
		const signals: TemporalSignals = {
			recentSessions: [],
			recentMessages: [],
			recentEvents: [],
			collectedAt: new Date().toISOString(),
		};
		expect(domainCoveragePolicy.evaluate(signals)).toEqual([]);
	});

	it("returns [] when all domains updated within lookback window", () => {
		const now = new Date();
		const signals = makeSignals(
			[
				{
					name: "typescript",
					recordCount: 50,
					lastUpdated: new Date(now.getTime() - 3600000).toISOString(),
				},
			],
			now.toISOString(),
		);
		// lastUpdated 1h ago, default lookback 24h → not stale
		expect(domainCoveragePolicy.evaluate(signals)).toHaveLength(0);
	});

	it("returns recommendation for stale domain", () => {
		const now = new Date();
		const signals = makeSignals(
			[
				{
					name: "typescript",
					recordCount: 50,
					lastUpdated: new Date(now.getTime() - 86400001).toISOString(),
				},
			],
			now.toISOString(),
		);
		// lastUpdated just over 24h ago
		const results = domainCoveragePolicy.evaluate(signals);
		expect(results).toHaveLength(1);
		expect(results[0]?.factor).toBe("reminder_domain_coverage");
		expect(results[0]?.source).toBe("temporal-reminders");
		expect(results[0]?.priority).toBe("low");
	});

	it("returns one recommendation per stale domain", () => {
		const now = new Date();
		const signals = makeSignals(
			[
				{
					name: "typescript",
					recordCount: 50,
					lastUpdated: new Date(now.getTime() - 90000000).toISOString(),
				},
				{
					name: "cli",
					recordCount: 20,
					lastUpdated: new Date(now.getTime() - 3600000).toISOString(),
				},
				{
					name: "missions",
					recordCount: 10,
					lastUpdated: new Date(now.getTime() - 90000000).toISOString(),
				},
			],
			now.toISOString(),
		);
		const results = domainCoveragePolicy.evaluate(signals);
		expect(results).toHaveLength(2);
	});

	it("custom lookbackWindowMs is respected", () => {
		const now = new Date();
		const signals = makeSignals(
			[
				{
					name: "typescript",
					recordCount: 50,
					lastUpdated: new Date(now.getTime() - 7200000).toISOString(), // 2h ago
				},
			],
			now.toISOString(),
		);
		// With 1h window, 2h old domain should fire
		const results = domainCoveragePolicy.evaluate(signals, { lookbackWindowMs: 3600000 });
		expect(results).toHaveLength(1);

		// With 3h window, should NOT fire
		const results2 = domainCoveragePolicy.evaluate(signals, { lookbackWindowMs: 10800000 });
		expect(results2).toHaveLength(0);
	});
});
