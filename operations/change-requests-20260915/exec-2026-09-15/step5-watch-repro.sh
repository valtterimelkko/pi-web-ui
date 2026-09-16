#!/usr/bin/env bash
# Does a pinned watch ledger survive a disposable-server restart?
# Reproduces exactly what Agent OS Stage J's Step 5 proof asserts, at product level,
# WITHOUT Agent OS in the loop — so the finding is about Pi Web UI, not about a harness.
set -uo pipefail
DIR=/tmp/step5-watch-repro
PORT=3511
OUT=/tmp/step5-watch-repro.log
SOCK="$DIR/internal-api.sock"
TOK="$DIR/internal-api-token"
UNIT=step5-watch-repro

say() { echo "$@" | tee -a "$OUT"; }
boot() {
  systemd-run --scope --collect --unit="$UNIT" \
    env AUTH_PASSWORD='$2b$10$nvqaORBU5z9FSTCnEgBGY.puZNYRuXcMsrDu2DdS4CYLkBxV.Gngm' NODE_ENV=development \
    npm run validate:server --prefix /root/pi-web-ui -- --dir "$DIR" --port "$PORT" >> "$OUT" 2>&1 &
  for i in $(seq 1 90); do [ -S "$SOCK" ] && curl -s --max-time 3 --unix-socket "$SOCK" -H "Authorization: Bearer $(cat "$TOK" 2>/dev/null)" http://localhost/api/v1/health >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}
stop() { systemctl stop "$UNIT.scope" 2>/dev/null; systemctl reset-failed "$UNIT.scope" 2>/dev/null; sleep 3; }
api() { local m=$1 p=$2 b=${3:-}; if [ -n "$b" ]; then curl -s --max-time 60 --unix-socket "$SOCK" -H "Authorization: Bearer $(cat "$TOK")" -H 'Content-Type: application/json' -X "$m" "http://localhost/api/v1$p" -d "$b"; else curl -s --max-time 60 --unix-socket "$SOCK" -H "Authorization: Bearer $(cat "$TOK")" -X "$m" "http://localhost/api/v1$p"; fi; }

: > "$OUT"
stop; rm -rf "$DIR"; mkdir -p "$DIR"
say "=== boot 1 ==="
boot || { say "server did not become ready"; exit 1; }
say "  ready"

SID=$(api POST /sessions '{"runtime":"pi","cwd":"/root/pi-web-ui"}' | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('sessionId') or (d.get('session') or {}).get('sessionId') or '')")
say "  session: $SID"
api POST "/sessions/$SID/watch" '{"conditions":[{"id":"repro","type":"text","contains":"REPRO_SENTINEL"}],"pin":true,"label":"step5-watch-repro"}' >/dev/null
BEFORE=$(api GET "/sessions/$SID/watch")
say "  pre-restart /watch: $(echo "$BEFORE" | head -c 300)"

say "=== restart (same state dir, as the proof does) ==="
stop
say "  ledger files on disk after stop:"
find "$DIR" -name "*watch*" -o -name "*ledger*" 2>/dev/null | head -6 | sed 's/^/    /'
say "  watch dir listing:"; ls -la "$DIR"/watches 2>/dev/null | head -5 | sed 's/^/    /' || true
boot || { say "server did not restart"; exit 1; }
say "  restarted"

AFTER=$(api GET "/sessions/$SID/watch")
say "  post-restart /watch: $(echo "$AFTER" | head -c 400)"
echo "$AFTER" | python3 -c "
import sys, json
try: d = json.load(sys.stdin)
except Exception as e: print('  unparseable:', e); raise SystemExit
print('  VERDICT status =', d.get('status'))
fr = d.get('firings')
print('  VERDICT firings =', len(fr) if isinstance(fr, list) else fr)
print('  keys:', sorted(d.keys())[:14])
" | tee -a "$OUT"
say "=== ledger files after restart ==="
ls -la "$DIR"/watches 2>/dev/null | head -6 | sed 's/^/    /'
stop
say "=== done ==="
