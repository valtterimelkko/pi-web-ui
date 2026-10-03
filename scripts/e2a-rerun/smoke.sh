#!/usr/bin/env bash
# E2a-5 harness smoke — ONE run within the STRESS-GATE allowance:
#   unit e2a-5-smoke, MemoryMax=2G, MemorySwapMax=1G, RuntimeMaxSec=300,
#   ≤ 2 model children (exactly 1 tiny zai turn), no deliberate allocation,
#   no CPU burn.
# Proves the harness end-to-end on the real build: server boot + isolation,
# /health + /capacity probes, one real session create + zai prompt (served model
# asserted by script), metrics file readable, vite dev client boots, the
# browser smoke mode opens + logs in with zero console errors, clean teardown.
#
# Usage: bash smoke.sh [--keep-vite=false]
set -euo pipefail
WT="/root/.worktrees/orch-scaling/e2-a5-pi-web-ui"
RUN="/root/e2a-runs/a5/smoke"
LOG="$RUN/smoke.log"
mkdir -p "$RUN/home" "$RUN/board" "$RUN/notifications" "$RUN/bin" "$RUN/workspaces" /root/e2a-runs/a5/screens
: > "$LOG"
log() { echo "[a5-smoke $(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
cleanup() {
  log "cleanup"
  systemctl stop e2a-5-smoke-vite 2>/dev/null || true
  if [ -f "$RUN/server/server-process.json" ] && [ ! -f "$RUN/SMOKE_SERVER_STOPPED" ]; then
    (cd "$WT" && node scripts/validation-server-stop.mjs --dir "$RUN/server" --timeout-ms 8000 >>"$LOG" 2>&1) || true
  fi
  systemctl stop e2a-5-smoke 2>/dev/null || true
}
trap cleanup EXIT

# Agent dir: realistic (extensions + skills + zai-only credential), as the arm
# server will boot — built BEFORE the unit so the 300 s window covers the run.
AG="$RUN/pi-agent"
if [ ! -d "$AG/extensions" ]; then
  log "building agent dir"
  mkdir -p "$AG/extensions"
  cp -a /root/.pi/agent/extensions/. "$AG/extensions/"
  cp -a /root/.skills-global/skills-global/ "$AG/skills/"
  cp /root/.pi/agent/AGENTS.md "$AG/AGENTS.md"
  cp /root/.pi/agent/settings.json "$AG/settings.json"
  T1_APPROVED=zai node /root/orch-ops/orchestration-scaling/t1/harness/make-agent-dir.mjs "$AG" >>"$LOG" 2>&1
fi
ln -sf "$WT/scripts/heap-soak/agent-os-stub.mjs" "$RUN/bin/agent-os"
PORT=$(node -e "const net=require('net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
echo "$PORT" > "$RUN/port"

# Pre-flight per STRESS-GATE (guard live, fresh sample, no trip files).
GUARD_STATE=/root/orch-ops/orchestration-scaling/e2/host-guard/state
[ -f /root/orch-ops/orchestration-scaling/e2/GUARD-LIVE ] || { log "FATAL: GUARD-LIVE missing"; exit 1; }
[ "$(systemctl is-active e2-host-guard)" = "active" ] || { log "FATAL: guard not active"; exit 1; }
LAST_SAMPLE=$(ls -1t "$GUARD_STATE"/samples.jsonl 2>/dev/null | head -1)
NOW_S=$(date +%s); SAMPLE_S=$(stat -c %Y "$GUARD_STATE/samples.jsonl" 2>/dev/null || echo 0)
[ $((NOW_S - SAMPLE_S)) -lt 15 ] || { log "FATAL: guard sample ${((NOW_S-SAMPLE_S))}s old"; exit 1; }
ls "$GUARD_STATE"/HOST-GUARD-TRIPPED >/dev/null 2>&1 && { log "FATAL: guard tripped"; exit 1; }
MEMAVAIL_KB=$(awk '/MemAvailable:/{print $2}' /proc/meminfo)
[ "$MEMAVAIL_KB" -ge $((12 * 1024 * 1024)) ] || { log "FATAL: MemAvailable $MEMAVAIL_KB kB < 12GiB"; exit 1; }
DISK_FREE_KB=$(df -k / | tail -1 | awk '{print $4}')
[ "$DISK_FREE_KB" -ge $((15 * 1024 * 1024)) ] || { log "FATAL: root disk free ${DISK_FREE_KB}kB < 15GiB"; exit 1; }
log "pre-flight ok (mem=${MEMAVAIL_KB}kB disk=${DISK_FREE_KB}kB sample age=$((NOW_S-SAMPLE_S))s)"

# ── the smoke unit ────────────────────────────────────────────────────────────
log "starting unit e2a-5-smoke (MemoryMax=2G RuntimeMaxSec=300) port $PORT"
systemd-run --collect --quiet --unit=e2a-5-smoke \
  -p MemoryMax=2G -p MemorySwapMax=1G -p RuntimeMaxSec=300 -p CPUWeight=100 \
  --working-directory="$WT" \
  bash -c "export HOME='$RUN/home' PATH='$RUN/bin:/root/.npm-global/bin:/usr/local/bin:/usr/bin:/bin' \
    PI_AGENT_DIR='$AG' PI_CODING_AGENT_DIR='$AG' AGENT_OS_BIN='$WT/scripts/heap-soak/agent-os-stub.mjs' \
    BOARD_STORE_DIR='$RUN/board' AGENT_OS_VAULT_ROOT='$RUN/home/vault' NOTIFICATIONS_ENABLED=false \
    OBSERVABILITY_HEALTH_ALERT_SINK=none NODE_ENV=test NODE_OPTIONS='--max-old-space-size=1200' AUTH_PASSWORD=dev-password ALLOWED_ORIGINS='http://localhost:3457,http://127.0.0.1:3457'; \
    unset SESSION_DIR PI_SESSION_ID; exec nice -n 10 node --import tsx scripts/validation-server.ts --dir '$RUN/server' --compiled --port '$PORT'" \
  >>"$RUN/server.log" 2>&1 &

DEADLINE=$((SECONDS + 90))
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  [ -S "$RUN/server/internal-api.sock" ] && [ -f "$RUN/server/internal-api-token" ] && break
  sleep 1
done
[ -S "$RUN/server/internal-api.sock" ] || { log "FATAL: socket never appeared"; tail -20 "$RUN/server.log" >&2; exit 1; }
BUILD=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$WT/server/dist/build-identity/embedded-manifest.json','utf8')).revision.slice(0,8))")
log "server ready (build $BUILD)"

TOKEN=$(cat "$RUN/server/internal-api-token")
api() { curl -sS --max-time 30 --unix-socket "$RUN/server/internal-api.sock" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' "$@"; }

HEALTH=$(api http://localhost/api/v1/health)
echo "$HEALTH" > "$RUN/health.json"
log "health: contract=$(echo "$HEALTH" | python3 -c 'import json,sys; print(json.load(sys.stdin)["contract"]["contractVersion"])') pi=$(echo "$HEALTH" | python3 -c 'import json,sys; print(json.load(sys.stdin)["runtimes"]["pi"])')"

CAP=$(api http://localhost/api/v1/capacity)
echo "$CAP" > "$RUN/capacity-baseline.json"
log "capacity baseline: available=$(echo "$CAP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["available"])')"

# one real session + one tiny zai turn (served model asserted)
WS="$RUN/workspaces/ws0"; mkdir -p "$WS"
CREATE=$(api -X POST -d "{\"runtime\":\"pi\",\"cwd\":\"$WS\",\"model\":\"zai/glm-5.3-flash\",\"source\":\"e2a5-smoke\"}" http://localhost/api/v1/sessions)
echo "$CREATE" > "$RUN/create.json"
SID=$(echo "$CREATE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sessionId"])')
log "session created: $SID"
PROMPT_RES=$(api -X POST -d '{"message":"Reply with exactly one line: A5SMOKE-OK and nothing else."}' "http://localhost/api/v1/sessions/$SID/prompt")
echo "$PROMPT_RES" > "$RUN/prompt-receipt.json"
SESS=$(api "http://localhost/api/v1/sessions/$SID")
echo "$SESS" > "$RUN/session-after-prompt.json"
RUNID=$(echo "$PROMPT_RES" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("runId",""))')
[ -n "$RUNID" ] && api "http://localhost/api/v1/runs/$RUNID" > "$RUN/run-receipt.json" || true
python3 - "$RUN" <<'PY' || { echo "[a5-smoke] FATAL: served-model assertion failed" | tee -a "$RUN/smoke.log"; exit 1; }
import json, sys, pathlib
run = pathlib.Path(sys.argv[1])
receipt = json.loads((run / 'prompt-receipt.json').read_text())
assert receipt.get('turnComplete') is True and 'A5SMOKE-OK' in str(receipt.get('content', '')), f'turn not complete: {str(receipt)[:200]}'
served = receipt.get('model') or receipt.get('servedModel')
sess = None
if not served:
    sess = json.loads((run / 'session-after-prompt.json').read_text())
    served = sess.get('model') or sess.get('servedModel') or (sess.get('entry') or {}).get('model')
if not served and (run / 'run-receipt.json').exists():
    rr = json.loads((run / 'run-receipt.json').read_text())
    served = rr.get('model') or rr.get('modelSelector') or (rr.get('record') or {}).get('modelSelector')
assert served == 'zai/glm-5.3-flash', f'served model {served!r} != zai/glm-5.3-flash (receipt={str(receipt)[:150]})'
print(f'[a5-smoke] served model asserted: {served}')
PY
DEL=$(api -X DELETE "http://localhost/api/v1/sessions/$SID")
log "prompt ok + session deleted (status $(echo "$DEL" | head -c 40))"

# metrics file readable by the harness library
node -e "
  import('$WT/scripts/e2a-rerun/lib.mjs').then(async (lib) => {
    const readings = lib.readMetrics('$RUN/server');
    if (!readings.length) throw new Error('no A2 metrics readings found');
    const last = readings[readings.length - 1];
    console.log('[a5-smoke] metrics ok:', readings.length, 'readings, last activeTurns=' + last.activeTurns + ' lagP99=' + last.lagP99Ms);
    const ws = lib.windowStats(readings, readings[0].atMs, Date.now());
    if (ws.readingCount !== readings.length) throw new Error('windowStats dropped readings');
    console.log('[a5-smoke] windowStats ok: n=' + ws.readingCount);
  });
" 2>>"$LOG" || { log "FATAL: harness metrics read failed"; exit 1; }

# one persistent session so the sidebar has a row to render
KEEP=$(api -X POST -d "{\"runtime\":\"pi\",\"cwd\":\"$WS\",\"model\":\"zai/glm-5.3-flash\",\"source\":\"e2a5-smoke\"}" http://localhost/api/v1/sessions)
echo "$KEEP" > "$RUN/keep-session.json"
log "sidebar session kept: $(echo "$KEEP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sessionId"])' 2>/dev/null || echo '?')"

# vite + browser smoke mode (both viewports, login + sidebar + console sweep)
log "starting vite in e2a-5-smoke-vite"
systemd-run --collect --quiet --unit=e2a-5-smoke-vite \
  -p MemoryMax=2G -p MemorySwapMax=1G -p RuntimeMaxSec=300 \
  --working-directory="$WT/client" \
  env VITE_API_TARGET="http://127.0.0.1:$PORT" NODE_ENV=development \
  npx vite --host 127.0.0.1 --port 3457 --strictPort >>"$RUN/vite.log" 2>&1
DEADLINE=$((SECONDS + 60))
VITE_UP=0
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  if curl -s -o /dev/null "http://127.0.0.1:3457/"; then VITE_UP=1; break; fi
  sleep 1
done
if [ "$VITE_UP" = "1" ]; then
  log "vite up; running browser smoke (desktop+mobile)"
  python3 "$WT/scripts/e2a-rerun/browser-check.py" --run-dir="$RUN" --viewport=both --smoke=true 2>>"$LOG" || { log "FATAL: browser smoke failed"; exit 1; }
else
  log "WARN: vite did not come up in 60s (browser smoke skipped — see vite.log)"; exit 1
fi

touch "$RUN/SMOKE_SERVER_STOPPED"
(cd "$WT" && node scripts/validation-server-stop.mjs --dir "$RUN/server" --timeout-ms 8000 >>"$LOG" 2>&1)
systemctl stop e2a-5-smoke-vite 2>/dev/null || true
if [ -S "$RUN/server/internal-api.sock" ]; then log "FATAL: socket still present after stop"; exit 1; fi
log "SMOKE PASS (unit e2a-5-smoke self-terminates at RuntimeMaxSec; server stopped, vite stopped)"
