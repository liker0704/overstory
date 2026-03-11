# Operational Health Scoring

This document is the contributor guide for Overstory's health scoring and
recommendation system. It covers signal collection, score computation, the
recommendation engine, CLI commands, and instructions for adding new signals.

---

## 1. What `ov health` and `ov next-improvement` Do

**`ov health`** computes an overall operational health score (0--100) for the
swarm by collecting signals from SessionStore, MetricsStore, and DoctorChecks.
It breaks the score into weighted factors with per-factor explanations and
assigns a letter grade (A through F).

**`ov next-improvement`** uses the same signals and score computation, then
selects the single highest-priority improvement recommendation. The
recommendation is deterministic and rule-based -- no LLM required.

Together they enable a status-next-resolve-verify loop:

```
ov health              # See overall score and factor breakdown
ov next-improvement    # Get the top recommendation
# ... fix the issue ...
ov health              # Verify the score improved
```

---

## 2. Signal Collection

**Source:** [`src/health/signals.ts`](../src/health/signals.ts)

```typescript
export function collectSignals(params: CollectSignalsParams): HealthSignals
```

Signals are gathered from three sources:

| Source | Signals |
|--------|---------|
| `sessions.db` (SessionStore) | `totalActiveSessions`, `stalledSessions`, `zombieSessions`, `bootingSessions`, `workingSessions`, `runtimeSwapCount` |
| `metrics.db` (MetricsStore) | `totalSessionsRecorded`, `completedSessionsRecorded`, `mergeSuccessCount`, `mergeTotalCount`, `averageDurationMs`, `costPerCompletedTask` |
| DoctorChecks (optional) | `doctorFailCount`, `doctorWarnCount` |

Three computed rates are derived:

| Rate | Formula | Default |
|------|---------|---------|
| `completionRate` | `completedSessionsRecorded / totalSessionsRecorded` | `1.0` (no data = healthy) |
| `stalledRate` | `stalledSessions / totalActiveSessions` | `0.0` (no active = not stalled) |
| `mergeSuccessRate` | `mergeSuccessCount / mergeTotalCount` | `1.0` (no merges = healthy) |

All store access is wrapped in try/catch -- missing or corrupt databases
return zero-value defaults so the scorer always produces a result.

### `HealthSignals` type

```typescript
export interface HealthSignals {
	totalActiveSessions: number;
	stalledSessions: number;
	zombieSessions: number;
	bootingSessions: number;
	workingSessions: number;
	runtimeSwapCount: number;
	totalSessionsRecorded: number;
	completedSessionsRecorded: number;
	mergeSuccessCount: number;
	mergeTotalCount: number;
	averageDurationMs: number;
	costPerCompletedTask: number | null;
	doctorFailCount: number;
	doctorWarnCount: number;
	completionRate: number;
	stalledRate: number;
	mergeSuccessRate: number;
	collectedAt: string;
}
```

---

## 3. Score Computation

**Source:** [`src/health/score.ts`](../src/health/score.ts)

```typescript
export function computeScore(signals: HealthSignals): HealthScore
```

### Factor Weights

Six factors, each scored 0--100, combined via fixed weights that sum to 1.0:

| Factor | Weight | Description | Scoring formula |
|--------|--------|-------------|-----------------|
| `completion_rate` | 0.25 | % of recorded sessions that completed | `round(completionRate * 100)` |
| `stalled_rate` | 0.20 | % of active sessions stalled (inverted) | `round((1 - stalledRate * 2) * 100)` |
| `zombie_count` | 0.15 | Raw zombie count (penalized on a curve) | 0 = 100, 1 = 70, 2 = 40, 3+ = 0 |
| `doctor_failures` | 0.20 | Doctor check failures and warnings | `100 - failures*15 - warnings*5` |
| `merge_quality` | 0.10 | % of merges that resolved cleanly | `round(mergeSuccessRate * 100)` |
| `runtime_stability` | 0.10 | Runtime swap rate (inverted) | `round((1 - swapRate/0.25) * 100)` |

### Overall Score

```
overall = clamp(0, 100, round(sum(factor.score * factor.weight)))
```

### Grade Thresholds

| Grade | Minimum score |
|-------|---------------|
| A | 85 |
| B | 70 |
| C | 55 |
| D | 40 |
| F | < 40 |

### `HealthScore` type

```typescript
export interface HealthScore {
	overall: number;
	grade: HealthGrade;
	factors: HealthFactor[];
	collectedAt: string;
	signals: HealthSignals;
}
```

### `HealthFactor` type

```typescript
export interface HealthFactor {
	name: string;
	label: string;
	score: number;
	weight: number;
	contribution: number;
	details: string;
}
```

---

## 4. Recommendation Engine

**Source:** [`src/health/recommendations.ts`](../src/health/recommendations.ts)

