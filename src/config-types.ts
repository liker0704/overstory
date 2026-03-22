import type { PlanReviewTier } from "./mail/types.ts";

// === Model & Provider Types ===

/** Backward-compatible model alias for Anthropic models. */
export type ModelAlias = "sonnet" | "opus" | "haiku";

/**
 * A model reference: either a simple alias ('sonnet') or a provider-qualified
 * string ('provider/model', e.g. 'openrouter/openai/gpt-5.3').
 */
export type ModelRef = ModelAlias | (string & {});

/** Configuration for a model provider. */
export interface ProviderConfig {
	type: "native" | "gateway";
	baseUrl?: string;
	authTokenEnv?: string;
}

/** Resolved model with optional provider environment variables. */
export interface ResolvedModel {
	model: string;
	env?: Record<string, string>;
	/** True when the model was explicitly set via config.models[capability]. */
	isExplicitOverride?: boolean;
}

/** Configuration for the Pi runtime's model alias expansion. */
export interface PiRuntimeConfig {
	/** Provider prefix for unqualified model aliases (e.g., "anthropic", "amazon-bedrock"). */
	provider: string;
	/** Maps short aliases (e.g., "opus") to provider-qualified model IDs. */
	modelMap: Record<string, string>;
}

// === Task Tracker ===

/** Backend for the task tracker. Defined here for use in OverstoryConfig. */
export type TaskTrackerBackend = "auto" | "seeds" | "beads" | "github";

/** Configuration for the autonomous GitHub Issues poller. */
export interface GitHubPollerConfig {
	/** How often to poll GitHub for new ready issues, in milliseconds. Default: 30000. */
	pollIntervalMs: number;
	/** GitHub owner/org (auto-detected from git remote if omitted). */
	owner?: string;
	/** GitHub repo name (auto-detected from git remote if omitted). */
	repo?: string;
	/** Label that marks issues as ready to dispatch. Default: 'ov-ready'. */
	readyLabel: string;
	/** Label applied when an issue is claimed for dispatch. Default: 'ov-active'. */
	activeLabel: string;
	/** Maximum number of concurrently dispatched issues. Default: 5. */
	maxConcurrent: number;
}

// === Project Configuration ===

/**
 * Conditions that trigger automatic coordinator shutdown.
 * All triggers default to false for backward compatibility.
 */
export interface CoordinatorExitTriggers {
	/** Exit when all spawned agents have completed and their branches have been merged. */
	allAgentsDone: boolean;
	/** Exit when the task tracker reports no unblocked work (sd/bd ready returns empty). */
	taskTrackerEmpty: boolean;
	/** Exit when a typed shutdown mail is received from an external caller (e.g., greenhouse). */
	onShutdownSignal: boolean;
}

/** A single quality gate command that agents must pass before reporting completion. */
export interface QualityGate {
	/** Display name shown in the overlay (e.g., "Tests"). */
	name: string;
	/** Shell command to run (e.g., "bun test"). */
	command: string;
	/** Human-readable description of what passing means (e.g., "all tests must pass"). */
	description: string;
}

