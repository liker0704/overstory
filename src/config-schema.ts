/** Latest config schema version supported by this version of overstory. */
export const CURRENT_CONFIG_VERSION = 2;

/** All supported config versions. */
export const SUPPORTED_VERSIONS = [1, 2] as const;

/** Union of all supported config version numbers. */
export type ConfigVersion = (typeof SUPPORTED_VERSIONS)[number];

/**
 * Known fields at each level of the config hierarchy.
 * Used for strict unknown-field validation — any key not listed here is rejected.
 *
 * Dynamic-key sections (providers, models, runtime.capabilities, runtime.pi.modelMap)
 * allow arbitrary string keys; their values are validated by validateConfigValues instead.
 */
export const KNOWN_FIELDS = {
	root: new Set([
		"version",
		"project",
		"agents",
		"worktrees",
		"taskTracker",
		"mulch",
		"merge",
		"providers",
		"watchdog",
		"models",
		"logging",
		"coordinator",
		"rateLimit",
		"runtime",
		"mission",
		"mail",
		"resilience",
		"compat",
		"headroom",
		"reminders",
		"healthPolicy",
	]),
	project: new Set(["name", "root", "canonicalBranch", "qualityGates"]),
	qualityGateItem: new Set(["name", "command", "description"]),
	agents: new Set([
		"manifestPath",
		"baseDir",
		"maxConcurrent",
		"staggerDelayMs",
		"maxDepth",
		"maxSessionsPerRun",
		"maxAgentsPerLead",
	]),
	worktrees: new Set(["baseDir"]),
	taskTracker: new Set(["backend", "enabled", "github"]),
	taskTrackerGithub: new Set([
		"pollIntervalMs",
		"owner",
		"repo",
		"readyLabel",
		"activeLabel",
		"maxConcurrent",
	]),
	mulch: new Set(["enabled", "domains", "primeFormat", "semantic"]),
	mulchSemantic: new Set(["enabled", "provider", "model"]),
	merge: new Set(["aiResolveEnabled", "reimagineEnabled"]),
	watchdog: new Set([
		"tier0Enabled",
		"tier0IntervalMs",
		"tier1Enabled",
		"tier2Enabled",
		"staleThresholdMs",
		"zombieThresholdMs",
		"nudgeIntervalMs",
	]),
	logging: new Set(["verbose", "redactSecrets"]),
	coordinator: new Set(["autoPull", "exitTriggers"]),
	coordinatorExitTriggers: new Set(["allAgentsDone", "taskTrackerEmpty", "onShutdownSignal"]),
	rateLimit: new Set([
		"enabled",
		"behavior",
		"maxWaitMs",
		"pollIntervalMs",
		"notifyCoordinator",
		"swapRuntime",
	]),
	runtime: new Set(["default", "capabilities", "printCommand", "pi", "shellInitDelayMs"]),
	runtimePi: new Set(["provider", "modelMap"]),
	providerItem: new Set(["type", "baseUrl", "authTokenEnv"]),
	mission: new Set(["planReview"]),
	missionPlanReview: new Set(["enabled", "tier", "maxRounds", "criticModel"]),
	mail: new Set(["reliability"]),
	mailReliability: new Set(["leaseTimeoutSec", "maxRetries", "backoffBaseMs", "backoffMaxMs"]),
	resilience: new Set(["retry", "circuitBreaker", "reroute"]),
	compat: new Set(["enabled", "skipPatterns", "aiThreshold", "strictMode", "maxAiCallsPerRun"]),
	resilienceRetry: new Set([
		"maxAttempts",
		"backoffBaseMs",
		"backoffMaxMs",
		"backoffMultiplier",
		"globalMaxConcurrent",
	]),
	resilienceCircuitBreaker: new Set([
		"failureThreshold",
		"windowMs",
		"cooldownMs",
		"halfOpenMaxProbes",
	]),
	resilienceReroute: new Set(["enabled", "maxReroutes", "fallbackCapability"]),
	headroom: new Set([
		"enabled",
		"pollIntervalMs",
		"cacheTtlMs",
		"warnThresholdPercent",
		"criticalThresholdPercent",
		"throttle",
	]),
	headroomThrottle: new Set([
		"slowThresholdPercent",
		"pauseThresholdPercent",
		"blockSpawnsOnPause",
	]),
	reminders: new Set([
		"lookbackWindowMs",
		"completionTrendThreshold",
		"mergeConflictThreshold",
		"errorRecurrenceMinCount",
		"staleEscalationMaxAgeMs",
		"escalationResponseMinRate",
	]),
	healthPolicy: new Set([
		"enabled",
		"dryRun",
		"rules",
		"defaultCooldownMs",
		"evaluationIntervalMs",
		"maxPauseDurationMs",
	]),
	healthPolicyRule: new Set(["id", "action", "condition", "cooldownMs", "priority"]),
	healthPolicyCondition: new Set(["factor", "threshold", "grade", "operator"]),
} as const;
