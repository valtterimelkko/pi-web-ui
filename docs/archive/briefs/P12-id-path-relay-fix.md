# P12 — Fix the id/path wiring defect that breaks every UI-driven relay

## The defect (found by P9's browser E2E — read that first)

`docs/plans/VOICE-MODE-BROWSER-E2E-RESULTS.md` §4. The assembled UI works end to end
**up to the confirm gate**, then the confirmed relay never reaches the worker.

**Root cause, already bisected (do not re-derive it):** the UI sends the session
**id** as `workerSessionId` (`DriveModeOverlay.tsx:132` passes `activeSessionId`,
and the app distinguishes id from path at the same call site), while the pi delivery
adapter hands that value straight to `MultiSessionManager`, which keys sessions by
**path** (`multi-session-manager.ts:708/849`, lookups at `:1479-1482` and
`:1536-1539`). For pi sessions id ≠ path, so **every UI-driven release is refused**
with `Session <id> does not exist`. The gate's fail-closed behaviour is correct; the
wiring is not.

Proof of the bisect: `scripts/voice-mode-release-path-probe.mjs` runs the identical
conversation through the same server and delivers **byte-for-byte 67/67/67** when
`workerSessionId` is the **path**. Three independent runs.

## The aim

**A confirmed relay reaches the worker whichever identifier the caller supplies.**

## How to fix it — and the trap to avoid

**Fix it in one place, server-side, so every caller works.** Resolve the supplied
`workerSessionId` to the manager's session key (accept **either** the id or the path)
before it reaches the delivery adapter. Do **not** patch only the UI call site: the
wire field is named `workerSessionId` and the server itself issues the id in
`session_created`, so a client using the id is behaving correctly. Patching the UI
would leave the Internal API, the RPC surface and every future caller with the same
latent break.

**The trap:** an id and a path can both be opaque strings, so a naive "try id then
path" is a silent-wrong-answer risk. Prefer an **explicit resolution** against the
registry/manager's own index, and make the failure mode loud — if the value resolves
to nothing, say so (the current fail-closed refusal is correct behaviour and must
stay).

**Check the other runtimes too.** The adapters are per-runtime. Claude, OpenCode and
Antigravity may resolve differently, may already work, or may share the defect. Find
out and **report** what you find for each — do not assume pi's shape generalises.

## Invariants — do not soften

- **The release gate is untouched**: `release()` stays private with one caller,
  `takeForRelease` stays atomic and staleness-enforcing, no text-composition path is
  introduced, and **a refusal still fails closed**. You are fixing resolution, not
  authorisation.
- **No regression in the existing relay validations**, which pass a path — the fix
  must accept a path exactly as before.
- **No new lint warnings** (ratchet ceiling 1738; check with
  `node scripts/check-lint-ratchet.mjs --base HEAD`).
- **Production is off-limits.** Disposable servers only.

## TDD — the regression test is the point

Write the test first, **failing for the right reason**: a release whose
`workerSessionId` is the session **id** must be refused *before* your fix (RED — the
exact production symptom), and delivered *after* it (GREEN). Pin the **path** case too,
so both identifiers are covered and the old behaviour is provably preserved.

## Live proof required

Unit tests are not enough — this defect lived precisely in the gap between "units
pass" and "the assembled thing works", and it was found by a browser. Prove it the
same way:

1. Re-run the **browser E2E** (`scripts/voice-mode-browser-e2e.mjs` — a sibling child
   owns that file; if it is not yours to touch, say so and use it read-only or
   coordinate through the parent rather than editing it).
2. Show a confirmed relay **from the real UI** reaching the worker's **own
   transcript**, **byte-for-byte with byte counts**.
3. Include a **screenshot** of the release succeeding.

If you cannot drive the browser, say so plainly and report how far you got — but the
whole point of this fix is the joint between the pieces, so a unit-only proof is a
partial result and must be labelled as one.

## Owned paths (yours)

`server/src/talker/**`, `server/src/pi/multi-session-manager.ts` (add a **resolution**
helper; do not change delivery semantics), the client call site **only if** the
server-side fix cannot work, and tests.

## Off-limits

