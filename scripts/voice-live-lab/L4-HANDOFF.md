# L4 Handoff — Tier 1 Guarded Live Harness & Runner (Phase L4)

**Child A3, Voice Live Lab build sequence (plan §23 L4 row).** Committed on
`master`; the parent independently verifies and signs off.

## What was delivered

| Deliverable | File | Status |
|---|---|---|
| Gemini Live adapter | `scripts/voice-live-lab/lib/providers/gemini-live.ts` | NEW |
| Tier 1 guarded harness | `scripts/voice-live-lab/lib/harness/tier1-guarded.ts` | NEW |
| Tier 1 runner (dry + measured) | `scripts/voice-live-lab/lib/tier1-dryrun.ts` | NEW |
| CLI `tier1-dryrun` / `tier1-run` | `scripts/voice-live-lab/cli.ts` | additive |
| README (Tier 1 usage) | `scripts/voice-live-lab/README.md` | updated |
| Adapter contract tests | `server/tests/voice-live-lab/gemini-live.test.ts` | NEW (23) |
| Harness + runner + CLI tests | `server/tests/voice-live-lab/tier1-guarded.test.ts` | NEW (29) |

Nothing else in the repository was touched. No `server/src/**` changes; the
policy core is consumed, not modified. Run records were written only outside
the repository (`/root/agent-benchmarks/.../runs/L4-e2e-*`) and are never
committed.

## 1. `gemini-live.ts` — the injectable Live seam (§16.2)

- Implements `ProviderInputSink`: `pushAudio` streams 16 kHz base64 PCM
  chunks via `sendRealtimeInput`; `activityStart`/`activityEnd` send the
  E-lane markers (logged, not sent, in N).
- Connect config: `responseModalities: ['AUDIO']`,
  `inputAudioTranscription: {}`, `outputAudioTranscription: {}`,
  `sessionResumption: {}`; E lane `automaticActivityDetection: {disabled:
  true}`, N lane `automaticActivityDetection: {}`.
- Declares exactly the two tier-1 functions (`mark_addressed_to_talker`,
  `offer_ask_worker`), both `behavior: NON_BLOCKING`, and acknowledges every
  tool call with `scheduling: 'SILENT'` so a call never triggers a new model
  turn.
- Server messages → dense `provider_content` / `provider_usage` /
  `lifecycle` events plus typed callbacks (`onInputTranscriptionDelta`,
  `onOutputTranscriptionDelta`, `onAudioPcm` with decoded PCM,
  `onTurnComplete`, `onInterrupted`, `onToolCall`, `onResumptionHandle`,
  `onGoAway`). Usage passes through `promptTokenCount`,
  `responseTokenCount`, `totalTokenCount`, `thoughtsTokenCount` (ET).
- State-view context updates (`sendClientContent{turnComplete:false}`):
  coalesced ≥ 2 s apart (latest wins), deferred while speech is active
  (lane-uniform `setSpeechActive`), flushed on release. Urgent context notes
  (what the host said on a mechanical turn) follow the same never-mid-speech
  rule.
- 100 % offline for tests: a mock `LiveSessionFactory` captures the connect
  request and drives `onmessage` by hand. `createGenaiLiveSessionFactory`
  (real `@google/genai` 1.52.0) is built only for a measured run.

## 2. `tier1-guarded.ts` — the guarded harness (§16.3, §16.5)

- **Commit rule as a pure state machine** (`TranscriptCommitTracker`,
  default 400 ms): commits only when (1) the provider signalled end of input
  turn (`activityEnd` in E; the 400 ms no-delta window in N), (2) the
  transcript is stable ≥ 400 ms, (3) it is non-empty after
  `relay-normalise`. Partials are logged (every delta is already a
  `provider_content` event) and never committed. Late ASR deltas that arrive
  after `activityEnd` stay in the SAME turn (only a commit starts the next
  one) — found by test, pinned by test. `commitLatencyMs` is measured and
  reported on every turn (the price of N2).
