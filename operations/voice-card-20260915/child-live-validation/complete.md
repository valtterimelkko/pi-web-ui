# W2b — live validation of the card contract on a disposable server (child handback)

**Status: COMPLETE — every briefed row driven, all PASS except the one row of `p27-ws-transport-validate.mjs` that pins the pre-fix defect (expected flip, explained in §5). One INDETERMINATE family, reasoned in §6.**

- Programme: `operations/voice-card-20260915/` · Brief: `child-live-validation/brief.md`
- Validated bytes: repo `/root/pi-web-ui`, branch `master`, **HEAD `0798661`** (frozen — no source edit, no git mutation, no build, no service change)
- Child session: `01a0a42c-b47d-7422-bc57-055e4ca4dd61` · Parent: `01a0a410-f683-7422-bc57-055af50db3f2`
- Server under test: **disposable `npm run validate:server` only.** Production was never contacted, started, stopped or restarted by this child.

---

## 1. What was driven, and how

The card contract lives on the **browser WebSocket seam**. Every row below was
driven over that seam exactly as the browser drives it — cookie login →
`/ws` → `talker_turn` → `talker_turn_result` — against a disposable server whose
**talker model is a local deterministic stub** (`harness/talker-stub.mjs`,
OpenAI-compatible SSE on `127.0.0.1:3918`, fixed non-marker reply, every request
body logged).

Two mechanics worth recording, because the brief's rows cannot be driven without
them:

1. **A proposed turn needs a real worker session.** The talker refuses with
   `model_unconfigured` if no talker model is configured, and refuses a
   non-existent worker; so a real pi worker session is created over the socket
   (`new_session`) first.
2. **The pi branch of the WS `new_session` message ignores its `model` field**
   (`connection.ts` → `handleNewSession` → `createAndSubscribe(clientId, cwd, …)`,
   no model argument). Setting a model requires the browser's own `set_model`
   message. (See §7 S1 — an observation, not a fix.)
