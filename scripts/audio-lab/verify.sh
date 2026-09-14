#!/usr/bin/env bash
# Audio regression lab — independent verification.
#
# Reruns the bounded automated gates and re-validates the IMMUTABLE evidence
# records. It does not grep for a self-reported success: the record check
# recomputes every artifact hash and re-derives each scenario status from that
# scenario's own assertions.
#
# Usage:
#   scripts/audio-lab/verify.sh                        # gates + all recorded attempts
#   scripts/audio-lab/verify.sh <attempt-dir> [...]    # gates + those attempts only
#
# Exit codes: 0 everything verified; 1 a real regression was recorded;
#             2 verification could not be completed (missing/invalid proof).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# Explicit isolated environment: an inherited NODE_ENV=production silently
# changed what `npm ci` installed during this lab's construction, and the
# workspace test runner must never inherit provider credentials either.
export NODE_ENV=test
unset OPENAI_API_KEY TTS_OPENAI_API_KEY DICTATION_OPENAI_API_KEY 2>/dev/null || true

EVIDENCE_ROOT="${AUDIO_LAB_EVIDENCE_ROOT:-/root/.pi-web-ui/operations/audio-lab-20260914/implementation/evidence}"
LAB="npx tsx scripts/audio-lab/cli.ts"
failures=0
recorded_regression=0

step() { printf '\n=== %s ===\n' "$1"; }
ok()   { printf 'PASS  %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }

# ---------------------------------------------------------------------------
step "1. lab unit + adversarial suite (oracle, WAV, DSP, record verification)"
if npx vitest run --root server tests/audio-lab --reporter=basic; then
  ok "audio-lab suite"
else
  bad "audio-lab suite"
fi

# ---------------------------------------------------------------------------
step "2. oracle adversarial matrix is enforced (detectors must be able to FAIL)"
# Named explicitly so a future refactor cannot quietly drop the negative
# controls: a detector that cannot fail on damaged audio is not a detector.
if npx vitest run --root server tests/audio-lab/oracle.test.ts -t "adversarial controls" --reporter=basic; then
  ok "adversarial controls present and enforced"
else
  bad "adversarial controls"
fi

# ---------------------------------------------------------------------------
step "3. offline verification of immutable records"
attempts=()
if [ "$#" -gt 0 ]; then
  for arg in "$@"; do attempts+=("$arg"); done
else
  while IFS= read -r dir; do attempts+=("$dir"); done < <(
    find "$EVIDENCE_ROOT/runs" -mindepth 2 -maxdepth 2 -type d -name 'attempt-*' 2>/dev/null | sort
  )
fi

if [ "${#attempts[@]}" -eq 0 ]; then
  bad "no recorded attempts found under $EVIDENCE_ROOT/runs"
else
  for attempt in "${attempts[@]}"; do
    if [ ! -d "$attempt" ]; then bad "missing attempt directory: $attempt"; continue; fi
    if $LAB verify-record "$attempt"; then
      ok "record verified: $attempt"
    else
      status=$?
      if [ "$status" -eq 1 ]; then recorded_regression=1; fi
      bad "record NOT verified: $attempt (exit $status)"
    fi
  done
fi

# ---------------------------------------------------------------------------
step "4. environment is still capable of running the lab"
if $LAB doctor; then
  ok "doctor"
else
  doctor_status=$?
  # A missing production-TTS fixture corpus is exit 2 by design and is reported
  # by doctor itself; treat only an unexplained failure as a hard failure here.
  if [ "$doctor_status" -eq 2 ]; then
    bad "doctor reported an unmet capability (see output above)"
  else
    bad "doctor"
  fi
fi

# ---------------------------------------------------------------------------
step "5. hygiene: no media, profiles or credentials staged for commit"
staged="$(git diff --cached --name-only 2>/dev/null || true)"
if printf '%s\n' "$staged" | grep -qE '\.(mp3|wav|pcm|raw|png)$|browser-profile|(^|/)secrets?\.env'; then
  bad "staged files include media/profile/secret-looking paths"
else
  ok "no media, browser profile or secret paths staged"
fi

# ---------------------------------------------------------------------------
printf '\n=== summary ===\n'
if [ "$failures" -ne 0 ]; then
  printf '%d verification step(s) failed\n' "$failures"
  exit 2
fi
if [ "$recorded_regression" -ne 0 ]; then
  printf 'records verified, but a recorded scenario demonstrates a REGRESSION\n'
  exit 1
fi
printf 'all verification steps passed\n'
exit 0