- **The gate is the L3 policy core, executed exactly as `TalkerSession`
  does**: `tickTurn` → `utteranceLog.record` → `decideOperatorTurn` →
  execute only what the decision names (release via `takeForRelease` →
  recorded `WorkerDelivery`; `refuse-lapsed` → `markResurfaced`; cancel with
  draftable residue; worker-directed pre-draft; post-model plan via
  `decideAfterModelReply`).
- **The two declared functions are interpreted through the SAME policy
  function**: the harness synthesises the marker-equivalent reply (appending
  `[[to-talker]]`/`[[ask-worker]]` when the model called the corresponding
  function) and hands it to `decideAfterModelReply` — suppression and
  candidate-creation only, never a release; zero re-implementation of the
  semantics.
- **Mechanical gate transitions**: trusted mechanical voice at receipt tier
  (injectable `MechanicalVoice`; Supertonic in production, labelled silence
  mock in dry runs with real byte accounting), `harness_mechanical` /
  `harness_release` / `harness_receipt` events, and the same text injected
  as a context update. Native audio queued before the decision is discarded
  via the reference player (`mechanical-gate` stops) with honest accounting
  — received = rendered + discarded + queued stays balanced.
- **Two transcript conditions**: `native` (Gemini `inputTranscription`
  decides; shadow ASR logged as fidelity reference) and `sidecar` (shadow
  ASR decides; Gemini transcript logged as the shadow). The deciding
  transcript is recorded as `turn_complete.transcript`; both transcripts are
  in every payload.
- **Playback**: reference player duck profile wired to the operator floor
  (gain 0.15 while speech is active); `native-interrupt` profile exploration
  supported through the player's own profile switch;
  `provider interrupted` → `player.interrupt` (flush in native-interrupt,
  recorded-as-ignored in duck).
- `buildTier1SystemInstruction`: the v3-harness prompt minus the
  text-marker lines, plus the two-function contract and "You never send; the
  host sends."
- Event vocabulary is scorer-compatible: per turn one `provider_content`
  (leg `tier1-turn`), one `provider_usage` (deciding `stt`, `shadow` /
  `nativeShadow`, `model`, optional `tts`), one `turn_complete` (superset of
  the L2 payload: condition, native/shadow transcripts, commitLatencyMs,
  toolCalls, modelTurnComplete).

## 3. Runner and CLI

- `runTier1DryAttempt` (hermetic): scripted live client (transcription
  deltas → world-basis reply audio + outputTranscription → bookkeeping tool
  call → turnComplete; confirm-shaped turns stay silent because the harness
  owns those transitions), scripted shadow ASR (`whisper-script`), silence
  mechanical voice, null delivery. Manifest labels
  `provider: "gemini-live-dryrun"`, `mode: "dry-run"`,
  `realProviderCalls: 0`, the transcript condition, the commit rule used and
  the delivery description. Condition naming follows §26.5:
  `t1/gemini-live-dryrun/<lane>-<condition>-duck/<world>`.
- `runTier1MeasuredAttempt` + `createWhisperShadowAsr` + `encodeWav`: the
  guarded real-run entry — refuses an empty `GEMINI_API_KEY` (never an
  unlabelled attempt), real Live session + real Whisper container shadow;
  manifest `mode: "measured"`. Budget/quota/window checks stay with the
  caller (plan §21).
- CLI: `tier1-dryrun [--scenario] [--runs-root] [--run-id] [--attempts]
  [--condition native|sidecar] [--stability-ms N] [--frame-interval-ms N]
  [--json]` and `tier1-run --scenario … [--condition] [--model]
  [--whisper-endpoint]` (exit 2 + explanation without the key). The shared
  attempt loop is factored once for baseline/tier1.

## 4. Verification evidence (all re-runnable)

