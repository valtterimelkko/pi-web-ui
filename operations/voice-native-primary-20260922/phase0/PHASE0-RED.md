# Phase 0 — baseline recheck and RED reproductions (2026-09-22)

> Conductor evidence record. Raw logs: `red-probe-output.txt` (first run),
> `red-probe-output2.txt` (tightened run). Probe source: `red-probe.ts` (temporary,
> executed as a vitest file at baseline, then removed from the test tree).
> Canonical defects and intent: plan [`§2`](../../docs/plans/VOICE-MODE-NATIVE-PRIMARY-AND-AUTONOMOUS-VALIDATION-PLAN.md).

**Baseline:** master `fa1eb393` (= plan revision `a97ca060` + sibling SDK bump `41c60d8a`
+ ledger commits). Command: `npm test --workspace=server -- tests/unit/websocket/phase0-red-probe.test.ts`
→ **5 failed | 7 passed (12)** on the tightened run.

| # | Defect class | Status at baseline | Evidence (tightened run) |
|---|---|---|---|
| 1 | Punctuation-free relay addressing | **RED confirmed** | `normaliseRelayText('Relay to worker I want to find out about Podpoint')` → unchanged; same for `'Ask the worker I want …'`. Control `'Relay to worker: I want …'` strips correctly. Cause: `consumeRelayFrame` / `consumeAskFrame` require a connector (`that`/`to`) or separator (colon/dash) after the frame head; a bare continuation is left untouched. |
| 2 | Casual / qualified confirmation | **GREEN at baseline** (already repaired) | `'not sure'`, `'sure, but wait'`, `'yes, hold phase three'`, `'I said yes'` → `statement`; `'yes'` → `confirm`. No RED needed — retained as regression controls (plan Phase 3 still locks it with corpus C21). |
| 3 | Correction accumulates instead of replacing | **RED confirmed** | Two `appendToDraft` calls yield `'Investigate the alternative Investigate the alternative, but do not change anything'`. The store documents “accumulates — never replaces”; no replacement/correction path exists. |
| 4 | Original wording not preserved on native promotion | **RED confirmed** | After operator utterance `'I want to find out about Podpoint'` and model relay text `'Find out about Podpoint'`, the proposal's `original` is `'Find out about Podpoint'` (defaulted to tidied) — the operator's recognised words are never stored. `voice-live-mount.ts` retains `lastOperatorFinalText` but does not pass it to `kernel.promote` (which supports `original`). |
| 5 | Async source binding guesses the latest utterance | **RED confirmed** | Utterance 1 (`'Investigate the alternative'`, the originating one) then utterance 2, then the `relay_to_worker` tool call → proposal binds `sourceUtteranceId = 2` (latest). The tool call reads `lane.utteranceSeq` at call time; it neither binds the originating turn nor refuses on ambiguity. |

**Plan §2 drift check (verified against current source):**

- Main controls and the native surface are separate engines: `client/src/components/DriveMode/DriveModeDictate.tsx:80` (`useVoiceTurn`) vs `:415` (`NativeVoiceLane`) — confirmed.
- All other §2 rows are production/historical observations; not re-verified here by design (no production access in this programme).
- Sibling lineage settled mid-Phase-0: SDK bumped `0.87.0 → 0.87.1` (`41c60d8a`, clean tree); programme baseline includes it.

**Implication for Wave 1 briefs:** child **H** owns the durable RED tests for classes 1, 3, 4, 5 in
`server/src/talker/**` and `server/src/websocket/voice-live-mount.ts` (+ its tests); class 2 stays a
regression control. The probe cases above are the acceptance seeds for Phase 3.
