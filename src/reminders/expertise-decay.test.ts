import { describe, expect, it } from "bun:test";
import { expertiseDecayPolicy } from "./expertise-decay.ts";
import type { MulchSignals, TemporalSignals } from "./types.ts";

function emptySignals(): TemporalSignals {
	return {
		recentSessions: [],
		recentMessages: [],
		recentEvents: [],
		collectedAt: new Date().toISOString(),
	};
}

function withMulch(staleCounts: MulchSignals["staleCounts"]): TemporalSignals {
	return {
		...emptySignals(),
		mulchSignals: {
			domains: [],
			staleCounts,
			recordsWithOutcomes: [],
		},
	};
}

describe("expertiseDecayPolicy", () => {
	it("returns [] when no mulchSignals", () => {
		expect(expertiseDecayPolicy.evaluate(emptySignals())).toEqual([]);
	});

	it("returns [] when all domains are below threshold", () => {
		const signals = withMulch([{ domain: "typescript", before: 100, pruned: 20, after: 80 }]);
		// ratio = 0.2, below default 0.3
		expect(expertiseDecayPolicy.evaluate(signals)).toEqual([]);
	});

	it("returns [] when before is 0", () => {
		const signals = withMulch([{ domain: "typescript", before: 0, pruned: 0, after: 0 }]);
		expect(expertiseDecayPolicy.evaluate(signals)).toEqual([]);
	});

	it("returns recommendation when ratio exceeds threshold", () => {
		const signals = withMulch([{ domain: "typescript", before: 100, pruned: 40, after: 60 }]);
		// ratio = 0.4, above default 0.3
		const results = expertiseDecayPolicy.evaluate(signals);
		expect(results).toHaveLength(1);
		expect(results[0]?.factor).toBe("reminder_expertise_decay");
		expect(results[0]?.source).toBe("temporal-reminders");
		expect(results[0]?.priority).toBe("medium"); // 0.4 <= 0.5
	});

	it("uses high priority when ratio exceeds 0.5", () => {
		const signals = withMulch([{ domain: "typescript", before: 100, pruned: 60, after: 40 }]);
		// ratio = 0.6, above 0.5
		const results = expertiseDecayPolicy.evaluate(signals);
		expect(results).toHaveLength(1);
		expect(results[0]?.priority).toBe("high");
	});

	it("returns one recommendation per decayed domain", () => {
		const signals = withMulch([
			{ domain: "typescript", before: 100, pruned: 60, after: 40 },
			{ domain: "cli", before: 50, pruned: 20, after: 30 },
			{ domain: "missions", before: 10, pruned: 1, after: 9 }, // below threshold
		]);
		const results = expertiseDecayPolicy.evaluate(signals);
		expect(results).toHaveLength(2);
	});

	it("custom threshold is respected", () => {
		const signals = withMulch([{ domain: "typescript", before: 100, pruned: 40, after: 60 }]);
		// ratio = 0.4, with threshold=0.5 should NOT fire
		const results = expertiseDecayPolicy.evaluate(signals, { expertiseDecayThreshold: 0.5 });
		expect(results).toHaveLength(0);

		// with threshold=0.3 should fire
		const results2 = expertiseDecayPolicy.evaluate(signals, { expertiseDecayThreshold: 0.3 });
		expect(results2).toHaveLength(1);
	});
});
