/** Assertion kinds supported by the eval framework. */
export type AssertionKind =
	| "min_workers_spawned"
	| "no_zombies"
	| "merge_queue_empty"
	| "tasks_completed"
	| "max_stall_rate"
	| "max_cost"
	| "max_duration_ms"
	| "custom";

/** A single assertion declaration from assertions.yaml. */
export interface Assertion {
	kind: AssertionKind;
	/** Human label (optional, auto-generated from kind if omitted). */
	label?: string;
	/** Threshold or expected value depending on kind. */
	expected: number | boolean | string;
}

/** Result of evaluating a single assertion. */
export interface AssertionResult {
	assertion: Assertion;
	passed: boolean;
	actual: number | boolean | string;
	message: string;
}

/** Startup action to run before the eval scenario begins. */
export interface StartupAction {
	/** Shell command to run in the fixture repo. */
	command: string;
	/** Human description. */
	description?: string;
}

/** Config overrides applied to .overstory/config.yaml in the fixture. */
export type ConfigOverrides = Record<string, unknown>;

/** A scenario loaded from disk. */
export interface EvalScenario {
	/** Scenario name (directory name). */
	name: string;
	/** Absolute path to the scenario directory. */
	path: string;
	/** Human description of what this scenario tests. */
	description: string;
	/** Path to repo template directory (absolute). */
	repoTemplatePath: string | null;
	/** Config overrides for the eval run. */
	configOverrides: ConfigOverrides;
	/** Actions to run after fixture setup but before coordinator start. */
	startupActions: StartupAction[];
	/** Timeout in ms for the entire eval run. */
	timeoutMs: number;
	/** Assertions to evaluate after the run. */
	assertions: Assertion[];
}

/** Runtime config for an eval run (combines scenario + CLI options). */
export interface EvalRunConfig {
	scenario: EvalScenario;
	runId: string;
	fixtureRepoPath: string;
	scenarioPath: string;
	timeoutMs?: number;
}

/** Collected metrics from an eval run, derived from existing SQLite stores. */
export interface EvalMetrics {
	/** Total number of agents spawned. */
	totalAgents: number;
	/** Number of agents in completed state. */
	completedAgents: number;
	/** Number of zombie agents detected. */
	zombieCount: number;
	/** Number of stalled agents. */
	stallCount: number;
	/** Stall rate (stalls / total agents, 0 if no agents). */
	stallRate: number;
	/** Merge success count. */
	mergeSuccessCount: number;
	/** Merge conflict count. */
	mergeConflictCount: number;
	/** Merge queue pending entries remaining. */
	mergeQueuePending: number;
	/** Number of tasks that reached completed status. */
	tasksCompleted: number;
	/** Total duration of the eval run in ms. */
	durationMs: number;
	/** Total input tokens across all agents. */
	totalInputTokens: number;
	/** Total output tokens across all agents. */
	totalOutputTokens: number;
	/** Estimated total cost in USD. */
	estimatedCostUsd: number;
	/** Number of nudges sent. */
	nudgesSent: number;
	/** Number of runtime swaps (e.g. watchdog rate-limit swaps). */
	runtimeSwaps: number;
	/** Median session duration in ms across all agents. */
	medianSessionDurationMs: number;
}

/** Final result of an eval run. */
export interface EvalResult {
	runId: string;
	scenarioName: string;
	scenarioPath: string;
	startedAt: string;
	completedAt: string;
	durationMs: number;
	metrics: EvalMetrics;
	assertions: AssertionResult[];
	passed: boolean;
	timedOut: boolean;
	fixtureRoot?: string;
}

/** Paths to artifact files written by the store. */
export interface EvalArtifacts {
	dir: string;
	manifest: string;
	summary: string;
	events: string;
	sessions: string;
	metrics: string;
	assertions: string;
}
