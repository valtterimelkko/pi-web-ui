# Lane shape — one tab with several lanes, or a tab per lane?

**Status: awaiting the operator's decision. This note exists because `MULTILANE-DESIGN.md` ASSUMED the answer
rather than asking it, and the assumption is the largest single driver of complexity in that design.**

Owner input already recorded (2026-09-15, this session):

1. **No cross-device lanes.** The operator switches device by closing Voice Mode on one and opening it on the
   other, so the server-side lane registry and its contract bump are **dropped entirely**.
2. **Mobile is single-lane** and that is fine.
3. **Multi-lane is a laptop scenario.**
4. Approved otherwise: **cap 3**; a fourth lane should **ask** (replace, or choose which to hand over), never appear
   silently; **visual announcement** over a cue tone; **waiting-time fairness** over fixed priority.

Those four decisions are *shape-independent* — they survive whichever lane shape is chosen.

---

## What is true today (read from the code, not assumed)

| Fact | Evidence |
|---|---|
| A drive-mode surface holds **one** session at a time | `DriveModeOverlay.tsx`: `activeSessionId` is a single value; `handleSelectSession()` sets it and moves to the `dictate` phase |
| There is **no in-place worker switch** while dictating | `DriveModeDictate.tsx` props expose only `onExit` / `onAbort`; `session-pick` is reachable only from the entry/continue flow |
| The speech arbiter is **per tab** | `speechArbiter` is a module singleton; measured `evidence/repro-*.json` — tab A's arbiter read `current: null` while tab B was playing |
| A floor taken in one tab does **not** affect another | measured: tab B kept playing at volume 1.0, `ducked: false`, zero `setVolume` events |
| `talkerBus` is a per-tab bus for talker turn results | `client/src/lib/talkerBus.ts` — `emit/subscribe/getLast/reset`, no lane registry |

**Consequence:** the entire cross-tab machinery in `MULTILANE-DESIGN.md` §4.5 (BroadcastChannel + 1 Hz heartbeat,
lane announcements between tabs, "disconnected lane" states) exists **only** to bridge tabs that cannot see each
other. Put the lanes in one page and that machinery is not needed at all, because the existing `speechArbiter`
already schedules playback *within* a tab.

---

## Shape A — a tab per lane (the design as written)

You keep 2–3 browser tabs open, each with Voice Mode on a different worker session. The tabs coordinate through
`BroadcastChannel`; a lane strip in each tab mirrors what the others are doing.

- **Cost:** modest — each tab already runs one voice surface; the new work is the coordination layer.
- **Resilience:** good — tabs are isolated, so a tab crash loses one lane.
- **Weaknesses:** tab juggling remains (and worker switching *inside* a tab still does not exist); background tabs
  are subject to browser timer throttling, which is a real hazard for a surface that must speak on schedule;
  impractical on mobile.

## Shape B — one tab, several lanes (recommended)

One Voice Mode page holds 1–3 worker sessions. A lane strip switches which worker the operator's voice is
addressed to, live, without leaving the screen; playback is scheduled by the **existing per-tab arbiter**.

- **Cost:** real but contained — the surface's state must hold several sessions instead of one `activeSessionId`,
  and per-lane state (transcript, talker turn, card, reading level, focus) must coexist.
- **Fixes the operator's actual complaint by construction:** nothing can talk over anything else, because there is
  only one arbiter; and switching becomes an in-app action on the screen the operator is already looking at.
- **Weaknesses:** a single tab crash loses every lane; three live lanes mean three concurrent STT/talker streams in
  one page (CPU and audio mixing).
- **Bonus:** works on mobile later for free, if it is ever wanted.

---

## Recommendation

**Shape B**, sequenced smallest-first:

1. Two live lanes in one tab, with the lane strip and the cap — nothing else. This alone removes the "unexpected,
  it started talking" surprise and makes switching deliberate.
2. Add the third lane and the cross-lane queueing rules once (1) is in use.
3. Build the cross-tab bridging **only** if the operator later genuinely wants two tabs side by side. Until then it
   is unrequested complexity, and it is the only part carrying the painful edge cases (throttled background tabs,
   heartbeat expiry, split-brain floors).

## What changes in the existing design if B is chosen

- §4.1 lane identity: keep, but it becomes an in-page registry rather than a cross-tab one.
- §4.2 lane strip: keep, and it becomes the **primary control** (switch which worker you are talking to) rather
  than a mirror of other tabs.
- §4.3 cap and §4.4 queueing: keep unchanged.
- §4.5 "which lane is speaking when you are not looking at it": **largely obsolete** — there is only one page, so
  the audio and the strip are always in the same context.
- §4.6 failure modes: drop the cross-tab rows; keep the "a lane crashed / tab closed mid-recording" behaviour,
  which the committed `4342f9e` already improves.
- Cross-device (§5 step 3, §8 Q1): **dropped by the owner.**