3. **The worker lane was also pinned to the local stub**, so that "never a real
   hosted model" holds absolutely: an isolated `PI_AGENT_DIR` whose `models.json`
   overrides the `openai` provider's `baseUrl` to `http://127.0.0.1:3918/v1`, plus
   the disposable server launched with `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
   `DEEPSEEK_API_KEY`, `ZAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`,
   `GEMINI_API_KEY`, `NVIDIA_API_KEY` **removed from its environment**. Proof that
   this held: every assistant text block in every session on the disposable server
   is byte-equal to the stub reply
   (`evidence/no-hosted-model-reconciliation.txt`: 11 sessions, 6 assistant text
   blocks, 6 equal, 0 others), and every stub request carries `Bearer stub-local-key`.

The rows are driven by `harness/l-rows.mjs` (new file, evidence harness only —
not repo source).

---

## 2. Row table — observed bytes

Final coherent run: `evidence/rows-L1-L7-full.json` (raw frames),
`evidence/key-frames.json` (raw frames, condensed).

| Row | Drove | **Observed bytes** | Expected | Verdict |
|---|---|---|---|---|
| **L1** | `talker_turn {utterance:"Proceed.\n"}` on a fresh worker | `{"type":"talker_turn_result",…,"phase":"proposed","utteranceClass":"statement","released":null,"cancelled":false,"proposal":{"text":"Proceed.","cleaned":false},"receiptAck":"Noted — still holding that."}` — result keys are exactly `type,requestId,workerSessionId,runtime,reply,phase,utteranceClass,released,cancelled,proposal,receiptAck`; the `proposal` object has exactly the keys `text,cleaned` | `phase:proposed`; `proposal.text === "Proceed."`; `cleaned:false`; **no** `removed`, **no** `original` | **PASS** |
| **L2** | `talker_turn {utterance:"Um, tell the worker to rerun the suite"}` on a fresh worker | `"proposal":{"text":"rerun the suite","cleaned":true,"original":"Um, tell the worker to rerun the suite","removed":"Um, tell the worker to"}` | `cleaned:true`; `removed` = fragments only, never the whole utterance; `original` = the raw utterance | **PASS** |
| **L3** | default confirm `yes, go ahead` after L2 | `"released":{"utteranceId":1,"text":"rerun the suite","delivery":{"outcome":"delivered","mechanism":"prompt","disclosure":"delivered as the worker was idle"}}`; `phase:"released"`; worker transcript user text = `"rerun the suite"` (byte-equal, 1 user message) | `released.text` byte-identical to L2's `proposal.text`; the delivery adapter recorded exactly those bytes | **PASS** |
| **L4** | fresh L2 utterance, then confirm `yes, go ahead` with `releaseVariant:"original"` | proposal: `"text":"rerun the suite","cleaned":true,"original":"Um, tell the worker to rerun the suite","removed":"Um, tell the worker to"`; release: `"released":{"utteranceId":1,"text":"Um, tell the worker to rerun the suite",…}`; transcript user text = `"Um, tell the worker to rerun the suite"` | `released.text` byte-identical to that turn's `proposal.original` | **PASS** |
| **L5a** | statement `Um, tell the worker to rerun the suite` **with** `releaseVariant:"original"`, fresh session; control: same utterance **without** the variant, separate fresh session | variant turn: `phase:"proposed"`, `released:null`, `proposal={"text":"rerun the suite","cleaned":true,"original":"…","removed":"Um, tell the worker to"}`; control turn: byte-identical `proposal` (`identical=true`) | nothing released; the draft is unaffected by the variant | **PASS** |
| **L5b** | draft held → `did you send it?` **with** `releaseVariant:"original"` → plain default confirm | mid turn `phase:"proposed"`, `released:null`; draft before `{"text":"rerun the suite",…}` == draft after (byte-identical); later confirm `phase:"released"`, `released.text:"rerun the suite"` | the variant-carrying non-confirm turn releases nothing and leaves the draft intact | **PASS** |
| **L6** | `talker_turn {utterance:"Um, …", releaseVariant:"raw"}` | `{"type":"error","message":"Invalid talker_turn message format","code":"INVALID_MESSAGE","requestId":"r11"}`; **no** `talker_turn_result` for that `requestId` | `INVALID_MESSAGE`; no `talker_turn_result` | **PASS** |
| **L6-control** | same field, valid value `releaseVariant:"tidied"` | `phase:"proposed"`, no error | proves the L6 rejection is about the *value*, not the field | **PASS** |
| **L7** | draft, then 6 non-draft-touching turns (`did you send it?`, `maxPendingAgeTurns=6`), then confirm **with** `releaseVariant:"original"`; control: same lapse with the default variant | variant: `phase:"proposed"`, `released:null`, `reply:"You were composing something — still want that sent? Here is what I am holding: \"rerun the suite\". Say yes and I will send it."`; control: byte-identical reply (`sameReply=true`), `released:null` | the existing re-confirmation refusal, unchanged — the variant does not widen the gate | **PASS** |
| **L8a** | `npx tsx scripts/p27-talker-matrix-live.ts --stub-only` | `rows executed: 33, PASS: 33, FAIL: 0` → `P27 PHASE A: all executed rows PASS` (exit 0) | unchanged pass | **PASS** |
| **L8b** | `node scripts/p27-ws-transport-validate.mjs` against the disposable server | `rows: 15, PASS: 14, FAIL: 1` (exit 1) — the only FAIL is `17-wire-REPRO` | unchanged pass | **14/15 PASS — see §5** |

**Byte strings recorded above are copied verbatim from the raw frames** in
`evidence/rows-L1-L7-full.json`; `evidence/key-frames.json` carries the
sent/received frame pairs per row, and
`evidence/delivered-bytes-in-transcripts.jsonl` carries the delivered user bytes
as they landed in each worker transcript.

---

## 3. Exact commands

```bash
# 0. local deterministic talker stub (own systemd scope — see §4)
systemd-run --scope --collect --unit=w2b-stub-<TS> \
  node $HB/harness/talker-stub.mjs --port 3918 --log $HB/logs/talker-stub.jsonl

# 1. disposable validation server (own systemd scope), talker + pi runtime pinned to the stub
systemd-run --scope --collect --unit=w2b-server-<TS> \
  env -u OPENAI_API_KEY -u OPENROUTER_API_KEY -u DEEPSEEK_API_KEY -u ZAI_API_KEY \
      -u ANTHROPIC_API_KEY -u GOOGLE_API_KEY -u GEMINI_API_KEY -u NVIDIA_API_KEY \
      AUTH_PASSWORD='$2b$10$PQVNnqIkoSAi07zqxH6KUu3w3pQaySmCv9P.5ckyqNo.aCcPwhV8y' \
      TALKER_BASE_URL=http://127.0.0.1:3918/v1 TALKER_API_KEY=stub-local-key \
      TALKER_MODEL=stub/deterministic PI_AGENT_DIR=/tmp/w2b-agent \
  npm run validate:server -- --dir /tmp/w2b-live-f

