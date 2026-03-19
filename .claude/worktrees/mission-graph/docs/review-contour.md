# Review Contour

This document is the contributor guide for Overstory's review contour system.
It covers the six scoring dimensions, the three subject types, analyzers,
staleness detection, the ReviewStore, CLI commands, and instructions for
adding new analyzers.

---

## 1. What `ov review` Does

The review contour provides deterministic quality scoring of three kinds of
orchestration artifacts:

- **Sessions** -- completed agent sessions (checkpoint quality, error rates).
- **Handoffs** -- session handoff records (checkpoint completeness, clarity).
- **Specs** -- task specification files (section presence, concreteness).

Each artifact is scored along six dimensions (0--100 each), producing an
overall score and per-dimension details. All scoring is deterministic and
heuristic-based -- no LLM is required.

Reviews are persisted in `.overstory/reviews.db` and can be marked stale when
the underlying agent definitions or templates change.

---

## 2. The Six Dimensions

**Source:** [`src/review/dimensions.ts`](../src/review/dimensions.ts)

```typescript
export type ReviewDimension =
	| "clarity"
	| "actionability"
	| "completeness"
	| "signal-to-noise"
	| "correctness-confidence"
	| "coordination-fit";
```

| Dimension | Label | Question it answers |
|-----------|-------|---------------------|
| `clarity` | Clarity | How clear and unambiguous is the artifact? |
| `actionability` | Actionability | Can someone act on this without further clarification? |
| `completeness` | Completeness | Are all expected sections/fields present? |
| `signal-to-noise` | Signal-to-Noise | How much useful information vs filler? |
| `correctness-confidence` | Correctness Confidence | How confident can we be in the accuracy? |
| `coordination-fit` | Coordination Fit | Does this fit the swarm coordination model? |

### Score type

```typescript
export interface DimensionScore {
	dimension: ReviewDimension;
	score: number;       // 0 (worst) to 100 (best)
	details: string;     // one-line explanation
}
```

### Overall score

The overall review score is the simple average of all dimension scores:

```typescript
export function computeOverallScore(dimensions: DimensionScore[]): number {
	if (dimensions.length === 0) return 0;
	const sum = dimensions.reduce((acc, d) => acc + d.score, 0);
	return Math.round(sum / dimensions.length);
}
```

---

## 3. Subject Types

**Source:** [`src/review/types.ts`](../src/review/types.ts)

```typescript
export type ReviewSubjectType = "session" | "handoff" | "spec";
```

| Type | Artifact reviewed | Data sources |
|------|-------------------|--------------|
| `session` | A completed agent session | SessionStore, EventStore, MailStore, checkpoint files |
| `handoff` | A session handoff record | Checkpoint files (`checkpoint.json`) |
| `spec` | A task specification file | Spec markdown files in `.overstory/specs/` |

---

## 4. Analyzers

Each subject type has a dedicated analyzer that produces an `InsertReviewRecord`
from its input signals.

### Session Analyzer

**Source:** [`src/review/analyzers/session.ts`](../src/review/analyzers/session.ts)

Input:

```typescript
export interface SessionReviewInput {
	session: AgentSession;
	checkpoint: SessionCheckpoint | null;
	eventCount: number;
	errorCount: number;
	nudgeCount: number;
	mailSent: number;
	mailReceived: number;
	durationMs: number;
}
```

Dimension scoring:

| Dimension | Signals used | Scoring logic |
|-----------|-------------|---------------|
| `clarity` | Checkpoint `progressSummary` and `pendingWork` presence | `scorePresence(present, 2)` -- 100 if both fields present |
| `actionability` | `pendingWork` length > 10, `filesModified` non-empty | `scorePresence(present, 2)` |
| `completeness` | Session state `completed`, checkpoint exists, event count > 0 | `scorePresence(present, 3)` |
| `signal-to-noise` | Useful events vs errors and nudges; nudgeCount > 3 penalty | `scorePresence(useful, total)` with -20 for excessive nudges |
| `correctness-confidence` | Error rate (`errorCount / eventCount`) | `round((1 - errorRate) * 100)` |
| `coordination-fit` | Whether agent sent any mail (`mailSent > 0`) | 100 if mail sent, 30 otherwise |

### Handoff Analyzer

**Source:** [`src/review/analyzers/handoff.ts`](../src/review/analyzers/handoff.ts)

Input:

```typescript
export interface HandoffReviewInput {
	handoff: SessionHandoff;
	checkpoint: SessionCheckpoint;
}
```

Dimension scoring:

| Dimension | Signals used | Scoring logic |
|-----------|-------------|---------------|
| `clarity` | `progressSummary` text | `scoreTextQuality(text)` -- heuristic text quality score |
| `actionability` | `pendingWork` length > 10, contains file paths | `scorePresence(present, 2)` |
| `completeness` | `filesModified`, `mulchDomains`, `currentBranch` populated | `scorePresence(present, 3)` |
| `signal-to-noise` | `progressSummary` length (too brief < 20, too long > 2000) | 0/30/50/80 based on length range |
| `correctness-confidence` | Handoff reason is not `crash`, valid agent data present | `scorePresence(present, 2)` |
| `coordination-fit` | `currentBranch` set, `filesModified` count <= 50 | `scorePresence(present, 2)` |

