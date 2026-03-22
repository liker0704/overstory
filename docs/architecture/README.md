# Overstory Architecture Docs

Repository review date: 2026-03-22
Inspected commit: `6359e58`

This folder documents the current architecture of the repository as it exists in code, not only as described in the README.

Quick read:

- [overview.md](./overview.md) — architecture categories, layers, bounded contexts, state surfaces, runtime map, command map.
- [workflows.md](./workflows.md) — end-to-end workflows, sequence diagrams, and how the command families fit together.
- [review.md](./review.md) — architectural review, strengths, risks, and refactor priorities.

Current architectural summary:

1. Overstory is a modular monolith, not a distributed system.
2. The command layer is the application shell. A recent refactoring (Phases 0-4, March 2026) extracted significant orchestration logic from commands into dedicated service modules: `src/missions/*`, `src/dashboard/*`, `src/agents/spawn.ts`, `src/db/migrate.ts`, and `src/process/util.ts`. The shared type kernel was decomposed into 17 domain-specific type files.
3. The runtime-adapter boundary is one of the cleanest parts of the design.
4. `.overstory/` is the operational center of gravity: config, stores, logs, artifacts, worktrees, and pointers all converge there.
5. Remaining architectural risks: `coordinator.ts` command concentration (1,284 LOC), and monitor persistent-root lifecycle consolidation. Shared-kernel coupling and boundary leaks were resolved in the refactoring.
