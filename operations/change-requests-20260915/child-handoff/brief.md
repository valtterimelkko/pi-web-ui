# Child H — auto-compact-75 handoff fails from the Web UI frontend

**You are a dispatched child worker.** You own one bounded outcome. You do not
commit, push, build for production, or touch any service; the parent does that.

- Your session id: `01a0a42e-e5b1-7422-bc57-0560c028e9fd`
- Your pi-web-ui tree (worktree, yours alone): `/root/pi-web-ui-wt-handoff`
- Your second repo (yours alone): `/root/pi-enhancement`
- Handback: `/root/pi-web-ui/operations/change-requests-20260915/child-handoff/complete.md`
  (create the directory; evidence in `logs/` beside it)

## The report (operator, verbatim)

> "pi-enhancement: … (your session log) … autocompact75 handoff not working when
> trying to handoff from webui frontend - fix."

He referenced his live Web UI session log:
`/root/.pi/agent/sessions/--root-pi-web-ui--/2026-09-15T07-56-10-243Z_01a0a410-f683-7422-bc57-055af50db3f2.jsonl`

## What exists

- `/root/pi-enhancement/auto-compact-75/` — the extension. It offers
  `/autocompact75 handoff` (prepare an intentional transfer from the current,
  idle session) and `/autocompact75 claim` (claim it on the target). Read its
  `README.md` first; the ownership/lease safety gates are load-bearing and must
  not be weakened.
- The extension is **deployed by copy** to
  `/root/.pi/agent/extensions/auto-compact-75` (currently byte-identical to the
  source). Editing the source repo has no live effect; deployment does.
- Pi Web UI hosts pi sessions itself: `server/src/pi/pi-service.ts` (extension
  loading via `DefaultResourceLoader`, `getExtensionCommands()`), the routes in
  `server/src/routes/extensions.ts`, the chat send path in
  `client/src/components/Chat/MessageInput.tsx` (note: `/compact` is intercepted
  client-side), and the WebSocket prompt path in
  `server/src/websocket/connection.ts`.

## Required outcome

1. **Reproduce it.** Drive a session on a **disposable** Web UI server
   (`npm run validate:server`) and attempt the handoff the way the operator
   would from the browser path — typing `/autocompact75 handoff` into the chat
   input, and any extension-command surface the UI offers. Capture the exact
   failure: client behaviour, server log lines, extension diagnostics, and the
   session JSONL.
2. **Root-cause it with evidence.** Name the failing layer precisely — client
   interception, the send/prompt path, extension command registration or
   invocation, extension runtime assumptions under the Web UI host (session
   file path, agent dir, lease location, idle/ownership state), or the
   handoff/claim protocol itself. If it turns out the operator simply used it
   wrongly, say so with the evidence and document the correct path — that is a
   legitimate outcome.
3. **Fix it**, TDD (RED first) in whichever repo the cause lives. Keep it
   minimal; do not widen the extension's ownership safety gates to make a
   failure disappear.
4. **Validate end-to-end, isolated.** A disposable Web UI server with an
   isolated agent dir holding your modified extension copy (do **not** overwrite
   `/root/.pi/agent/extensions` while validating) and a real pi session: show
   handoff → claim working Web UI → target, and show a state where it must still
   refuse (e.g. a non-idle or mismatched source) still refusing.
5. **Report deployment needs; do not deploy.** If the fix needs a copy into
   `~/.pi/agent/extensions`, a `server/dist` build, or a production restart, say
   so exactly in the handback — the parent owns deployment.

## Constraints

- Disposable servers only. Never production, never `systemctl`, never
  `npm run build` (production serves `server/dist`).
- No git mutations in either repo (no commit/branch/stash/checkout/reset).
- Only your worktree and `/root/pi-enhancement` are yours to edit.
- Clean up disposable servers and sessions you create.

## Handback (`complete.md`)

Reproduction (exact commands + observed failure), root cause with the evidence
that proves it, RED/GREEN for every behaviour change, the isolated end-to-end
validation transcript, changed-path inventory across both repos, anything you
could not do, and the exact deployment steps the parent must perform.
Keep it evidence-dense; a claim without evidence is not a handback.
