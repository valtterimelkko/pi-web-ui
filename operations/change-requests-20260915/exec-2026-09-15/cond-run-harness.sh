#!/usr/bin/env bash
# CONDUCTOR runs child B's multi-lane harness MYSELF, against MY OWN disposable pieces
# (ports 3501/3503, state dir /tmp/cond-lanes-srv) — not the child's servers or evidence dir.
# A fresh browser profile and workspace so nothing is inherited from the child's run.
set -uo pipefail

H=/root/pi-web-ui/operations/change-requests-20260915/child-voice/harness/one-tab-lanes.mjs
OUT=/tmp/cond-lanes-evidence
rm -rf "$OUT" /tmp/cond-lanes-profile /tmp/cond-lanes-workspace
mkdir -p "$OUT"

VOICE_EVIDENCE_DIR="$OUT" \
VOICE_APP_URL=http://127.0.0.1:3503 \
VOICE_SOCKET=/tmp/cond-lanes-srv/internal-api.sock \
VOICE_TOKEN_PATH=/tmp/cond-lanes-srv/internal-api-token \
VOICE_PASSWORD='voice-lab-pass' \
VOICE_PROFILE=/tmp/cond-lanes-profile \
VOICE_WORKSPACE=/tmp/cond-lanes-workspace \
  node "$H" 2>&1 | tail -40

echo "=== exit=$? ==="
echo "=== verdicts as recorded by the harness ==="
python3 - <<'PY'
import json,os
p="/tmp/cond-lanes-evidence/lanes.json"
if not os.path.exists(p): print("  no lanes.json written"); raise SystemExit
d=json.load(open(p))
v=d.get("verdicts") or {}
passed=[k for k,x in v.items() if x is True]
failed=[k for k,x in v.items() if x is not True]
print(f"  {len(passed)} pass / {len(failed)} not-pass  of {len(v)}")
for k in sorted(v): print(f"    {'PASS' if v[k] is True else 'FAIL'}  {k}")
print("  screenshots:", len(d.get("screenshots") or []))
for n in d.get("notes") or []: print("   note:", str(n)[:160])
PY
