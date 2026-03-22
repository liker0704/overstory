import type { ResilienceStore } from "./store.ts";
import type { CircuitBreakerConfig, CircuitBreakerState } from "./types.ts";

function defaultState(capability: string): CircuitBreakerState {
	return {
		capability,
		state: "closed",
		failureCount: 0,
		lastFailureAt: null,
		openedAt: null,
		halfOpenAt: null,
	};
}

export function getState(store: ResilienceStore, capability: string): CircuitBreakerState {
	return store.getBreaker(capability) ?? defaultState(capability);
}

export function recordFailure(
	store: ResilienceStore,
	capability: string,
	config: CircuitBreakerConfig,
): CircuitBreakerState {
	const current = getState(store, capability);
	const now = new Date().toISOString();
	let next: CircuitBreakerState;

	if (current.state === "half_open") {
		// probe failed → transition to open
		next = {
			...current,
			state: "open",
			openedAt: now,
			halfOpenAt: null,
			failureCount: current.failureCount + 1,
			lastFailureAt: now,
		};
	} else if (current.state === "open") {
		// stay open, bump count
		next = {
			...current,
			failureCount: current.failureCount + 1,
			lastFailureAt: now,
		};
	} else {
		// closed: check windowed failure count
		const recentFailures = store.getRecentFailures(capability, config.windowMs);
		if (recentFailures + 1 >= config.failureThreshold) {
			next = {
				...current,
				state: "open",
				openedAt: now,
				failureCount: current.failureCount + 1,
				lastFailureAt: now,
			};
		} else {
			next = {
				...current,
				failureCount: current.failureCount + 1,
				lastFailureAt: now,
			};
		}
	}

	store.upsertBreaker(next, current.state);
	return next;
}

export function recordSuccess(store: ResilienceStore, capability: string): CircuitBreakerState {
	const current = getState(store, capability);

	if (current.state === "half_open") {
		// probe succeeded → close and reset
		const next: CircuitBreakerState = {
			...current,
			state: "closed",
			failureCount: 0,
			lastFailureAt: null,
			openedAt: null,
			halfOpenAt: null,
		};
		store.upsertBreaker(next, current.state);
		return next;
	}

	// closed or open: no-op
	return current;
}

export function canDispatch(
	store: ResilienceStore,
	capability: string,
	config: CircuitBreakerConfig,
): boolean {
	const current = getState(store, capability);

	if (current.state === "closed") {
		return true;
	}

	if (current.state === "open") {
		if (!current.openedAt) return false;
		const elapsed = Date.now() - new Date(current.openedAt).getTime();
		if (elapsed >= config.cooldownMs) {
			const now = new Date().toISOString();
			const next: CircuitBreakerState = { ...current, state: "half_open", halfOpenAt: now };
			store.upsertBreaker(next, current.state);
			return true;
		}
		return false;
	}

	// half_open: count pending retries for this capability
	const pending = store.getPendingRetries(config.halfOpenMaxProbes);
	const pendingForCapability = pending.filter((r) => r.agentName === capability);
	return pendingForCapability.length < config.halfOpenMaxProbes;
}
