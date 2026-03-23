import type { EventType, StoredEvent } from "../events/types.ts";
import type { MailMessage } from "../mail/types.ts";

/** Selects events from the timeline for temporal/count assertions. */
export interface EventSelector {
	eventType: EventType;
	agentName?: string;
	dataMatch?: string; // substring match on event.data
}

/** Assertion kinds supported by the eval framework. */
export type AssertionKind =
	| "min_workers_spawned"
	| "no_zombies"
	| "merge_queue_empty"
	| "tasks_completed"
	| "max_stall_rate"
	| "max_cost"
	| "max_duration_ms"
	| "custom"
	| "before"
	| "after"
	| "within"
	| "event_count"
	| "success_ratio"
	| "percentile_bound"
	| "max_retry_frequency";

/** A single assertion declaration from assertions.yaml. */
export interface Assertion {
	kind: AssertionKind;
	/** Human label (optional, auto-generated from kind if omitted). */
	label?: string;
	/** Threshold or expected value depending on kind. */
	expected: number | boolean | string;
	eventA?: EventSelector;
	eventB?: EventSelector;
	selector?: EventSelector; // for event_count
	windowMs?: number; // for within
	hookPath?: string; // relative to scenario dir, for custom
	metric?: string; // for percentile_bound
	percentile?: number; // for percentile_bound
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
	/** Optional probabilistic trial configuration. */
	trials?: ProbabilisticConfig;
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

/** Full context collected from an eval run's SQLite stores. */
export interface EvalContext {
	metrics: EvalMetrics;
	events: StoredEvent[]; // full timeline from events.db
	mailMessages: MailMessage[]; // all mail from mail.db
	missionEvents: StoredEvent[]; // filtered: eventType === "mission"
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
	context?: EvalContext;
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

/** Config for probabilistic eval runs. */
export interface ProbabilisticConfig {
	/** Number of trials to run. */
	count: number;
	/** Max concurrent trials (default: 1, sequential). */
	maxConcurrent?: number;
}

/** Result of a single trial within a probabilistic run. */
export interface TrialResult {
	/** 0-based trial index. */
	trialIndex: number;
	/** The full single-run eval result. */
	evalResult: EvalResult;
}

/** Aggregate values for a single numeric metric across trials. */
export interface MetricAggregate {
	mean: number;
	median: number;
	min: number;
	max: number;
	p5: number;
	p95: number;
	stddev: number;
}

/** Aggregate statistics computed across all trials. */
export interface AggregateStats {
	trialCount: number;
	passCount: number;
	failCount: number;
	successRatio: number;
	timeoutCount: number;
	/** Per-metric aggregates: mean, median, p5, p95 for each numeric EvalMetrics field. */
	metrics: Record<string, MetricAggregate>;
}

/** Result of evaluating a stochastic assertion across trials. */
export interface StochasticAssertionResult {
	kind: string;
	label: string;
	passed: boolean;
	actual: number;
	expected: number;
	message: string;
}

/** Full result of a probabilistic eval run. */
export interface ProbabilisticEvalResult {
	runId: string;
	scenarioName: string;
	scenarioPath: string;
	startedAt: string;
	completedAt: string;
	totalDurationMs: number;
	config: ProbabilisticConfig;
	trials: TrialResult[];
	aggregateStats: AggregateStats;
	/** Stochastic assertion results (evaluated after all trials). */
	stochasticAssertions: StochasticAssertionResult[];
	/** Overall pass: all stochastic assertions passed. */
	passed: boolean;
}
