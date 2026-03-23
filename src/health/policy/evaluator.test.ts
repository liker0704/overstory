import { describe, expect, test } from "bun:test";
import type { HealthScore } from "../types.ts";
import { evaluatePolicy } from "./evaluator.ts";
import type { PolicyActionRecord, PolicyRule } from "./types.ts";

function makeScore(
	overallGrade: "A" | "B" | "C" | "D" | "F",
	factors: { name: string; score: number }[],
): HealthScore {
	return {
		overall: 75,
		grade: overallGrade,
		factors: factors.map((f) => ({
			name: f.name,
			label: f.name,
			score: f.score,
			weight: 0.1,
			contribution: f.score * 0.1,
			details: "",
		})),
		collectedAt: new Date().toISOString(),
		signals: {} as HealthScore["signals"],
	};
}

function makeRule(id: string, overrides: Partial<PolicyRule> = {}): PolicyRule {
	return {
		id,
		action: "pause_spawning",
		condition: { factor: "completion_rate", threshold: 50, operator: "lt" },
		cooldownMs: 60_000,
		priority: "medium",
		...overrides,
	};
}

function makeRecord(
	ruleId: string,
	overrides: Partial<PolicyActionRecord> = {},
): PolicyActionRecord {
	return {
		action: "pause_spawning",
		ruleId,
		triggered: true,
		suppressed: false,
		dryRun: false,
		details: "",
		timestamp: new Date(Date.now() - 10_000).toISOString(),
		...overrides,
	};
}

describe("evaluatePolicy", () => {
	test("factor condition lt triggers when score is below threshold", () => {
		const score = makeScore("B", [{ name: "completion_rate", score: 30 }]);
		const rule = makeRule("r1", {
			condition: { factor: "completion_rate", threshold: 50, operator: "lt" },
		});
		const result = evaluatePolicy(score, [rule], [], { dryRun: false });
		expect(result.evaluations[0]?.triggered).toBe(true);
	});

	test("factor condition gt triggers when score is above threshold", () => {
		const score = makeScore("A", [{ name: "completion_rate", score: 90 }]);
		const rule = makeRule("r2", {
			action: "resume_spawning",
			condition: { factor: "completion_rate", threshold: 80, operator: "gt" },
		});
		const result = evaluatePolicy(score, [rule], [], { dryRun: false });
		expect(result.evaluations[0]?.triggered).toBe(true);
	});

	test("grade condition triggers when grade matches operator", () => {
		const score = makeScore("D", []);
		const rule = makeRule("r3", { condition: { grade: "C", operator: "lt" } });
		const result = evaluatePolicy(score, [rule], [], { dryRun: false });
		expect(result.evaluations[0]?.triggered).toBe(true);
	});

	test("rule not triggered when condition not met", () => {
		const score = makeScore("A", [{ name: "completion_rate", score: 80 }]);
		const rule = makeRule("r4", {
			condition: { factor: "completion_rate", threshold: 50, operator: "lt" },
		});
		const result = evaluatePolicy(score, [rule], [], { dryRun: false });
		expect(result.evaluations[0]?.triggered).toBe(false);
	});

	test("suppression: recently executed rule is suppressed within cooldown", () => {
		const score = makeScore("D", [{ name: "completion_rate", score: 20 }]);
		const rule = makeRule("r5", { cooldownMs: 60_000 });
		const history = [makeRecord("r5", { timestamp: new Date(Date.now() - 5_000).toISOString() })];
		const result = evaluatePolicy(score, [rule], history, { dryRun: false });
		const ev = result.evaluations[0];
		expect(ev).toBeDefined();
		if (!ev) return;
		expect(ev.triggered).toBe(true);
		expect(ev.suppressed).toBe(true);
		expect(ev.suppressReason).toMatch(/cooldown:/);
	});

	test("suppression: rule is NOT suppressed after cooldown expires", () => {
		const score = makeScore("D", [{ name: "completion_rate", score: 20 }]);
		const rule = makeRule("r6", { cooldownMs: 1_000 });
		const history = [makeRecord("r6", { timestamp: new Date(Date.now() - 10_000).toISOString() })];
		const result = evaluatePolicy(score, [rule], history, { dryRun: false });
		const ev = result.evaluations[0];
		expect(ev).toBeDefined();
		if (!ev) return;
		expect(ev.triggered).toBe(true);
		expect(ev.suppressed).toBe(false);
	});

	test("suppression: dry-run records do not count for suppression", () => {
		const score = makeScore("D", [{ name: "completion_rate", score: 20 }]);
		const rule = makeRule("r7", { cooldownMs: 60_000 });
		const history = [
			makeRecord("r7", { dryRun: true, timestamp: new Date(Date.now() - 5_000).toISOString() }),
		];
		const result = evaluatePolicy(score, [rule], history, { dryRun: false });
		const ev = result.evaluations[0];
		expect(ev).toBeDefined();
		if (!ev) return;
		expect(ev.suppressed).toBe(false);
	});

	test("suppression: suppressed records do not count for suppression", () => {
		const score = makeScore("D", [{ name: "completion_rate", score: 20 }]);
		const rule = makeRule("r8", { cooldownMs: 60_000 });
		const history = [
			makeRecord("r8", { suppressed: true, timestamp: new Date(Date.now() - 5_000).toISOString() }),
		];
		const result = evaluatePolicy(score, [rule], history, { dryRun: false });
		const ev = result.evaluations[0];
		expect(ev).toBeDefined();
		if (!ev) return;
		expect(ev.suppressed).toBe(false);
	});

	test("multiple rules: some trigger, some don't", () => {
		const score = makeScore("C", [
			{ name: "completion_rate", score: 30 },
			{ name: "merge_quality", score: 90 },
		]);
		const rules = [
			makeRule("low", { condition: { factor: "completion_rate", threshold: 50, operator: "lt" } }),
			makeRule("high", { condition: { factor: "merge_quality", threshold: 50, operator: "lt" } }),
		];
		const result = evaluatePolicy(score, rules, [], { dryRun: false });
		expect(result.evaluations[0]?.triggered).toBe(true);
		expect(result.evaluations[1]?.triggered).toBe(false);
	});

	test("empty rules array returns empty evaluations", () => {
		const score = makeScore("A", []);
		const result = evaluatePolicy(score, [], [], { dryRun: false });
		expect(result.evaluations).toHaveLength(0);
	});

	test("unknown factor name: condition does not match (triggered = false)", () => {
		const score = makeScore("B", [{ name: "completion_rate", score: 20 }]);
		const rule = makeRule("r9", {
			condition: { factor: "nonexistent_factor", threshold: 50, operator: "lt" },
		});
		const result = evaluatePolicy(score, [rule], [], { dryRun: false });
		expect(result.evaluations[0]?.triggered).toBe(false);
	});
});
