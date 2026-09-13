# P1 — Browser↔server talker transport probe (close the last unproven link)

## Why this exists

The voice relay is built and its **server-side half is already proven live**
(`scripts/talker-live-validate.ts` drives the real Pi service, the real
`MultiSessionManager`, the real `TalkerSessionRegistry` and the real OpenRouter
talker model through the full scenario: conversational turn → proposal with
nothing sent → confirm → the operator's **verbatim** words steered into a *busy*
worker → byte-for-byte comparison).

One link has **never** been exercised end to end: **the browser transport**.
The `talker_turn` / `talker_turn_result` WebSocket pair is fully wired
(`shared/src/protocol-types.ts`, `server/src/websocket/protocol.ts`,
`server/src/websocket/connection.ts` around lines 1015 / 4118 / 4150, and
`client/src/lib/talkerBus.ts`) but is covered by **unit tests only**.

Your job is to close that gap with real evidence, because Phase 4 is a UI built
on top of this wire. Building the surface before proving the wire is how a
polished UI ends up over a dead connection.

## The bounded outcome

**A real authenticated WebSocket client drives `talker_turn` and receives a
correct `talker_turn_result`, against a real talker and a real worker, with the
raw frames captured as evidence.**

Specifically, prove all four:

1. A `talker_turn` sent over the authenticated `/ws` path produces a
   `talker_turn_result` for the right session (no silent drop, no mismatch).
2. A **conversational** turn returns a reply (the talker model actually answered
   — not a fabricated or empty result).
3. An **instruction** turn produces a result whose phase shows a proposal was
   raised and **nothing was relayed** — then a **confirm** turn relays, and the
   worker's transcript contains the operator's utterance **byte-for-byte**.
4. Transport honesty: a malformed `talker_turn` is rejected with the
   `Invalid talker_turn message format` error path rather than hanging or
   half-applying.

Extending `scripts/ws-validate.mjs` is the intended shape — it already performs
cookie login, connects to `/ws`, and drives real messages (`switch_session`,
`compact`, `prompt`). Add a `talker_turn` path rather than writing a new harness
from scratch. A new script is acceptable **only** if extending it is genuinely
awkward; if you do that, say why in your report.

## Owned paths (yours)

- `scripts/ws-validate.mjs` (extend) — or a new `scripts/*.mjs` if justified
- Any test file you add for the harness logic
- This brief, if you need to append findings

## Off-limits — do not modify

- `server/src/talker/**` — owned by a sibling package (P2). If you believe the
  transport needs a **server change**, that is a finding to report, not a change
  to make.
- `client/src/**` — Phase 4 UI work, a later package.
- `shared/src/protocol-types.ts` and the server protocol/router — read them
  freely, change nothing. A schema change here is a design decision for the
  parent, not a fix.
- **Production.** Never. Disposable validation server only.
- Anything in `/root/.pi-web-ui/secrets.env` — you may **read its path** and
  source it into the validation server's environment, but never print its
  values, and never copy it into the repository.

## Method

Start a disposable validation server and run against it. The established path:

```
npm run validate:server        # prints a socket path and a token path
```

The talker needs its model credential. It lives **outside the repo** at
`/root/.pi-web-ui/secrets.env` (mode 600) as `TALKER_API_KEY` (and
`OPENROUTER_API_KEY`). Export it into the **validation server's** environment
only. **Never print or commit the value** — assert only that the variable is
non-empty if you need to show it was present.

Read the real message shapes from `shared/src/protocol-types.ts` and
`server/src/websocket/protocol.ts` rather than guessing them; a guessed shape
will produce a confusing failure that looks like a transport bug.

## TDD expectation

Write the failing check first and show it failing for the right reason (e.g. the
harness reports "no `talker_turn_result` received"), then make it pass. A probe
that passes on the first run without ever having failed is not evidence that it
tests anything.

## Evidence you must return

- The exact commands you ran, with exit codes.
- **Raw frames**: the `talker_turn` you sent and the `talker_turn_result` you
  received, as literal text. This is the whole point of the package.
- For point 3, the worker's received text and the operator's utterance side by
  side, showing they match byte-for-byte (state the comparison method — e.g. a
  byte count plus an equality assertion, not eyeballing).
