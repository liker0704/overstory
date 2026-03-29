export type ScalingDirection = "up" | "down" | "hold";

export interface ParallelismContext {
	healthScore: number;
	healthGrade: string;
	headroomPercent: number | null;
	mergeQueueDepth: number;
	activeWorkers: number;
	stalledWorkers: number;
	rateLimitedAgents: number;
	readyTaskCount: number | null;
	inProgressCount: number | null;
	collectedAt: string;
}

export interface ScalingDecision {
	effectiveMaxConcurrent: number;
	direction: ScalingDirection;
	previousMaxConcurrent: number;
	factors: ScalingFactor[];
	decidedAt: string;
}

export interface ScalingFactor {
	signal: string;
	value: number;
	effect: ScalingDirection;
	weight: number;
	detail: string;
}

export interface AdaptiveConfig {
	enabled: boolean;
	minWorkers: number;
	maxWorkers: number;
	evaluationIntervalMs: number;
	cooldownMs: number;
	hysteresisPercent: number;
}
