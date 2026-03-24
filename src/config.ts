import { dirname, join, resolve } from "node:path";
import {
	detectConfigVersion,
	migrateDeprecatedTaskTrackerKeys,
	migrateDeprecatedWatchdogKeys,
	migrateToLatest,
} from "./config-migrate.ts";
import { validateUnknownFields } from "./config-validate.ts";
import { deepMerge, parseYaml } from "./config-yaml.ts";
import { ConfigError, ValidationError } from "./errors.ts";
import type { PolicyAction, PolicyConditionOperator } from "./health/policy/types.ts";
import { KNOWN_FACTORS } from "./health/policy/types.ts";
import type {
	CoordinatorExitTriggers,
	OverstoryConfig,
	QualityGate,
	TaskTrackerBackend,
} from "./types.ts";

// Module-level project root override (set by --project global flag)
let _projectRootOverride: string | undefined;

// Tracks warnings already emitted this process to avoid repeating on every loadConfig call.
const _warnedOnce = new Set<string>();

/** Clear the dedup warning set. Intended for tests only. */
export function clearWarningsSeen(): void {
	_warnedOnce.clear();
}

/** Override project root for all config resolution (used by --project global flag). */
export function setProjectRootOverride(path: string): void {
	_projectRootOverride = path;
}

/** Get the current project root override, if any. */
export function getProjectRootOverride(): string | undefined {
	return _projectRootOverride;
}

/** Clear the project root override (used in tests and cleanup). */
export function clearProjectRootOverride(): void {
	_projectRootOverride = undefined;
}

/**
 * Default configuration with all fields populated.
 * Used as the base; file-loaded values are merged on top.
 */
/** Default quality gates used when no qualityGates are configured in config.yaml. */
export const DEFAULT_QUALITY_GATES: QualityGate[] = [
	{ name: "Tests", command: "bun test", description: "all tests must pass" },
	{ name: "Lint", command: "bun run lint", description: "zero errors" },
	{ name: "Typecheck", command: "bun run typecheck", description: "no TypeScript errors" },
];

export const DEFAULT_CONFIG: OverstoryConfig = {
	project: {
		name: "",
		root: "",
		canonicalBranch: "main",
		qualityGates: DEFAULT_QUALITY_GATES,
	},
	agents: {
		manifestPath: ".overstory/agent-manifest.json",
		baseDir: ".overstory/agent-defs",
		maxConcurrent: 25,
		staggerDelayMs: 2_000,
		maxDepth: 2,
		maxSessionsPerRun: 0,
		maxAgentsPerLead: 5,
	},
	worktrees: {
		baseDir: ".overstory/worktrees",
	},
	taskTracker: {
		backend: "auto" as TaskTrackerBackend,
		enabled: true,
		github: {
			pollIntervalMs: 30_000,
			readyLabel: "ov-ready",
			activeLabel: "ov-active",
			maxConcurrent: 5,
		},
	},
	mulch: {
		enabled: true,
		domains: [],
		primeFormat: "markdown",
	},
	merge: {
		aiResolveEnabled: true,
		reimagineEnabled: false,
	},
	providers: {
		anthropic: { type: "native" },
	},
	watchdog: {
		tier0Enabled: true, // Tier 0: Mechanical daemon
		tier0IntervalMs: 30_000,
		tier1Enabled: false, // Tier 1: Triage agent (AI analysis)
		tier2Enabled: false, // Tier 2: Monitor agent (continuous patrol)
		staleThresholdMs: 300_000, // 5 minutes
		zombieThresholdMs: 600_000, // 10 minutes
		nudgeIntervalMs: 60_000, // 1 minute between progressive nudge stages
	},
	mission: {
		planReview: {
			enabled: true,
			tier: "full" as const,
			maxRounds: 3,
		},
	},
	coordinator: {
		autoPull: false,
		exitTriggers: {
			allAgentsDone: false,
			taskTrackerEmpty: false,
			onShutdownSignal: false,
		} as CoordinatorExitTriggers,
	},
	models: {},
	logging: {
		verbose: false,
		redactSecrets: true,
	},
	runtime: {
		default: "claude",
		shellInitDelayMs: 0,
		pi: {
			provider: "anthropic",
			modelMap: {
				opus: "anthropic/claude-opus-4-6",
				sonnet: "anthropic/claude-sonnet-4-6",
				haiku: "anthropic/claude-haiku-4-5",
			},
		},
	},
	rateLimit: {
		enabled: true,
		behavior: "wait" as const,
		maxWaitMs: 3_600_000, // 1 hour max wait
		pollIntervalMs: 30_000, // check every 30s
		notifyCoordinator: true,
		swapRuntime: undefined,
	},
	mail: {
		reliability: {
			leaseTimeoutSec: 120,
			maxRetries: 3,
			backoffBaseMs: 5_000,
			backoffMaxMs: 60_000,
		},
	},
	resilience: {
		retry: {
			maxAttempts: 3,
			backoffBaseMs: 5_000,
			backoffMaxMs: 120_000,
			backoffMultiplier: 2,
			globalMaxConcurrent: 5,
		},
		circuitBreaker: {
			failureThreshold: 5,
			windowMs: 600_000,
			cooldownMs: 300_000,
			halfOpenMaxProbes: 2,
		},
		reroute: {
			enabled: false,
			maxReroutes: 2,
		},
	},
	healthPolicy: {
		enabled: false,
		dryRun: false,
		rules: [],
		defaultCooldownMs: 300_000, // 5 minutes
		evaluationIntervalMs: 60_000, // 1 minute
		maxPauseDurationMs: 600_000, // 10 minutes
	},
	context: {
		enabled: true,
		cachePath: ".overstory/project-context.json",
	},
};