- `docs/plans/VOICE-MODE-BROWSER-E2E-RESULTS.md` — evidence record; do not rewrite.
- `docs/plans/VOICE-MODE-VALIDATION-RESULTS.md` — evidence record.
- The release gate's semantics.
- **Production.**

## Evidence you must return

- Exact commands and exit codes.
- The RED-then-GREEN regression test, both identifiers covered.
- The per-runtime finding (pi / claude / opencode / antigravity): does each resolve
  an id, a path, or both?
- The **live browser proof** with byte counts, or an honest statement of what blocked
  it.
- The ratchet result showing no new warnings.
- Anything that did **not** work, stated plainly.

## Do not commit

Leave the work in the tree and report. The parent reviews, commits and pushes.

---

## Resolution (2026-09-13, this work package)

**Fixed, unit-proven and live-proven. A confirmed relay reaches the pi worker whichever identifier the caller supplies.** Left uncommitted in the tree for parent review, per the brief.

### The fix (one place, server-side)

- `server/src/pi/multi-session-manager.ts` — new read-only `resolveSessionRef(ref)`: resolves a supplied reference against the manager's own active index to the canonical session key (path identity; id → path; no match → `undefined`). Explicit resolution against the manager's index, never try-one-then-the-other. `prompt`/`steer` semantics unchanged — the manager still refuses an id directly (pinned).
- `server/src/talker/session-registry.ts` — one resolution chokepoint (`canonicalWorkerRef`, pi-only; claude/antigravity are id-keyed already) applied at the top of `handleOperatorTurn` and inside `get`/`has`/`dispose`, so the talker state key, the stored delivery target, the worker snapshot and the transport's phase read all land on one canonical value. Unresolvable references pass through unchanged and still fail closed loudly. The wire echo keeps the caller's raw id (client correlation). The client call site was not touched.

### Evidence

- TDD RED first: release with `workerSessionId = <session id>` refused with the exact production symptom (`Session <uuid> does not exist`); GREEN after. Path pin passed before and after.
- `server/tests/unit/talker/session-registry-id-path.test.ts` (new): id-release, path release, one-session-per-worker regardless of identifier, unresolvable-ref fail-closed.
- `server/tests/unit/pi/multi-session-manager.test.ts`: helper semantics (id→path, path identity, unknown→undefined) and `prompt(id)` still refuses.
- Suites: talker + transport + pi 672 green; full server suite 4037 green (4 failures pre-existing environment artefacts, verified failing identically at HEAD); lint ratchet 1736 ≤ 1738; typecheck clean; zero gate-related lines in the source diff.
- **Live browser proof** (disposable server + real UI): the UI sent the **id** from `session_created`; release banner "delivered (prompt)"; worker's own transcript received the instruction **68/68/68/68 bytes byte-for-byte** (utterance / card / server release frame / transcript user entry); 0 transcript entries at proposal time (gate held); screenshots in `/tmp/p12-evidence/` (`08-released.png` is the release).
- **Path no-regression, live**: `scripts/talker-live-validate.ts` → `✅ LIVE-VALIDATED` on a real busy pi worker, mechanism steer, byte-for-byte true, worker replied `TALKER-RELAY-OK`.

### Per-runtime finding (as required)

| Runtime | Keying by the services | UI's id works? |
|---|---|---|
| pi | session **path** (MultiSessionManager) | NO → fixed by resolution |
| claude | server-issued **id** (claude-sdk-service sessions map) | already worked |
| antigravity | server-issued **id** (streamProcesses / sessionMeta / registry) | already worked |
| opencode | no talker delivery adapter exists (`TalkerRuntime = pi\|claude\|antigravity`; protocol guard rejects others) | n/a — no relay surface |

### Known residual (honest)

- The worker's conversational answer can arrive long after the release (the pi release result resolves only when the worker's full turn completes — the behaviour already reported in the P9 evidence record §4). Delivery is proven by the transcript write; the answer wait timed out empty in the browser run.
- `server/src/websocket/protocol.ts` still documents `workerSessionId` as "(Pi: the session path)" — outside this package's owned paths; one-line doc fix for the parent to fold in or assign.
- The original defect finding in `docs/plans/VOICE-MODE-BROWSER-E2E-RESULTS.md` §4 is intentionally untouched: it remains the accurate record of pre-fix builds.
