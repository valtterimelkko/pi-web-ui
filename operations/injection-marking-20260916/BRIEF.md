# Injection marking — child brief (dispatch 2026-09-16)

**Status:** DISPATCHED. Parent: `pi-01a0a978` (this session). Child session + goal recorded in
`checkpoint.md`. **This brief is the contract; the checkpoint is the mutable truth.**

## Operator's request (verbatim, 2026-09-16)

> "if we mark routine injections, meaning the talker excludes them … let's make sure that it does
> not bring any regression to any other parts, like the session, the normal session view, or even
> the session view that I have on the side when I have the voice mode … We need to make sure,
> though, that we are only marking the injections, not necessarily my prompt or any of the other
> stuff. So it would need a really good amount of live validation for us to be sure that the right
> thing is being marked."

Background: the operator's spoken digest used to narrate the routine Agent OS memory-capture
housekeeping ("two candidates were extracted, cand-…, evidence written to …") instead of the
work. A prompt-level fix already shipped (`d27e75c`, `scripts/talker-prompts/digest.txt`); this
task makes the exclusion **structural** rather than a model judgement.

## Outcome (what must be true when done)

Routine Agent OS injections into a pi session are **structurally marked at the source**, and
**only** those marked injections are excluded from the talker's spoken context (its state history
and the read-aloud digest decision). Every other consumer — the chat session view, tool grouping,
the Voice Mode side pane, transcript/replay endpoints, search and transfer — is **unchanged**, and
that is proven by tests and live validation, not asserted.

## Grounded findings from parent reconnaissance (verify each; do not trust)

1. `/root/.pi/agent/extensions/agent-os-inject` is a symlink to `/root/pi-enhancement/agent-os-inject`
   (git repo, master `f4ed617`, tests are `tests/*.test.mjs`).
2. The packet / reground / workset / coordination-annex lanes already return
   `{message: {customType: 'agent-os', display: false, content}}` from `before_agent_start` — those
   lanes are **already structurally marked**.
3. The **capture-prompt lane** (`index.ts` → `sendCapturePrompt` → `pi.sendUserMessage(text,
   {deliverAs:'followUp', triggerTurn:true})`) is **unmarked**: it arrives as a real user message,
   textually indistinguishable from the operator's own prompt. That is the lane to mark.
4. `pi.sendMessage({customType, content, display, details}, {triggerTurn:true, deliverAs:'followUp'})`
   is documented in `/root/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
   §`pi.sendMessage` as: *"Inject a custom message into the session. Custom messages participate in
   LLM context."* — i.e. the same behavioural effect with a structural mark. Confirm this against
   the live API before relying on it.
5. Pi Web UI's talker history builder (`server/src/talker/session-registry.ts`, `toHistoryEntries`)
   keeps **only** `role user|assistant` entries, so a capture prompt sent as a custom message drops
   out of the talker's history by construction. Verify, and pin it with a test.
6. Pi Web UI already parses `customType` from session files
   (`server/src/internal-api/background-children.ts`), so the marker is readable server-side.
7. The spoken digest is decided **client-side** (`client/src/components/DriveMode/useAnswerReader.ts`
   builds the turn from the client's message projection and asks the server's `talker_digest` seam).
   A turn that was produced *by* an injection must not be read out as the operator's work — that is
   the part that needs the marker to reach that decision.

## Required work

- **A. Mark the capture lane at the source** in `/root/pi-enhancement-wt-inject/agent-os-inject`
  (custom type, behaviour preserved: content still reaches the model, still triggers the follow-up
  turn after the current turn). Keep an env kill switch in the same style as the existing
  `AGENT_OS_INJECT_COORDINATION=0`. Extend `tests/` (existing `.test.mjs` suite) for the new lane
  and for the kill switch.
- **B. Exclude marked injections from the talker's spoken context only** in
  `/root/pi-web-ui-wt-inject`: the talker's state history and the digest/read-out decision for a
  turn produced by a marked injection. Do not filter anything anywhere else.
- **C. Regression proof — the primary acceptance criterion.** For a session with NO injections,
  show the client transcript / replay / screen-view output and tool grouping are **identical**
  before and after the change. For a session WITH injections, show the same, with only the
  intended, explicitly enumerated difference. Prove by test that an operator prompt which quotes
  the injection wording **verbatim** is never treated as an injection — the match must be
  structural (entry type / custom type), never a text heuristic. This is the operator's explicit
  condition and a partial answer is a fail.
- **D. Live validation on a DISPOSABLE server** (never production; see
  `operations/voice-desktop-20260916/harness/boot.sh` for the pattern, or `npm run validate:server`
  + `scripts/live-validate.ts`): a real pi session that really receives injections, showing (i) the
  talker no longer narrates the capture housekeeping, (ii) the session view and the Voice Mode pane
  render as before. Keep evidence and raw commands under
  `operations/injection-marking-20260916/evidence/`.
- **E. Handback**: `operations/injection-marking-20260916/complete.md` with exact commands and exit
  codes, evidence paths, what is proven vs inferred, and the exact commit ids in both repos. The
  parent independently re-verifies; a claim without its command is not evidence.

## Invariants that must not be softened

- The routine capture itself must keep happening exactly as today (the operator relies on it);
  only its *marking* changes.
- No change to how the operator's or the worker's own messages render, group, replay or transfer.
- No protocol/contract change; no new endpoint; no schema change to existing event payloads that a
  consumer already depends on (an additive field is acceptable **only** if the regression proof in
  C covers its consumers).
- Never deploy, merge to master, restart or reconfigure `pi-web-ui.service`, or mutate the live
  extension symlink without restoring it in the same session. Deployment is the parent's call.

## Stop-and-ask conditions (write `NN-questions.md` and end your turn)

- The marking cannot be structural and would require matching operator text.
- The change would alter how operator/assistant messages render anywhere.
- Live validation cannot be done without affecting the operator's host beyond a reversible symlink
  flip you restore immediately.
- Any premise in "Grounded findings" proves false in a way that changes the design.

## Coordination

- Your session id is given in the dispatch prompt; declare presence on the board with
  `agent-os board declare --task "…" --join-session <your session id> --repo /root/pi-web-ui`.
- Coordination directory (outside both work trees): `/tmp/injection-marking-coord/` — write
  `01-questions.md`, `02-blocked.md`, `03-complete.md` there when you need the parent, then **end
  your turn** (never hold it open).
- Work only in `/root/pi-web-ui-wt-inject` and `/root/pi-enhancement-wt-inject`. Do not touch other
  agents' files or any other repo.