const CONFIG_FILENAME = "config.yaml";
const CONFIG_LOCAL_FILENAME = "config.local.yaml";
const OVERSTORY_DIR = ".overstory";

/**
 * Validate that a config object has the required structure and sane values.
 * Throws ValidationError on failure.
 */
function validateConfig(config: OverstoryConfig): void {
	// project.root is required and must be a non-empty string
	if (!config.project.root || typeof config.project.root !== "string") {
		throw new ValidationError("project.root is required and must be a non-empty string", {
			field: "project.root",
			value: config.project.root,
		});
	}

	// project.canonicalBranch must be a non-empty string
	if (!config.project.canonicalBranch || typeof config.project.canonicalBranch !== "string") {
		throw new ValidationError(
			"project.canonicalBranch is required and must be a non-empty string",
			{
				field: "project.canonicalBranch",
				value: config.project.canonicalBranch,
			},
		);
	}

	// agents.maxConcurrent must be a positive integer
	if (!Number.isInteger(config.agents.maxConcurrent) || config.agents.maxConcurrent < 1) {
		throw new ValidationError("agents.maxConcurrent must be a positive integer", {
			field: "agents.maxConcurrent",
			value: config.agents.maxConcurrent,
		});
	}

	// agents.maxDepth must be a non-negative integer
	if (!Number.isInteger(config.agents.maxDepth) || config.agents.maxDepth < 0) {
		throw new ValidationError("agents.maxDepth must be a non-negative integer", {
			field: "agents.maxDepth",
			value: config.agents.maxDepth,
		});
	}

	// agents.staggerDelayMs must be non-negative
	if (config.agents.staggerDelayMs < 0) {
		throw new ValidationError("agents.staggerDelayMs must be non-negative", {
			field: "agents.staggerDelayMs",
			value: config.agents.staggerDelayMs,
		});
	}

	// agents.maxSessionsPerRun must be a non-negative integer (0 = unlimited)
	if (!Number.isInteger(config.agents.maxSessionsPerRun) || config.agents.maxSessionsPerRun < 0) {
		throw new ValidationError(
			"agents.maxSessionsPerRun must be a non-negative integer (0 = unlimited)",
			{
				field: "agents.maxSessionsPerRun",
				value: config.agents.maxSessionsPerRun,
			},
		);
	}

	// agents.maxAgentsPerLead must be a non-negative integer (0 = unlimited)
	if (!Number.isInteger(config.agents.maxAgentsPerLead) || config.agents.maxAgentsPerLead < 0) {
		throw new ValidationError(
			"agents.maxAgentsPerLead must be a non-negative integer (0 = unlimited)",
			{
				field: "agents.maxAgentsPerLead",
				value: config.agents.maxAgentsPerLead,
			},
		);
	}

	// watchdog intervals must be positive if enabled
	if (config.watchdog.tier0Enabled && config.watchdog.tier0IntervalMs <= 0) {
		throw new ValidationError("watchdog.tier0IntervalMs must be positive when tier0 is enabled", {
			field: "watchdog.tier0IntervalMs",
			value: config.watchdog.tier0IntervalMs,
		});
	}

	if (config.watchdog.nudgeIntervalMs <= 0) {
		throw new ValidationError("watchdog.nudgeIntervalMs must be positive", {
			field: "watchdog.nudgeIntervalMs",
			value: config.watchdog.nudgeIntervalMs,
		});
	}

	if (config.watchdog.staleThresholdMs <= 0) {
		throw new ValidationError("watchdog.staleThresholdMs must be positive", {
			field: "watchdog.staleThresholdMs",
			value: config.watchdog.staleThresholdMs,
		});
	}

	if (config.watchdog.zombieThresholdMs <= config.watchdog.staleThresholdMs) {
		throw new ValidationError("watchdog.zombieThresholdMs must be greater than staleThresholdMs", {
			field: "watchdog.zombieThresholdMs",
			value: config.watchdog.zombieThresholdMs,
		});
	}

	// mulch.primeFormat must be one of the valid options
	const validFormats = ["markdown", "xml", "json"] as const;
	if (!validFormats.includes(config.mulch.primeFormat as (typeof validFormats)[number])) {
		throw new ValidationError(`mulch.primeFormat must be one of: ${validFormats.join(", ")}`, {
			field: "mulch.primeFormat",
			value: config.mulch.primeFormat,
		});
	}

	// mulch.semantic.provider must be one of the valid options (if semantic is configured)
	if (config.mulch.semantic !== undefined) {
		const validProviders = ["sentence-transformers", "openai", "ollama"] as const;
		if (
			!validProviders.includes(config.mulch.semantic.provider as (typeof validProviders)[number])
		) {
			throw new ValidationError(
				`mulch.semantic.provider must be one of: ${validProviders.join(", ")}`,
				{
					field: "mulch.semantic.provider",
					value: config.mulch.semantic.provider,
				},
			);
		}
		if (!config.mulch.semantic.model || typeof config.mulch.semantic.model !== "string") {
			throw new ValidationError("mulch.semantic.model must be a non-empty string", {
				field: "mulch.semantic.model",
				value: config.mulch.semantic.model,
			});
		}
	}

	// taskTracker.backend must be one of the valid options
	const validBackends = ["auto", "seeds", "beads", "github"] as const;
	if (!validBackends.includes(config.taskTracker.backend as (typeof validBackends)[number])) {
		throw new ValidationError(`taskTracker.backend must be one of: ${validBackends.join(", ")}`, {
			field: "taskTracker.backend",
			value: config.taskTracker.backend,
		});
	}

	// taskTracker.github: validate poller config if present
	if (config.taskTracker.github !== undefined) {
		const gh = config.taskTracker.github;
		if (gh.pollIntervalMs <= 0) {
			throw new ValidationError("taskTracker.github.pollIntervalMs must be positive", {
				field: "taskTracker.github.pollIntervalMs",
				value: gh.pollIntervalMs,
			});
		}
		if (!gh.readyLabel || typeof gh.readyLabel !== "string") {
			throw new ValidationError("taskTracker.github.readyLabel must be a non-empty string", {
				field: "taskTracker.github.readyLabel",
				value: gh.readyLabel,
			});
		}
		if (!gh.activeLabel || typeof gh.activeLabel !== "string") {
			throw new ValidationError("taskTracker.github.activeLabel must be a non-empty string", {
				field: "taskTracker.github.activeLabel",
				value: gh.activeLabel,
			});
		}
		if (!Number.isInteger(gh.maxConcurrent) || gh.maxConcurrent < 1) {
			throw new ValidationError("taskTracker.github.maxConcurrent must be a positive integer", {
				field: "taskTracker.github.maxConcurrent",
				value: gh.maxConcurrent,
			});
		}
	}

	// coordinator.autoPull: must be boolean if present
	if (
		config.coordinator?.autoPull !== undefined &&
		typeof config.coordinator.autoPull !== "boolean"
	) {
		throw new ValidationError("coordinator.autoPull must be a boolean", {
			field: "coordinator.autoPull",
			value: config.coordinator.autoPull,
		});
	}

	// providers: validate each entry
	const validProviderTypes = ["native", "gateway"];
	for (const [name, provider] of Object.entries(config.providers)) {
		const p = provider as unknown;
		if (p === null || typeof p !== "object") {
			throw new ValidationError(`providers.${name} must be an object`, {
				field: `providers.${name}`,
				value: p,
			});
		}
		if (!validProviderTypes.includes(provider.type)) {
			throw new ValidationError(
				`providers.${name}.type must be one of: ${validProviderTypes.join(", ")}`,
				{
					field: `providers.${name}.type`,
					value: provider.type,
				},
			);
		}
		if (provider.type === "gateway") {
			if (!provider.baseUrl || typeof provider.baseUrl !== "string") {
				throw new ValidationError(`providers.${name}.baseUrl is required for gateway providers`, {
					field: `providers.${name}.baseUrl`,
					value: provider.baseUrl,
				});
			}
			if (!provider.authTokenEnv || typeof provider.authTokenEnv !== "string") {
				throw new ValidationError(
					`providers.${name}.authTokenEnv is required for gateway providers`,
					{
						field: `providers.${name}.authTokenEnv`,
						value: provider.authTokenEnv,
					},
				);
			}
		}
	}

	// qualityGates: if present, validate each entry
	if (config.project.qualityGates) {
		for (let i = 0; i < config.project.qualityGates.length; i++) {
			const gate = config.project.qualityGates[i];
			if (!gate) continue;
			if (!gate.name || typeof gate.name !== "string") {
				throw new ValidationError(`project.qualityGates[${i}].name must be a non-empty string`, {
					field: `project.qualityGates[${i}].name`,
					value: gate.name,
				});
			}
			if (!gate.command || typeof gate.command !== "string") {
				throw new ValidationError(`project.qualityGates[${i}].command must be a non-empty string`, {
					field: `project.qualityGates[${i}].command`,
					value: gate.command,
				});
			}
			if (!gate.description || typeof gate.description !== "string") {
				throw new ValidationError(
					`project.qualityGates[${i}].description must be a non-empty string`,
					{
						field: `project.qualityGates[${i}].description`,
						value: gate.description,
					},
				);
			}
		}
	}

	// coordinator.exitTriggers: validate all three flags are booleans if present
	if (config.coordinator?.exitTriggers !== undefined) {
		const et = config.coordinator.exitTriggers;
		for (const key of ["allAgentsDone", "taskTrackerEmpty", "onShutdownSignal"] as const) {
			if (typeof et[key] !== "boolean") {
				throw new ValidationError(`coordinator.exitTriggers.${key} must be a boolean`, {
					field: `coordinator.exitTriggers.${key}`,
					value: et[key],
				});
			}
		}
	}

	// runtime.default must be a string if present
	if (config.runtime !== undefined && typeof config.runtime.default !== "string") {
		process.stderr.write(
			`[overstory] WARNING: runtime.default must be a string. Got: ${typeof config.runtime.default}. Ignoring.\n`,
		);
	}

	// runtime.pi: validate provider and modelMap if present
	if (config.runtime?.pi) {
		const pi = config.runtime.pi;
		if (!pi.provider || typeof pi.provider !== "string") {
			throw new ValidationError("runtime.pi.provider must be a non-empty string", {
				field: "runtime.pi.provider",
				value: pi.provider,
			});
		}
		if (pi.modelMap && typeof pi.modelMap === "object") {
			for (const [alias, qualified] of Object.entries(pi.modelMap)) {
				if (!qualified || typeof qualified !== "string") {
					throw new ValidationError(`runtime.pi.modelMap.${alias} must be a non-empty string`, {
						field: `runtime.pi.modelMap.${alias}`,
						value: qualified,
					});
				}
			}
		}
	}

	// runtime.shellInitDelayMs: validate if present
	if (config.runtime?.shellInitDelayMs !== undefined) {
		const delay = config.runtime.shellInitDelayMs;
		if (typeof delay !== "number" || delay < 0 || !Number.isFinite(delay)) {
			process.stderr.write(
				`[overstory] WARNING: runtime.shellInitDelayMs must be a non-negative number. Got: ${delay}. Using default (0).\n`,
			);
			config.runtime.shellInitDelayMs = 0;
		} else if (delay > 30_000) {
			process.stderr.write(
				`[overstory] WARNING: runtime.shellInitDelayMs is ${delay}ms (>${30}s). This adds delay before every agent spawn. Consider a lower value.\n`,
			);
		}
	}

	if (config.runtime?.capabilities) {
		for (const [cap, runtimeName] of Object.entries(config.runtime.capabilities)) {
			if (runtimeName !== undefined && (typeof runtimeName !== "string" || runtimeName === "")) {
				throw new ValidationError(`runtime.capabilities.${cap} must be a non-empty string`, {
					field: `runtime.capabilities.${cap}`,
					value: runtimeName,
				});
			}
		}
	}

	// resilience: validate fields if section is present
	if (config.resilience !== undefined) {
		const r = config.resilience;
		if (r.retry !== undefined) {
			const rt = r.retry;
			if (
				rt.maxAttempts !== undefined &&
				(!Number.isInteger(rt.maxAttempts) || rt.maxAttempts < 1)
			) {
				throw new ValidationError("resilience.retry.maxAttempts must be a positive integer", {
					field: "resilience.retry.maxAttempts",
					value: rt.maxAttempts,
				});
			}
			if (
				rt.backoffBaseMs !== undefined &&
				(typeof rt.backoffBaseMs !== "number" || rt.backoffBaseMs <= 0)
			) {
				throw new ValidationError("resilience.retry.backoffBaseMs must be a positive number", {
					field: "resilience.retry.backoffBaseMs",
					value: rt.backoffBaseMs,
				});
			}
			if (
				rt.backoffMaxMs !== undefined &&
				(typeof rt.backoffMaxMs !== "number" || rt.backoffMaxMs <= 0)
			) {
				throw new ValidationError("resilience.retry.backoffMaxMs must be a positive number", {
					field: "resilience.retry.backoffMaxMs",
					value: rt.backoffMaxMs,
				});
			}
			if (
				rt.backoffBaseMs !== undefined &&
				rt.backoffMaxMs !== undefined &&
				rt.backoffMaxMs < rt.backoffBaseMs
			) {
				throw new ValidationError(
					"resilience.retry.backoffMaxMs must be >= resilience.retry.backoffBaseMs",
					{
						field: "resilience.retry.backoffMaxMs",
						value: rt.backoffMaxMs,
					},
				);
			}
			if (
				rt.backoffMultiplier !== undefined &&
				(typeof rt.backoffMultiplier !== "number" || rt.backoffMultiplier <= 0)
			) {
				throw new ValidationError("resilience.retry.backoffMultiplier must be a positive number", {
					field: "resilience.retry.backoffMultiplier",
					value: rt.backoffMultiplier,
				});
			}
			if (
				rt.globalMaxConcurrent !== undefined &&
				(!Number.isInteger(rt.globalMaxConcurrent) || rt.globalMaxConcurrent < 1)
			) {
				throw new ValidationError(
					"resilience.retry.globalMaxConcurrent must be a positive integer",
					{
						field: "resilience.retry.globalMaxConcurrent",
						value: rt.globalMaxConcurrent,
					},
				);
			}
		}
		if (r.circuitBreaker !== undefined) {
			const cb = r.circuitBreaker;
			if (
				cb.failureThreshold !== undefined &&
				(!Number.isInteger(cb.failureThreshold) || cb.failureThreshold < 1)
			) {
				throw new ValidationError(
					"resilience.circuitBreaker.failureThreshold must be a positive integer",
					{
						field: "resilience.circuitBreaker.failureThreshold",
						value: cb.failureThreshold,
					},
				);
			}
			if (cb.windowMs !== undefined && (typeof cb.windowMs !== "number" || cb.windowMs <= 0)) {
				throw new ValidationError("resilience.circuitBreaker.windowMs must be a positive number", {
					field: "resilience.circuitBreaker.windowMs",
					value: cb.windowMs,
				});
			}
			if (
				cb.cooldownMs !== undefined &&
				(typeof cb.cooldownMs !== "number" || cb.cooldownMs <= 0)
			) {
				throw new ValidationError(
					"resilience.circuitBreaker.cooldownMs must be a positive number",
					{
						field: "resilience.circuitBreaker.cooldownMs",
						value: cb.cooldownMs,
					},
				);
			}
			if (
				cb.halfOpenMaxProbes !== undefined &&
				(!Number.isInteger(cb.halfOpenMaxProbes) || cb.halfOpenMaxProbes < 1)
			) {
				throw new ValidationError(
					"resilience.circuitBreaker.halfOpenMaxProbes must be a positive integer",
					{
						field: "resilience.circuitBreaker.halfOpenMaxProbes",
						value: cb.halfOpenMaxProbes,
					},
				);
			}
		}
		if (r.reroute !== undefined) {
			const rr = r.reroute;
			if (
				rr.maxReroutes !== undefined &&
				(!Number.isInteger(rr.maxReroutes) || rr.maxReroutes < 0)
			) {
				throw new ValidationError("resilience.reroute.maxReroutes must be a non-negative integer", {
					field: "resilience.reroute.maxReroutes",
					value: rr.maxReroutes,
				});
			}
		}
	}

	// headroom.throttle: validate thresholds if present
	if (config.headroom?.throttle !== undefined) {
		const t = config.headroom.throttle;
		if (
			t.slowThresholdPercent !== undefined &&
			(typeof t.slowThresholdPercent !== "number" ||
				t.slowThresholdPercent < 0 ||
				t.slowThresholdPercent > 100)
		) {
			throw new ValidationError(
				"headroom.throttle.slowThresholdPercent must be a number between 0 and 100",
				{
					field: "headroom.throttle.slowThresholdPercent",
					value: t.slowThresholdPercent,
				},
			);
		}
		if (
			t.pauseThresholdPercent !== undefined &&
			(typeof t.pauseThresholdPercent !== "number" ||
				t.pauseThresholdPercent < 0 ||
				t.pauseThresholdPercent > 100)
		) {
			throw new ValidationError(
				"headroom.throttle.pauseThresholdPercent must be a number between 0 and 100",
				{
					field: "headroom.throttle.pauseThresholdPercent",
					value: t.pauseThresholdPercent,
				},
			);
		}
		if (
			t.slowThresholdPercent !== undefined &&
			t.pauseThresholdPercent !== undefined &&
			t.pauseThresholdPercent >= t.slowThresholdPercent
		) {
			throw new ValidationError(
				"headroom.throttle.pauseThresholdPercent must be less than slowThresholdPercent",
				{
					field: "headroom.throttle.pauseThresholdPercent",
					value: t.pauseThresholdPercent,
				},
			);
		}
	}

	// models: validate each value.
	// - Standard runtimes: aliases (sonnet/opus/haiku) or provider-prefixed refs.
	// - Codex runtime: also allow bare model refs (e.g. gpt-5.3-codex).
	const validAliases = ["sonnet", "opus", "haiku"];
	const toolHeavyRoles = ["builder", "scout"];
	const defaultRuntime = config.runtime?.default ?? "claude";
	const allowBareModelRefs = defaultRuntime === "codex";
	for (const [role, model] of Object.entries(config.models)) {
		if (model === undefined) continue;
		if (model.includes("/")) {
			// Provider-prefixed ref: validate the provider name exists
			const providerName = model.split("/")[0] ?? "";
			if (!providerName || !(providerName in config.providers)) {
				throw new ValidationError(
					`models.${role} references unknown provider '${providerName}'. Add it to the providers section first.`,
					{
						field: `models.${role}`,
						value: model,
					},
				);
			}
			if (toolHeavyRoles.includes(role)) {
				const warnKey = `non-anthropic:${role}:${model}`;
				if (!_warnedOnce.has(warnKey)) {
					_warnedOnce.add(warnKey);
					process.stderr.write(
						`[overstory] WARNING: models.${role} uses non-Anthropic model '${model}'. Tool-use compatibility cannot be verified at config time.\n`,
					);
				}
			}
		} else {
			// Must be a valid alias unless codex runtime is active.
			if (!validAliases.includes(model)) {
				if (allowBareModelRefs) {
					if (toolHeavyRoles.includes(role)) {
						process.stderr.write(
							`[overstory] WARNING: models.${role} uses non-Anthropic model '${model}'. Tool-use compatibility cannot be verified at config time.\n`,
						);
					}
					continue;
				}
				throw new ValidationError(
					`models.${role} must be a valid alias (${validAliases.join(", ")}) or a provider-prefixed ref (e.g., openrouter/openai/gpt-4)`,
					{
						field: `models.${role}`,
						value: model,
					},
				);
			}
		}
	}

	// healthPolicy: validate semantic constraints if section is present
	if (config.healthPolicy !== undefined) {
		const hp = config.healthPolicy;

		const validActions: PolicyAction[] = [
			"pause_spawning",
			"resume_spawning",
			"prioritize_merger",
			"escalate_mission_refresh",
			"trigger_recovery",
		];
		const validOperators: PolicyConditionOperator[] = ["lt", "lte", "eq", "gt", "gte"];
		const validGrades = ["A", "B", "C", "D", "F"];

		if (hp.defaultCooldownMs <= 0) {
			throw new ValidationError("healthPolicy.defaultCooldownMs must be positive", {
				field: "healthPolicy.defaultCooldownMs",
				value: hp.defaultCooldownMs,
			});
		}

		if (hp.evaluationIntervalMs <= 0) {
			throw new ValidationError("healthPolicy.evaluationIntervalMs must be positive", {
				field: "healthPolicy.evaluationIntervalMs",
				value: hp.evaluationIntervalMs,
			});
		}

		if (hp.maxPauseDurationMs <= 0) {
			throw new ValidationError("healthPolicy.maxPauseDurationMs must be positive", {
				field: "healthPolicy.maxPauseDurationMs",
				value: hp.maxPauseDurationMs,
			});
		}

		const seenIds = new Set<string>();
		for (let i = 0; i < hp.rules.length; i++) {
			const rule = hp.rules[i];
			if (!rule) continue;

			if (!rule.id || typeof rule.id !== "string") {
				throw new ValidationError(`healthPolicy.rules[${i}].id must be a non-empty string`, {
					field: `healthPolicy.rules[${i}].id`,
					value: rule.id,
				});
			}
			if (seenIds.has(rule.id)) {
				throw new ValidationError(
					`healthPolicy.rules[${i}].id '${rule.id}' is a duplicate. Rule IDs must be unique.`,
					{ field: `healthPolicy.rules[${i}].id`, value: rule.id },
				);
			}
			seenIds.add(rule.id);

			if (!validActions.includes(rule.action as PolicyAction)) {
				throw new ValidationError(
					`healthPolicy.rules[${i}].action must be one of: ${validActions.join(", ")}`,
					{ field: `healthPolicy.rules[${i}].action`, value: rule.action },
				);
			}

			if (rule.cooldownMs <= 0) {
				throw new ValidationError(`healthPolicy.rules[${i}].cooldownMs must be positive`, {
					field: `healthPolicy.rules[${i}].cooldownMs`,
					value: rule.cooldownMs,
				});
			}

			const cond = rule.condition;
			if (
				cond.operator !== undefined &&
				!validOperators.includes(cond.operator as PolicyConditionOperator)
			) {
				throw new ValidationError(
					`healthPolicy.rules[${i}].condition.operator must be one of: ${validOperators.join(", ")}`,
					{ field: `healthPolicy.rules[${i}].condition.operator`, value: cond.operator },
				);
			}

			if (
				cond.factor !== undefined &&
				!(KNOWN_FACTORS as readonly string[]).includes(cond.factor)
			) {
				throw new ValidationError(
					`healthPolicy.rules[${i}].condition.factor '${cond.factor}' is not a known factor. Valid: ${KNOWN_FACTORS.join(", ")}`,
					{ field: `healthPolicy.rules[${i}].condition.factor`, value: cond.factor },
				);
			}

			if (cond.grade !== undefined && !validGrades.includes(cond.grade)) {
				throw new ValidationError(
					`healthPolicy.rules[${i}].condition.grade must be one of: ${validGrades.join(", ")}`,
					{ field: `healthPolicy.rules[${i}].condition.grade`, value: cond.grade },
				);
			}
		}
	}
}

