# Voice Mode with up to three concurrent voice lanes — design note

**Status: proposal for operator review. Nothing here is implemented.**
Written by Child V, 2026-09-15, alongside a bounded defect fix (§6) and a
reproduction of the current multi-tab behaviour (§3).

---

## 1. What the operator asked

> "when holding two voice modes on separate browser tabs, I might struggle to
> switch - especially if I'm trying to voice myself on one while the other,
> unexpected started to talk. the microphone button does not seem to activate,
> even if the browser tab activates the red 'recording' button. How would a
> multi-voice mode thing look like, with max 3 voice modes on?"

Two different problems are tangled in that sentence, and they need different
answers:

| Problem | Nature | Answer in this note |
|---|---|---|
| You cannot tell which lane is talking, and another lane talks over you | missing cross-lane arbitration | §4 — one floor, many lanes |
| The button does not activate although the browser shows recording | a real defect in one tab's capture lifecycle | §6 — fixed now (minimal safe part) |

The multi-lane redesign itself is deliberately **not** implemented. §8 says
exactly what an implementation would need and what the operator has to decide.

---

## 2. The relevant existing invariants (do not lose these)

From `docs/plans/DRIVE-MODE-TWO-LANE-PLAN.md` §4.1, already decided and shipped:

1. **Capture is unconditional; only playback is scheduled.** Nothing in the
   speech ladder can delay, refuse or drop the operator's words.
2. **The operator's floor is never interrupted.** In-flight speech ducks
   (volume 0.15); new speech waits; chatter is dropped.
3. Every scheduling decision is observed into the browser diagnostic ring
   (`speechTelemetry`), so "why didn't I hear it?" stays answerable.

The four floor states (`voiceFloor.ts`) are the surface's language:
`you-have-the-floor`, `talker-speaking`, `working-silently`,
`answer-ready-held`, `idle`.

## 3. What is true today, measured

Reproduced in a real Chromium with two tabs, two different worker sessions,
both in Voice Mode (`harness/two-tab-repro-v2.mjs`;
evidence `evidence/repro-v2.json`, `repro-v3.json`, `repro-after-fix.json`):

| Observation | Measured |
|---|---|
| Two tabs can capture at the same time | yes — each tab got its own `getUserMedia` stream and its own `/api/dictation/start` (both HTTP 200) |
| Each tab's own floor banner is correct | yes — the recording tab reads "You have the floor" |
| The speech arbiter is per-tab | yes — `speechArbiter` is a module singleton, i.e. one instance **per tab**; tab A's arbiter reported `current: null` while tab B was playing |
| A floor taken in tab A affects tab B | **no** — with tab A holding the floor, tab B kept playing at volume 1.0, `ducked: false`, and recorded zero `setVolume` events |
| Tab B's speech can start while the operator is speaking in tab A | yes, and nothing in either surface can see it |

**There is no lane identity and no cross-tab coordination anywhere in the
current build.** That is the whole of the "the other, unexpected started to
talk" complaint, and it is structural, not a bug in one line.

## 4. The proposal — one floor, three lanes

### 4.1 Lane identity

A **lane** is one (browser tab × worker session) pair doing voice work. Give it:

- a stable `laneId` — `${workerSessionId}:${tabNonce}` where the tab nonce is
  generated per tab and kept in `sessionStorage` (per-tab by definition, so two
  tabs never collide and a reload keeps its identity);
- a short human label the operator sees everywhere: the session's display name
  (`Drive Mode — Worker 3`), never a number the operator has to remember;
- one **floor owner across all lanes**: at most one lane is *speaking* at a time
  and at most one lane holds the *operator floor*.

### 4.2 Seeing and switching (the part that fixes "I struggle to switch")

```
┌─ Voice Mode · 2 lanes ────────────────────────────────────────────┐
│  ● Worker 1  [ speaking ]   ← talking now                          │
│  ○ Worker 2  [ you have the floor ]                                │
│  ○ Worker 3  [ working silently ]                                  │
└───────────────────────────────────────────────────────────────────┘
```

