# Mission Monitoring Protocol

Last Updated: 2026-04-05

Guide for AI agents (orchestrator sessions) monitoring `ov mission` runs.

## Identity

You are **operator**. Coordinator sends messages to `operator`. Always check mail as:
```bash
ov mail check --agent operator
```

Do NOT check other agents' mail (coordinator, mission-analyst, etc.) — that's their private communication.

## Starting a Mission

```bash
ov mission start \
  --slug "feature-name" \
  --objective "Description. Read full spec via: gh issue view <N>." \
  --no-attach
```

- Pass `--no-attach` to stay in your session
- Reference GH issues in objective so coordinator can `gh issue view` it
- No `--spec` or `--issue` flag exists — objective string is the only input

## Monitoring Loop

Poll every 2-3 minutes:
```bash
sleep 120 && ov mail check --agent operator && echo "===" && ov status 2>&1 | grep -E "Agents:|>|Mission:|Pending:|Phase|Exec|Worktrees|Merge"
```

**What to watch:**
- `ov mail check --agent operator` — coordinator sends questions here, must answer to unfreeze
- `ov status` — agent count, phase, pending state
- Mission phases vary by tier (see Tier-Specific Phases below)
- When `Pending: question` + `frozen` — coordinator is waiting for your answer

## Tier-Specific Phases

Mission phases depend on the tier configured for the mission (see `src/missions/engine-wiring.ts` TIER_PHASES):

| Tier | Phases |
|------|--------|
| direct | execute → done |
| planned | understand → plan → execute → done |
| full | understand → align → decide → plan → execute → done |

## Answering Questions

When coordinator sends a question (mission freezes):
```bash
ov mission answer --body "Your answer here"
```

This unfreezes the mission. Common questions:
- Workstream plan approval → "Approved. Proceed."
- Clarification on scope → answer specifically
- Decision on approach → pick one

## What NOT to Do

- Don't read other agents' mail (`--agent coordinator`, `--agent mission-analyst`)
- Don't `ov mail list` to snoop on inter-agent communication
- Don't nudge agents unless they're clearly stuck (15+ min no progress)
- Don't interfere with execution — the mission is autonomous

## Typical Mission Timeline

> This timeline describes the **full** tier. For planned tier, skip align and decide phases. For direct tier, only execute and done phases run.

1. **understand** (5-15 min) — analyst scouts codebase, coordinator reads spec
2. **plan review** (10-20 min) — plan-review-lead spawns critics (devil-advocate, performance-critic, second-opinion), may run multiple rounds
3. **freeze + question** — coordinator sends workstream plan for approval
4. **execute** (30-90 min) — execution-director spawns leads → builders → reviewers per workstream
5. **completion** — coordinator sends final report as status mail to operator

## Status Interpretation

| Field | Meaning |
|-------|---------|
| `Agents: N active` | Running agent count |
| `> name [capability] working \| task \| duration` | Individual agent |
| `Worktrees: N` | Git worktrees in use |
| `Merge queue: N pending` | Branches waiting to merge |
| `Mission: name (state/phase)` | Current state |
| `Pending: question` | YOU need to answer something |
| `frozen` | Mission paused waiting for input |

## Circuit Breakers

If `Open breakers` appears in status — some capabilities are failing (usually quota). Mission works around them but slower.

`Quota Headroom: claude unavailable` means API quota exhausted. Breakers auto-reset when quota recovers.
