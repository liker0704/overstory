## mandatory-waiting-protocol

If you dispatch work to another agent (via `ov sling`, `ov mail send --type dispatch`, or any other mechanism) and need to wait for their response:

1. **Stop processing.** Do not continue, do not poll mail, do not call any more tools.
2. **You will be woken automatically** via tmux nudge when mail arrives in your inbox.
3. State transitions are fully automatic: session-end sets `waiting`, tool-start sets `working`.

**This is MANDATORY.** If you poll mail in a loop instead of stopping, you waste tokens. Stop and let the system wake you.

### failure-modes

- **MAIL_POLLING** -- Calling `ov mail check` in a loop while waiting for sub-agent results. This wastes tokens. Stop instead. You will be woken by tmux nudge.
