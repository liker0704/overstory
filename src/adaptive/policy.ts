import type {
	AdaptiveConfig,
	ParallelismContext,
	ScalingDecision,
	ScalingDirection,
	ScalingFactor,
} from "./types.ts";

export interface PolicyEvalParams {
	context: ParallelismContext;
	config: AdaptiveConfig;
	previousDecision: ScalingDecision | null;
}

function healthSignal(score: number): { effect: ScalingDirection; detail: string } {
	if (score >= 85) return { effect: "up", detail: `health score ${score} >= 85` };
	if (score >= 55) return { effect: "hold", detail: `health score ${score} in [55, 85)` };
	return { effect: "down", detail: `health score ${score} < 55` };
}

function headroomSignal(headroomPercent: number | null): {
	effect: ScalingDirection;
	weight: number;
	detail: string;
} {
	if (headroomPercent === null) {
		return { effect: "hold", weight: 0.13, detail: "headroom unavailable, reduced weight" };
	}
	if (headroomPercent >= 50) {
		return { effect: "up", weight: 0.25, detail: `headroom ${headroomPercent}% >= 50%` };
	}
	if (headroomPercent >= 20) {
		return { effect: "hold", weight: 0.25, detail: `headroom ${headroomPercent}% in [20%, 50%)` };
	}
	return { effect: "down", weight: 0.25, detail: `headroom ${headroomPercent}% < 20%` };
}

function backlogSignal(
	readyTaskCount: number | null,
	activeWorkers: number,
): { effect: ScalingDirection; weight: number; detail: string } {
	if (readyTaskCount === null) {
		return { effect: "hold", weight: 0.08, detail: "backlog unavailable, reduced weight" };
	}
	if (readyTaskCount > activeWorkers * 2) {
		return {
			effect: "up",
			weight: 0.15,
			detail: `backlog ${readyTaskCount} ready tasks > ${activeWorkers * 2} (activeWorkers=${activeWorkers})`,
		};
	}
	if (readyTaskCount < activeWorkers * 0.5) {
		return {
			effect: "down",
			weight: 0.15,
			detail: `backlog ${readyTaskCount} ready tasks < ${activeWorkers * 0.5} (activeWorkers=${activeWorkers})`,
		};
	}
	return {
		effect: "hold",
		weight: 0.15,
		detail: `backlog ${readyTaskCount} ready tasks in range (activeWorkers=${activeWorkers})`,
	};
}

function mergeSignal(depth: number): { effect: ScalingDirection; detail: string } {
	if (depth <= 2) return { effect: "up", detail: `merge queue depth ${depth} <= 2` };
	if (depth <= 5) return { effect: "hold", detail: `merge queue depth ${depth} in [3, 5]` };
	return { effect: "down", detail: `merge queue depth ${depth} > 5` };
}

function utilizationSignal(
	activeWorkers: number,
	currentMax: number,
): { effect: ScalingDirection; detail: string } {
	const utilization = activeWorkers / currentMax;
	const pct = Math.round(utilization * 100);
	if (utilization > 0.8) return { effect: "up", detail: `utilization ${pct}% > 80%` };
	if (utilization >= 0.5) return { effect: "hold", detail: `utilization ${pct}% in [50%, 80%]` };
	return { effect: "down", detail: `utilization ${pct}% < 50%` };
}

function effectScore(effect: ScalingDirection): number {
	if (effect === "up") return 1;
	if (effect === "down") return -1;
	return 0;
}

export function evaluateAdaptivePolicy(params: PolicyEvalParams): ScalingDecision {
	const { context, config, previousDecision } = params;

	const currentMax = previousDecision?.effectiveMaxConcurrent ?? config.maxWorkers;
	const previousMax = currentMax;

	// Compute signals
	const health = healthSignal(context.healthScore);
	const headroom = headroomSignal(context.headroomPercent);
	const merge = mergeSignal(context.mergeQueueDepth);
	const utilization = utilizationSignal(context.activeWorkers, currentMax);
	const backlog = backlogSignal(context.readyTaskCount, context.activeWorkers);

	const factors: ScalingFactor[] = [
		{
			signal: "health",
			value: context.healthScore,
			effect: health.effect,
			weight: 0.3,
			detail: health.detail,
		},
		{
			signal: "headroom",
			value: context.headroomPercent ?? -1,
			effect: headroom.effect,
			weight: headroom.weight,
			detail: headroom.detail,
		},
		{
			signal: "merge_pressure",
			value: context.mergeQueueDepth,
			effect: merge.effect,
			weight: 0.2,
			detail: merge.detail,
		},
		{
			signal: "utilization",
			value: context.activeWorkers,
			effect: utilization.effect,
			weight: 0.1,
			detail: utilization.detail,
		},
		{
			signal: "backlog_pressure",
			value: context.readyTaskCount ?? -1,
			effect: backlog.effect,
			weight: backlog.weight,
			detail: backlog.detail,
		},
	];

	// Weighted sum
	let weightedSum = 0;
	let totalWeight = 0;
	for (const f of factors) {
		weightedSum += effectScore(f.effect) * f.weight;
		totalWeight += f.weight;
	}

	const normalizedSum = weightedSum / totalWeight;
	const threshold = config.hysteresisPercent / 100;

	// Determine raw direction
	let direction: ScalingDirection;
	if (Math.abs(normalizedSum) < threshold) {
		direction = "hold";
	} else if (normalizedSum > 0) {
		direction = "up";
	} else {
		direction = "down";
	}

	// Cooldown: if recent non-hold decision within cooldownMs, force hold
	if (previousDecision !== null && previousDecision.direction !== "hold") {
		const elapsed = Date.now() - new Date(previousDecision.decidedAt).getTime();
		if (elapsed < config.cooldownMs) {
			direction = "hold";
		}
	}

	// Compute effectiveMaxConcurrent
	let effectiveMaxConcurrent: number;
	if (direction === "up") {
		effectiveMaxConcurrent = Math.min(currentMax + 1, config.maxWorkers);
	} else if (direction === "down") {
		effectiveMaxConcurrent = Math.max(currentMax - 1, config.minWorkers);
	} else {
		effectiveMaxConcurrent = currentMax;
	}

	// Clamp
	effectiveMaxConcurrent = Math.max(
		config.minWorkers,
		Math.min(config.maxWorkers, effectiveMaxConcurrent),
	);

	return {
		effectiveMaxConcurrent,
		direction,
		previousMaxConcurrent: previousMax,
		factors,
		decidedAt: new Date().toISOString(),
	};
}