```typescript
export function selectRecommendation(score: HealthScore): HealthRecommendation | null
```

### Selection Strategy

1. Each factor has one or more **rules** with a score threshold and priority.
2. A rule **fires** when the factor's score is below the rule's threshold.
3. Fired rules are sorted by: priority descending, then weighted contribution
   ascending (most impactful low-scoring factor wins).
4. The top candidate is selected and its recommendation is returned.
5. If no rules fire, `null` is returned (the swarm is healthy).

### Rule Table

| Factor | Threshold | Priority | Recommendation title |
|--------|-----------|----------|---------------------|
| `zombie_count` | < 100 | critical | Clean up zombie agents |
| `doctor_failures` | < 55 | critical | Fix critical doctor check failures |
| `doctor_failures` | < 85 | medium | Address doctor check warnings |
| `stalled_rate` | < 80 | high | Reduce stalled agent rate |
| `completion_rate` | < 75 | high | Investigate low task completion rate |
| `merge_quality` | < 80 | high | Reduce merge conflicts |
| `runtime_stability` | < 70 | medium | Investigate frequent runtime swaps |
| `completion_rate` | < 90 | low | Monitor task completion trend |

### `HealthRecommendation` type

```typescript
export interface HealthRecommendation {
	title: string;
	whyNow: string;
	expectedImpact: string;
	action: string;
	verificationStep: string;
	priority: "low" | "medium" | "high" | "critical";
	factor: string;
}
```

Each recommendation includes a concrete `action` (command to run or config
change) and a `verificationStep` to confirm the improvement worked.

---

## 5. CLI Usage

### `ov health`

```bash
ov health                           # Human-readable score + factor breakdown
ov health --json                    # JSON output
ov health --compare snapshot.json   # Compare against a previous snapshot
```

Output includes:

- Overall score and grade.
- Factor breakdown sorted worst-first, with per-factor score bars.
- Optional delta against a previous snapshot.

### `ov next-improvement`

```bash
ov next-improvement                 # Top recommendation
ov next-improvement --all           # All fired recommendations
ov next-improvement --json          # JSON output
```

Output for each recommendation includes: title, factor, priority, why now,
expected impact, action, and verification step.

### Options

| Flag | Command | Description |
|------|---------|-------------|
| `--json` | Both | JSON output |
| `--run <id>` | Both | Scope to a specific run (informational) |
| `--compare <path>` | `ov health` | Compare against a snapshot JSON file |
| `--all` | `ov next-improvement` | Show all recommendations |

---

## 6. Snapshots

**Source:** [`src/health/types.ts`](../src/health/types.ts) (`HealthSnapshot`)

```typescript
export interface HealthSnapshot {
	score: HealthScore;
	recommendation: HealthRecommendation | null;
	savedAt: string;
}
```

Snapshots can be saved to `.overstory/health/` and used for historical
comparison via `ov health --compare <path>`.

---

## 7. Adding New Signals (Contributor Guide)

### Step 1: Add the signal field

In `src/health/types.ts`, add the new field to `HealthSignals`:

```typescript
export interface HealthSignals {
	// ...existing fields...
	/** Number of failed quality gate runs. */
	qualityGateFailures: number;
}
```

### Step 2: Collect the signal

In `src/health/signals.ts`, add data extraction logic in `collectSignals()`:

```typescript
let qualityGateFailures = 0;
// Read from the appropriate SQLite database or data source
// ...
return {
	// ...existing signals...
	qualityGateFailures,
};
```

### Step 3: Add a scoring factor

In `src/health/score.ts`, create a scoring function and add it to the
`computeScore()` factors array:

```typescript
function scoreQualityGates(signals: HealthSignals): HealthFactor {
	const score = clamp100(100 - signals.qualityGateFailures * 20);
	return {
		name: "quality_gates",
		label: "Quality Gates",
		score,
		weight: 0.10,  // Adjust existing weights to sum to 1.0
		contribution: score * 0.10,
		details: `${signals.qualityGateFailures} quality gate failures`,
	};
}
```

When adding a new factor, you must adjust the existing weights so they
continue to sum to 1.0.

### Step 4: Add a recommendation rule

In `src/health/recommendations.ts`, add a rule to the `RULES` array:

```typescript
{
	factor: "quality_gates",
	threshold: 80,
	priority: "high",
	build: (f) => ({
		title: "Fix quality gate failures",
		whyNow: `${f.details}. Failing quality gates block agent completion.`,
		expectedImpact: "Higher completion rate and fewer wasted agent sessions.",
		action: "Run `ov doctor --category quality-gates` to diagnose failures.",
		verificationStep: "Re-run `ov health` and confirm quality_gates score improved.",
	}),
},
```

### Step 5: Write tests

Add test cases to `src/health/score.test.ts`, `src/health/signals.test.ts`,
and `src/health/recommendations.test.ts`.