| Gate | Command | Result |
|---|---|---|
| Unit tests | `cd server && npx vitest run tests/voice-live-lab/` | **198/198 pass** (146 existing + 52 new; 0 modified) |
| Typecheck | `npm run typecheck` | **exit 0** |
| Lint | `npm run lint` | **0 errors, 0 warnings** |
| Build | `npm run build` | **exit 0** |
| Scorer parity | `python3 -m pytest /root/agent-benchmarks/benchmarks/04-voice-live-lab/tests/ -q` | **12/12 pass** |
| E2E dry run | `tier1-dryrun` × 7 shipped scenarios × {native, sidecar}, then `verifyAttempt` | **14/14 `verify=ok`**, releases 2/2/1/2/1/2/0 per scenario in BOTH conditions |
| E2E scoring | `score_voice.py runs/L4-e2e-native` and `runs/L4-e2e-sidecar` | **14/14 PASS, failedBeats=[] everywhere**; releases only in confirm-permitted windows; receipts on the composition beats |

The dry-run records live at
`/root/agent-benchmarks/benchmarks/04-voice-live-lab/runs/L4-e2e-native/` and
`.../L4-e2e-sidecar/` (outside the repository, never committed). Every beat
expectation the shipped scenarios declare — relay gating, draft creation,
released-contains, trusted acks, conversational-only, answered-from-history,
permission answered, receipt at receipt tier — was exercised mechanically and
passed in both transcript conditions.

## 5. Notes and known boundaries (for the parent's sign-off)

1. **Commit-rule finding pinned by test**: native ASR finalises the
   transcript *after* `activityEnd`; a late delta belongs to the same
   utterance and restarts the stability window rather than opening a new
   turn. The tracker preserves `activityEnd` across reopen; only a commit
   starts the next turn.
2. **`settle()` deadlock avoidance**: an E-lane turn with no `activityEnd`
   can never commit by rule, so `settle()` leaves it open (flush's force
   closes it as an explicit `flush` boundary); it does not spin.
3. **Dry-run stability compression**: the CLI/runner accept
   `--stability-ms` for hermetic speed; the default and every measured run
   use the real 400 ms. The unit tests pin the 400 ms default on the tracker
   itself with a manual clock.
4. **Mechanical voice in a measured `tier1-run`** stays the labelled silence
   mock until the Supertonic binding is reviewed; the manifest records
   `mechanicalVoice: { provider: "silence-mock", synthesised: false }` so a
   measured row can never pass the mechanical audio off as Supertonic.
   Binding Supertonic is a wiring task for the measured-matrix phase (L4's
   5×7×2×2 runs), not a harness change — the interface accepts it.
5. **The L4 measured matrix is deliberately NOT run here** (5 attempts × 7
   scenarios × 2 conditions × 2 lanes ≈ 140 live attempts, ~9 serialised
   hours). This phase delivers and proves the harness hermetically; the
   measured matrix is a scheduled, budgeted run for the operator's window.
6. `turn_complete.ttftMs` stays `null` for tier 1 (Live exposes no
   per-token timing); the honest model-leg split is `modelMs`
   (commit → turnComplete) plus `commitLatencyMs`.
7. The adapter's `usageMetadata` passes token fields through verbatim
   (including `thoughtsTokenCount` for the ET model); the scorer's
   spend estimation remains char-based and clearly labelled, unchanged from
   L2.

## 6. Pre-existing quirk observed (not touched)

`DEFAULT_RUNS_ROOT` ends in `/runs` while `attemptDirFor` appends another
`runs` segment, so `baseline-dryrun` without `--runs-root` writes to
`.../runs/runs/...` (pre-existing L2 behaviour; the same path outside the
repository). The tier-1 e2e evidence above passes `--runs-root` pointing at
the benchmark root, which yields the intended `runs/<runId>/...`. Left
untouched as out of scope; flagging it for the parent to route.

---

FROZEN-HANDBACK: Phase L4 Tier 1 Guarded Live Harness Complete.
