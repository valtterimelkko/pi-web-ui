#!/usr/bin/env bash
# Injection marking (2026-09-16) — scope the extension symlink flip.
#
# The MARKED leg needs the worktree extension build loaded by the sessions the
# disposable server creates. The brief allows exactly one reversible host
# mutation: flip /root/.pi/agent/extensions/agent-os-inject to the worktree
# build and restore it in the same session. Usage:
#   flip-symlink.sh worktree   # flip to the worktree build (records the target)
#   flip-symlink.sh restore    # restore the recorded original target
set -uo pipefail
LINK=/root/.pi/agent/extensions/agent-os-inject
WORKTREE=/root/pi-enhancement-wt-inject/agent-os-inject
RECORD=/root/inject-lab-20260916/symlink-original.txt

case "${1:?usage: flip-symlink.sh worktree|restore}" in
  worktree)
    mkdir -p "$(dirname "$RECORD")"
    readlink "$LINK" > "$RECORD"
    echo "original target: $(cat "$RECORD")"
    ln -sfn "$WORKTREE" "$LINK"
    echo "flipped to: $(readlink "$LINK")"
    ;;
  restore)
    TARGET=$(cat "$RECORD")
    ln -sfn "$TARGET" "$LINK"
    echo "restored to: $(readlink "$LINK")"
    ;;
esac
