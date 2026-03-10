# Eval Fixture: dispatch-smoke

This is a minimal fixture repo for the dispatch-smoke eval scenario.

The coordinator should discover available tasks via `sd ready`, dispatch workers
to handle each task, and the workers should complete their assignments.

Each task asks a worker to write a simple text file.
