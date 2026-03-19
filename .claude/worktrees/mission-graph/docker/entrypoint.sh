#!/bin/bash
set -e

# Start tmux server so agent sessions can be created
tmux start-server 2>/dev/null || true

# Verify critical tools are available
for tool in ov ml git tmux; do
	if ! command -v "$tool" &>/dev/null; then
		echo "ERROR: $tool not found in PATH" >&2
		exit 1
	fi
done

echo "Overstory environment ready"
echo "  ov:    $(ov --version 2>/dev/null || echo 'installed')"
echo "  ml:    $(ml --version 2>/dev/null || echo 'installed')"
echo "  git:   $(git --version)"
echo "  tmux:  $(tmux -V)"
echo "  node:  $(node --version)"
echo "  bun:   $(bun --version)"

# If a command was provided, run it; otherwise start interactive shell
if [ $# -gt 0 ]; then
	exec "$@"
else
	exec bash
fi
