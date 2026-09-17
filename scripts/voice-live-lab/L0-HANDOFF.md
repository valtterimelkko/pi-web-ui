# L0 Equipment — child A handoff

> **Phase:** L0 (Equipment & Infrastructure) of the Voice Live Lab.
> **Authoritative spec:** [`docs/VOICE-GEMINI-LIVE-REDESIGN-INTENT-AND-LAB.md`](../../docs/VOICE-GEMINI-LIVE-REDESIGN-INTENT-AND-LAB.md)
> §21 (records/budgets), §23 (L0 row and its gate).
> **Operative plan:** [`docs/VOICE-GEMINI-LIVE-IMPLEMENTATION-PLAN.md`](../../docs/VOICE-GEMINI-LIVE-IMPLEMENTATION-PLAN.md).
> **Child:** `voice-lab-child-a-equipment`, session `01a0aeb5-5069-77eb-8ae8-7fe1fb7916c0`.

## Owned paths (single-writer)

- `scripts/voice-live-lab/**`
- `server/tests/voice-live-lab/**`

Nothing outside these paths was modified. `agent-benchmarks/benchmarks/04-voice-live-lab/**`
was allocated to this stream but is **not** part of the L0 equipment deliverables,
so it was left untouched rather than pre-empted.

## Deliverables

| Deliverable | Path |
|---|---|
| Monotonic scheduler, append-only JSONL event log, independent pumps | `scripts/voice-live-lab/lib/scheduler.ts` |
| Fixture synthesis (Supertonic → 24 kHz master → 16 kHz s16le PCM), SHA-256 freezing, Whisper ASR gate (WER ≤ 0.08) | `scripts/voice-live-lab/lib/fixtures.ts` |
| Paced 640-byte / 20 ms PCM driver with E (explicit) and N (natural) endpointing lanes | `scripts/voice-live-lab/lib/speech-driver.ts` |
| In-process 24 kHz reference player: duck profile (gain 0.15, barge-in does not cancel) and native-interrupt profile (flush) | `scripts/voice-live-lab/lib/playback.ts` |
| Immutable attempt records + offline verifier | `scripts/voice-live-lab/lib/record.ts` |
| Scripted `serverContent` fake provider | `scripts/voice-live-lab/lib/providers/fake-live.ts` |
| `verify <attemptDir>` CLI | `scripts/voice-live-lab/cli.ts` |
| Disposable-server boot script (systemd scope) | `scripts/voice-live-lab/boot-disposable-server.sh` |
| Module map and usage | `scripts/voice-live-lab/README.md` |
| Tests | `server/tests/voice-live-lab/*.test.ts` (6 files) |

## Acceptance gate (objective)

| Gate | Command | Result |
|---|---|---|
| Tests | `npx vitest run tests/voice-live-lab/` (server workspace) | **PASS** — 6 files, 66 assertions, 0 failed |
| Lint | `npm run lint` | **PASS** — exit 0; 313 pre-existing warnings, **0 from this work** |
| Typecheck | `npm run typecheck` | **PASS** — exit 0 |
| Scoped strict types | `tsc --noEmit --strict …` over the new sources and tests | **PASS** — exit 0 |

Cross-check: in a full `npm test` run, all six `tests/voice-live-lab/*` files passed
(66 assertions, 0 failed).

## L0 verification gate (damaged traces)

`server/tests/voice-live-lab/record.test.ts` proves each of the four required
damage classes fails the verifier while a clean control passes:

- missing usage record → `required event kind missing: provider_usage`
- dropped input frames → `dropped frames …`
- non-dense / reordered sequence → `event sequence is not dense …`
- leaked golden text (in the trace or under `provider/`) → `golden text leaked …`

Tampering with a finalised artefact is caught by the artefact/manifest hashes.
`speech-driver.test.ts` additionally drives the real driver into the fake
provider and shows the same trace passing, then failing once one frame is removed.

## Disposable-server boot (in situ, 2026-09-17)

`VOICE_LAB_DIR=$(mktemp -d) bash scripts/voice-live-lab/boot-disposable-server.sh boot`

- Server ready after 6 s; `/api/v1/health` over the Internal API socket → **HTTP 200**, `status: ok`, contract `1.44.0`.
- Process cgroup: `/system.slice/voice-lab-srv.scope` — **outside** `pi-web-ui.service`; production untouched.
- Teardown (`… stop`): scope inactive, socket removed, no process remaining, state dir deleted.

The script exists because the session text guard refuses command lines containing
the literal server entrypoint path; the server's own cgroup guard (exit 78)
remains the authoritative safety control.

## Repository-wide suite status (attribution)

A full `npm test` run during the session failed 192 tests across 22 files, all in
the talker/websocket surface (`tests/unit/websocket/talker-transport.test.ts` and
neighbours) — the sibling child's in-progress talker refactor, not this work. The
same file passed again on re-run once that child's change settled. **No failure
was in `scripts/voice-live-lab/**` or `server/tests/voice-live-lab/**`.**

Note for future agents: two concurrent vitest invocations in the `server`
workspace both write `server/test-results.json`, so a scoped run can overwrite a
full run's discovery input. Prefer scoped test/lint/typecheck commands while a
sibling is active, and attribute a full-suite failure before treating it as your
own regression.

## Commit state — needs a decision

These deliverables are **uncommitted**. The master implementation plan says
children commit and push on master per phase, but a standing owner gate forbids
new commits to the pi-web-ui master branch without explicit approval, and a
sibling child holds uncommitted work in the same tree. The non-destructive
default was taken: leave the tree untouched and escalate. The parent should
review, run the gates and commit a path-limited change set.

## Next action

Phase **L1 — capability handshake** (parent-executed per the plan): open a real
`gemini-3.8-live` session and its extended-thinking variant, record transcription
events, VAD behaviour, `goAway`/resume, async tool results across a resume,
`interaction_status`, usage fields and the measured rate-limit tier; write
`capabilities.json`; probe the judge endpoint; then update the L0 fake provider to
replay the real handshake events.

## Uncertainty

- The full-suite result above is a transient concurrent-writer state, not a
  property of this work.
- L1 needs a live Gemini key and the parent to proceed; the quota tier is still
  operator-supplied rather than probed.
