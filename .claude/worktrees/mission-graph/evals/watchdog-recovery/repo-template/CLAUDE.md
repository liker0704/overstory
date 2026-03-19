# Eval Fixture: watchdog-recovery

This fixture tests watchdog detection and coordinator recovery after an agent stalls.

The watchdog is configured with an aggressive stall timeout (30s). A task is created
and dispatched. If the worker stalls, the watchdog should detect it and the coordinator
should recover — either by re-dispatching the task or completing the run gracefully.
