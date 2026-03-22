// Config types
export interface RetryConfig {
	maxAttempts: number;
	backoffBaseMs: number;
	backoffMaxMs: number;
	backoffMultiplier: number;
	globalMaxConcurrent: number;
}

export interface CircuitBreakerConfig {
	failureThreshold: number;
	windowMs: number;
	cooldownMs: number;
	halfOpenMaxProbes: number;
}

export interface RerouteConfig {
	enabled: boolean;
	maxReroutes: number;
	fallbackCapability?: string;
}

export interface ResilienceConfig {
	retry: RetryConfig;
	circuitBreaker: CircuitBreakerConfig;
	reroute: RerouteConfig;
}

// State/record types
export interface CircuitBreakerState {
	capability: string;
	state: "closed" | "open" | "half_open";
	failureCount: number;
	lastFailureAt: string | null;
	openedAt: string | null;
	halfOpenAt: string | null;
}

export interface RetryRecord {
	taskId: string;
	attempt: number;
	outcome: "pending" | "success" | "failure";
	agentName: string;
	startedAt: string;
	failedAt: string | null;
	errorClass: "recoverable" | "structural" | "unknown";
}

export interface RerouteDecision {
	action: "retry" | "recommend_reroute" | "abandon";
	targetCapability?: string;
	targetRuntime?: string;
	delay: number;
	reason: string;
	probeTaskId?: string;
}
