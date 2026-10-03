#!/usr/bin/env bash
# Isolation wrapper for the E2a-5 H1 disposable compiled validation server
# (method: H1's server-exec.sh — isolated agent dir with the REAL extension set
# + skills corpus + zai-only credential, fake HOME, Agent OS stub, notifications
# off, watch-wake pointed at the disposable socket, NODE_ENV=development,
# heap cap for containment).
# Usage: h1-server-exec.sh <runDir> <worktree> <port>
set -euo pipefail
RUN="$1"; WT="$2"; PORT="$3"

export HOME="$RUN/home"
export PATH="$RUN/bin:/root/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"
export PI_CODING_AGENT_DIR="$RUN/pi-agent"
export PI_AGENT_DIR="$RUN/pi-agent"
export AGENT_OS_BIN="$WT/scripts/heap-soak/agent-os-stub.mjs"
export AGENT_OS_STUB_LOG="$RUN/agent-os-stub.log"
export BOARD_STORE_DIR="$RUN/board"
export AGENT_OS_VAULT_ROOT="$RUN/home/agent-os-memory-vault"
export NOTIFICATIONS_DIR="$RUN/notifications"
export NOTIFICATIONS_ENABLED=false
export OBSERVABILITY_HEALTH_ALERT_SINK=none
export PI_WEB_UI_WATCH_WAKE_SOCKET="$RUN/server/internal-api.sock"
export PI_WEB_UI_WATCH_WAKE_TOKEN_FILE="$RUN/server/internal-api-token"
export PI_WEB_UI_GOAL_HOME="$RUN/goal-home"
export PI_COMPACTION_LOG="$RUN/compaction-log.jsonl"
export PI_BG_TASKS_DIR="$RUN/bg-tasks"
export NODE_OPTIONS="--max-old-space-size=4096"
export NODE_ENV=development
# Disposable default explicitly pinned: no inherited/ambient value may change it.
export AUTH_PASSWORD=dev-password
unset SESSION_DIR

echo "a5-server-exec: cgroup=$(cat /proc/self/cgroup 2>/dev/null | head -1)"
echo "a5-server-exec: view-only=$PI_WEB_UI_VIEW_ONLY_SUBSCRIBE allowed-origins=$ALLOWED_ORIGINS"
cd "$WT"
exec nice -n 10 node --import tsx scripts/validation-server.ts --dir "$RUN/server" --compiled --port "$PORT" >>"$RUN/server.log" 2>&1
