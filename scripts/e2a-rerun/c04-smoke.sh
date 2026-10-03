#!/usr/bin/env bash
# Correction 04 phase-1 smoke: seed pre-boot → server boot → 3 view-only
# switches over seeded targets (ZERO model children, no allocation, no browser)
# → residency classification → collect with raw-row/latch-trace preservation.
# STRESS-GATE allowance: unit e2a-5-smoke2, MemoryMax=2G, RuntimeMaxSec=300,
# 0 model children.
set -uo pipefail
WT="/root/.worktrees/orch-scaling/e2-a5-pi-web-ui"
RUN="/root/e2a-runs/a5/c04-smoke"
LOG="$RUN/arm.log"
rm -rf "$RUN"; mkdir -p "$RUN/home" "$RUN/board" "$RUN/notifications" "$RUN/bin" "$RUN/workspaces"
: > "$LOG"
log() { echo "[c04-smoke $(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
cleanup() {
  systemctl stop e2a-5-smoke2 2>/dev/null || true
  if [ -f "$RUN/server/server-process.json" ] && [ ! -f "$RUN/SMOKE_SERVER_STOPPED" ]; then
    (cd "$WT" && node scripts/validation-server-stop.mjs --dir "$RUN/server" --timeout-ms 8000 >>"$LOG" 2>&1) || true
  fi
  rm -f "$RUN/server/internal-api-token" "$RUN/server/server.env" 2>/dev/null || true
}
trap cleanup EXIT

# 1. seed BEFORE boot (offline; pre-boot assert: socket must not exist yet)
[ -S "$RUN/server/internal-api.sock" ] && { log "FATAL: socket exists before boot"; exit 1; }
node "$WT/scripts/e2a-rerun/h1-burst.mjs" seed --run-dir="$RUN" --count=4 2>>"$LOG" || { log "FATAL: seed failed"; exit 1; }
grep -q "written OFFLINE pre-boot" "$LOG" || { log "FATAL: seed did not announce offline pre-boot"; exit 1; }
[ -f "$RUN/server/session-registry.json" ] || { log "FATAL: registry not seeded"; exit 1; }
[ -f "$RUN/server/internal-api.sock" ] && { log "FATAL: server booted before seed?"; exit 1; }
log "seed ok (4 targets, offline, pre-boot)"

# 2. boot (zai-only credential line asserted; zero children)
AG="$RUN/pi-agent"
mkdir -p "$AG/extensions"
cp /root/.pi/agent/AGENTS.md "$AG/AGENTS.md" 2>/dev/null || true
cp /root/.pi/agent/settings.json "$AG/settings.json" 2>/dev/null || true
T1_APPROVED=zai node /root/orch-ops/orchestration-scaling/t1/harness/make-agent-dir.mjs "$AG" >>"$LOG" 2>&1
ln -sf "$WT/scripts/heap-soak/agent-os-stub.mjs" "$RUN/bin/agent-os"
PORT=$(node -e "const net=require('net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
echo "$PORT" > "$RUN/port"
systemd-run --collect --quiet --unit=e2a-5-smoke2 \
  -p MemoryMax=2G -p MemorySwapMax=1G -p RuntimeMaxSec=300 -p CPUWeight=100 \
  --working-directory="$WT" \
  bash -c "export HOME='$RUN/home' PATH='$RUN/bin:/root/.npm-global/bin:/usr/local/bin:/usr/bin:/bin' \
    PI_AGENT_DIR='$AG' PI_CODING_AGENT_DIR='$AG' AGENT_OS_BIN='$WT/scripts/heap-soak/agent-os-stub.mjs' \
    BOARD_STORE_DIR='$RUN/board' AGENT_OS_VAULT_ROOT='$RUN/home/vault' NOTIFICATIONS_ENABLED=false \
    OBSERVABILITY_HEALTH_ALERT_SINK=none NODE_ENV=test NODE_OPTIONS='--max-old-space-size=1024' \
    AUTH_PASSWORD=dev-password PI_WEB_UI_VIEW_ONLY_SUBSCRIBE=on ALLOWED_ORIGINS='http://localhost:3457,http://127.0.0.1:3457'; \
    unset SESSION_DIR PI_SESSION_ID; exec nice -n 10 node --import tsx scripts/validation-server.ts --dir '$RUN/server' --compiled --port '$PORT'" \
  >>"$RUN/server.log" 2>&1 &
DEADLINE=$((SECONDS + 90))
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  [ -S "$RUN/server/internal-api.sock" ] && [ -f "$RUN/server/internal-api-token" ] && break
  sleep 1
done
[ -S "$RUN/server/internal-api.sock" ] || { log "FATAL: socket never appeared"; exit 1; }
PROV_LINE=$(grep -m1 "Available providers (with auth):" "$RUN/server.log" || true)
log "providers: [${PROV_LINE#*Available providers (with auth):}]"

# 3. three view-only switches over seeded targets (zero children)
node "$WT/scripts/e2a-rerun/h1-burst.mjs" burst --run-dir="$RUN" --count=3 --interval-ms=300 \
  --skip-turn-wait=true 2>>"$LOG" || { log "FATAL: burst failed"; exit 1; }
grep -q "targets cold (server evidence" "$LOG" || { log "FATAL: residency classification did not run"; exit 1; }

# 4. collect (raw rows + latch trace preserved)
node "$WT/scripts/e2a-rerun/h1-burst.mjs" collect --run-dir="$RUN" --label=c04 2>>"$LOG" || { log "FATAL: collect failed"; exit 1; }
[ -f "$RUN/a2-raw-readings.jsonl" ] || { log "FATAL: raw A2 rows not preserved"; exit 1; }
[ -f "$RUN/latch-replay-trace.json" ] || { log "FATAL: latch trace not preserved"; exit 1; }
[ -f "$RUN/target-residency.json" ] || { log "FATAL: residency classification not saved"; exit 1; }
python3 - <<'PY' || { echo "[c04-smoke] FATAL: verdict checks failed" | tee -a "$RUN/arm.log"; exit 1; }
import json, pathlib
run = pathlib.Path('/root/e2a-runs/a5/c04-smoke')
burst = json.loads((run / 'burst-burst.json').read_text())
residency = json.loads((run / 'target-residency.json').read_text())
assert burst['summary']['ok'] == 3 and burst['summary']['failed'] == 0, burst['summary']
assert all(t['resident'] is False for t in residency['targets']), 'targets must be classified non-resident'
assert burst['coldOnly']['coldCount'] == 3, burst['coldOnly']
assert 'p50' in burst['coldOnly']
print('[c04-smoke] 3/3 cold switches, all targets classified non-resident, cold-only percentiles present')
PY

touch "$RUN/SMOKE_SERVER_STOPPED"
(cd "$WT" && node scripts/validation-server-stop.mjs --dir "$RUN/server" --timeout-ms 8000 >>"$LOG" 2>&1)
if [ -S "$RUN/server/internal-api.sock" ]; then log "FATAL: socket remains"; exit 1; fi
rm -f "$RUN/pi-agent/auth.json" "$RUN/pi-agent/models.json" 2>/dev/null
log "SMOKE PASS (zero children; seed pre-boot verified; residency classified; raw rows + latch trace preserved)"