# 2. the briefed rows L1–L7 over the real WebSocket seam
node $HB/harness/l-rows.mjs --base http://localhost:39815 \
  --origin https://pi.letsautomate.work --password validation-pass \
  --rows L1,L2,L3,L4,L5,L6,L7 --out $HB/evidence/rows-L1-L7-full.json

# 3. L8 transport regressions
env -u OPENCODE_ENABLED -u PI_MAX_SESSIONS npx tsx scripts/p27-talker-matrix-live.ts \
  --stub-only --json $HB/evidence/p27-talker-matrix-stub.json

node scripts/p27-ws-transport-validate.mjs --base http://localhost:39815 \
  --password validation-pass --origin https://pi.letsautomate.work \
  --out $HB/evidence/p27-ws-transport.json --server-log $HB/logs/validation-server.log \
  --dir /tmp/w2b-live-f --socket /tmp/w2b-live-f/internal-api.sock \
  --token /tmp/w2b-live-f/internal-api-token

# 4. teardown (mine only)
systemctl stop w2b-server-<TS>.scope && systemctl stop w2b-stub-<TS>.scope
rm -rf /tmp/w2b-live-{20260915,b,c,d,e,f} /tmp/w2b-agent
```

(`$HB` = `operations/voice-card-20260915/child-live-validation`; `<TS>` = the
timestamped unit names recorded in `logs/server-unit.txt` and `logs/stub-unit.txt`.)

**Operational note (post-incident rule).** My first disposable server ran inside
the `pi-web-ui.service` cgroup and was killed when that service was restarted
under me at 08:30:26 UTC. Every server and stub after that ran in its own
transient `systemd-run --scope` unit (outside the service cgroup) — see
`logs/*-unit.txt`; both scopes were stopped afterwards and
`systemctl list-units 'w2b-*'` is now empty.

---

## 4. Logs and evidence

| Path | Contents |
|---|---|
| `logs/talker-stub.jsonl` | every model request the stub served (talker + worker lanes), with auth header, model, and last user content — the byte-level proof of the deliveries |
| `logs/validation-server.log` | disposable server startup + `voice turn pi:<session>` / `voice release pi:<session>` lines |
| `logs/p27-talker-matrix-stub.log` | the 33-row in-process matrix |
| `logs/p27-ws-transport.log` | the 15-row WS transport run |
| `evidence/rows-L1-L7-full.json` | **primary**: rows + raw sent/received frames |
| `evidence/key-frames.json` | the same, condensed per row |
| `evidence/delivered-bytes-in-transcripts.jsonl` | the delivered user bytes as they landed in each worker transcript |
| `evidence/no-hosted-model-reconciliation.txt` | the zero-hosted-model reconciliation |
| `evidence/p27-talker-matrix-stub.json`, `evidence/p27-ws-transport.json` | machine-readable P27 ledgers |
| `harness/talker-stub.mjs`, `harness/l-rows.mjs` | the two harness files (new, evidence-only) |
| `evidence/rows-L1-L2-L6.json`, `rows-L2-L3.json`, `rows-L4-L5.json`, `rows-L7.json`, `probe-default-model.json` | intermediate runs kept for provenance (earlier server instances); superseded by `rows-L1-L7-full.json` |

---

## 5. The single L8b FAIL is the expected flip, not a regression

`scripts/p27-ws-transport-validate.mjs` contains a row that *pins the defect this
commit fixed*:

```js
record('17-wire-REPRO', 'inspect the proposed result for the P26 card contract',
  `wire result keys=${JSON.stringify(Object.keys(w2))} — has proposal object: ${hasProposal}`,
  hasProposal === false /*** asserts the proposal object is ABSENT ***/);
