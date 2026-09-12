# R2 — Fix the two confirmed defects behind the event-loop stall

You are a child worker. Complete this end-to-end, then report back. Do not ask the operator anything — if you hit a genuine blocker, stop and report it.

## Background — the investigation is DONE, the fixes are not

Three independent investigations (glm-5.3 and gemini-3.8) converged on the root
cause of the 2026-09-12 event-loop stall. Their full reports, evidence and
recommendations are at `/tmp/r1-investigation/R1-REPORT.md` — **read it first**, and
`/tmp/r1-bench/` holds their reproductions. Do not re-investigate; implement.

Two defects, both confirmed by the parent:

### Defect A — the event-broker accounting leak (the amplifier, and a live problem)

`server/src/internal-api/event-broker.ts`. There are two eviction loops and they are
**not equivalent**:

```js
// ~line 226 — count-based trim: decrements ONLY the local `bytes`
while (buffer.length > this.replayBufferSize) { const old = buffer.shift(); if (old) bytes -= old.bytes; }

// ~line 229 — byte-based trim: decrements the global counter correctly
while (bytes > this.replayBufferMaxBytes && buffer.length > 0) {
  const old = buffer.shift();
  if (old) { bytes -= old.bytes; this.retainedBytesTotal = Math.max(0, this.retainedBytesTotal - old.bytes); ... }
}
// ~line 236 — then, unconditionally:
this.retainedBytesTotal += measured.bytes;
```

The count-based path never decrements `retainedBytesTotal`, so the counter
**ratchets up monotonically**. Once it passes `DEFAULT_REPLAY_BUDGET_MAX_BYTES`
(32 MB), `enforceGlobalBounds()` (~line 302-306) runs its eviction `while` loop on
**every published event**, up to a 10,000-iteration guard, scanning every session's
buffers.

**It does not self-repair**: `dropSessionState` (~line 286) subtracts only that
session's `replayBufferBytes` (bounded by the 1 MB per-session cap) and is skipped
when a session is *hot* — the streaming case. **Only a process restart clears it.**

**Live proof it is still inflated right now:** `/api/v1/diagnostics` reports
`EvictedEventsTotal: 632022`.

### Defect B — the quadratic per-delta parse (the trigger)

`node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js` **lines 455-456**:

```js
block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;
block.arguments = parseStreamingJson(block.partialArgs);
```

`parseStreamingJson` on an incomplete JSON string does **four O(n) passes per delta**
(two throwing `JSON.parse` attempts, a full char-by-char `repairJson` walk, then
`partialParse`) over an ever-growing string → linear per call, **quadratic in total**,
all synchronous on the event loop. Parent-measured: **0.399 ms/call at 5 KB rising to
14.566 ms at 460 KB**, integrating to **124 s of pure CPU** for one 131k-token
generation.

## What to do

**1. Fix Defect A in our repo (highest priority, and ours to own).**

Decrement `retainedBytesTotal` in the count-based trim as well. Then make the class
provably leak-free: after any sequence of `deliver()` calls, `retainedBytesTotal`
should equal the summed bytes of the retained buffers. **Write that as a property
test** — e.g. drive mixed traffic (many sessions, many deltas, forced count-trims and
byte-trims) and assert the invariant holds after every delivery. That test is the
deliverable that stops this class of bug returning.

**2. Fix Defect B — but note it is in `node_modules`.**

`node_modules/@earendil-works/pi-ai/...` is a dependency, not our source. Decide and
report which approach you take:
- **(a) Prefer a real patch upstream or a local patch mechanism** (e.g. `patch-package`
  if the repo has it, or a documented `postinstall` patch script) so the fix survives
  `npm ci`. Check whether the repo already has such a mechanism before inventing one.
- **(b) If no mechanism exists, implement a guarded local patch** with a regeneration
  script and a test that fails loudly if the dependency is updated without re-applying
  it. Document it as a known maintainability cost.
- **(c) If neither is clean, do NOT hack node_modules silently** — report the options
  and your recommendation instead. A fix that vanishes on the next install is worse
  than no fix.

Whatever you choose: throttle or defer the parse (parse at `finishBlock`, or at most
on a ~250 ms throttle) **and** cap `partialArgs` length, failing the call early with a
clear error instead of streaming to the token ceiling.

**3. Add a regression test for the trigger** — a tool-args stream that accumulates a
large buffer must not perform per-delta parsing. Assert on parse *count*, not on
timing, so the test is deterministic.

## Constraints

- **TDD**: failing test first for both defects. Record the RED output.
- **Do not restart production.** The operator has authorised a restart for the
  *secrets migration*, which another child is performing. Two restarts racing is a
  hazard — make your changes, verify locally, and say in your report that a restart
  is required to clear the leaked counter.
- **Do not touch** `/root/.pi-web-ui/secrets.env`, `.env.production`, or the systemd
  unit — another child owns those.
- **Do not touch** `client/**` — that child's sibling owns it.
- **Do not commit or push.** Leave work in the tree for parent review.
- Repo: `/root/pi-web-ui` (main tree). Confirm `git status --short` before finishing.

## Verification

- Full `server/tests/unit/internal-api/` suite green, plus `npm run typecheck` (exit 0)
  and `npm run lint` (exit 0; ~1700 pre-existing warnings are normal).
- The property test must **fail** if you revert the one-line fix — prove it catches
  the bug, don't just show it passes.
- For Defect B, demonstrate the parse-count reduction with the regression test.
- A child shell may leak `OPENCODE_ENABLED`/`PI_MAX_SESSIONS`; rule that out with
  `env -u OPENCODE_ENABLED -u PI_MAX_SESSIONS` before calling anything a regression.

## Hand-back format (report exactly this)

1. **Status**: complete / partial / blocked.
2. **Defect A** — the fix, the property test, and the proof it catches the bug
   (revert → RED).
3. **Defect B** — which approach (a/b/c), why, and what happens on the next
   `npm ci`. Be explicit about maintainability.
4. **RED→GREEN evidence** for both.
5. **Evidence the leaked counter is now bounded** — the invariant holds under mixed
   traffic.
6. **What still requires a restart**, and what a restart will and will not fix.
7. **Checks run** — exact commands with exit status.
8. **What you could NOT do** and why.
9. **Any finding that contradicts this brief** — state it; do not silently adapt.
