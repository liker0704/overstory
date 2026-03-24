import { expect, test } from "bun:test";
import { evaluateAdaptivePolicy } from "./policy.ts";
import type { AdaptiveConfig, ParallelismContext, ScalingDecision } from "./types.ts";

function makeContext(overrides: Partial<ParallelismContext> = {}): ParallelismContext {
	return {
		healthScore: 80,
		healthGrade: "B",
		headroomPercent: 50,
		mergeQueueDepth: 2,
		activeWorkers: 8,
		stalledWorkers: 0,
		collectedAt: new Date().toISOString(),
		...overrides,
	};
}

function makeConfig(overrides: Partial<AdaptiveConfig> = {}): AdaptiveConfig {
	return {
		enabled: true,
		minWorkers: 1,
		maxWorkers: 20,
		evaluationIntervalMs: 30000,
		cooldownMs: 60000,
		hysteresisPercent: 10,
		...overrides,
	};
}

function makePreviousDecision(overrides: Partial<ScalingDecision> = {}): ScalingDecision {
	return {
		effectiveMaxConcurrent: 10,
		direction: "hold",
		previousMaxConcurrent: 10,
		factors: [],
		decidedAt: new Date(Date.now() - 120000).toISOString(), // 2 min ago, past cooldown
		...overrides,
	};
}

// Test 1: Scale up
test("scale up: healthy system increases effectiveMaxConcurrent by 1", () => {
	const context = makeContext({
		healthScore: 90,
		healthGrade: "A",
		headroomPercent: 70,
		mergeQueueDepth: 1,
		activeWorkers: 9,
	});
	const config = makeConfig();
	const prev = makePreviousDecision({ effectiveMaxConcurrent: 10 });
	const result = evaluateAdaptivePolicy({ context, config, previousDecision: prev });
	expect(result.direction).toBe("up");
	expect(result.effectiveMaxConcurrent).toBe(11);
});

// Test 2: Scale down
test("scale down: degraded system decreases effectiveMaxConcurrent by 1", () => {
	const context = makeContext({
		healthScore: 40,
		healthGrade: "F",
		headroomPercent: 15,
		mergeQueueDepth: 8,
		activeWorkers: 2,
	});
	const config = makeConfig();
	const prev = makePreviousDecision({ effectiveMaxConcurrent: 10 });
	const result = evaluateAdaptivePolicy({ context, config, previousDecision: prev });
	expect(result.direction).toBe("down");
	expect(result.effectiveMaxConcurrent).toBe(9);
});

// Test 3: Hold on mixed signals
test("hold: mixed signals that cancel out produce no change", () => {
	// health=90 (up, 0.35), headroom=15 (down, 0.30), merge=1 (up, 0.20), utilization low (down, 0.15)
	// weightedSum = 0.35 - 0.30 + 0.20 - 0.15 = 0.10, normalized = 0.10/1.0 = 0.10
	// hysteresis threshold = 10/100 = 0.10, |0.10| < 0.10 is false... let's pick a closer balance
	// health=80 (hold 0), headroom=35 (hold 0), merge=4 (hold 0), util=60% (hold 0) -> all hold
	const context = makeContext({
		healthScore: 80,
		healthGrade: "B",
		headroomPercent: 35,
		mergeQueueDepth: 4,
		activeWorkers: 6, // 6/10 = 60%, hold
	});
	const config = makeConfig();
	const prev = makePreviousDecision({ effectiveMaxConcurrent: 10 });
	const result = evaluateAdaptivePolicy({ context, config, previousDecision: prev });
	expect(result.direction).toBe("hold");
	expect(result.effectiveMaxConcurrent).toBe(10);
});

// Test 4: Hysteresis - marginal signals within dead zone
test("hysteresis: marginal signals within dead zone force hold", () => {
	// health=90 (up 0.35), headroom=15 (down 0.30), merge=1 (up 0.20), util=3/10=30% (down 0.15)
	// weightedSum = 0.35 - 0.30 + 0.20 - 0.15 = 0.10
	// normalized = 0.10/1.0 = 0.10
	// hysteresis=20% -> threshold=0.20, |0.10| < 0.20 -> hold
	const context = makeContext({
		healthScore: 90,
		healthGrade: "A",
		headroomPercent: 15,
		mergeQueueDepth: 1,
		activeWorkers: 3,
	});
	const config = makeConfig({ hysteresisPercent: 20 });
	const prev = makePreviousDecision({ effectiveMaxConcurrent: 10 });
	const result = evaluateAdaptivePolicy({ context, config, previousDecision: prev });
	expect(result.direction).toBe("hold");
});

// Test 5: Hysteresis with reduced weight (headroom=null)
test("hysteresis with null headroom: totalWeight=0.85, threshold remains proportional", () => {
	// health=90 (up 0.35), headroom=null (hold 0.15), merge=1 (up 0.20), util=9/10=90% (up 0.15)
	// weightedSum = 0.35 + 0 + 0.20 + 0.15 = 0.70, totalWeight=0.85
	// normalized = 0.70/0.85 ≈ 0.824 -> clearly up, so this won't test hysteresis well
	// Let's get a marginal case: health=40 (down 0.35), headroom=null (hold 0.15), merge=1 (up 0.20), util=50% (hold 0.15)
	// weightedSum = -0.35 + 0 + 0.20 + 0 = -0.15, totalWeight=0.85
	// normalized = -0.15/0.85 ≈ -0.176
	// hysteresis=20% -> threshold=0.20, |-0.176| < 0.20 -> hold
	const context = makeContext({
		healthScore: 40,
		healthGrade: "F",
		headroomPercent: null,
		mergeQueueDepth: 1,
		activeWorkers: 5, // 5/10 = 50%, hold
	});
	const config = makeConfig({ hysteresisPercent: 20 });
	const prev = makePreviousDecision({ effectiveMaxConcurrent: 10 });
	const result = evaluateAdaptivePolicy({ context, config, previousDecision: prev });
	// headroom weight should be 0.15 (not 0.30)
	const headroomFactor = result.factors.find((f) => f.signal === "headroom");
	expect(headroomFactor?.weight).toBe(0.15);
	expect(result.direction).toBe("hold");
});

