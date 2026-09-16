# STRATEGY — Voice/Drive-Mode confirmation card: honest tidying + the operator's choice

- **Status:** EXECUTING (operator authorised autonomous defect fixing in-session,
  2026-09-15; production restart remains separately gated).
- **Written:** 2026-09-15 by the parent conductor session
  `01a0a410-f683-7422-bc57-055af50db3f2` (the Drive-Mode worker lane).
- **Scope:** two reproduced defects on one seam — the `proposal` payload the
  server sends to Drive Mode's confirmation card, and the client card that
  renders it. **It does not permit** production restart, deployment, service
  changes, or edits outside the owned paths in each child brief.

## 1. Authority and intent

The operator, in-session 2026-09-15, reported that the card claimed it had tidied
his prompt while the text looked verbatim identical, that what looked like his
whole prompt was shown as "taken out", and that he had expected an option to
choose the original prompt which never appeared. He authorised: "do these fixes
autonomously with children … orchestrate children, use DeepSeek V4.1 flash …
zero token waiting and watching … whenever something is open, work fully
autonomously until it's at end". Production restarts stay gated.

Canonical design intent: `docs/VOICE-ORCHESTRATOR-FEASIBILITY.md` (§3.2 rule 3 —
semi-verbatim relay: the operator's own words, optionally made more concise),
`docs/plans/DRIVE-MODE-TWO-LANE-PLAN.md` §4.1/§4.2, and the P22–P27 briefs in
`docs/archive/briefs/`. The relay text is harness-owned; the model never produces
it (P25 boundary, preserved by this programme).

## 2. The defects (parent-reproduced)

| ID | Defect | Parent evidence |
|---|---|---|
| D1 | Invisible (whitespace-only) normalisation claims a visible tidy, and `removed` carries the operator's **entire** original utterance, not the removed fragments | `normaliseRelayText("Proceed.\n")` → `{changed:true, removals:[]}` (probe, 2026-09-15); live `[VoiceMode]` records from the same morning carry `"Proceed.\n"`; `connection.ts` ~L4216 builds `cleaned` from `originalText !== undefined` and `removed` from the whole original |
| D2 | No way to send the operator's original words, though the store keeps them (`DraftUtteranceEntry.originalText`) and the card is the only release gate | `client/src/components/DriveMode/ConfirmationCard.tsx` has Confirm / Cancel / typed-text only |

## 3. Collision boundary

- No other agent lineage owns `/root/pi-web-ui` per the Agent OS board
  (2026-09-15): the two live neighbour entries are host maintenance at `/root`
  (`pi-01a0a40b`) and an unstarted `/root` session (`pi-01a0a40e`).
- The operator is **live on this repository's production service** through Voice
  Mode. Therefore: children never build `dist/`, never touch the service, and the
  working tree stays source-only until the gated deployment.
- The parent (this session) is itself the operator's Drive-Mode worker lane and
  owns the seam, the integration, the commits and the final verdict.

## 4. Waves

| Wave | Work | Owner | Gate to the next wave |
|---|---|---|---|
| **W0** | Diagnosis + frozen interface + programme artefacts (this file, `STATE.md`, the child brief) | parent | brief is self-contained; interface frozen |
| **W1** | Card contract implementation: D1 + D2, server and client, in one bounded child (single writer, single seam — the P26/P25 seam defect came from splitting a seam across agents) | child `card-contract` (pi / `opencode-go/deepseek-v4.1-flash` / `high`) | handback with RED/GREEN evidence; parent re-runs the suites |
| **W2a** | Parent verification: independent seam probe written by the parent (not the child's tests), full affected suites, typecheck, commit + push path-limited | parent | seam probe green on the frozen bytes |
| **W2b** | Live validation on a **disposable** server (`npm run validate:server`), driving the real WS protocol: whitespace-only utterance, visible tidy, default confirm release, original-variant release, and the card payload ↔ release byte-equality | child `live-validation` | evidence table with the actual relayed bytes |
| **W3** | Fresh read-only reviewer over the accepted commits (no implementation ownership) | child `reviewer` | findings returned as one bounded correction brief or an explicit clean verdict |
| **W4** | Deployment: build + production restart, **operator-gated**, with `activeTurns === 0` pre-check and contract verification after | parent, on operator approval | operator's explicit go |

## 5. Non-regression gates

- Server: `npm test --workspace=server` full workspace green.
- Client: `npm test --workspace=client` full workspace green.
- `npm run typecheck --workspace=server` and `--workspace=client` clean.
- The seam invariant pinned **in one test** (payload text ≡ default release text;
  payload original ≡ original-variant release text).
- P27's live matrix (`scripts/p27-talker-matrix-live.ts` /
  `scripts/p27-ws-transport-validate.mjs`) is the re-runnable regression evidence
  for the surrounding function surface — W2b uses it as the outer harness.

## 6. Stop / question boundaries

Stop and ask the operator only for: production restart or deployment, an
irreversible action, a contradiction in the frozen interface that blocks work, or
a defect whose cause cannot be established. Everything below that line is
conductor-autonomous, including sequence gating between waves.
