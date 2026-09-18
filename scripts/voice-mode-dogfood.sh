#!/usr/bin/env bash
# Voice Mode — Phase 7 operator dogfood slice (disposable, NOT production).
#
# Boots a disposable Pi Web UI server with the LIVE voice engine enabled
# (VOICE_MODE_ENGINE=gemini-live) plus the Vite dev client wired to it, so the
# operator can run the Phase 7 real-ear session in a browser. Ctrl-C tears both
# down through the validation server's own single teardown authority.
#
# Usage (run from an interactive shell; the shell profile exports GEMINI_API_KEY):
#   bash scripts/voice-mode-dogfood.sh
# Options via env: VOICE_DOGFOOD_DIR, VOICE_DOGFOOD_PORT, VOICE_DOGFOOD_CLIENT_PORT,
#                  VOICE_DOGFOOD_PASSWORD
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${VOICE_DOGFOOD_DIR:-/tmp/pi-voice-dogfood}"
PORT="${VOICE_DOGFOOD_PORT:-3097}"
CPORT="${VOICE_DOGFOOD_CLIENT_PORT:-3499}"
PASS="${VOICE_DOGFOOD_PASSWORD:-voice-dogfood}"

cd "$REPO"

if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "GEMINI_API_KEY is not set in this shell." >&2
  echo "Run this from an interactive shell (e.g. a fresh terminal in the VNC desktop)," >&2
  echo "or export GEMINI_API_KEY yourself. The key is never printed by this script." >&2
  exit 1
fi

if [ -e "$DIR" ]; then
  echo "Disposable dir $DIR already exists."
  echo "If a previous slice is still running, stop it first:"
  echo "  node scripts/validation-server-stop.mjs --dir $DIR"
  echo "…then remove the directory and re-run. (Refusing to guess.)"
  exit 1
fi

HASH="$(node -e "console.log(require('bcrypt').hashSync(process.argv[1], 10))" "$PASS")"
if [ -z "$HASH" ]; then echo "bcrypt hash generation failed" >&2; exit 1; fi

echo "── Voice Mode Phase 7 dogfood slice ──────────────────────────────────"
echo " disposable dir : $DIR"
echo " server port    : $PORT   (engine: gemini-live)"
echo " client port    : $CPORT"
echo "──────────────────────────────────────────────────────────────────────"

# The validation server child inherits this environment (its launcher spreads
# process.env), so the engine flag and the allowed origin reach it.
AUTH_PASSWORD="$HASH" \
ALLOWED_ORIGINS="http://localhost:$CPORT,http://127.0.0.1:$CPORT" \
VOICE_MODE_ENGINE=gemini-live \
  npm run validate:server -- --dir "$DIR" --port "$PORT" \
    --claude-ws-port 43220 --claude-hook-port 43221 --opencode-port 44199 &
SERVER_PID=$!

VITE_PID=""
cleanup() {
  echo
  echo "stopping the slice…"
  if [ -n "$VITE_PID" ]; then kill "$VITE_PID" 2>/dev/null || true; fi
  node "$REPO/scripts/validation-server-stop.mjs" --dir "$DIR" 2>/dev/null || true
  echo "slice stopped. (Dir $DIR is preserved; remove it when you are done looking.)"
}
trap cleanup INT TERM

for _ in $(seq 1 90); do
  if [ -f "$DIR/internal-api-token" ] && (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    exec 3>&- && break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "the disposable server exited before becoming reachable — see its log above" >&2
    exit 1
  fi
  sleep 1
done

VITE_API_TARGET="http://localhost:$PORT" npm run dev:client -- --port "$CPORT" --strictPort &
VITE_PID=$!

sleep 3
cat <<EOF

════════════════════════════════════════════════════════════════════════
 Phase 7 session — open this in the browser:

     http://localhost:$CPORT          password: $PASS

 Steps
  1. Log in, then start (or pick) a Pi session in a scratch workspace you can
     think aloud about — a real small task, not a toy.
  2. Open Drive Mode. In the dictation row, expand the native voice lane and
     press its Start control (it is closed by default and never competes with
     the shipped mic).
  3. Talk hands-busy for ~15 minutes: think aloud, free discussion, ask the
     talker questions, give it instructions for the worker.
  4. Watch for, and judge:
       · spoken time-to-first-audio — natural pacing (target ≤ 2.0 s p90)
       · colleague feel — no switchboard interruptions, no "may I…" loops
       · ducking — audio drops while you speak and recovers, no eaten words
       · honest delivery — the chime ONLY on delivered, and the receipt
         verdict (delivered / queued / refused / unknown) visible and truthful
  5. Say "stop the lane" (or press Stop) when you are done.

 Ctrl-C here stops the disposable server and the client. Nothing in this
 script touches production.
════════════════════════════════════════════════════════════════════════
EOF

wait "$VITE_PID"