// Test 6: Cooldown forces hold
test("cooldown: recent non-hold decision within cooldownMs forces hold", () => {
	const context = makeContext({
		healthScore: 90,
		healthGrade: "A",
		headroomPercent: 70,
		mergeQueueDepth: 1,
		activeWorkers: 9,
	});
	const config = makeConfig({ cooldownMs: 60000 });
	const prev = makePreviousDecision({
		effectiveMaxConcurrent: 10,
		direction: "up",
		decidedAt: new Date(Date.now() - 1000).toISOString(), // 1 second ago
	});
	const result = evaluateAdaptivePolicy({ context, config, previousDecision: prev });
	expect(result.direction).toBe("hold");
	expect(result.effectiveMaxConcurrent).toBe(10);
});

// Test 7: Bounds min - at minWorkers, down signal stays at minWorkers
test("bounds min: at minWorkers with down signal stays at minWorkers", () => {
	const context = makeContext({
		healthScore: 40,
		healthGrade: "F",
		headroomPercent: 15,
		mergeQueueDepth: 8,
		activeWorkers: 1,
	});
	const config = makeConfig({ minWorkers: 2, maxWorkers: 20 });
	const prev = makePreviousDecision({ effectiveMaxConcurrent: 2 });
	const result = evaluateAdaptivePolicy({ context, config, previousDecision: prev });
	expect(result.effectiveMaxConcurrent).toBe(2);
	expect(result.effectiveMaxConcurrent).toBeGreaterThanOrEqual(config.minWorkers);
});

// Test 8: Bounds max - at maxWorkers, up signal stays at maxWorkers
test("bounds max: at maxWorkers with up signal stays at maxWorkers", () => {
	const context = makeContext({
		healthScore: 90,
		healthGrade: "A",
		headroomPercent: 70,
		mergeQueueDepth: 1,
		activeWorkers: 19,
	});
	const config = makeConfig({ minWorkers: 1, maxWorkers: 20 });
	const prev = makePreviousDecision({ effectiveMaxConcurrent: 20 });
	const result = evaluateAdaptivePolicy({ context, config, previousDecision: prev });
	expect(result.effectiveMaxConcurrent).toBe(20);
	expect(result.effectiveMaxConcurrent).toBeLessThanOrEqual(config.maxWorkers);
});

// Test 9: First evaluation - no cooldown, currentMax defaults to config.maxWorkers
test("first evaluation: null previousDecision uses config.maxWorkers as currentMax", () => {
	const context = makeContext({
		healthScore: 90,
		healthGrade: "A",
		headroomPercent: 70,
		mergeQueueDepth: 1,
		activeWorkers: 9,
	});
	const config = makeConfig({ maxWorkers: 15 });
	const result = evaluateAdaptivePolicy({ context, config, previousDecision: null });
	expect(result.previousMaxConcurrent).toBe(15);
	// Should scale up from 15, but capped at maxWorkers=15
	expect(result.effectiveMaxConcurrent).toBe(15);
});

// Test 10: Explainability - all 4 factors present with non-empty detail strings
test("explainability: all 4 factors have non-empty detail strings", () => {
	const context = makeContext();
	const config = makeConfig();
	const result = evaluateAdaptivePolicy({ context, config, previousDecision: null });
	expect(result.factors).toHaveLength(4);
	for (const factor of result.factors) {
		expect(factor.detail.length).toBeGreaterThan(0);
		expect(factor.signal.length).toBeGreaterThan(0);
	}
	const signals = result.factors.map((f) => f.signal);
	expect(signals).toContain("health");
	expect(signals).toContain("headroom");
	expect(signals).toContain("merge_pressure");
	expect(signals).toContain("utilization");
});

// Test 11: Utilization uses previousDecision.effectiveMaxConcurrent, not config.maxWorkers
test("utilization uses previousDecision.effectiveMaxConcurrent not config.maxWorkers", () => {
	// 10 workers, previousDecision.effectiveMaxConcurrent=25 -> utilization=40% -> down
	const context = makeContext({
		healthScore: 80,
		healthGrade: "B",
		headroomPercent: 50,
		mergeQueueDepth: 2,
		activeWorkers: 10,
	});
	const config = makeConfig({ maxWorkers: 30 }); // config.maxWorkers differs from prev
	const prev = makePreviousDecision({ effectiveMaxConcurrent: 25 });
	const result = evaluateAdaptivePolicy({ context, config, previousDecision: prev });
	const utilizationFactor = result.factors.find((f) => f.signal === "utilization");
	// 10/25 = 40% < 50% -> down
	expect(utilizationFactor?.effect).toBe("down");
	expect(utilizationFactor?.detail).toContain("40%");
});
