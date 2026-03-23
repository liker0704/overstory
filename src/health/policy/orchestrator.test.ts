import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OverstoryConfig } from "../../config-types.ts";
import type { HealthScore } from "../types.ts";
import { runPolicyEvaluation } from "./orchestrator.ts";
import type { PolicyActionRecord, PolicyRule } from "./types.ts";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "policy-orch-test-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function makeScore(overall = 80, grade: HealthScore["grade"] = "B"): HealthScore {
	return {
		overall,
		grade,
		factors: [
			{
				name: "completion_rate",
				label: "Completion Rate",
				score: overall,
				weight: 1,
				contribution: overall,
				details: "test",
			},
		],
		collectedAt: new Date().toISOString(),
		signals: {
			totalActiveSessions: 0,
			stalledSessions: 0,
			zombieSessions: 0,
			bootingSessions: 0,
			workingSessions: 0,
			runtimeSwapCount: 0,
			totalSessionsRecorded: 0,
			completedSessionsRecorded: 0,
			mergeSuccessCount: 0,
			mergeTotalCount: 0,
			averageDurationMs: 0,
			costPerCompletedTask: null,
			doctorFailCount: 0,
			doctorWarnCount: 0,
			completionRate: 1,
			stalledRate: 0,
			mergeSuccessRate: 1,
			openBreakerCount: 0,
			activeRetryCount: 0,
			recentRerouteCount: 0,
			lowestHeadroomPercent: null,
			criticalHeadroomCount: 0,
			collectedAt: new Date().toISOString(),
		},
	};
}

function makeRule(overrides: Partial<PolicyRule> = {}): PolicyRule {
	return {
		id: "test-rule",
		action: "pause_spawning",
		condition: { factor: "completion_rate", threshold: 90, operator: "lt" },
		cooldownMs: 0,
		priority: "medium",
		...overrides,
	};
}

function makeConfig(
	overrides: Partial<NonNullable<OverstoryConfig["healthPolicy"]>> = {},
): OverstoryConfig {
	return {
		healthPolicy: {
			enabled: true,
			dryRun: false,
			rules: [makeRule()],
			defaultCooldownMs: 60_000,
			evaluationIntervalMs: 5_000,
			maxPauseDurationMs: 30_000,
			...overrides,
		},
	} as unknown as OverstoryConfig;
}

// 1. Returns null when kill switch is active (config disabled)
test("returns null when healthPolicy is disabled in config", async () => {
	const config = makeConfig({ enabled: false });
	const result = await runPolicyEvaluation({
		overstoryDir: tempDir,
		config,
		score: makeScore(),
		history: [],
		mailSend: mock(() => {}),
	});
	expect(result).toBeNull();
});

// 2. Returns null when kill switch sentinel file exists
test("returns null when health-policy-disabled sentinel exists", async () => {
	writeFileSync(join(tempDir, "health-policy-disabled"), "");
	const config = makeConfig();
	const result = await runPolicyEvaluation({
		overstoryDir: tempDir,
		config,
		score: makeScore(),
		history: [],
		mailSend: mock(() => {}),
	});
	expect(result).toBeNull();
});

// 3. Returns null when evaluation interval not elapsed
test("returns null when evaluation interval not elapsed", async () => {
	const config = makeConfig({ evaluationIntervalMs: 60_000 });
	const recentEval = new Date().toISOString();

	const result = await runPolicyEvaluation({
		overstoryDir: tempDir,
		config,
		score: makeScore(),
		history: [],
		mailSend: mock(() => {}),
		lastEvaluationAt: recentEval,
	});
	expect(result).toBeNull();
});

// 4. Runs evaluation and returns results when active
test("returns evaluation result when policy is active and interval has elapsed", async () => {
	const config = makeConfig();
	const result = await runPolicyEvaluation({
		overstoryDir: tempDir,
		config,
		score: makeScore(),
		history: [],
		mailSend: mock(() => {}),
	});

	expect(result).not.toBeNull();
	expect(result?.evaluations).toBeDefined();
	expect(typeof result?.timestamp).toBe("string");
});

// 5. Executes triggered, non-suppressed actions
test("executes triggered non-suppressed actions and sets executedAt", async () => {
	// Score of 50 < threshold of 90 => triggers the rule
	const score = makeScore(50, "D");
	const mailSend = mock(() => {});
	const config = makeConfig({
		rules: [makeRule({ action: "prioritize_merger", cooldownMs: 0 })],
		dryRun: false,
	});

	const result = await runPolicyEvaluation({
		overstoryDir: tempDir,
		config,
		score,
		history: [],
		mailSend,
	});

	expect(result).not.toBeNull();
	const triggered = result?.evaluations.find((e) => e.triggered && !e.suppressed);
	expect(triggered).toBeDefined();
	expect(triggered?.executedAt).toBeDefined();
	expect(mailSend).toHaveBeenCalledTimes(1);
});

// 6. Does not execute suppressed actions
test("does not execute suppressed actions", async () => {
	const score = makeScore(50, "D");
	const mailSend = mock(() => {});

	// History has recent trigger — should cause cooldown suppression
	const history: PolicyActionRecord[] = [
		{
			action: "prioritize_merger",
			ruleId: "test-rule",
			triggered: true,
			suppressed: false,
			dryRun: false,
			details: "executed",
			timestamp: new Date().toISOString(),
		},
	];

	const config = makeConfig({
		rules: [makeRule({ action: "prioritize_merger", cooldownMs: 60_000 })],
		dryRun: false,
	});

	const result = await runPolicyEvaluation({
		overstoryDir: tempDir,
		config,
		score,
		history,
		mailSend,
	});

	expect(result).not.toBeNull();
	const suppressed = result?.evaluations.find((e) => e.triggered && e.suppressed);
	expect(suppressed).toBeDefined();
	expect(mailSend).not.toHaveBeenCalled();
});

// 7. Auto-resume runs before evaluation
test("auto-resume fires for stale spawn-paused sentinel before evaluation", async () => {
	// Write a stale sentinel
	const staleDate = new Date(Date.now() - 10_000).toISOString();
	writeFileSync(
		join(tempDir, "spawn-paused"),
		JSON.stringify({ ruleId: "old-rule", pausedAt: staleDate }),
	);

	const events: Array<Record<string, unknown>> = [];
	const config = makeConfig({ maxPauseDurationMs: 5_000 });

	const result = await runPolicyEvaluation({
		overstoryDir: tempDir,
		config,
		score: makeScore(),
		history: [],
		mailSend: mock(() => {}),
		logEvent: (_type, data) => {
			events.push(data);
		},
	});

	expect(result).not.toBeNull();
	const resumeEvent = events.find((e) => e.type === "health_auto_resume");
	expect(resumeEvent).toBeDefined();
});

// 8. Handles missing healthPolicy config gracefully (returns null)
test("returns null when healthPolicy config is absent", async () => {
	const config = {} as OverstoryConfig;

	const result = await runPolicyEvaluation({
		overstoryDir: tempDir,
		config,
		score: makeScore(),
		history: [],
		mailSend: mock(() => {}),
	});

	expect(result).toBeNull();
});