export interface OverstoryConfig {
	/**
	 * Detected config schema version. Set by the loader after reading config.yaml.
	 * 1 = legacy (no explicit version field), 2 = current.
	 * Absent when loadConfig falls back to all defaults (no config file).
	 */
	configVersion?: number;
	project: {
		name: string;
		root: string; // Absolute path to target repo
		canonicalBranch: string; // "main" | "develop"
		qualityGates?: QualityGate[];
		/** Default canopy profile name. Used when --profile is not explicitly passed to sling/coordinator. */
		defaultProfile?: string;
	};
	agents: {
		manifestPath: string; // Path to agent-manifest.json
		baseDir: string; // Path to base agent definitions
		maxConcurrent: number; // Rate limit ceiling
		staggerDelayMs: number; // Delay between spawns
		maxDepth: number; // Hierarchy depth limit (default 2)
		maxSessionsPerRun: number; // Max total sessions per run (0 = unlimited)
		maxAgentsPerLead: number; // Max children a single lead can spawn (0 = unlimited)
	};
	worktrees: {
		baseDir: string; // Where worktrees live
	};
	taskTracker: {
		backend: TaskTrackerBackend; // "auto" | "seeds" | "beads" | "github"
		enabled: boolean;
		/** GitHub Issues poller config (used when backend is "github" or autoPull is enabled). */
		github?: GitHubPollerConfig;
	};
	mulch: {
		enabled: boolean;
		domains: string[]; // Domains to prime (empty = auto-detect)
		primeFormat: "markdown" | "xml" | "json";
	};
	merge: {
		aiResolveEnabled: boolean;
		reimagineEnabled: boolean;
	};
	providers: Record<string, ProviderConfig>;
	watchdog: {
		tier0Enabled: boolean; // Tier 0: Mechanical daemon (heartbeat, tmux/pid liveness)
		tier0IntervalMs: number; // Default 30_000
		tier1Enabled: boolean; // Tier 1: Triage agent (ephemeral AI analysis)
		tier2Enabled: boolean; // Tier 2: Monitor agent (continuous patrol)
		staleThresholdMs: number; // When to consider agent stale
		zombieThresholdMs: number; // When to kill
		nudgeIntervalMs: number; // Time between progressive nudge stages (default 60_000)
	};
	models: Partial<Record<string, ModelRef>>;
	logging: {
		verbose: boolean;
		redactSecrets: boolean;
	};
	coordinator?: {
		/** Conditions that trigger automatic coordinator shutdown. */
		exitTriggers: CoordinatorExitTriggers;
		/** When true, auto-start the GitHub Issues poller on coordinator start. */
		autoPull?: boolean;
	};
	rateLimit?: {
		enabled: boolean;
		behavior: "wait" | "swap" | "kill";
		maxWaitMs: number;
		pollIntervalMs: number;
		notifyCoordinator: boolean;
		swapRuntime?: string;
	};
	runtime?: {
		/** Default runtime adapter name (default: "claude"). */
		default: string;
		/**
		 * Per-capability runtime overrides. Maps capability names (e.g. "coordinator", "builder")
		 * to runtime adapter names. Lookup chain: explicit --runtime flag > capabilities[cap] > default > "claude".
		 */
		capabilities?: Partial<Record<string, string>>;
		/**
		 * Runtime adapter for headless one-shot AI calls (--print mode).
		 * Used by merge/resolver.ts and watchdog/triage.ts.
		 * Falls back to runtime.default when omitted.
		 */
		printCommand?: string;
		/** Pi runtime configuration for model alias expansion. */
		pi?: PiRuntimeConfig;
		/**
		 * Delay in milliseconds between creating a tmux session and polling
		 * for TUI readiness. Gives slow shells (oh-my-zsh, starship, etc.)
		 * time to finish initializing before the agent command starts.
		 * Default: 0 (no delay).
		 */
		shellInitDelayMs?: number;
	};
	mission?: {
		planReview?: {
			/** Whether plan review is enabled. Default: true when in mission mode. */
			enabled: boolean;
			/** Verification depth. Default: "full". */
			tier: PlanReviewTier;
			/** Maximum review rounds before declaring stuck. Default: 3. */
			maxRounds: number;
			/** Model override for critic agents. Default: uses manifest default. */
			criticModel?: ModelRef;
		};
	};
	mail?: {
		reliability?: {
			/** Lease timeout for claimed messages in seconds. Default: 120. */
			leaseTimeoutSec?: number;
			/** Max retry attempts before dead-lettering. Default: 3. */
			maxRetries?: number;
			/** Base backoff delay in milliseconds. Default: 5000. */
			backoffBaseMs?: number;
			/** Maximum backoff delay in milliseconds. Default: 60000. */
			backoffMaxMs?: number;
		};
	};
}