### Spec Analyzer

**Source:** [`src/review/analyzers/spec.ts`](../src/review/analyzers/spec.ts)

Input:

```typescript
export interface SpecReviewInput {
	specPath: string;
	content: string;
}
```

The spec analyzer checks for the presence of markdown sections via regex:

| Section | Pattern |
|---------|---------|
| Objective | `^#{1,3}\s*objective` |
| Acceptance Criteria | `^#{1,3}\s*(acceptance criteria\|criteria)` |
| Files | `^#{1,3}\s*files` |
| Scope | `^#{1,3}\s*(scope\|file scope)` |
| Context | `^#{1,3}\s*context` |
| Dependencies | `^#{1,3}\s*dependencies` |

Dimension scoring:

| Dimension | Signals used | Scoring logic |
|-----------|-------------|---------------|
| `clarity` | Objective section present, concrete references (file paths, backtick refs) | `scorePresence(present, 2)` |
| `actionability` | Acceptance criteria present, file scope present | `scorePresence(present, 2)` |
| `completeness` | Objective + criteria + scope + context sections present | `scorePresence(present, 4)` |
| `signal-to-noise` | Code blocks, bullet points vs total line count | `min(100, round(signalLines / lineCount * 200))` |
| `correctness-confidence` | References `.ts` or `.js` files | 80 if present, 40 otherwise |
| `coordination-fit` | Dependencies section present | 100 if present, 40 otherwise |

---

## 5. Scoring Helpers

**Source:** [`src/review/dimensions.ts`](../src/review/dimensions.ts)

### `scorePresence(present, expected)`

Scores how many of the expected items are present. Returns 0--100.

```typescript
export function scorePresence(present: number, expected: number): number
// scorePresence(2, 3) => 67
// scorePresence(0, 2) => 0
// scorePresence(2, 2) => 100
```

### `scoreTextQuality(text)`

Heuristic text quality scorer. Max 100 points:

| Signal | Points |
|--------|--------|
| Length > 0 | 20 |
| Length > 50 | 10 |
| List markers (`-`, `*`, numbered) | 15 |
| Section headers (`#`, `##`) | 15 |
| Multiple lines | 10 |
| No excessive repetition | 10 |
| Concrete refs (file paths, commands) | 20 |

---

## 6. Staleness Detection

**Source:** [`src/review/staleness.ts`](../src/review/staleness.ts)

Reviews can become stale when the underlying agent definitions or templates
change. Staleness is tracked via SHA-256 hashes of watched files.

### Watched Surfaces

Each subject type has a list of files that, when changed, invalidate reviews
of that type:

```typescript
export const WATCHED_SURFACES: Record<ReviewSubjectType, string[]> = {
	session: [
		"agents/coordinator.md", "agents/lead.md", "agents/builder.md",
		"agents/scout.md", "agents/reviewer.md", "src/agents/overlay.ts",
		"src/agents/hooks-deployer.ts", "templates/overlay.md.tmpl",
	],
	handoff: [
		"src/agents/checkpoint.ts", "src/agents/lifecycle.ts",
		"agents/lead.md", "agents/builder.md",
	],
	spec: [
		"src/commands/spec.ts", "agents/lead.md",
		"templates/overlay.md.tmpl",
	],
};
```

### Detection Flow

```
computeStalenessState(repoRoot, subjectType)
        |
        v
Hash each watched file with SHA-256
(missing files get sentinel "MISSING")
        |
        v
detectStaleness(current, stored)
        |
        v
Compare hashes against previously stored state
Return list of changed file paths
        |
        v
If changes detected:
  store.markStale(subjectType, reason)
        |
        v
store.saveStalenessState(allCurrentHashes)
```

The `checkAndMarkStale()` function runs this flow for all three subject types
in a single call.

---

## 7. ReviewStore

**Source:** [`src/review/store.ts`](../src/review/store.ts)

SQLite-backed store at `.overstory/reviews.db`. Uses WAL mode and 5-second
busy timeout for concurrent agent access.

### Schema

```sql
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('session','handoff','spec')),
  subject_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  dimensions TEXT NOT NULL,      -- JSON array of DimensionScore
  overall_score INTEGER NOT NULL,
  notes TEXT NOT NULL,           -- JSON array of strings
  reviewer_source TEXT NOT NULL DEFAULT 'deterministic',
  stale INTEGER NOT NULL DEFAULT 0,
  stale_since TEXT,
  stale_reason TEXT
);

CREATE TABLE IF NOT EXISTS staleness_state (
  file_path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  captured_at TEXT NOT NULL
);
```

### `ReviewStore` interface