- The lane list lives in the **floor strip** that already exists, so there is
  one place to look in every lane and every tab.
- Each row shows the same four states the single-lane banner shows today, plus
  which lane is audible.
- **Switching** is one tap on a row (or `Tab`/`Shift+Tab` + Enter). Switching
  never moves the microphone: capture belongs to the lane that started it.
- Every lane shows a persistent, low-noise marker when *another* lane is
  speaking ("Worker 1 is talking — muted here"), including a 350 ms cue tone
  before a hidden lane begins to speak, so unexpected speech is announced
  rather than startling (see §5, failure modes).

### 4.3 The cap (max 3) and what happens at it

- Three concurrent lanes maximum, on this browser profile.
- The cap is enforced where lanes are created — entering Voice Mode in a fourth
  tab offers *replace* or *choose which lane to hand over*, never a silent
  fourth lane.
- Rationale for 3: the shipped surface already carries two lanes' worth of
  concepts (worker + talker) and a three-row strip is still readable at phone
  width; a fourth row stops being glanceable while driving, which is the point
  of this mode.
- Lane count is visible at all times (`2 of 3`), so the cap is never a surprise.

### 4.4 What happens when a second lane starts talking while you are speaking

This is the exact case in the operator's report. Proposed rule, in precedence
order:

1. **A lane never starts speech over the microphone.** If any lane is capturing
   (`starting` or `recording`), speech in *every* lane waits at the current
   chunk boundary — the existing rule 1, promoted from intra-tab to cross-lane.
2. **If speech is already playing when capture begins**, it ducks to 0.15 in
   every lane and stays ducked until the next chunk boundary after the floor is
   released (existing rule 1, extended).
3. **A lane that wants to speak while another lane speaks** queues behind the
   audibly-playing lane; when the active lane finishes its chunk, the highest
   tier wins, ties broken by waiting-time fairness (a lane that has waited
   longest speaks next). Chat-relaxed chatter is still dropped, not queued.
4. **The lane holding the floor is announced.** Taking the floor in tab A
   immediately marks tab B's flight strip: "you have the floor in Worker 1".
   No lane may start speech while another lane holds the floor (rule 1 again).

The net effect on the operator's sentence: nothing they say is ever dropped,
and nothing speaks over them — the ambiguity moves from "what was that noise?"
to "Worker 1 is talking", stated before it happens.

### 4.5 Which lane is speaking, when it is not the one you are looking at

Because tabs cannot see each other's DOM, the audible-lane state has to be
shared. Options, in preference order:

1. **`BroadcastChannel` + `localStorage` heartbeat** in the same browser
   profile (no server change, works offline, survives reload, dies with the
   profile). Each lane publishes `{laneId, label, state, at}` at ~1 Hz plus on
   every state change; a lane that has not been seen for 5 s is shown as
   `disconnected` rather than silently dropped.
2. **Server-side lane registry** on the existing Voice Mode/talker records —
   more truthful across devices, but it needs an API contract bump and a
   server-side owner of the floor (see §8).

I recommend starting with (1): it is entirely client-side, needs no contract
change, and it is enough for "two or three tabs on one machine", which is the
reported scenario. (2) is the right answer the moment the operator wants lanes
on *different devices* (phone + laptop), which is a materially bigger change.

### 4.6 Failure modes and what the operator sees

| Failure | Current behaviour | Proposed behaviour |
|---|---|---|
| Two lanes speak at once | both play, indistinguishably | impossible: one floor owner |
| Lane B speaks while you speak in A | B talks over you | B waits; your words are never gated |
| A lane crashes / tab closed mid-recording | microphone stays live, no control (§6) | lane marked `disconnected` in every other lane; local capture released on unload |
| A tab cannot see the others (`BroadcastChannel` blocked) | — | lane strip shows only its own lane and says "other lanes unavailable" — never a false "you are alone" claim |
| Fourth lane attempted | would just work, silently | explicit replace/hand-over prompt |
| Two lanes answer the same prompt | both speak | second is queued at the same tier — never simultaneous |
| Operator closes the lane holding the floor | floor is released immediately (heartbeat expiry ≤5 s, plus an unload beacon) | other lanes resume at the next chunk boundary |