/**
 * Load and merge config.local.yaml on top of the current config.
 *
 * config.local.yaml is gitignored and provides machine-specific overrides
 * (e.g., maxConcurrent for weaker hardware) without dirtying the worktree.
 *
 * Merge order: DEFAULT_CONFIG <- config.yaml <- config.local.yaml
 */
async function mergeLocalConfig(
	resolvedRoot: string,
	config: OverstoryConfig,
): Promise<OverstoryConfig> {
	const localPath = join(resolvedRoot, OVERSTORY_DIR, CONFIG_LOCAL_FILENAME);
	const localFile = Bun.file(localPath);

	if (!(await localFile.exists())) {
		return config;
	}

	let text: string;
	try {
		text = await localFile.text();
	} catch (err) {
		throw new ConfigError(`Failed to read local config file: ${localPath}`, {
			configPath: localPath,
			cause: err instanceof Error ? err : undefined,
		});
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = parseYaml(text);
	} catch (err) {
		throw new ConfigError(`Failed to parse YAML in local config file: ${localPath}`, {
			configPath: localPath,
			cause: err instanceof Error ? err : undefined,
		});
	}

	migrateDeprecatedWatchdogKeys(parsed);
	migrateDeprecatedTaskTrackerKeys(parsed);
	validateUnknownFields(parsed);

	return deepMerge(
		config as unknown as Record<string, unknown>,
		parsed,
	) as unknown as OverstoryConfig;
}

