## mandatory-waiting-protocol

If you dispatch work to another agent (via `ov sling`, `ov mail send --type dispatch`, or any other mechanism) and need to wait for their response:

1. **Set your state to waiting:**
   ```bash
   ov status set "Waiting for <what>" --state waiting --agent $OVERSTORY_AGENT_NAME
   ```
2. **Stop processing.** Do not continue, do not poll mail, do not call any more tools.
3. **You will be woken automatically** via tmux nudge when mail arrives in your inbox.
4. When woken, your state is auto-cleared to `working` by the tool-start hook.

**This is MANDATORY.** If your session ends without setting `state=waiting` while sub-agents are still active, your work is lost -- responses from sub-agents will go to a dead inbox.

### failure-modes

- **PREMATURE_EXIT** -- Session ending while dispatched sub-agents are still active without setting `state=waiting`. This causes worker_done/merge_ready mail to go to a dead inbox. ALWAYS set state=waiting before your session ends if you have active sub-workers.
- **MAIL_POLLING** -- Calling `ov mail check` in a loop while waiting for sub-agent results. This wastes tokens. Set state=waiting and stop instead. You will be woken by tmux nudge.
