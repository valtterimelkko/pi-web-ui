# Voice Mode — continuation brief (read this first after compaction)

**Written 2026-09-14 ~14:15, immediately before a session compaction.**

## Live state right now

- Production `pi-web-ui.service`: **PID 1074314, started 14:09:29**, health 200,
  `NRestarts: 0`, no startup warnings, contract **1.42.0**.
- **Verified loaded**: the process start time is *after* the last build (14:08:07).
  Do not skip this check — see "the trap that has bitten twice" below.
- Repo clean, everything pushed. `master` == origin.

## What is live and testable

| Feature | Delivered by |
|---|---|
| Reading levels: **Verbatim / Summary / Headlines** + indicator | P17 (`729a222`) |
| **Whole-turn digest** (interim output included) | P19 (`9758495`) |
| Q&A: **offer to ask the worker**, through the gate, verbatim | P18 (`f073197`) |
| **Focus/hold** + "what arrived while you were focused" recap | P18 |
| **Tier-4 split** (an elicited answer outranks unprompted musings) | P18 |
| Talker can answer **questions about earlier turns** | P20 (`7fd28ac`) |
| **One-ahead synthesis** (pauses) + **synthesis retry** (eaten start) | P21 (`ed38ca9`) |
| Stop talker, speech dedup, barge-in | P15 (`9261aba`), P16 (`8b066b3`), P13 (`3b7b66b`) |

## The operator is testing these three things

1. **"What has happened earlier in this session?"** on a mid-session attach → should now
   be answered from real history, not deferred.
2. **Summary mode** → should digest rather than read everything.
3. **Eaten start words + pauses in long reads** → should be improved.

## Honest caveats to carry (do not quietly drop these)

- **The start-clip could not be reproduced in any client-side variant.** P21 disproved
  four hypotheses by sample-level audio capture and fixed the one real code-level loss
  path (a missing retry). **If the operator still hears clipped words, the likely cause
  is device audio routing, outside this repo.** Do not assert it is fixed.
- **The pause fix has a bound**: one-ahead priming hides synthesis only while synthesis
  is faster than the chunk being played (true for the real backend, measured 410 ms →
  15–20 ms).
- **The digest fallback is safe but is the worst case**: on digest failure it reads the
  *whole* turn verbatim, i.e. the longest possible read. Seen live.
- **The talker's history window is bounded** (entries / total chars / per-entry chars in
  `SESSION_HISTORY_LIMITS`). Questions beyond it should still defer via the offer.

## How to troubleshoot Voice Mode (the observability path)

```bash
SOCKET=/root/.pi-web-ui/internal-api.sock
TOKEN="$(cat /root/.pi-web-ui/internal-api-token)"
# 1. Every recorded voice turn, newest last:
curl -s --unix-socket "$SOCKET" -H "Authorization: Bearer $TOKEN" \
  "http://localhost/api/v1/diagnostics?component=VoiceMode&limit=200"
# 2. One turn end to end:
curl -s … "http://localhost/api/v1/diagnostics?voiceTurnId=<runtime:workerSessionId:turnIndex>"
# 3. Server logs:
journalctl -u pi-web-ui.service --since "10 min ago" --no-pager
```

**A `VoiceMode` record tells you**: `phase` (answered / proposed / released / refused),
`utteranceClass`, whether the model was called, gate state, and delivery outcome. This
is what identified the earlier-turns issue in one read — the turn was a `question` that
reached `proposed`, i.e. it *deferred* rather than failed. **Check that field before
diagnosing anything.**

## The trap that has bitten TWICE — check it first every time

**Rebuilt code that was never loaded looks exactly like a broken feature.**

- The relay fix appeared broken → the server was running the pre-fix build.
- The digest appeared broken ("Could not summarise — read in full") → the server had
  started **6h50m before** its build.

**So: before diagnosing any "X doesn't work", verify the running process post-dates its
build.** A process cannot load a build made after it started. This is now the single
highest-yield check in this repo.

## Governance notes for this work

- **The gate is structural and must never be widened**: `release()` private with one
  caller, `takeForRelease` atomic, the relayed text is always the operator's verbatim
  words. Every package re-verifies this.
- **Summarise ONE direction only**: worker → operator may be condensed; operator →
  worker never.
- **Capture is never gated**; the operator's speech is never interrupted; only playback
  is scheduled.
- **Lint ratchet ceiling 326, actual ~310.** No suppressions; the ceiling was
  re-baselined when tests were exempted from two rules — see `check-lint-ratchet.mjs`.
- **Children cannot switch modes, only suggest.** The model proposes, never acts.

## Open / unfinished (deliberately, not forgotten)

- **The P21 audio-probe scripts were removed**, not committed: the parent damaged them
  attempting a lint fix. The findings are in the child's report. Re-do them if the audio
  evidence is needed again — they are not required for the feature.
- **`docx-fidelity-guard`**: 979 lines of unique unpushed work in a 6-week-old branch.
  Operator said leave the worktree be. Untouched.
- **Antigravity** validation gap and the operator's **listening check** remain open by
  design (no audio hardware on this host).
- **Heredoc caution**: `bash` heredocs containing backticks/quotes have silently
  mangled commands in this session; verify file contents after writing.

## Where the durable records live

- `docs/plans/VOICE-READING-AND-QA-DESIGN.md` — the agreed design for levels + Q&A.
- `docs/plans/VOICE-HARNESS-EXECUTION-STATE.md` — the long chronological record.
- `docs/plans/VOICE-MODE-VALIDATION-RESULTS.md` — acceptance evidence + findings.
- `docs/plans/VOICE-MODE-BROWSER-E2E-RESULTS.md` — the browser E2E + the relay defect.
- `docs/archive/briefs/` — all ~31 package briefs (another agent archived them here).
- `docs/OBSERVABILITY.md` § "Voice Mode observability" — the documented queries.