```typescript
export interface ReviewStore {
	insert(record: InsertReviewRecord): ReviewRecord;
	getById(id: string): ReviewRecord | null;
	getByType(subjectType: ReviewSubjectType, opts?: { limit?: number }): ReviewRecord[];
	getLatest(subjectType: ReviewSubjectType, subjectId: string): ReviewRecord | null;
	getStale(): ReviewRecord[];
	markStale(subjectType: ReviewSubjectType, reason: string): number;
	markStaleById(id: string, reason: string): void;
	getSummary(subjectType: ReviewSubjectType, opts?: { limit?: number }): ReviewSummary;
	saveStalenessState(state: StalenessState): void;
	loadStalenessState(): StalenessState | null;
	close(): void;
}
```

---

## 8. CLI Usage

### `ov review sessions`

Review recent completed sessions.

```bash
ov review sessions                  # Review last 10 sessions
ov review sessions --recent 20      # Review last 20
ov review sessions --json           # JSON output
```

Output: table with per-agent scores for all six dimensions.

### `ov review session <session-id>`

Review a single session by agent name or session ID.

```bash
ov review session my-builder        # By agent name
ov review session a1b2c3d4          # By session ID
ov review session my-builder --json
```

Output: overall score, per-dimension breakdown with details, and notes.

### `ov review handoffs`

Review recent session handoffs (from checkpoint files).

```bash
ov review handoffs                  # Review last 10 handoffs
ov review handoffs --recent 5       # Review last 5
ov review handoffs --json
```

### `ov review specs`

Review all spec files in `.overstory/specs/`.

```bash
ov review specs
ov review specs --json
```

Output: table with per-spec scores, plus notes for any issues found.

### `ov review stale`

Check for changed watched surfaces and mark affected reviews as stale.

```bash
ov review stale
ov review stale --json
```

Output: per-subject-type list of changed files, or "all up to date".

---

## 9. `ReviewRecord` Type

**Source:** [`src/review/types.ts`](../src/review/types.ts)

```typescript
export interface ReviewRecord {
	id: string;
	subjectType: ReviewSubjectType;
	subjectId: string;
	timestamp: string;
	dimensions: DimensionScore[];
	overallScore: number;
	notes: string[];
	reviewerSource: "deterministic";
	stale: boolean;
	staleSince: string | null;
	staleReason: string | null;
}
```

---

## 10. Adding New Analyzers (Contributor Guide)

### Step 1: Define the subject type

If this is a new subject type (not `session`, `handoff`, or `spec`), add it
to `ReviewSubjectType` in `src/review/types.ts`:

```typescript
export type ReviewSubjectType = "session" | "handoff" | "spec" | "mytype";
```

Update the SQL CHECK constraint in `src/review/store.ts`:

```sql
CHECK(subject_type IN ('session','handoff','spec','mytype'))
```

### Step 2: Create the analyzer

Create `src/review/analyzers/mytype.ts`:

```typescript
import { computeOverallScore, scorePresence } from "../dimensions.ts";
import type { DimensionScore, InsertReviewRecord } from "../types.ts";

export interface MyTypeReviewInput {
	// Define the input signals your analyzer needs
	name: string;
	content: string;
}

export function analyzeMyType(input: MyTypeReviewInput): InsertReviewRecord {
	const dimensions: DimensionScore[] = [
		{ dimension: "clarity", score: /* ... */, details: "..." },
		{ dimension: "actionability", score: /* ... */, details: "..." },
		{ dimension: "completeness", score: /* ... */, details: "..." },
		{ dimension: "signal-to-noise", score: /* ... */, details: "..." },
		{ dimension: "correctness-confidence", score: /* ... */, details: "..." },
		{ dimension: "coordination-fit", score: /* ... */, details: "..." },
	];

	return {
		subjectType: "mytype",
		subjectId: input.name,
		dimensions,
		overallScore: computeOverallScore(dimensions),
		notes: [],
		reviewerSource: "deterministic",
	};
}
```

Use the scoring helpers from `src/review/dimensions.ts`:

- `scorePresence(present, expected)` -- count-based scoring.
- `scoreTextQuality(text)` -- heuristic text quality.
- `computeOverallScore(dimensions)` -- average of dimension scores.

### Step 3: Add a CLI subcommand

In `src/commands/review.ts`, add a new subcommand:

```typescript
review
	.command("mytypes")
	.description("Review all mytype artifacts")
	.option("--json", "Output as JSON")
	.action(async (opts) => {
		await executeReviewMyTypes(opts);
	});
```

### Step 4: Register watched surfaces

In `src/review/staleness.ts`, add the files that should trigger staleness
for the new subject type:

```typescript
export const WATCHED_SURFACES: Record<ReviewSubjectType, string[]> = {
	// ...existing entries...
	mytype: [
		"src/mymodule/config.ts",
		"templates/mytype.md.tmpl",
	],
};
```

### Step 5: Write tests

Create `src/review/analyzers/mytype.test.ts` with test cases covering:

- All six dimensions produce scores in range 0--100.
- Edge cases (empty input, missing fields).
- Overall score matches the average of dimension scores.
