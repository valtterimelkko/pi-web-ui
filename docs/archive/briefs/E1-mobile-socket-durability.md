# E1 — Mobile socket durability (lost prompts, Drive Mode)

You are a child worker. Complete this end-to-end, then report back. Do not ask the operator anything — if you hit a genuine blocker, stop and report it.

## The operator-reported defect

On mobile browsers, dictated prompts frequently **never leave the device**. The text appears in the prompt box, but nothing is sent. The only known workaround is to copy the text, refresh the browser, and paste it again. This never happens on a laptop.

This matters far more for the coming voice work (Drive Mode): a spoken instruction cannot easily be retyped, and a talker that silently never transmits is a broken talker, not a degraded one.

## The root cause — already investigated, three verified links

Do not re-investigate from scratch; these were verified by the parent. Confirm them as you work.

1. **Reconnection is scheduled with `setTimeout`** (`client/src/lib/websocket.ts`, `attemptReconnect`). Mobile browsers **freeze timers** when a tab is backgrounded or the screen locks. The backoff never fires while suspended, and it is stale on return.
2. **Nothing reconnects on resume.** The client contains exactly **one** `visibilitychange` handler and it only flushes throttled `localStorage` writes (`client/src/store/sessionStore.ts:67`). There is no `online`, no `focus`, and no resume check touching the socket.
3. **The failure is silent.** `WebSocketClient.send()` returns `false` when `readyState !== OPEN`, and callers discard it. `client/src/hooks/useDriveModeDictation.ts` does `if (sessionId) { sendPrompt(text); }` with the boolean ignored — the text is dropped with only a `console.error`.

Additionally: a suspended tab can consume the bounded reconnect budget (`maxReconnectAttempts = 5`) while frozen, before it ever retries.

**Refresh fixes it because a refresh is currently the only thing that reconnects.** That is the confirming tell.

## Outcome

A prompt sent while the socket is down is **not lost**, and a returned tab **recovers by itself** — no refresh, no copy-paste.

## Required (in priority order)

1. **Reconnect on resume.** On `visibilitychange → visible`, `online`, and window `focus`: if `readyState !== OPEN`, reconnect **immediately** (do not wait on a suspended timer) and **reset the attempt budget** so a frozen tab cannot exhaust it.
2. **Never drop a user send.** When the socket is not open, **queue** the outbound message and flush it after reconnect (in order). Extend the existing `pendingSessionReconnect` mechanism if it fits; do not invent a parallel one. There is an existing reconnect re-subscription path in `client/src/hooks/useWebSocket.ts` — read it first, because a queued prompt must be sent *after* the session re-subscription, or it will be refused.
3. **Surface the failure.** A send that cannot be queued or delivered must reach the operator visibly (the app's existing error/notification surface), not a `console.error`.
4. **Preserve the dictation transcript.** In Drive Mode dictation, a failed send must not discard the text: keep it (restore to the prompt box or an explicit retry affordance) so a spoken instruction is never lost.

## Constraints

- **Do not change the WebSocket protocol** or the server. This is a client-side durability fix. If you conclude a protocol change is genuinely required, **stop and report** — another child is working on the server transport path in parallel.
- Preserve existing reconnect semantics for the ordinary (non-suspended) case; do not regress the desktop path or the existing `maxReconnectAttempts` behaviour beyond the resume reset.
- Keep any user-visible text British English and consistent with existing UI copy.
- **No production access.**

## Method — TDD

1. **RED first**, with a deterministic fake socket (do not rely on real network conditions):
   - a send while the socket is closed currently returns `false` and the message is **not** queued → assert the queue is empty today;
   - a simulated suspend (timer never fires) followed by resume currently leaves the socket closed and no reconnect attempted → assert today's behaviour;
   - a dictation transcript lost on send failure.
2. Implement, then green.
3. **Cover the ordered case explicitly**: queue a prompt while disconnected, reconnect, and assert it is sent *and* that session re-subscription happened first.
4. **Cover the budget reset**: simulate exhausting attempts while suspended, then resume, and assert reconnect is attempted rather than giving up.
5. **Live-validate in a real browser** if you can do so safely on localhost: use the repo's `webapp-testing` approach for a local dev server, simulate a socket drop (stop the server or block the socket), and show the message is delivered after recovery. If live browser validation is not feasible in your environment, say so plainly and report the structural evidence — do not claim a live pass you did not perform.

## Scope and paths

**Owned:**
- `client/src/lib/websocket.ts`
- `client/src/hooks/useWebSocket.ts`
- `client/src/hooks/useDriveModeDictation.ts` (and its immediate UI consumer if a retry affordance is needed)
- Their tests.

**Do not touch:** `server/**` (another child owns the server transport path right now), the talker modules, or the plan/brief files.

**Do not commit or push.** Leave work in the tree for parent review.

## Environment

- Repo: `/root/pi-web-ui`. Work in the tree given to you; verify `git status --short` first.
- Checks: `npm run typecheck` (exit 0), `npm run lint` (exit 0; ~1700 pre-existing warnings are normal), and the client test suite.
- A child shell may leak `OPENCODE_ENABLED`/`PI_MAX_SESSIONS` and cause unrelated failures — rule those out with `env -u OPENCODE_ENABLED -u PI_MAX_SESSIONS` before reporting a regression.

## Stop and report if

- The fix appears to require a server or protocol change.
- Queueing cannot preserve message order relative to session re-subscription.
- You cannot test the suspend/resume path deterministically.

## Hand-back format (report exactly this)

1. **Status**: complete / partial / blocked.
2. **What you changed** — files, and the shape of the queue + resume handling.
3. **RED→GREEN evidence** — each of the three RED cases, failing first.
4. **Ordered-delivery evidence** — queued prompt delivered after re-subscription, with the assertion.
5. **Budget-reset evidence** — exhausted-while-suspended then resumed.
6. **Dictation-preservation evidence** — what the operator sees when a send fails.
7. **Live browser validation** — what you actually did, with output; or an explicit statement that you could not and why.
8. **Checks run** — exact commands with exit status.
9. **What you could NOT do** and why.
10. **Any finding that contradicts the brief** — state it; do not silently adapt.
