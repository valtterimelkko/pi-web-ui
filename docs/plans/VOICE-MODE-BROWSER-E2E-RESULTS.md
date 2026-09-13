# Voice Mode Browser E2E — Results (P9)

**Date:** 2026-09-13 · **Driver:** P9 brief (`docs/plans/briefs/P9-browser-e2e.md`)
**Environment:** disposable validation server (`/tmp/p9-e2e`, port 3777) + vite dev client
(`VITE_API_TARGET=http://localhost:3777`, port 5173) + real Chromium (Playwright) + real pi
worker session (Kimi for Coding) + real talker (OpenRouter Gemma) + real STT (OpenAI
`gpt-4o-mini-transcribe` via the server's own dictation route). Production untouched.

---

## Verdict

| Brief condition | Result |
|---|---|
| 0. Isolation anomaly resolved before any browser test | ✅ Root-caused (file:line below); created sessions **are** isolated; REST listing route is a **real isolation defect** (reported, not fixed) |
| 1. Voice Mode opens and binds a talker to a real worker session | ✅ Real browser, real session (`session_created` + `set_model` → `model_changed`) |
| 2. Instruction produces a proposal, card shows it verbatim, worker transcript empty | ✅ Card text == sent utterance (68 B == 68 B); worker transcript had **0** message entries |
| 3. Confirming relays it; worker transcript byte-for-byte | ❌ **Blocked by a real integration defect** — the UI's release is refused ("Session \<uuid\> does not exist"). Bisected (§4): the identical conversation released through the same server delivers **byte-for-byte (67/67/67)** when `workerSessionId` is the session *path* |
| 4. Receipt ack emitted, ordered ahead of the answer | ✅ UI run: ack frames precede release (no answer existed — worker untouched). Full-chain proof from the bisect runs: receiptAck 16:50:03.810 strictly precedes release delivery (16:50:04.865) and all worker work/answer events (16:50:37+); three independent chains delivered byte-for-byte (§4.1) |
| 5. Screenshots of the driven states | ✅ 9 screenshots in `/tmp/p9-evidence/` |

**Bottom line:** the assembled product works end-to-end up to and including the confirm
gate; the last link — the confirmed relay reaching the worker — **fails from the real UI**
for every model the Voice Mode picker offers (all pi workers). One value is wired wrong:
the UI sends the session **id** where the delivery machinery resolves session **paths**.
Product code is frozen for this package, so it is reported here with evidence, not fixed.

---

## 1. The isolation anomaly (resolved first, as ordered)

### 1.1 Where `GET /api/sessions` gets its list (file:line)

The route with no `cwd` parameter calls `piService.listAllSessions()`:

- `server/src/routes/sessions.ts:46-59` — `GET /api/sessions` → `piService.listAllSessions()`
- `server/src/pi/pi-service.ts:575-577` — `listAllSessions()` calls the SDK's `SessionManager.listAll()` **with no sessionDir argument** (contrast `listSessions(cwd)` at `:560`, which passes `config.sessionDir`)
- SDK `@earendil-works/pi-coding-agent/dist/core/session-manager.js:1319-1327` — argument-less `listAll()` falls back to `getSessionsDir()`
- SDK `dist/config.js:457-459` — `getSessionsDir()` = `join(getAgentDir(), 'sessions')`
- SDK `dist/config.js:421-427` — `getAgentDir()` honours **only** `PI_CODING_AGENT_DIR`, else `~/.pi/agent`

The validation server sets `SESSION_DIR` and `SESSION_REGISTRY_PATH` (`server/src/config.ts:352-354` — pi-web-ui config keys, verified in the child's environ) but **never `PI_CODING_AGENT_DIR`**, so the SDK's argument-less list reads `/root/.pi/agent/sessions` — production's session directory.

The **WebSocket** `get_sessions` path is different and isolated: `server/src/pi/session-list-cache.ts:256` keys the cache on `config.sessionDir || join(config.piAgentDir, 'sessions')` → `/tmp/p9-e2e/pi-sessions`. The client's session list/sidebar/session picker are fed by the WS path; **the client never calls `GET /api/sessions`** (zero call sites in `client/src`).

### 1.2 Anomaly reproduced (read-only)

```
curl -b cookies.txt http://localhost:3777/api/sessions      → HTTP 200
→ total 855 sessions; 855 point at /root/.pi/agent/sessions; 0 at /tmp/p9-e2e
```

### 1.3 Created sessions ARE isolated (the critical proof)

Session created over the WebSocket (`new_session`, `cwd=/tmp/p9-workdir`, `sdkType=pi`)
on the disposable server (`node ws-isolation-probe.mjs`, exit 0):

```
sessionId  = 01a09b8a-e189-75e4-92f6-35f9759ef373
sessionPath= /tmp/p9-e2e/pi-sessions/2026-09-13T16-12-45-322Z_01a09b8a-e189-75e4-92f6-35f9759ef373.jsonl
under disposable dir: true
```

- The transcript file exists only under `/tmp/p9-e2e/pi-sessions/` (creation uses `SessionManager.create(cwd, config.sessionDir)`, `server/src/pi/pi-service.ts:392/406`; SDK `session-manager.js:1206-1208` honours the passed dir).
- `GET /api/sessions` after creation still lists 855 production paths and **does not** include the new session — the two list paths demonstrably diverge.
- Production snapshot diff (`find /root/.pi/agent/sessions -name '*.jsonl' -printf '%p %s %T@'` before vs after): **only one file changed — this agent's own live session file.** The disposable server touched nothing in production.

### 1.4 Verdict: real isolation defect (REST route), creation path safe

**Real defect**, not benign: on a disposable server, `GET /api/sessions` exposes
production session metadata (paths, first messages, message counts) to any holder of the
disposable server's auth cookie, and the route family offers mutations on those
production paths — e.g. `DELETE /api/sessions/:id` → `piService.deleteSession()` →
`fs.unlink(sessionPath)` (`server/src/pi/pi-service.ts:585-588`). A driver or script
pointed at a validation server could enumerate and destroy real transcripts. The
assembled UI itself is not exposed (it uses the isolated WS path), which is why the
browser test below is still valid — but the REST route violates the isolation contract
the validation server otherwise enforces. **Reported, not fixed (product frozen).**

---

## 2. Method

- **Disposable server** (detached, clean env + secrets, `AUTH_PASSWORD`/`JWT_SECRET`/`CSRF_SECRET` unset so the sanctioned non-production fallback `dev-password` applies — secrets.env's `AUTH_PASSWORD` is a bcrypt *hash* and not a login password):
  `setsid env -i HOME=/root PATH=… bash -c 'set -a; . /root/.pi-web-ui/secrets.env; set +a; unset AUTH_PASSWORD JWT_SECRET CSRF_SECRET; exec npx tsx scripts/validation-server.ts --dir /tmp/p9-e2e --port 3777'` — healthy (HTTP 200 `/health`).
- **Dev client:** `cd client && VITE_API_TARGET=http://localhost:3777 npx vite --port 5173 --strictPort` (the `VITE_API_TARGET` change in `client/vite.config.ts`; defaults unchanged).
- **Real audio:** local TTS (Supertonic, voice F1) rendered the spoken instruction to
  `/tmp/p9-evidence/instruction.wav` (8.36 s, PCM16 44.1 kHz incl. 3 s tail silence), fed
  to Chromium via `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=…`.
  The browser's MediaRecorder therefore captured **genuine speech**, which went through
  the server's real dictation pipeline (`POST /api/dictation/start|/finish` → STT →
  cleanup) — no stubbing anywhere.
- **Driver:** `scripts/voice-mode-browser-e2e.mjs` (Playwright, headless Chromium,
  `grantPermissions(['microphone'])`, uiStore `recentFolders` seeded in localStorage so
  the folder picker offers `/tmp/p9-workdir`; every WS frame logged to
  `ws-frames.jsonl`; transcripts read from disk read-only at the exact moments ordered).

## 3. What the real browser drive proved (final run, 16:32 UTC)

| # | Step | Evidence |
|---|---|---|
| 1 | Login → main UI | `01-logged-in-main-ui.png`; one expected 401 (pre-auth probe) |
| 2 | Voice Mode entry | `02-voice-mode-entry.png` |
| 3 | Model pick — Kimi for Coding (pi) | `03-model-pick.png` |
| 4 | Folder pick — /tmp/p9-workdir | `04-folder-pick.png` |
| 5 | Worker session bound | `session_created` frame seq 21: id `01a09b9c-a56e-75e4-92f6-3600dc786a1d`, path `/tmp/p9-e2e/pi-sessions/2026-09-13T16-32-09-582Z_….jsonl`; `set_model kimi-coding/kimi-for-coding` → `model_changed` (seq 22→23); "Model changed to kimi for coding" toast visible in `05/06` screenshots |
| 6 | Floor taken, real audio recorded 7 s | `06-recording.png` — "You have the floor" banner, red mic |
| 7 | STT → cleanup → talker proposal | Spoken instruction transcribed to `Tell the worker to reply with exactly "pineapple" and nothing else.` (trailing `\n` from the STT/cleanup text, kept verbatim end-to-end); `talker_turn` sent with `runtime:"pi"` (frame seq ~83) |
| 8 | Confirmation card, verbatim | `07-proposal-card.png`; card `textContent` == sent utterance, **68 B == 68 B** (`utterance_eq_card: true`) |
| 9 | Worker transcript empty pre-confirm | Transcript on disk: **0 message entries** (header/model/thinking/custom only); snapshot in `transcript-at-proposal.json` |
| 10 | Receipt ack | Frame seq 88: `talker_turn_result phase:"proposed" receiptAck:"Noted — still holding that."` — **before** the confirm (seq 94) |
| 11 | Confirm (real click) → release attempt | seq 94 `talker_turn "yes, send that"` → seq 96 result: `released.text` = the stored verbatim proposal (68 B), but `released.delivery = {outcome:"refused", reason:"Session 01a09b9c-… does not exist"}`; UI showed it honestly — `08-released.png`; the worker session transcript on disk stayed message-free (verified after the run) |
| 12 | Answer | None — correctly: the worker was never touched (see §4) |

Identical outcome on the first full drive (session `01a09b8e-fabf…`, 16:17 UTC) — the
failure is deterministic.

## 4. The release defect, precisely

**On-wire trigger** (from `ws-frames.jsonl`): the UI sends
`{type:"talker_turn", workerSessionId:"01a09b9c-a56e-75e4-…", …}` — the **session id**
the server itself issued in `session_created`.

**Resolution side**: the pi delivery adapter is wired straight to the manager
(`server/src/talker/session-registry.ts:181-182` — `steer/prompt: (id,text) => manager.steer/prompt(id,text)`), and `MultiSessionManager` stores sessions **keyed by session path**
(`server/src/pi/multi-session-manager.ts:708, 849`; lookups at `:1479-1482` `prompt()`
and `:1536-1539` `steer()` throw `Session ${sessionPath} does not exist`). For pi sessions
id ≠ path, so every UI-driven release is refused. The error surfaces honestly in the UI
(green "Sent to the worker: … — refused —" banner) and nothing reaches the worker —
the confirm gate's fail-closed behaviour is correct; the wiring is not.

**Why earlier validations never hit this:** the server-side relay validations passed the
session **path** in the parameter named `workerSessionId` —
`scripts/talker-live-validate.ts:150/155/165/217` and
`scripts/voice-relay-scenarios-validate.ts:439` (`return { workerSessionId: sessionPath, … }`).
Every piece was therefore proven with the one value that works, and the assembled UI,
which correctly uses the id the API issued, was never exercised at this joint.

### 4.1 Bisect: same server, same gate, same relay, `workerSessionId = path`

`scripts/voice-mode-release-path-probe.mjs` (WS client against the same disposable
server, differing **only** in passing `sessionPath`), run three times 2026-09-13 —
16:25, 16:50, 16:57 UTC. **All three delivered byte-for-byte.** Clean final run
(16:57, exit 0, `release-path-probe-result.json`):

```
proposal → receiptAck → confirm 'yes, send that' → released (delivered, mechanism prompt)
instructionSent             : 67 bytes
releasedTextServer          : 67 bytes   instruction_eq_released: true
workerTranscriptUserText    : 67 bytes   released_eq_worker: true
                                         instruction_eq_worker: true
ackOrdering: receiptAck seq 23  <  confirm seq 24  <  released result seq 266
```

Run 16:50 adds full-chain ordering (frame log `probe-ws-frames.jsonl`, analysis in
`release-ordering-evidence.json`): receipt ack 16:50:03.810 → release delivered to the
worker 16:50:04.865 (transcript user entry, byte-equal 67/67) → worker work events from
16:50:37 — **the ack is strictly ahead of everything the worker did**. Its transcript
also shows an honest observation: a disposable pi worker inherits the operator's full
extension environment (this one ran the Agent OS recall skill before dispatching its
own subagent) because pi sessions load extensions from the shared agent dir — the same
sharing that makes auth work. Extension-level isolation for disposable servers would
need `PI_CODING_AGENT_DIR` handling and is out of scope here.

**Observed behaviour worth the owner's attention (reported, not fixed):** the released
talker result frame arrives only when the worker's ENTIRE turn completes —
`manager.prompt()` resolves then (`multi-session-manager.ts:1483-1500`). In run 16:50
the worker stalled on a subagent toolCall, its turn never finished during observation,
and no result frame ever came; the run-16:50 probe initially reported failure on that
basis while the delivery itself had succeeded. In the real UI the same property means
the green "Sent to the worker" banner only resolves after the full worker turn — a
successful but slow release would look like a hang.

Earlier run (16:25, glm-5.3 worker): delivered, then the worker delegated to a subagent
tool and answered "The worker replied with exactly: > pineapple" (transcript 16:25:05
user → 16:25:28 answer).

(Note: `release-path-probe-result.json` was accidentally overwritten once by a failed
run's failure output; it was recomputed from the 16:25 session transcript — marked as
such inside the file — and the probe now writes failures to a separate file.)

**Conclusion:** gate, verbatim draft, confirm classification, release, delivery and
transcript write all work; the defect is exactly the **id-vs-path identity mismatch**
between `session_created` and the delivery adapter. Fix direction (owner's call, not
implemented): resolve ids to paths at one boundary — e.g. the talker delivery resolving
via the session registry before calling the manager — or issue pi `sessionId` as the
path; one-line-per-side choices exist at `session-registry.ts:181-182` or in the
`talker_turn` handler. The frozen-package rule is respected here.

## 5. What worked / what did not

**Worked (real browser, zero stubs):** cookie login via proxied dev client; Voice Mode
phases (entry → model → folder → dictate); real worker session creation + Kimi model
binding; real STT of real TTS audio through the server dictation route; talker
classification + verbatim proposal; verbatim confirmation card; typed fallback present;
receipt ack before release; fail-closed honest refusal; bisected machinery delivering
byte-for-byte in three independent chains (16:25, 16:50, 16:57) with full ack-ordering
frame evidence;
byte-for-byte when given the path.

**Did not work:** the release from the UI (§4) — the objective's central claim — blocked
by the id/path wiring defect. Also: `POST /api/sessions` is 404 on this build (noted in
brief, expected); `AUTH_PASSWORD` from secrets.env is a hash and cannot be used for
login (documented §2 workaround is the sanctioned dev-password fallback).

**Minor findings (reported only):** (a) the refused delivery renders in the *green*
"Sent to the worker" success banner (`useVoiceTurn` folds `delivery.outcome:'refused'`
into `lastReleased`) — text is honest, colour is misleading; (b) STT/cleanup returned a
trailing `\n` which the whole verbatim chain preserved — harmless but worth knowing;
(c) the empty-transcript check counts `type:"message"` entries — model/thinking/custom
metadata entries exist from creation, which is expected.

## 6. Commands and exit codes (abbreviated)

| Command | Exit |
|---|---|
| `node ws-isolation-probe.mjs` (create session over WS) | 0 |
| `curl -s -b cookies.txt http://localhost:3777/api/sessions` (+ python count) | 0 (855/855 production paths) |
| `node scripts/voice-mode-browser-e2e.mjs` (run 1 — frame-capture bug, driver-fixed) | 1 (expected; driver logging fixed) |
| `node scripts/voice-mode-browser-e2e.mjs` (run 2 — full drive, defect surfaced) | 0 (driver completed; release refused as reported) |
| `node scripts/voice-mode-release-path-probe.mjs` (bisect) | 0 (delivered, byte-for-byte) |
| `node scripts/voice-mode-browser-e2e.mjs` (final run for clean evidence) | 0 |
| production snapshot diffs (before / mid) | only this agent's own session file changed |

## 7. Evidence inventory (`/tmp/p9-evidence/`)

- `ws-frames.jsonl` — every WS frame, timestamped+sequenced (final UI run)
- `e2e-result.json` — measured values, byte counts, equalities, ack ordering
- `transcript-at-proposal.json` — worker transcript at proposal time (0 messages)
- `release-path-probe-result.json` — bisect comparisons (67/67/67, all equal), recomputed from the 16:25 transcript after an overwrite (noted inside); `probe-ws-frames.jsonl` + `release-ordering-evidence.json` — run-16:50 full-chain frame log and ordering analysis; `release-path-probe-FAILED.json` — the failed-run record kept separate
- `api-sessions.json`, `cookies.txt` (dev-password disposable server only), `login-response.json`
- `instruction-raw.wav`, `instruction.wav` — the spoken instruction (Supertonic F1)
- `prod-sessions-before.txt` / `prod-sessions-mid.txt` — production snapshots
- `01…09-*.png` — screenshots of every driven state
- `server.log`, `vite.log` — disposable infrastructure logs

## 8. Repo artefacts left in the tree (not committed, per brief)

- `client/vite.config.ts` — `VITE_API_TARGET` (pre-existing parent change, kept)
- `scripts/voice-mode-browser-e2e.mjs` — the browser driver
- `scripts/voice-mode-release-path-probe.mjs` — the bisect probe
- `docs/plans/briefs/P9-browser-e2e.md` — the brief
- this document

**Disposable infrastructure still running for immediate re-drive after any fix:**
validation server port 3777 (`--dir /tmp/p9-e2e`), vite on 5173 (`VITE_API_TARGET` set).
Stop with `pkill -f validation-server` and `pkill -f "vite --port 5173"`.

---

## 9. Isolation: accepted limitation (owner decision, 2026-09-13)

§1.4 reports the REST listing defect. The owner has reviewed it and **accepted it**:
the exposure is local to the owner's own machine, on the owner's own data, and
agents create fresh sessions for validation anyway. No confidentiality risk is
considered material.

**One nuance worth recording, because it is not about exposure.** The defect is not
merely that the listing *shows* production sessions — it is that it makes them
**reachable**. `switch_session` accepts a `sessionPath` directly
(`server/src/websocket/connection.ts:2286`) with **no guard scoping the value to the
validation directory**, so a disposable server can load a production session, after
which a prompt or a Voice Mode relay would target it.

The realistic hazard is therefore an **unintended instruction into live work** — a
driver that selects an existing session instead of creating one, or an operator
clicking through 854 listed sessions — not data leakage. Low likelihood (agents
create their own sessions; the UI requires an explicit pick), so it is accepted
rather than fixed.

**Read this before treating a disposable server as fully isolated.** Its *creation*
path is isolated — sessions it creates stay in the validation directory, verified
in §1.3 — but its *listing and switching* path is not. If a validation server is ever
handed to an agent for open-ended testing, scope the listing (and `switch_session`)
to the validation directory first; it is a small change.
