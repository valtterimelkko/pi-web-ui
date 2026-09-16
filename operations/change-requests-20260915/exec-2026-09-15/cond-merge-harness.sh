#!/usr/bin/env bash
# CONDUCTOR post-merge end-to-end browser proof, run against the MERGED MASTER checkout
# (its own disposable server :3505 + vite :3507, own state dir and browser profiles).
# Both harnesses were written by children; the conductor drives them here, in its own
# environment, against the merged tree — the strongest available end-to-end evidence.
set -uo pipefail

MID=/tmp/cond-merge-evidence
rm -rf "$MID" /tmp/cond-merge-lane-profile /tmp/cond-merge-lane-ws /tmp/cond-merge-card-profile
mkdir -p "$MID/lanes" "$MID/card" /tmp/cond-merge-lane-ws

LANE=/root/pi-web-ui/operations/change-requests-20260915/child-voice/harness/one-tab-lanes.mjs
CARD=/root/pi-web-ui/operations/change-requests-20260915/exec-2026-09-15/harness-card-identity.mjs
SOCK=/tmp/cond-merge-srv/internal-api.sock
TOK=/tmp/cond-merge-srv/internal-api-token
APP=http://127.0.0.1:3507

echo "##### LANE HARNESS (multi-lane voice in one tab) #####"
VOICE_EVIDENCE_DIR="$MID/lanes" VOICE_APP_URL="$APP" \
VOICE_SOCKET="$SOCK" VOICE_TOKEN_PATH="$TOK" \
VOICE_PASSWORD='voice-lab-pass' VOICE_PROFILE=/tmp/cond-merge-lane-profile VOICE_WORKSPACE=/tmp/cond-merge-lane-ws \
  node "$LANE" 2>&1 | tail -22
echo "lane harness exit=${PIPESTATUS[0]}"

echo
echo "##### CARD HARNESS (confirmation-card identity + staleness refusal) #####"
CARD_EVIDENCE_DIR="$MID/card" CARD_APP_URL="$APP" \
CARD_SOCKET="$SOCK" CARD_TOKEN_PATH="$TOK" \
CARD_PASSWORD='voice-lab-pass' CARD_PROFILE=/tmp/cond-merge-card-profile \
  node "$CARD" 2>&1 | tail -22
echo "card harness exit=${PIPESTATUS[0]}"

echo
echo "##### VERDICTS AS RECORDED #####"
python3 - <<'PY'
import json, os
for label, path, key in (("LANES", "/tmp/cond-merge-evidence/lanes/lanes.json", "verdicts"),
                         ("CARD", "/tmp/cond-merge-evidence/card/card-identity.json", "verdicts")):
    print(f"--- {label}: {path}")
    if not os.path.exists(path):
        print("   NOT WRITTEN"); continue
    d = json.load(open(path))
    v = d.get(key) or {}
    ok = [k for k, x in v.items() if (x is True or (isinstance(x, dict) and x.get("ok") is True))]
    bad = [k for k in v if k not in ok]
    print(f"   {len(ok)} pass / {len(bad)} not-pass  of {len(v)}")
    for k in bad:
        print("     FAIL:", k, str(v[k])[:150])
    print("   screenshots:", len(d.get("screenshots") or []))
PY
echo "##### MERGED-TREE HARNESS RUN DONE #####"
