#!/usr/bin/env bash
# Injection marking (2026-09-16) — boot the two disposable validation servers.
#
#   LEGACY  — the SAME worktree extension build with the kill switch env
#             AGENT_OS_INJECT_CAPTURE_MARKING=0 (proves the kill switch
#             restores today's byte-for-byte behaviour).
#   MARKED  — the same build, no kill switch (the new structural lane).
#
# Both servers share the normal agent dir (sanctioned disposable posture:
# no credential copying). Both get AGENT_OS_VAULT_ROOT pointed at a
# disposable vault so the REAL agent-os verb runs with real decision logic
# while writing nothing to the operator's vault, and their own
# AGENT_OS_INJECT_LOG journal. The MARKED leg additionally requires the
# extension symlink to point at the worktree build (flip is done by
# flip-symlink.sh around session creation only, and restored immediately).
#
# Usage: boot-ab.sh legacy|marked
set -uo pipefail

VARIANT=${1:?usage: boot-ab.sh legacy|marked}
TREE=/root/pi-web-ui-wt-inject
LAB=/root/inject-lab-20260916
EVIDENCE=$TREE/operations/injection-marking-20260916/evidence

if [ "$VARIANT" = legacy ]; then
  SRV_UNIT=injmark-server-legacy
  DIR=$LAB/srv-legacy
  PORT=3531
  EXTRA_ENV="AGENT_OS_INJECT_CAPTURE_MARKING=0"
else
  SRV_UNIT=injmark-server-marked
  DIR=$LAB/srv-marked
  PORT=3532
  EXTRA_ENV=""
fi

OPENROUTER_KEY=$(bash -c 'source /root/.bashrc >/dev/null 2>&1; printf %s "${OPENROUTER_API_KEY:-}"')
if [ -z "$OPENROUTER_KEY" ]; then echo "OPENROUTER_API_KEY not resolvable — refusing to boot" >&2; exit 3; fi

mkdir -p "$DIR" "$EVIDENCE/logs"

# shellcheck disable=SC2086
systemd-run --scope --collect --unit="$SRV_UNIT" \
  env $EXTRA_ENV \
      AGENT_OS_VAULT_ROOT="$LAB/vault" \
      AGENT_OS_INJECT_LOG="$DIR/inject-journal.jsonl" \
      AUTH_PASSWORD='$2b$10$nvqaORBU5z9FSTCnEgBGY.puZNYRuXcMsrDu2DdS4CYLkBxV.Gngm' \
      NODE_ENV=development \
      ALLOWED_ORIGINS="http://localhost:$PORT,http://127.0.0.1:$PORT,http://localhost:3541,http://127.0.0.1:3541,http://localhost:3542,http://127.0.0.1:3542" \
      OPENROUTER_API_KEY="$OPENROUTER_KEY" \
      npm run validate:server --prefix "$TREE" -- --dir "$DIR" --port "$PORT" \
  > "$EVIDENCE/logs/server-$VARIANT.log" 2>&1 &

echo "booting $VARIANT unit=$SRV_UNIT dir=$DIR port=$PORT"
for i in $(seq 1 120); do
  if grep -q "running on port\|Available providers" "$EVIDENCE/logs/server-$VARIANT.log" 2>/dev/null; then
    echo "server $VARIANT up after ${i}s"; break
  fi
  sleep 1
done
grep -E "port |socket |token " "$EVIDENCE/logs/server-$VARIANT.log" | tail -6
