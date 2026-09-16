# W3 review findings — what is fixed, what is open

Source: the second W3 read-only reviewer, run `sa_mu2i6gln_7ic8ql` (completed 10:14Z), plus the conductor's own
verification of each claim against the deployed code. The reviewer's verdict was **"do not approve production
deployment yet"**; the conductor had already reviewed and deployed, so each finding is recorded here rather than
argued away. One is fixed and deployed (`447f43e`); three are open and need your decision.

## ✅ Fixed and deployed: deleting punctuation is a visible change (`447f43e`)

`repairRelaySeams()` deleted duplicated punctuation the operator spoke — `run!! tests` → `run! tests` — while its
comment claimed these transforms are "whitespace/punctuation only … not recorded as removals". Nothing was
recorded, so `describeProposal()` returned `cleaned: false` and the card claimed **"your words, exactly"** over text
that differed from what was said. That is the original defect in mirror image: the first bug claimed a tidy that
never happened; this one stayed silent about a change that did.

Confirmed by the conductor directly (`normaliseRelayText('run!! tests')` → `changed:true`, `removals:[]`). Fixed by
recording the dropped punctuation; whitespace collapsing stays unrecorded because it is genuinely invisible.
Regression tests cover both directions.

## ⚠️ OPEN 1 (critical): the card is not bound to the bytes you authorise

**What is wrong.** When the card appears it shows you a snapshot of the text. When you confirm, the client sends
a generic "yes" (plus which variant). The server then releases **whatever the draft currently holds** — there is no
proposal id, version or hash tying your confirmation to the text you actually looked at.

**How it can bite.** If the draft changes between the card appearing and you pressing Confirm — you speak again
while the card is up, or (once multi-lane exists) another tab mutates the draft — the released text differs from
the card you approved. The card contract says the card shows *the exact text that will be sent*; today that holds
only while the draft is stable between render and confirm.

**Why it is not fixed here.** The fix is a protocol change: the card's payload must carry an identity for the
proposal (a version or hash), the confirm must reference it, and the server must refuse a confirmation whose
identity no longer matches — surfacing "that card is out of date, here is the current text" rather than releasing
something you did not read. That changes the wire shape on both sides and therefore needs a contract version and
coordinated updates (the Internal API mirror in Agent OS included).

**Effort.** Moderate: one identity field through `propose` → card → confirm, a staleness refusal with its own
reason, plus tests for the four race cases (append after render, replace, cancel, cross-tab). The concurrent
WebSocket handler path makes this genuinely racy, so the tests must be real.

**Recommendation.** Do it — the card is the only door to the worker and it is the operator's own words. But do it
deliberately, with the contract bump, not as a hotfix.

## ⚠️ OPEN 2 (small, safety-shaped): the "original" variant is not server-gated

**What is wrong.** `releaseVariant: 'original'` is validated only as an enum. If a client sends it for a proposal
whose card advertised **no** original choice (a whitespace-only change: `cleaned:false`, no `original` field), the
server releases the raw text anyway — bytes the card never offered.

**Impact.** The client is your own browser, so this is defence-in-depth rather than an exploit — but it means the
"one door, gated" claim in the release commit is slightly overstated, and a stale or buggy client could send
un-tidied words.

**Fix shape.** Small: in `takeForRelease`, refuse the `original` variant when the selected entries' descriptor has
no `original` (i.e. no visible removal), through the existing mechanical-refusal path so the operator sees an
honest refusal rather than a silent substitution.

**Recommendation.** Fix, and fold it into the OPEN 1 work since both touch the same release decision — doing it
twice is wasted effort.

## ⚠️ OPEN 3 (pre-existing, matters more once lanes exist): no request/proposal correlation in `talkerBus`

**What is wrong.** `talkerBus` results are global and filtered only by worker session; the request id and runtime
are ignored (`client/src/lib/talkerBus.ts:69-90`, `useVoiceTurn.ts:261`). This predates the card work.

**Why it matters now.** With one tab it is a latent ordering risk. With several lanes in one page — the shape
under discussion — a stale or out-of-order result is exactly how a card from lane A shows up in lane B. The
reviewer explicitly ties this to the multi-lane decision.

**Recommendation.** Scope it with the lane work rather than separately: whichever lane shape is chosen, results
must carry the lane and request they belong to.

## Evidence gaps the reviewer named (for honesty, not action)

- The live rows exercise the trailing-newline case and the two release variants **over the WebSocket seam**, but
  they do **not** drive the real `ConfirmationCard` in a browser — no disclosure opened, no "Send my exact words"
  clicked. `L4` sends `releaseVariant:"original"` directly.
- No evidence covers concurrency, cross-tab mutation, stale/out-of-order results or proposal replacement.
- The card fix's live evidence used a deterministic local stub, so it proves the seam, not real-model behaviour.

## Note on the reviewer's readonly "violation"

The harness flagged the workspace changing during the review (HEAD `1f341bd` → `c298775`, plus the
`p27-ws-transport-validate.mjs` edit). **That was the conductor's own work**, not the reviewer: the cherry-picks
and the P27 commit landed while the reviewer was reading. The reviewer changed nothing.
