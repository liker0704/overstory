# Mission E2E Smoke (v6)

The `ov mission` pipeline provides end-to-end orchestration for multi-agent mission execution. It covers mission creation (`ov mission start`), phase progression through the RFC-aligned phases (understand → align → decide → plan → execute → verify), bundle export (`ov mission export`), and completion (`ov mission complete`). Smoke verification confirms that the full lifecycle executes without error and that all state transitions are persisted correctly in the SQLite mission store.

_Generated: 2026-03-13T18:35:50Z_
