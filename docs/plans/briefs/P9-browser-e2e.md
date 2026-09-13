# P9 — Drive the assembled Voice Mode UI from a real browser (the unproven last link)

## Why this exists

Every piece of Voice Mode is proven **separately**:

- the browser↔talker↔worker transport (P1) — proven by a **script**, not a browser;
- the talker, gate, receipt ack and draft (P2/P3/P7) — proven server-side and live;
- the UI (P5) — proven only through a **dev harness with the network stubbed**
  (fake WebSocket, canned dictation, generated TTS).

**The assembled product has never been driven from a real browser against a real
server and worker.** That is the objective's own success condition — *"the
operator can hold a spoken conversation with a running worker from a browser"* —
and it is the one claim still resting on inference rather than evidence.

## Do this first: resolve an isolation anomaly (it blocks a valid test)

While setting this up, the parent found that a disposable validation server
**listed 854 sessions all referencing `/root/.pi/agent/sessions/…`** — i.e.
production's sessions — even though the child process env was **correct**
(`SESSION_DIR=/tmp/<dir>/pi-sessions`, `SESSION_REGISTRY_PATH=/tmp/<dir>/session-registry.json`,
verified in `/proc/<child-pid>/environ`). Its own `pi-sessions/` was empty.

**Before running any browser test, determine:**

1. Where does `/api/sessions` get its list from, and why does it include production
   sessions when `SESSION_DIR`/`SESSION_REGISTRY_PATH` point elsewhere? Name the
   file and line.
2. **Critically: confirm that a session CREATED on a disposable server lands in the
   disposable directory and does not touch `/root/.pi/agent/sessions`.** Prove it —
   create one over the WebSocket (`new_session`; note `POST /api/sessions` is 404 on
   this build) and show the resulting transcript path.
3. Decide whether the listing behaviour is a **real isolation defect** (a validation
   UI exposing the operator's real sessions — a genuine hazard, since a driver could
   interact with them) or a benign artefact. Report either way with evidence.

If the created session is not isolated, **stop and report** — a browser test would
be driving production state, which is not acceptable.

## Environment facts the parent established (use them, don't rediscover)

- Boot a disposable server:
  ```
  set -a && . /root/.pi-web-ui/secrets.env && set +a
  npx tsx scripts/validation-server.ts --dir /tmp/<yourdir> --port <port>
  ```
  Run it **detached from your agent session's env** where practical, and note that
  the launcher spawns a real child (`scripts/validation-server-child.ts`).
- **Auth password:** non-production falls back to `dev-password`, but if
  `AUTH_PASSWORD` is in the environment (it is, from `secrets.env`) that value is
  used. Log in with it; **never print the value**.
- **Allowed origins are `http://localhost:5173` and `http://localhost:3000`** — the
  dev client must run on one of those or the WebSocket upgrade is rejected.
- The server serves `client/dist` **only in production**, so a disposable server
  cannot serve the UI. Use the vite dev server with a proxy.
- The parent added **`VITE_API_TARGET`** to `client/vite.config.ts` so the dev client
  can be pointed at a disposable server (it defaults to the old `http://localhost:3456`,
  so behaviour is unchanged). Use it:
  ```
  cd client && VITE_API_TARGET=http://localhost:<port> npx vite --port 5173 --strictPort
  ```
  Keep that change; it is what makes browser validation possible at all and belongs
  in the commit.
- `client/dist` is current (it contains P7's `receiptAck` wiring).
- **Never point anything at production (port 3456) except read-only checks.**

## The bounded outcome

**A real browser, running the real UI against a disposable server and a real worker,
holds a conversation in which an instruction is relayed only after confirmation,
and the worker receives it byte-for-byte.**

Drive it with Playwright (browser automation is available; fake media-device flags
let MediaRecorder run). The confirmation card has a **typed fallback** — use it to
drive the conversation, since synthesised audio will not transcribe to anything
meaningful. That still exercises the real `talker_turn` path, the real gate, the
real card, and the real relay.

Verify, with evidence at each step:

1. Voice Mode opens and binds a talker to a **real worker session**.
2. An instruction produces a **proposal**; the confirmation card shows it
   **verbatim**; and the worker's transcript contains **nothing** at this point.
3. Confirming relays it, and the **worker's own transcript** contains the operator's
   text **byte-for-byte** (report byte counts; compare, do not eyeball).
4. The **receipt ack** is emitted and ordered ahead of the answer.
5. Capture **screenshots** of the states you drove — the parent will look at them.

## Owned paths (yours)

- `client/vite.config.ts` — the `VITE_API_TARGET` change only (already made)
- A browser-driving script under `scripts/` if you need one
- A results document under `docs/plans/` (e.g. `VOICE-MODE-BROWSER-E2E-RESULTS.md`)
- Your brief

## Off-limits

- **`server/src/**` and `client/src/**`** — the product is frozen for this package.
  If you find a defect, **report it with evidence, do not fix it**.
- **Production.** Disposable servers only. Do not restart or reconfigure anything.
- `docs/plans/VOICE-MODE-VALIDATION-RESULTS.md` — evidence record, do not rewrite.

## Evidence you must return

- The isolation finding (§"first"), with file/line and the proof for a created session.
- Exact commands and exit codes.
- Raw evidence at each step: the proposal text, the worker transcript entry and its
  byte count vs the operator's utterance, the ack ordering.
- **Screenshots** of the real UI driven end to end — or an honest statement that you
  could not drive it and exactly where it stopped.
- Anything that did **not** work. A partial result honestly reported is far more
  useful than a clean-sounding summary here; this package exists to find out whether
  the assembled thing works.

## Do not commit

Leave the work in the tree and report. The parent reviews, commits and pushes.
