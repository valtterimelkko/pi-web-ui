#!/usr/bin/env bash
# E2a-5 arms 2+3 — H1 burst + hb2/hb6 browser check on the deployed build.
# Runs the disposable server inside transient unit e2a-5-h1 (MemoryMax=12G,
# MemorySwapMax=1G, CPUWeight=100), the vite dev client inside e2a-5-vite
# (MemoryMax=2G), the burst driver OUTSIDE the units, and the Playwright oracle
# mid-burst. STRESS-GATE: caller must hold the stress lock for this arm.
#
# Usage: bash h1-arm.sh --run-dir=<dir> [--count=66] [--interval-ms=2000]
#                   [--viewports=both] [--browser-hook-at-switch=8]
set -euo pipefail

ARGS=("$@")
get_arg() {
  for a in "${ARGS[@]}"; do
    case "$a" in
      --$1=*) echo "${a#--$1=}" ; return ;;
    esac
  done
  echo "$2"
}

RUN=$(get_arg run-dir "/root/e2a-runs/a5/h1")
WT=$(get_arg worktree "/root/.worktrees/orch-scaling/e2-a5-pi-web-ui")
COUNT=$(get_arg count "66")
INTERVAL=$(get_arg interval-ms "2000")
VIEWPORTS=$(get_arg viewports "both")
HOOK_AT=$(get_arg browser-hook-at-switch "8")
SKIP_BROWSER=$(get_arg skip-browser "false")
LOG="$RUN/arm.log"
mkdir -p "$RUN/home" "$RUN/board" "$RUN/notifications" "$RUN/goal-home" "$RUN/bg-tasks" "$RUN/workspaces" "$RUN/bin"
: > "$LOG"
log() { echo "[a5-h1 $(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
cleanup() {
  log "cleanup: stopping vite + server unit"
  systemctl stop e2a-5-vite 2>/dev/null || true
  if [ -f "$RUN/server/server-process.json" ]; then
    (cd "$WT" && node scripts/validation-server-stop.mjs --dir "$RUN/server" --timeout-ms 8000 >>"$LOG" 2>&1) || true
  fi
  systemctl stop e2a-5-h1 2>/dev/null || true
}
trap cleanup EXIT

# ── isolated agent dir: real extension set byte-identical + real skills corpus
# + zai-only credential (the owner's realistic child pattern; B1.3-live method)
AG="$RUN/pi-agent"
if [ ! -d "$AG/extensions" ]; then
  log "building isolated agent dir (real extensions + skills corpus + zai-only credential)"
  rm -rf "$AG"
  mkdir -p "$AG/extensions"
  cp -a /root/.pi/agent/extensions/. "$AG/extensions/"
  cp -a /root/.skills-global/skills-global/ "$AG/skills/"
  cp -a /root/.pi/agent/prompts "$AG/prompts"
  cp /root/.pi/agent/AGENTS.md "$AG/AGENTS.md"
  cp /root/.pi/agent/settings.json "$AG/settings.json"
  T1_APPROVED=zai node /root/orch-ops/orchestration-scaling/t1/harness/make-agent-dir.mjs "$AG" >>"$LOG" 2>&1
  (cd /root/.pi/agent/extensions && find . -type f -print0 | sort -z | xargs -0 sha256sum) > "$RUN/extensions.sha256"
  find "$AG" -name 'SKILL.md' | wc -l > "$RUN/skill-count.txt"
  log "agent dir ready: extensions=$(find "$AG/extensions" -maxdepth 1 -mindepth 1 | wc -l) skills=$(cat "$RUN/skill-count.txt")"
fi
ln -sf "$WT/scripts/heap-soak/agent-os-stub.mjs" "$RUN/bin/agent-os"

# ── server unit ───────────────────────────────────────────────────────────────
PORT=$(node -e "const net=require('net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
echo "$PORT" > "$RUN/port"
log "starting server unit e2a-5-h1 (port $PORT, view-only subscribe ON, MemoryMax=12G)"
systemd-run --collect --quiet --unit=e2a-5-h1 \
  -p CPUWeight=100 -p MemoryMax=12G -p MemorySwapMax=1G \
  --setenv=PI_WEB_UI_VIEW_ONLY_SUBSCRIBE=on \
  --setenv=ALLOWED_ORIGINS="http://localhost:3457,http://127.0.0.1:3457,http://localhost:3000" \
  --working-directory="$WT" \
  bash "$WT/scripts/e2a-rerun/h1-server-exec.sh" "$RUN" "$WT" "$PORT"

DEADLINE=$((SECONDS + 180))
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  if [ -f "$RUN/server/server-process.json" ] && [ -f "$RUN/server/internal-api-token" ] && [ -S "$RUN/server/internal-api.sock" ]; then
    break
  fi
  sleep 1
done
[ -S "$RUN/server/internal-api.sock" ] || { log "FATAL: server socket never appeared"; tail -30 "$RUN/server.log" >&2 || true; exit 1; }
log "server ready (build $(node -e "console.log(JSON.parse(require('fs').readFileSync('$WT/server/dist/build-identity/embedded-manifest.json','utf8')).revision.slice(0,8))" 2>/dev/null || echo '?'))"

# ── prepare targets + children ────────────────────────────────────────────────
node "$WT/scripts/e2a-rerun/h1-burst.mjs" prepare --run-dir="$RUN" --count="$COUNT" 2>>"$LOG"
MARKER="A5H1-$(date -u +%H%M%S)"
A5_BROWSER_MARKER="$MARKER" node "$WT/scripts/e2a-rerun/h1-burst.mjs" children --run-dir="$RUN" 2>>"$LOG"

# ── vite dev client (browser path; proxy → the disposable server) ─────────────
if [ "$SKIP_BROWSER" != "true" ]; then
  log "starting vite dev client in e2a-5-vite (MemoryMax=2G)"
  systemd-run --collect --quiet --unit=e2a-5-vite \
    -p MemoryMax=2G -p MemorySwapMax=1G -p RuntimeMaxSec=2400 \
    --working-directory="$WT/client" \
    env VITE_API_TARGET="http://127.0.0.1:$PORT" NODE_ENV=development \
    npx vite --host 127.0.0.1 --port 3457 --strictPort >>"$RUN/vite.log" 2>&1
  DEADLINE=$((SECONDS + 90))
  while [ "$SECONDS" -lt "$DEADLINE" ]; do
    curl -s -o /dev/null "http://127.0.0.1:3457/" && break
    sleep 1
  done
  curl -s -o /dev/null "http://127.0.0.1:3457/" || { log "FATAL: vite never came up (see $RUN/vite.log)"; exit 1; }
  log "vite ready on 3457"
fi

# ── burst (children fired first; A2-gated; browser hook mid-burst) ────────────
HOOK_ARGS=()
if [ "$SKIP_BROWSER" != "true" ]; then
  HOOK_ARGS=(--browser-hook="$WT/scripts/e2a-rerun/browser-check.py" --browser-hook-at-switch="$HOOK_AT")
fi
A5_BROWSER_MARKER="$MARKER" node "$WT/scripts/e2a-rerun/h1-burst.mjs" burst \
  --run-dir="$RUN" --count="$COUNT" --interval-ms="$INTERVAL" "${HOOK_ARGS[@]}" 2>>"$LOG"

node "$WT/scripts/e2a-rerun/h1-burst.mjs" collect --run-dir="$RUN" --label=h1 2>>"$LOG"

log "burst + collect done; cleaning up"
