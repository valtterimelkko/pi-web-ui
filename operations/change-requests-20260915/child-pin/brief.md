# Child P — create a session and pin it in one go

**You are a dispatched child worker.** You own one bounded outcome. You do not
commit, push, build for production, or touch any service; the parent does that.

- Your session id: `01a0a42e-e8c7-7422-bc57-0562a081bbea`
- Your tree (worktree, yours alone): `/root/pi-web-ui-wt-pin`
- Handback: `/root/pi-web-ui/operations/change-requests-20260915/child-pin/complete.md`
  (create the directory; evidence in `logs/` beside it)

## The report (operator, verbatim)

> "can't create a session and pin it in the same go - clicking the pin won't
> activate the pin - need to refresh browser in between. (webui frontend)"

## Where to look (map, not a verdict)

- `client/src/components/Session/NewSessionModal.tsx` — session creation.
- `client/src/store/sessionStore.ts` — `session_created` handling (~line 1910),
  `pinSession`/`unpinSession` (~1460/1497), the pin message handler (~3432), and
  where the session list and `pinnedSessionPaths` are derived.
- `client/src/components/Sidebar/SessionItem.tsx` — `handleTogglePin`.
- `client/src/lib/api.ts` — `pinSessionPref`/`unpinSessionPref` (delta writes).
- `client/src/hooks/useWebSocket.ts` — the outgoing pin path.
- Server side only if the cause is provably there (`server/src/websocket/…`).

## Required outcome

1. **Reproduce first, in a browser.** Create a session and immediately click its
   pin without refreshing; capture the before-state (what the UI does, what the
   network/WS shows, any console error). `webapp-testing` against a local dev or
   disposable validation server is the expected tool.
2. **Root-cause it with evidence** — e.g. the new session is not yet in the list
   the item renders from, the pin action targets a path/id the just-created
   session does not yet have, the store's pin state is not applied to the new
   entry, or the pin write is refused because the session is not yet "ready".
   Name it precisely.
3. **Fix it with TDD** (RED first) so that create → pin works with no refresh.
4. **Check the siblings** for the same class of defect (unpin, rename, archive
   on a just-created session). Report what you find; fix it if it is the same
   root cause and the fix is small, otherwise document it.
5. **Live-validate in the browser**: after-state evidence that the pin activates
   immediately and survives a reload (screenshots or DOM assertions plus the
   relevant network/WS traffic).

## Constraints

- Only your worktree is yours to edit. No git mutations, no `npm run build`,
  no production, no service changes.
- Clean up any servers/sessions you create.

## Handback (`complete.md`)

Before/after browser evidence, the root cause, RED/GREEN per change, the exact
commands, changed-path inventory, sibling findings, and anything you could not
do. Evidence-dense; no unevidenced claims.
