import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEffectiveMaxConcurrent } from "../adaptive/index.ts";
import type { OverstoryConfig } from "../config-types.ts";

function makeConfig(adaptive?: OverstoryConfig["agents"]["adaptive"]): OverstoryConfig {
	return {
		project: { name: "test", root: "/tmp/test", canonicalBranch: "main" },
		agents: {
			manifestPath: ".overstory/agent-manifest.json",
			baseDir: ".overstory/agent-defs",
			maxConcurrent: 8,
			staggerDelayMs: 0,
			maxDepth: 2,
			maxSessionsPerRun: 0,
			maxAgentsPerLead: 5,
			adaptive,
		},
		worktrees: { baseDir: ".overstory/worktrees" },
		taskTracker: { backend: "auto", enabled: false },
		mulch: { enabled: false, domains: [], primeFormat: "markdown" },
		merge: { aiResolveEnabled: false, reimagineEnabled: false },
		providers: {},
		watchdog: {
			tier0Enabled: false,
			tier0IntervalMs: 30_000,
			tier1Enabled: false,
			tier2Enabled: false,
			staleThresholdMs: 300_000,
			zombieThresholdMs: 600_000,
			nudgeIntervalMs: 60_000,
		},
		models: {},
		logging: { verbose: false, redactSecrets: true },
	};
}

function makeDecision(
	overrides: Partial<{
		effectiveMaxConcurrent: number;
		direction: "up" | "down" | "hold";
		previousMaxConcurrent: number;
		decidedAt: string;
	}> = {},
): Record<string, unknown> {
	return {
		effectiveMaxConcurrent: 4,
		direction: "hold",
		previousMaxConcurrent: 4,
		factors: [],
		decidedAt: new Date().toISOString(),
		...overrides,
	};
}

describe("readEffectiveMaxConcurrent", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "adaptive-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("disabled: returns maxConcurrent when adaptive is disabled", () => {
		const config = makeConfig(undefined);
		const result = readEffectiveMaxConcurrent(tmpDir, config);
		expect(result).toBe(8);
	});

	it("valid cache: returns effectiveMaxConcurrent from fresh state file", () => {
		const config = makeConfig({
			enabled: true,
			minWorkers: 1,
			maxWorkers: 8,
			evaluationIntervalMs: 30_000,
			cooldownMs: 60_000,
			hysteresisPercent: 10,
		});
		const decision = makeDecision({ effectiveMaxConcurrent: 5 });
		writeFileSync(join(tmpDir, "adaptive-state.json"), JSON.stringify(decision));
		const result = readEffectiveMaxConcurrent(tmpDir, config);
		expect(result).toBe(5);
	});

	it("missing cache: returns maxConcurrent when file does not exist", () => {
		const config = makeConfig({
			enabled: true,
			minWorkers: 1,
			maxWorkers: 8,
			evaluationIntervalMs: 30_000,
			cooldownMs: 60_000,
			hysteresisPercent: 10,
		});
		const result = readEffectiveMaxConcurrent(tmpDir, config);
		expect(result).toBe(8);
	});

	it("stale: returns maxConcurrent when decidedAt is too old", () => {
		const config = makeConfig({
			enabled: true,
			minWorkers: 1,
			maxWorkers: 8,
			evaluationIntervalMs: 30_000,
			cooldownMs: 60_000,
			hysteresisPercent: 10,
		});
		// 200s ago, threshold is 5 * 30_000ms = 150_000ms — clearly stale
		const oldDate = new Date(Date.now() - 200_000).toISOString();
		const decision = makeDecision({ effectiveMaxConcurrent: 4, decidedAt: oldDate });
		writeFileSync(join(tmpDir, "adaptive-state.json"), JSON.stringify(decision));
		const result = readEffectiveMaxConcurrent(tmpDir, config);
		expect(result).toBe(8);
	});

	it("corrupted: returns maxConcurrent when file contains invalid JSON", () => {
		const config = makeConfig({
			enabled: true,
			minWorkers: 1,
			maxWorkers: 8,
			evaluationIntervalMs: 30_000,
			cooldownMs: 60_000,
			hysteresisPercent: 10,
		});
		writeFileSync(join(tmpDir, "adaptive-state.json"), "not-valid-json{{{");
		const result = readEffectiveMaxConcurrent(tmpDir, config);
		expect(result).toBe(8);
	});

	it("clamp-to-min: clamps values below minWorkers to minWorkers", () => {
		const config = makeConfig({
			enabled: true,
			minWorkers: 2,
			maxWorkers: 8,
			evaluationIntervalMs: 30_000,
			cooldownMs: 60_000,
			hysteresisPercent: 10,
		});
		const decision = makeDecision({ effectiveMaxConcurrent: 0 });
		writeFileSync(join(tmpDir, "adaptive-state.json"), JSON.stringify(decision));
		const result = readEffectiveMaxConcurrent(tmpDir, config);
		expect(result).toBe(2);
	});

	it("clamp-to-max: clamps values above config.agents.maxConcurrent to maxConcurrent", () => {
		// config.agents.maxConcurrent = 6, effectiveMaxConcurrent = 100 → clamped to 6
		const config = makeConfig({
			enabled: true,
			minWorkers: 1,
			maxWorkers: 8,
			evaluationIntervalMs: 30_000,
			cooldownMs: 60_000,
			hysteresisPercent: 10,
		});
		// Override maxConcurrent to 6
		config.agents.maxConcurrent = 6;
		const decision = makeDecision({ effectiveMaxConcurrent: 100 });
		writeFileSync(join(tmpDir, "adaptive-state.json"), JSON.stringify(decision));
		const result = readEffectiveMaxConcurrent(tmpDir, config);
		expect(result).toBe(6);
	});

	it("spawn-paused: state file is readable even when spawn-paused sentinel exists", () => {
		const config = makeConfig({
			enabled: true,
			minWorkers: 1,
			maxWorkers: 8,
			evaluationIntervalMs: 30_000,
			cooldownMs: 60_000,
			hysteresisPercent: 10,
		});
		const decision = makeDecision({ effectiveMaxConcurrent: 3 });
		writeFileSync(join(tmpDir, "adaptive-state.json"), JSON.stringify(decision));
		// sentinel file exists alongside state
		writeFileSync(join(tmpDir, "spawn-paused"), "");
		const result = readEffectiveMaxConcurrent(tmpDir, config);
		expect(result).toBe(3);
	});
});
