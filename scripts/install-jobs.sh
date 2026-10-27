#!/bin/bash
# Install (or update) the Claude Deck job runner on a VM and write its account list.
#   scripts/install-jobs.sh <ssh-alias>        e.g. scripts/install-jobs.sh my-vm
# Installs ~/.claude-deck/jobs/cdeck_jobs.py on the VM. Nothing else on the VM is changed;
# an existing config.json is kept.
set -euo pipefail
HOST="${1:?usage: scripts/install-jobs.sh <ssh-alias>   (the Host name from your ~/.ssh/config)}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ssh -o BatchMode=yes "$HOST" '
  set -e
  D="$HOME/.claude-deck/jobs"
  mkdir -p "$D" && chmod 700 "$HOME/.claude-deck" "$D"
  cat > "$D/cdeck_jobs.py.tmp" && chmod 700 "$D/cdeck_jobs.py.tmp" && mv "$D/cdeck_jobs.py.tmp" "$D/cdeck_jobs.py"
  python3 "$D/cdeck_jobs.py" init
' < "$HERE/resources/remote/cdeck_jobs.py" 2> >(grep -v -i -E "numpy|iap/docs|^WARNING:?\s*$|^\s*$" >&2)
cat <<MSG

Installed. Give a Claude Code session the tools with ONE of:

  # main agent on this Mac (tools run on $HOST over SSH)
  claude mcp add --scope user claude-jobs -- ssh -T -o BatchMode=yes -o ServerAliveInterval=30 $HOST python3 .claude-deck/jobs/cdeck_jobs.py mcp

  # main agent on $HOST itself (run this there, under the account that should orchestrate)
  claude mcp add --scope user claude-jobs -- python3 ~/.claude-deck/jobs/cdeck_jobs.py mcp

Accounts and limits: ~/.claude-deck/jobs/config.json on $HOST.
MSG
