# Child M3 — product fix: the delivery receipt is about bytes delivered, not turn completion

You are a product-fix child on Pi Web UI. The W4 campaign exposed this defect on real cells; you fix
the **product**, RED-first. You own the outcome, not just the edit.

## The defect (real-run evidence, reproduce it at unit level)

Evidence: `C01-standard/attempt-28` (`/root/voice-lane-lab/campaigns/primary-mic-journeys/runs/`).
Timeline from `provider/server-evidence.jsonl`:

- `confirm_authorised` + `delivery_attempt` at t+17.4 s;
- `worker_status_injected {workerActivity: 'busy'}` at t+18.0 s — the delivery **did** reach the
  worker and started its turn;
- then **nothing**: no `delivery_receipt`, no `delivery_outcome_unknown`, ever.

The director waited out its delivery deadline, spoke its repair, and the cell failed
("deadline exceeded waiting for delivery; repair budget exhausted").

Root cause (conductor-grounded, verify it yourself): the Pi delivery adapter awaits
`MultiSessionManager.prompt()` / `steer()`, and `manager.prompt()` awaits the **whole worker turn**
(`server/src/pi/multi-session-manager.ts:1500` — `await activeSession.agentSession.prompt(message)`).
The mount then records the delivery and emits `receipt_event` only after that await settles.

Why this never showed before: the disposable worker sessions previously had **no provider
credentials**, so their turns failed in ~1 s and the await returned immediately. Child L5 seeded the
isolated agent dir with the host auth store (a correct fix for the C22 busy drive), workers now
genuinely run, and every real turn now delays the receipt by its full duration (tens of seconds) —
past every journey deadline, and past what the operator experience can bear.

**The contract is explicit that this is wrong.** `docs/plans/VOICE-LIVE-WIRE-CONTRACT.md` §4.4/§4.6:
three artefacts stay distinct — *audio received*, *words recognised*, **bytes delivered** — and
"the trusted chime fires on a receipt with `outcome: "delivered"`". A receipt that waits for the
worker's whole turn makes the chime (and the journey) mean "the worker finished", not "the
instruction was delivered".

## Your job

1. **RED first.** Write a failing test that reproduces the gap against the real adapter (or the
   mount with a real `MultiSessionManager`-shaped double): a delivery to an idle worker whose turn
   takes a long time must produce a receipt **at submission**, not at turn completion; and a
   delivery to a **busy** worker must be honest about queueing (`queued`) rather than blocking.
   Prove the test fails on the current code for the right reason.
2. **Fix it product-side.** Make the Pi delivery report submission promptly:
   - idle worker → start the turn and return once it has genuinely started (the session is
     busy/streaming, or the first turn event has arrived) — `outcome: 'delivered'`,
     `mechanism: 'prompt'`, with an honest disclosure that the turn continues in the background;
   - busy worker → return `outcome: 'queued'`, `mechanism: 'steer'` (the contract already has
     `queued` for exactly this) unless the steer genuinely joins the running turn promptly;
   - submission failures (unresolvable session, immediate refusal) must still surface as `refused`
     — do not swallow them;
   - `unknown` stays for genuine ambiguity (a throw mid-submission), unchanged.
   Prefer a submission-shaped method on `MultiSessionManager` (e.g. `submitPrompt`/`steerSubmitted`
   that resolves once the turn has started) over weakening `prompt()`/`steer()` for other callers —
   the Internal API depends on their current semantics; state your choice and its blast radius.
3. **Do not widen the confirmation gate** (`talker/policy-core.ts` out of bounds) and do not change
   protocol shapes. Receipt field meanings must stay exactly as the contract defines them.
4. **Tests + gates.** Update/extend the delivery and mount tests (prompt path, steer path, refusal
   path, unknown path, idempotency) and run: `server/tests/unit/talker/**`,
   `server/tests/unit/websocket/**`, `server/tests/unit/voice/**`, `npm run typecheck`, `npm run lint`,
   `npm run build`.

## Boundaries

- **Owned:** `server/src/talker/**`, `server/src/pi/multi-session-manager.ts` (the new submission
  method only — do not change `prompt()`/`steer()` semantics for existing callers), `server/src/websocket/voice-live-mount.ts`
  (delivery path only), and their unit tests.
- **NO-TOUCH:** `scripts/voice-lane-lab/**`, `server/tests/voice-live-lab/**` (child L5's live
  paths), `client/src/**`, `operations/**`, corpus/fixtures, production state, the registry,
  `~/.pi/agent`.
- **Do not run the heavy lab harness.** The conductor re-runs the campaign cells as the end-to-end
  confirmation once your fix is merged. Ask if you believe a real run is essential.
- Work only in `/root/pi-web-ui-wt-voice-m3` (branch `task/voice-native-m3`), commit there, push
  nothing.

## Evidence and handback

Write `/root/voice-native-20260922/coordination/M3/complete.md` and `complete.json`:

- the exact failing test (file, name, command, observed failure) before the fix;
- the fix (files, commits), the semantics you chose per outcome, and the blast radius of the method
  you added/changed;
- exact commands + results for every gate, quoted honestly;
- what you could **not** verify, stated as unverified;
- any product observation the campaign should know (e.g. other callers that await turns).

Honest unsupported outcomes beat a fake pass. If a boundary blocks you, write
`/root/voice-native-20260922/coordination/M3/01-questions.md` and end your turn.
