import { describe, expect, it } from "bun:test";
import {
	type PolicyStatusInfo,
	renderPolicyEvaluation,
	renderPolicyHistory,
	renderPolicyStatus,
} from "./render.ts";
import type { PolicyActionRecord, PolicyEvaluationResult } from "./types.ts";

// === Fixtures ===

const baseScore = {
	overall: 72,
	grade: "B" as const,
	collectedAt: "2024-01-01T12:00:00.000Z",
	factors: [],
	signals: {} as never,
};

const baseRule = {
	id: "pause-on-low-score",
	action: "pause_spawning" as const,
	condition: { factor: "completion_rate", threshold: 50, operator: "lt" as const },
	cooldownMs: 60000,
	priority: "high" as const,
};

// === renderPolicyEvaluation ===

describe("renderPolicyEvaluation", () => {
	it("renders empty evaluations", () => {
		const result: PolicyEvaluationResult = {
			evaluations: [],
			score: baseScore,
			timestamp: "2024-01-01T12:00:00.000Z",
		};
		const out = renderPolicyEvaluation(result);
		expect(out).toContain("Policy Evaluation");
		expect(out).toContain("72/100");
		expect(out).toContain("Total: 0");
	});

	it("renders triggered dry-run rule", () => {
		const result: PolicyEvaluationResult = {
			evaluations: [
				{
					rule: baseRule,
					triggered: true,
					suppressed: false,
					dryRun: true,
				},
			],
			score: baseScore,
			timestamp: "2024-01-01T12:00:00.000Z",
		};
		const out = renderPolicyEvaluation(result);
		expect(out).toContain("DRY-RUN");
		expect(out).toContain("pause-on-low-score");
		expect(out).toContain("pause_spawning");
		expect(out).toContain("Triggered: 1");
		expect(out).toContain("Dry-run: 1");
	});

	it("renders suppressed rule with suppress reason", () => {
		const result: PolicyEvaluationResult = {
			evaluations: [
				{
					rule: baseRule,
					triggered: true,
					suppressed: true,
					suppressReason: "cooldown: 30000ms remaining",
					dryRun: false,
				},
			],
			score: baseScore,
			timestamp: "2024-01-01T12:00:00.000Z",
		};
		const out = renderPolicyEvaluation(result);
		expect(out).toContain("SUPPRESSED");
		expect(out).toContain("cooldown: 30000ms remaining");
		expect(out).toContain("Suppressed: 1");
	});

	it("renders executed rule", () => {
		const result: PolicyEvaluationResult = {
			evaluations: [
				{
					rule: baseRule,
					triggered: true,
					suppressed: false,
					dryRun: false,
				},
			],
			score: baseScore,
			timestamp: "2024-01-01T12:00:00.000Z",
		};
		const out = renderPolicyEvaluation(result);
		expect(out).toContain("EXECUTED");
		expect(out).toContain("Executed: 1");
	});

	it("renders skipped rule", () => {
		const result: PolicyEvaluationResult = {
			evaluations: [
				{
					rule: baseRule,
					triggered: false,
					suppressed: false,
					dryRun: true,
				},
			],
			score: baseScore,
			timestamp: "2024-01-01T12:00:00.000Z",
		};
		const out = renderPolicyEvaluation(result);
		expect(out).toContain("SKIP");
		expect(out).toContain("Skipped Rules (1)");
	});

	it("renders mixed triggered/suppressed/dry-run", () => {
		const result: PolicyEvaluationResult = {
			evaluations: [
				{ rule: baseRule, triggered: true, suppressed: false, dryRun: true },
				{
					rule: { ...baseRule, id: "rule-2" },
					triggered: true,
					suppressed: true,
					suppressReason: "cooldown: 5000ms remaining",
					dryRun: false,
				},
				{ rule: { ...baseRule, id: "rule-3" }, triggered: false, suppressed: false, dryRun: true },
			],
			score: baseScore,
			timestamp: "2024-01-01T12:00:00.000Z",
		};
		const out = renderPolicyEvaluation(result);
		expect(out).toContain("DRY-RUN");
		expect(out).toContain("SUPPRESSED");
		expect(out).toContain("SKIP");
		expect(out).toContain("Triggered: 2");
		expect(out).toContain("Dry-run: 1");
		expect(out).toContain("Suppressed: 1");
	});
});

// === renderPolicyHistory ===

describe("renderPolicyHistory", () => {
	it("renders empty history", () => {
		const out = renderPolicyHistory([]);
		expect(out).toContain("Policy Action History");
		expect(out).toContain("No policy actions recorded.");
	});

	it("renders records with various types", () => {
		const records: PolicyActionRecord[] = [
			{
				action: "pause_spawning",
				ruleId: "rule-1",
				triggered: true,
				suppressed: false,
				dryRun: false,
				details: "executed: pause_spawning",
				timestamp: "2024-01-01T10:00:00.000Z",
			},
			{
				action: "resume_spawning",
				ruleId: "rule-2",
				triggered: true,
				suppressed: true,
				dryRun: false,
				details: "suppressed: cooldown",
				timestamp: "2024-01-01T11:00:00.000Z",
			},
			{
				action: "prioritize_merger",
				ruleId: "rule-3",
				triggered: true,
				suppressed: false,
				dryRun: true,
				details: "dry-run: would prioritize_merger",
				timestamp: "2024-01-01T12:00:00.000Z",
			},
		];
		const out = renderPolicyHistory(records);
		expect(out).toContain("EXECUTED");
		expect(out).toContain("SUPPRESSED");
		expect(out).toContain("DRY-RUN");
		expect(out).toContain("rule-1");
		expect(out).toContain("pause_spawning");
		expect(out).toContain("executed: pause_spawning");
		expect(out).toContain("Showing 3 record(s)");
	});
});

// === renderPolicyStatus ===

describe("renderPolicyStatus", () => {
	it("renders not-configured state", () => {
		const info: PolicyStatusInfo = {
			enabled: false,
			disabled: false,
			dryRun: false,
			ruleCount: 0,
			recentTriggered: 0,
		};
		const out = renderPolicyStatus(info);
		expect(out).toContain("Health Policy");
		expect(out).toContain("Not configured");
	});

	it("renders enabled live mode", () => {
		const info: PolicyStatusInfo = {
			enabled: true,
			disabled: false,
			dryRun: false,
			ruleCount: 3,
			lastEvaluationAt: "2024-01-01T12:00:00.000Z",
			recentTriggered: 2,
		};
		const out = renderPolicyStatus(info);
		expect(out).toContain("enabled");
		expect(out).toContain("live");
		expect(out).toContain("3");
		expect(out).toContain("Recent triggered: 2");
	});

	it("renders disabled kill-switch state", () => {
		const info: PolicyStatusInfo = {
			enabled: false,
			disabled: true,
			dryRun: false,
			ruleCount: 2,
			recentTriggered: 0,
		};
		const out = renderPolicyStatus(info);
		expect(out).toContain("disabled");
		expect(out).toContain("kill switch active");
	});

	it("renders dry-run mode", () => {
		const info: PolicyStatusInfo = {
			enabled: true,
			disabled: false,
			dryRun: true,
			ruleCount: 5,
			recentTriggered: 1,
		};
		const out = renderPolicyStatus(info);
		expect(out).toContain("dry-run");
	});
});
