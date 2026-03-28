import { describe, expect, it } from "bun:test";
import { confirmationTrendPolicy } from "./confirmation-trend.ts";
import type { MulchSignals, TemporalSignals } from "./types.ts";

function emptySignals(): TemporalSignals {
	return {
		recentSessions: [],
		recentMessages: [],
		recentEvents: [],
		collectedAt: new Date().toISOString(),
	};
}

function withMulch(recordsWithOutcomes: MulchSignals["recordsWithOutcomes"]): TemporalSignals {
	return {
		...emptySignals(),
		mulchSignals: {
			domains: [],
			staleCounts: [],
			recordsWithOutcomes,
		},
	};
}

describe("confirmationTrendPolicy", () => {
	it("returns [] when no mulchSignals", () => {
		expect(confirmationTrendPolicy.evaluate(emptySignals())).toEqual([]);
	});

	it("returns [] when below minimum failure count", () => {
		// outcomeCount=3, successRate=0.33 → failures=2 which meets threshold, but let's test count=1
		const signals = withMulch([
			{
				domain: "typescript",
				classification: "convention",
				outcomeCount: 1,
				successRate: 0.0,
				lastOutcomeAt: null,
			},
		]);
		// failures = 1, minFailures default = 2 → should NOT fire
		const results = confirmationTrendPolicy.evaluate(signals);
		expect(results).toHaveLength(0);
	});

	it("returns [] when success rate is above minimum", () => {
		const signals = withMulch([
			{
				domain: "typescript",
				classification: "convention",
				outcomeCount: 10,
				successRate: 0.8,
				lastOutcomeAt: null,
			},
		]);
		expect(confirmationTrendPolicy.evaluate(signals)).toHaveLength(0);
	});

	it("returns recommendation when threshold breached", () => {
		const signals = withMulch([
			{
				domain: "typescript",
				classification: "convention",
				outcomeCount: 10,
				successRate: 0.2,
				lastOutcomeAt: null,
			},
		]);
		// failures = 8, successRate 0.2 < 0.4
		const results = confirmationTrendPolicy.evaluate(signals);
		expect(results).toHaveLength(1);
		expect(results[0]?.factor).toBe("reminder_confirmation_trend");
		expect(results[0]?.source).toBe("temporal-reminders");
		expect(results[0]?.priority).toBe("medium"); // successRate != 0
	});

	it("uses high priority when success rate is 0", () => {
		const signals = withMulch([
			{
				domain: "cli",
				classification: "pattern",
				outcomeCount: 5,
				successRate: 0.0,
				lastOutcomeAt: null,
			},
		]);
		const results = confirmationTrendPolicy.evaluate(signals);
		expect(results).toHaveLength(1);
		expect(results[0]?.priority).toBe("high");
	});

	it("custom config is respected", () => {
		const signals = withMulch([
			{
				domain: "typescript",
				classification: "convention",
				outcomeCount: 10,
				successRate: 0.3,
				lastOutcomeAt: null,
			},
		]);
		// With minSuccessRate=0.2, should NOT fire (0.3 >= 0.2)
		const results = confirmationTrendPolicy.evaluate(signals, {
			confirmationTrendMinSuccessRate: 0.2,
		});
		expect(results).toHaveLength(0);

		// With minFailures=10, failures=7, should NOT fire
		const results2 = confirmationTrendPolicy.evaluate(signals, {
			confirmationTrendMinFailures: 10,
		});
		expect(results2).toHaveLength(0);
	});
});
