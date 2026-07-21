# Feature ownership and runtime matrix

Use this matrix to distinguish behavior owned by this repository from behavior supplied by a runtime or companion extension/plugin.

| Feature | Pi Web UI core | Runtime-dependent | Companion-dependent | Notes |
|---|---:|---:|---:|---|
| Browser login and shell | Yes | No | No | Core server/client behavior |
| Unified session sidebar | Yes | Yes | No | Runtime adapters provide underlying sessions |
| Streaming chat | Yes | Yes | No | Antigravity is batch-oriented with synthetic liveness rather than native token streaming |
| Transcript replay | Yes | Yes | No | Storage ownership differs by runtime |
| Session pin/archive/display name | Yes | No | No | Stored through core metadata/preferences paths |
| Model selection | Yes | Yes | No | Available models and thinking levels come from runtime capability data |
| Cross-runtime context transfer | Yes | Yes | No | Transfers visible context; it is not shared memory |
| Drive Mode | Yes | Yes | Optional enhancement | Frontend overlay over ordinary session/prompt paths |
| Files tree and Markdown editor | Yes | No | No | Core browser REST/file safety boundary |
| Telegram on `agent_end` | Yes | Yes | No | Core notification manager observes normalized runtime events |
| Terminal self-notifications | Yes | No | No | `scripts/notify.sh` calls the core Internal API |
| Internal API | Yes | Yes | No | Core contracted local boundary over runtime services |
| Durable run receipts | Yes | Yes | No | Dispatch-scoped; not a general job scheduler |
| Runtime health/evidence | Yes | Yes | No | Core aggregation plus runtime locators |
| Claude `AskUserQuestion` dialog | Yes | Claude SDK only | No | Requires the SDK interaction path |
| Pi custom extensions/tools | Integration support | Pi only | Usually yes | Extension implementation lives in the companion repo; see [`RUNTIME-COMPANIONS.md`](./RUNTIME-COMPANIONS.md) |
| OpenCode custom plugins | Integration support | OpenCode only | Usually yes | Plugin implementation lives in the companion repo; see [`RUNTIME-COMPANIONS.md`](./RUNTIME-COMPANIONS.md) |
| Goal/planning UI behavior | Partial integration | Usually Pi/extension-specific | Yes | See [`GOAL-EXTENSION-UI.md`](./GOAL-EXTENSION-UI.md) |
| Rich memory/status/orchestration behaviors | Integration surface | Varies | Often yes | Do not assume they are core merely because the UI renders them |

## Runtime integration character

| Runtime | Integration style | Operational character |
|---|---|---|
| Pi Coding Agent | SDK-native path | Lowest adapter caveat level; strongest extension/tool integration |
| Claude Code | SDK profiles, direct CLI, or channel-backed path | Multiple intentional backends; behavior and auth differ by backend |
| OpenCode | `opencode serve` HTTP/SSE | Supported server integration with OpenCode-owned transcript storage |
| Antigravity | `agy -p` subprocess per turn | Wrapper-oriented, batch output, runtime-owned conversation DB plus Pi Web UI turn logs |

## Documentation rule

When documenting a feature, state all three explicitly:

1. **owner** — core repo, runtime, or companion;
2. **transport** — browser REST/WebSocket, Internal API, runtime SDK/CLI, or extension protocol;
3. **persistence owner** — Pi Web UI, runtime, companion, or process-local only.

This prevents a visible UI feature from being mistaken for a fully core-owned implementation.