/**
 * Resolve the actual project root, handling git worktrees.
 *
 * When running from inside a git worktree (e.g., an agent's worktree at
 * `.overstory/worktrees/{name}/`), the passed directory won't contain
 * `.overstory/config.yaml`. This function detects worktrees using
 * `git rev-parse --git-common-dir` and resolves to the main repository root.
 *
 * @param startDir - The initial directory (usually process.cwd())
 * @returns The resolved project root containing `.overstory/`
 */
export async function resolveProjectRoot(startDir: string): Promise<string> {
	// Check for explicit override first (set by --project global flag)
	if (_projectRootOverride !== undefined) {
		return _projectRootOverride;
	}

	const { existsSync } = require("node:fs") as typeof import("node:fs");

	// Check git worktree FIRST. When running from an agent worktree
	// (e.g., .overstory/worktrees/{name}/), the worktree may contain
	// tracked copies of .overstory/config.yaml. We must resolve to the
	// main repository root so runtime state (mail.db, metrics.db, etc.)
	// is shared across all agents, not siloed per worktree.
	try {
		const proc = Bun.spawn(["git", "rev-parse", "--git-common-dir"], {
			cwd: startDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode === 0) {
			const gitCommonDir = (await new Response(proc.stdout).text()).trim();
			const absGitCommon = resolve(startDir, gitCommonDir);
			// Main repo root is the parent of the .git directory
			const mainRoot = dirname(absGitCommon);
			// If mainRoot differs from startDir, we're in a worktree — resolve to canonical root
			if (mainRoot !== startDir && existsSync(join(mainRoot, OVERSTORY_DIR, CONFIG_FILENAME))) {
				return mainRoot;
			}
		}
	} catch {
		// git not available, fall through
	}

	// Not inside a worktree (or git not available).
	// Check if .overstory/config.yaml exists at startDir.
	if (existsSync(join(startDir, OVERSTORY_DIR, CONFIG_FILENAME))) {
		return startDir;
	}

	// Fallback to the start directory
	return startDir;
}

/**
 * Load the overstory configuration for a project.
 *
 * Reads `.overstory/config.yaml` from the project root, parses it,
 * merges with defaults, and validates the result.
 *
 * Automatically resolves the project root when running inside a git worktree.
 *
 * @param projectRoot - Absolute path to the target project root (or worktree)
 * @returns Fully populated and validated OverstoryConfig
 * @throws ConfigError if the file cannot be read or parsed
 * @throws ValidationError if the merged config fails validation
 */
export async function loadConfig(projectRoot: string): Promise<OverstoryConfig> {
	// Resolve the actual project root (handles git worktrees)
	const resolvedRoot = await resolveProjectRoot(projectRoot);

	const configPath = join(resolvedRoot, OVERSTORY_DIR, CONFIG_FILENAME);

	// Start with defaults, setting the project root
	const defaults = structuredClone(DEFAULT_CONFIG);
	defaults.project.root = resolvedRoot;
	defaults.project.name = resolvedRoot.split("/").pop() ?? "unknown";

	// Try to read the config file
	const file = Bun.file(configPath);
	const exists = await file.exists();

	if (!exists) {
		// No config file — use defaults, but still check for local overrides
		let config = defaults;
		config = await mergeLocalConfig(resolvedRoot, config);
		config.project.root = resolvedRoot;
		validateConfig(config);
		return config;
	}

	let text: string;
	try {
		text = await file.text();
	} catch (err) {
		throw new ConfigError(`Failed to read config file: ${configPath}`, {
			configPath,
			cause: err instanceof Error ? err : undefined,
		});
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = parseYaml(text);
	} catch (err) {
		throw new ConfigError(`Failed to parse YAML in config file: ${configPath}`, {
			configPath,
			cause: err instanceof Error ? err : undefined,
		});
	}

	// Backward compatibility: migrate deprecated watchdog tier key names.
	// Old naming: tier1 = mechanical daemon, tier2 = AI triage
	// New naming: tier0 = mechanical daemon, tier1 = AI triage, tier2 = monitor agent
	migrateDeprecatedWatchdogKeys(parsed);
	migrateDeprecatedTaskTrackerKeys(parsed);

	// Detect version, validate unknown fields, then migrate to latest format.
	const configVersion = detectConfigVersion(parsed);
	validateUnknownFields(parsed);
	const { migrated } = migrateToLatest(parsed, configVersion);

	// Deep merge parsed config over defaults
	let merged = deepMerge(
		defaults as unknown as Record<string, unknown>,
		migrated,
	) as unknown as OverstoryConfig;

	// Record detected version on the config object for doctor / observability.
	merged.configVersion = configVersion;

	// Check for config.local.yaml (local overrides, gitignored)
	merged = await mergeLocalConfig(resolvedRoot, merged);

	// Ensure project.root is always set to the resolved project root
	merged.project.root = resolvedRoot;

	validateConfig(merged);

	return merged;
}