- The malformed-message rejection, with the actual error response.
- Anything that did **not** work, stated plainly. A partial result honestly
  reported is far more useful than a clean-sounding summary. If you cannot get
  the confirm-and-relay leg to work through the WebSocket path, say exactly
  where it stops, with the frame or error that stopped it.

## Do not commit

Leave your work in the tree and report. The **parent** reviews, commits and
pushes. Do not create branches, do not commit, do not push.

## Report format

1. **Outcome** — did the browser→talker→worker round trip work, yes or no.
2. **Commands and exit codes.**
3. **Raw frames** (sent and received).
4. **The byte-for-byte comparison** and how you established it.
5. **What did not work** / what you could not prove.
6. **Findings that contradict this brief**, if any — especially if the
   transport needs a server-side change to work at all. Say so; that is
   important information, not a failure on your part.
7. **Files touched**, as a list.

---

## P1 findings (appended by the transport probe, 2026-09-13)

**Outcome: the browser→talker→worker round trip WORKS.** Red-first evidence
obtained by fault injection (drop proxy), then a clean green pass against a
disposable validation server (dir /tmp/pi-talkprobe, port 3097). Full report
delivered to the parent; raw frames live in the probe output
(`/tmp/talker-red.json`, `/tmp/talker-green.json` — transient, contents quoted
in the report).

1. **Transport finding (no server change needed, but worth knowing):** the
   central WS pre-upgrade guard (`decideWsUpgrade` → `validateOrigin` in
   `server/src/security/websocket.ts`) enforces the strict origin allowlist
   with NO non-production localhost relaxation. The relaxed
   `isWebSocketOriginAllowed` in `server/src/websocket/connection.ts` sits
   downstream of the central guard, so its localhost branch is unreachable on
   every path the guard covers — including `/ws`. Practical consequence: any
   ws-validate run must pass an origin that is on the server's allowlist (this
   validation server inherited `ALLOWED_ORIGINS=https://pi.letsautomate.work`
   from the ambient shell). The comment in ws-validate.mjs ("Origin must be in
   the server's allowed-origins list") is the operative truth; the origin
   relaxation in connection.ts looks like dead code. Report only — not changed.
2. **Brief doc drift:** the brief cites `shared/src/protocol-types.ts` for the
   talker wire shapes; the shapes actually live in
   `server/src/websocket/protocol.ts` (`TalkerTurnMessage`,
   `TalkerTurnResultMessage`, `isTalkerTurnMessage`). `shared/src` contains no
   talker types at all.
3. **Secrets file shape:** `/root/.pi-web-ui/secrets.env` carries
   `TALKER_API_KEY` but NO `OPENROUTER_API_KEY`; the talker model client
   (`server/src/talker/model-client.ts`) accepts either, so the talker path is
   served by `TALKER_API_KEY` alone. Values never printed.
4. **RED method:** the transport cannot be disabled on the server without
   touching sibling-owned code, so red-first evidence comes from a
   fault-injection proxy (`scripts/talker-drop-proxy.mjs`) that drops the
   first server→client `talker_turn_result`. RED run: harness failed with
   `FAILED timeout (120000ms) waiting for talker_turn_result (t1,
   conversational) — no result means a silent drop` (exit 1) while the proxy
   log shows the server HAD sent a real t1 result — the harness demonstrably
   detects the silent-drop failure mode.
5. **Worker-compliance observation (not a P1 requirement):** in the green run
   the steered utterance landed byte-for-byte and mid-run (steer entry index 3
   < last assistant index 4), but this run's worker final answer did not
   contain `TALKER-RELAY-OK` (the model responded to the meta-instruction
   literally: "There's no worker in flight…"). The H6 server-side validator
   proved compliance with the same phrasing; this is model variance, not a
   transport defect — the delivery adapter itself reported
   `outcome: "delivered", mechanism: "steer"`.
6. **Harness shape:** `--step talker` creates its own worker session over the
   socket (no `--session`), needs `--ws-url` only for proxied runs, and needs
   the talker key in the SERVER's environment (the validation-server child
   inherits the wrapper env). Boot with `env -u NODE_ENV` — ambient
   production mode would demand production secrets.
