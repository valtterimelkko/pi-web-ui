# Goal extension Web UI integration

Goal/planning behavior is a cross-repository feature: Pi Web UI owns the browser integration and lifecycle surfaces, while the companion Pi extension owns much of the goal-specific behavior and data semantics.

## Ownership boundary

Pi Web UI core is responsible for:

- receiving and routing extension UI events;
- rendering the extension-provided goal/tree surface;
- binding that surface to the active Pi session;
- lifecycle behavior across session switch, reconnect, reopen, and extension reload;
- delegating tree navigation/actions back to the extension rather than reimplementing goal semantics in the client;
- capability advertisement so the UI does not invoke unsupported behavior.

### Core-owned presentation (browser only)

The browser projects the extension's events into a richer surface. This is
presentation only — no goal semantics, no mutation, no new extension contract:

| Core surface | Source | File |
|---|---|---|
| Parsed goal model (status, runs, spend, verification, plan, continuation interval) | `widget_content` lines | `client/src/lib/goalModel.ts` |
| Live phase (`working` / `continuing in Ns` / `paused` / `awaiting-input` / `done`) and the 1-based run in flight | parsed model + session streaming flag | `client/src/lib/goalModel.ts` |
| Collapsible goal panel, height-capped, collapsed by default on phones | parsed model | `client/src/components/Chat/GoalPanel.tsx` |
| Goal history after the extension clears its widget/status | archived on status-clear, labelled from the completion notification | `client/src/store/goalStore.ts` |
| Notification tray (re-read a one-shot report) | every `notification` event | `client/src/components/common/NotificationTray.tsx` |
| "Goal continuation · sent automatically" label on extension-authored user turns | text match on the extension's own continuation prompts | `client/src/components/Chat/MessageBubble.tsx` |

A bare `widget_cleared` means the extension hid its widget (`/goal status`); the
goal only ends when `extension_status` is cleared. Treating the two as the same
signal archives a live goal, so keep them distinct.

## Cross-runtime goal surface (contract 1.27.0)

The same browser surface now renders goals for Claude (local-CLI backends) and
Command Code, not just Pi/OpenCode. The server synthesizes the identical
extension-UI message grammar from each runtime's canonical goal projection
(`server/src/internal-api/goal/browser-bridge.ts`) — the client parsing,
panel, history, and archive behaviour stay shared and runtime-neutral.
Programmatic control lives on the Internal API
([`INTERNAL-API.md`](./INTERNAL-API.md) § Goal Function): `GET/POST
/sessions/:id/goal`, `goal_state`/`goal_end` events, create-with-goal, and the
`goal` field on `/info`. The browser goal buttons route through the WebSocket
`goal_control` message, which now fans out per runtime (Pi slash command,
OpenCode server bridge, Claude/Command Code Internal API handler).

The ownership boundary above is unchanged: for Pi the extension still owns
goal semantics and the web UI remains presentation-only. Claude and Command
Code have no companion extension — their goal channels are server-owned
(Claude: native `/goal` transcript attachments; Command Code: the
server-provisioned goal-runner mod and its state file).

**Known limits of the browser-side history.** It is stored per browser
(localStorage), so it is not shared between devices, and it can only record a
goal whose end that browser witnessed — a goal that starts *and* finishes while
no browser is attached leaves no entry. The transcript and the notification tray
remain the fallback in that case. Making history device-independent would mean
persisting goal state server-side, which is a larger change than projecting the
events the extension already broadcasts.

The companion extension is responsible for:

- goal/work-item semantics;
- source-of-truth data and mutations;
- extension commands/tools;
- deciding what a tree node means and how navigation should resolve;
- compatibility with its own persisted state.

See the public companion repository referenced by [`RUNTIME-COMPANIONS.md`](./RUNTIME-COMPANIONS.md).

## Lifecycle expectations

- The active session remains the binding context for extension UI.
- Switching sessions must not leave goal UI bound to the previous session.
- Reopening a session should restore supported extension UI state through normal replay/capability paths.
- A safe extension reload refreshes the active session in place rather than silently dropping the client binding.
- Tree navigation is delegated through the extension contract; the browser should not infer filesystem or goal hierarchy semantics.
- Unsupported capabilities should degrade visibly and safely rather than leaving controls that do nothing.

## Troubleshooting

| Symptom | First check |
|---|---|
| Goal panel is absent | active runtime/session, extension installed, capability advertised |
| Goal panel vanished mid-run | whether `extension_status` was cleared (goal ended) or only `widget_cleared` arrived (widget hidden) |
| Finished goal not remembered | `goalStore` archive on status-clear; history is per browser (localStorage), not server state |
| Slash command typed mid-run does nothing | `draftStore.sendDraft` streaming allowance (Pi extension commands are exempt) |
| A dialog is stuck open on a second device | `extension_ui_cancel` with reason `answered` — emitted when another client answers |
| Panel belongs to wrong session | session switch lifecycle and active binding |
| Tree item click does nothing | delegated navigation event and extension handler |
| UI vanishes after reload | extension reload capability and active-session refresh |
| Old goal data reappears | extension/source persistence and replay contract |
| Core session works but goal UI fails | companion extension logs/events before core runtime debugging |

Preserve the distinction between a **core runtime failure** and a **companion extension failure**. Start with the session evidence bundle for the core session, then inspect extension-specific events and companion state.

## Maintainer source map

Start from:

- `client/src` extension UI components and session store handling;
- `client/src/hooks/useWebSocket.ts`;
- `server/src/websocket/connection.ts`;
- shared protocol types for extension UI/navigation/cancel events;
- the corresponding extension implementation in the companion repo named by [`RUNTIME-COMPANIONS.md`](./RUNTIME-COMPANIONS.md).

Any protocol change must update shared types, server routing, client handling, companion behavior, replay expectations, and canonical documentation together.

## Documentation rule

When describing goal functionality, state whether the behavior is:

- shipped in Pi Web UI core;
- supplied by the companion extension;
- available only for Pi sessions;
- persisted by Pi Web UI or by the extension.

Do not advertise companion goal semantics as a runtime-neutral core feature.