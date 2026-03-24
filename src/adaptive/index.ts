import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OverstoryConfig } from "../config-types.ts";

export { evaluateAdaptivePolicy } from "./policy.ts";
export { collectParallelismContext } from "./signals.ts";
export type {
	AdaptiveConfig,
	ParallelismContext,
	ScalingDecision,
	ScalingDirection,
	ScalingFactor,
} from "./types.ts";

const DEFAULT_EVALUATION_INTERVAL_MS = 30_000;

/**
 * Read effective max concurrent from adaptive-state.json.
 * Returns config.agents.maxConcurrent on any error or if adaptive is disabled.
 * Clamps result to [adaptive.minWorkers, config.agents.maxConcurrent].
 */
export function readEffectiveMaxConcurrent(overstoryDir: string, config: OverstoryConfig): number {
	const fallback = config.agents.maxConcurrent;

	if (!config.agents.adaptive?.enabled) {
		return fallback;
	}

	const adaptive = config.agents.adaptive;

	try {
		const statePath = join(overstoryDir, "adaptive-state.json");
		if (!existsSync(statePath)) {
			return fallback;
		}

		const raw = readFileSync(statePath, "utf8");
		const state = JSON.parse(raw) as unknown;

		if (typeof state !== "object" || state === null) {
			return fallback;
		}

		const { effectiveMaxConcurrent, direction, decidedAt } = state as Record<string, unknown>;

		if (typeof effectiveMaxConcurrent !== "number" || !Number.isFinite(effectiveMaxConcurrent)) {
			return fallback;
		}

		if (direction !== "up" && direction !== "down" && direction !== "hold") {
			return fallback;
		}

		if (typeof decidedAt !== "string") {
			return fallback;
		}

		const evaluationIntervalMs = adaptive.evaluationIntervalMs ?? DEFAULT_EVALUATION_INTERVAL_MS;
		const staleness = Date.now() - new Date(decidedAt).getTime();
		if (staleness > 5 * evaluationIntervalMs) {
			return fallback;
		}

		return Math.max(adaptive.minWorkers, Math.min(fallback, effectiveMaxConcurrent));
	} catch {
		return fallback;
	}
}