```

Observed now: `wire result keys=[…,"proposal","receiptAck"] — has proposal object: true`.

That row asserts the **pre-fix** wire shape (no `proposal` object at all). Commit
`0798661` deliberately adds that object ("the card proposal finally rides the
wire"), so the assertion *must* now fail. Every other transport row is unchanged
and passes, including the ones that matter to this contract:

- `18e-wire` `phase=released` … `delivery={"outcome":"delivered","mechanism":"prompt"}`
- `9-wire` released text byte-compared against the worker transcript: **exact-byte match = true**
- `18f-wire` malformed turn → `INVALID_MESSAGE`; `16b–16e` diagnostics/log rows unchanged.

The script was not updated by `0798661` (its own `git log` shows no change in
that commit). **This is a stale assertion in a validation script, not a
behavioural regression** — recorded, not fixed (no source edits in this brief).

---

## 6. INDETERMINATE (with reasons)

| Item | Reason |
|---|---|
| The **real-model** rows of `p27-ws-transport-validate.mjs` (`19a`/`19b`, `talker_digest`). | The script's own header says those rows need the real OpenRouter talker model; the brief forbids calling a hosted model (§2/§3). They were driven with the deterministic stub, so they exercise the wire path only — the "digest" returned is the stub's fixed sentence (44 chars, non-repeating). They are **not** evidence about digest quality, and they are outside the card contract. |
| The **mid-run steer** delivery mechanism. | All deliveries observed were `mechanism:"prompt"` ("delivered as the worker was idle") because a stub-backed worker finishes instantly. Exercising `mechanism:"steer"` needs a long-running real worker, i.e. a real model — out of scope and forbidden here. The card contract's claim (which bytes are released) is unaffected: it was byte-verified for both variants. |
| Any behaviour requiring a real hosted model. | Forbidden by brief §3; the whole lane is stub-backed by construction, and that is independently verified in `evidence/no-hosted-model-reconciliation.txt`. |

---

## 7. Side observations (recorded, not fixed — outside this brief)

- **S1 — the pi branch of the WS `new_session` message ignores `model`.**
  `handleNewSession` logs the requested model but the pi path calls
  `createAndSubscribe(clientId, cwd, getWebUIContext(clientId))` with no model
  argument. Observed live: `new_session {model:"localstub/deterministic"}` →
  server log `model=localstub/deterministic`, but the session's transcript records
  `model_change → provider:"openai", modelId:"gpt-5.5"` and ran a real agent turn on
  that default. The working browser path is `set_model` (which reports
  `model_changed`). This affects any harness that assumes `new_session`'s `model`
  binds — including `scripts/p27-ws-transport-validate.mjs`, which creates its
  worker that way. The Internal API path has the loud-fail behaviour; the WS path
  does not appear to. Flagged for the parent to route.
- **S2 — `scripts/p27-ws-transport-validate.mjs` row `17-wire-REPRO` is now a stale
  assertion** (§5). It needs re-pointing at the frozen R2 contract (or retiring)
  before it can be used as a clean regression gate.
- **S3 — brief §2/§3 tension.** §2 requires creating a real pi worker as the
  delivery target and L8 names a script whose own header requires the real talker
  model, while §3 forbids a real hosted model. Resolved without violating §3 by
  isolating the entire pi runtime (isolated `PI_AGENT_DIR` + provider `baseUrl`
  override + stripped provider keys), so the named script ran end-to-end with zero
  hosted calls; the only cost is that its two digest rows no longer test a real
  model (§6).

---

## 8. Changed-path inventory

**Repository source: unchanged.** `git status --short` → `?? operations/` only;
`git diff --stat` empty; HEAD still `0798661`. No commit, branch, stash, reset,
build, or service change. Nothing outside the evidence directory was written.

New files (all untracked, under the brief's handback directory):

```
operations/voice-card-20260915/child-live-validation/
├── complete.md                      (this file)
├── harness/talker-stub.mjs          (new)
├── harness/l-rows.mjs               (new)
├── logs/                            (7 files, see §4)
└── evidence/                        (11 files, see §4)
```

Cleaned up: both transient `systemd-run --scope` units stopped; disposable dirs
`/tmp/w2b-live-20260915`, `/tmp/w2b-live-{b,c,d,e,f}`, `/tmp/w2b-agent` removed
(which is also the deletion of **every session I created** — 11 sessions, all on
the disposable server — see the directory list in §4; other agents'
`/tmp/pin-child` and `/tmp/pi-web-ui-validation` were left untouched).
