import { canDispatch, getState, recordFailure } from "./circuit-breaker.ts";
import type { ResilienceStore } from "./store.ts";
import type { RerouteDecision, ResilienceConfig, RetryRecord } from "./types.ts";

export { canDispatch, getState, recordFailure, recordSuccess } from "./circuit-breaker.ts";

export function calculateBackoff(
	attempt: number,
	baseMs: number,
	multiplier: number,
	maxMs: number,
): number {
	return Math.min(baseMs * multiplier ** attempt, maxMs);
}

export function shouldRetry(
	taskId: string,
	store: ResilienceStore,
	config: ResilienceConfig,
): { retry: boolean; delay: number; attempt: number; reason?: string } {
	const retryCount = store.getRetryCount(taskId);

	if (retryCount >= config.retry.maxAttempts) {
		return { retry: false, delay: 0, attempt: retryCount, reason: "max_attempts_exceeded" };
	}

	const pendingRetries = store.getPendingRetries(config.retry.maxAttempts);
	if (pendingRetries.length >= config.retry.globalMaxConcurrent) {
		return {
			retry: false,
			delay: config.retry.backoffMaxMs,
			attempt: retryCount,
			reason: "global_concurrency_limit",
		};
	}

	const delay = calculateBackoff(
		retryCount,
		config.retry.backoffBaseMs,
		config.retry.backoffMultiplier,
		config.retry.backoffMaxMs,
	);
	return { retry: true, delay, attempt: retryCount };
}

export function decideReroute(
	taskId: string,
	failureType: RetryRecord["errorClass"],
	store: ResilienceStore,
	config: ResilienceConfig,
): RerouteDecision {
	const retryCount = store.getRetryCount(taskId);

	if (retryCount >= config.retry.maxAttempts) {
		return { action: "abandon", delay: 0, reason: "max_retries_exceeded" };
	}

	if (failureType === "structural" && config.reroute.enabled) {
		const retries = store.getRetries(taskId);
		const structuralCount = retries.filter((r) => r.errorClass === "structural").length;
		if (structuralCount >= config.reroute.maxReroutes) {
			return { action: "abandon", delay: 0, reason: "max_retries_exceeded" };
		}
		return {
			action: "recommend_reroute",
			targetCapability: config.reroute.fallbackCapability,
			delay: 0,
			reason: "structural_failure",
		};
	}

	const delay = calculateBackoff(
		retryCount,
		config.retry.backoffBaseMs,
		config.retry.backoffMultiplier,
		config.retry.backoffMaxMs,
	);
	return { action: "retry", delay, reason: `${failureType}_failure` };
}

export function handleTaskFailure(
	taskId: string,
	capability: string,
	errorClass: RetryRecord["errorClass"],
	store: ResilienceStore,
	config: ResilienceConfig,
): RerouteDecision {
	const previousState = getState(store, capability);
	const wasHalfOpen = previousState.state === "half_open";

	const breakerState = recordFailure(store, capability, config.circuitBreaker);
	const retryCount = store.getRetryCount(taskId);

	store.recordRetry({
		taskId,
		attempt: retryCount + 1,
		outcome: "failure",
		capability,
		startedAt: new Date().toISOString(),
		failedAt: new Date().toISOString(),
		errorClass,
	});

	const isProbe = wasHalfOpen && breakerState.state === "open";
	const probeTaskId = isProbe ? taskId : undefined;

	const dispatching = canDispatch(store, capability, config.circuitBreaker);
	if (!dispatching) {
		if (config.reroute.enabled) {
			return {
				action: "recommend_reroute",
				targetCapability: config.reroute.fallbackCapability,
				delay: 0,
				reason: "circuit_breaker_open",
				probeTaskId,
			};
		}
		return { action: "abandon", delay: 0, reason: "circuit_breaker_open", probeTaskId };
	}

	const decision = decideReroute(taskId, errorClass, store, config);
	return { ...decision, probeTaskId: probeTaskId ?? decision.probeTaskId };
}