### 4.7 What does NOT change

- One-tab use is byte-identical: with one lane open, the strip collapses to
  today's single banner and no cross-lane messages are sent.
- Capture stays unconditional in every lane; nothing in the scheduler can gate it.
- Verbatim relay, confirmation card, focus hold and reading level are per-lane
  and unchanged.
- `speechArbiter` stays the only playback scheduler *within* a lane; the new
  layer only decides *which* lane's arbiter is allowed to sound at any moment.

## 5. Concrete recommendation

Implement §4 in this order, smallest first:

1. **Lane identity + visibility** (a lane registry in `BroadcastChannel`, a
   lane strip in the floor area, the cap at 3). This alone removes the
   "unexpected started to talk" surprise — the operator always knows which lane
   is which and which is audible — and it is the part that makes switching feel
   deliberate.
2. **Cross-lane floor** (one floor owner: never speak over any lane's capture;
   queue instead of overlapping).
3. **Cross-device lanes** (server-side registry) only if the operator actually
   wants phone + laptop at once. That is a separate decision with a contract
   bump.

If the operator wants only one of these, take (1): it is the visible half of
the problem and the half that is safe to ship alone.

---

## 6. What was fixed in this pass (the minimal safe part)

The operator's second complaint — *"the microphone button does not seem to
activate, even if the browser tab activates the red 'recording' button"* — was
a real defect in one tab's capture lifecycle, and it is fixed:

- **Two concurrent starts could exist.** A tap landing while the device was
  still being acquired (a second tab, a cold microphone) started a *second*
  `MediaRecorder` and opened a second dictation session. One tap then released
  only one of them: the app read "Start recording" while a recorder was still
  recording and the microphone track was still live.
  *Measured pre-fix:* `recorders = [inactive, inactive, **recording**,
  inactive]`, track `audio:live`, mic button label `Start recording`
  (`evidence/repro-v3.json`). *Post-fix:* zero recording, zero live tracks,
  `abort` HTTP 200 (`evidence/repro-after-fix.json`).
- **Leaving the surface left the microphone open.** Exiting Voice Mode while
  recording left the recorder and the track running with no control anywhere in
  the app. Post-fix: recorder stopped, track `readyState: ended`, server-side
  recording abandoned.
- **The acquisition window is now named.** `state: 'starting'` renders an
  explicit "Starting microphone…" state (button disabled, amber, `aria-busy`),
  so the surface can no longer look idle while the browser is already capturing.

What is deliberately **not** fixed here: cross-lane arbitration (§4). It is an
architecture change — lane identity, a shared floor owner, a communication
channel — and the operator reviews this note first.

## 7. Where the code would change (§4, for planning only)

| Concern | Where |
|---|---|
| Lane identity + cap + registry | new `client/src/lib/voiceLanes.ts` (`BroadcastChannel`), `sessionStorage` per-tab nonce |
| Cross-lane floor | `speechArbiter` gains a `floorOwner` input; the lane that does not own the floor holds its queue (no changes to intra-lane tiers) |
| Lane strip UI | `client/src/components/DriveMode/FloorBanner.tsx` → a strip; `voiceFloor.ts` gains a per-lane projection |
| Announce-before-speaking cue | `client/src/hooks/useReadAloud.ts` (one short tone) |
| Optional server registry | `server/src/routes/talker.ts` / Voice Mode records + Internal API contract bump |

## 8. What the operator must decide

1. **Scope:** lanes within one machine (client-only, no contract change) or
   across devices (server registry, contract bump)?
2. **Cap:** 3 as proposed, and does a fourth lane ask to *replace* or to
   *choose*?
3. **Announcement:** is a 350 ms cue tone before a hidden lane speaks wanted, or
   is a visual marker enough?
4. **Queue fairness:** when two lanes want the floor, waiting-time fairness
   (proposed) or a fixed lane priority?
