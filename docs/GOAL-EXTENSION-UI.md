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