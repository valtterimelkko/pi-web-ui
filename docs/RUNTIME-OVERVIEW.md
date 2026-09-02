# Runtime Overview

Pi Web UI can present **five runtime families in one browser UI**. Command Code is a full runtime path behind its own env gate (`COMMAND_CODE_ENABLED`, disabled by default).

This guide helps you choose where to start.

## Recommended mindset

Start with **one runtime you already trust or already use**.

Then add more runtimes only if they solve a real problem for you:
- provider access
- subscription economics
- model diversity
- extension/plugin ecosystem
- different strengths for different tasks

## Comparison table

| Runtime family | Uses | Integration style | Setup difficulty | Streaming/tool visibility | Best for | Caveat level |
|---|---|---|---|---|---|---|
| **Pi Coding Agent** | Pi Coding Agent | Native SDK/session integration | Medium | Richest Pi Coding Agent behaviour | Pi Coding Agent extensions, custom tools, Pi Coding Agent-first workflows, plus an optional broader OpenRouter-backed model catalogue | Low |
| **Claude Code** | Claude Agent SDK, `claude -p`, or channel-backed Claude Code | Profile-driven SDK integration (preferred), direct CLI fallback, or PTY/plugin path | Medium-high | SDK and channel modes offer good tool visibility; legacy direct is weaker | Claude Code-centric workflows, multi-provider access (GLM 5.3 / Z.ai, etc.), and users who want backend flexibility | Medium–higher |
| **OpenCode** | `opencode serve` | Local server/API integration | Medium | Strong normalized streaming via SSE adaptation | OpenCode-backed workflows and OpenCode/Z.AI setups | Low-medium |
| **Antigravity** | `agy -p` | Subprocess-per-turn wrapper | Medium | No native response/tool streaming; synthetic heartbeat + replay/log driven | Gemini/Antigravity access in the same UI | Higher |
| **Command Code** | `cmd -p` | Direct subprocess, host networking | High | Normalized NDJSON streaming, replay and native effort where advertised | Feature-gated fifth runtime with denylist catalogue discovery | High |

## The important trust distinction

These runtime paths are **not equally native**.

### More native / supported integration surfaces
- **Pi Coding Agent**
- **OpenCode**

### More wrapper-oriented paths
- **Claude Code**
- **Antigravity**

That does not make Claude or Antigravity useless. It just means adopters should expect those paths to be more operationally sensitive when upstream CLIs change.

## Which runtime should I start with?

### Start with Pi Coding Agent if...
- you already use Pi Coding Agent
- you want the deepest extension path
- you want companion Pi Coding Agent extensions to matter
- you want the most native Pi Coding Agent workflow behaviour
- you want the option to surface a much broader OpenRouter-backed model catalogue into the Pi runtime later

Read next:
- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`RUNTIME-COMPANIONS.md`](./RUNTIME-COMPANIONS.md)
- [`PROCESS-ISOLATION-DESIGN.md`](./PROCESS-ISOLATION-DESIGN.md)
- [`PI-OPENROUTER-MODEL-AUTOMATION.md`](./PI-OPENROUTER-MODEL-AUTOMATION.md)

### Start with OpenCode if...
- OpenCode is already in your workflow
- you want a local server/API style integration rather than a per-turn wrapper
- OpenCode/Z.AI/GLM access is one of the reasons you are considering Pi Web UI

Read next:
- [`OPENCODE-DIRECT-INTEGRATION.md`](./OPENCODE-DIRECT-INTEGRATION.md)
- [`RUNTIME-COMPANIONS.md`](./RUNTIME-COMPANIONS.md)

### Start with Claude Code if...
- Claude Code is the reason you want a browser UI
- you want to route through alternative providers (e.g. GLM 5.3 via Z.ai Coding Plan) using the same browser UI and session model
- you accept that this path has more operational nuance than Pi Coding Agent or OpenCode
- you specifically want channel-backed Claude visibility/features later

Recommended way to think about the three Claude modes:
- **SDK backend** — the preferred default, especially when you want explicit provider profiles and the strongest current behaviour
- **direct CLI backend** — keep available as a practical fallback when SDK or provider-profile behaviour changes upstream
- **channel-backed backend** — use when you explicitly want the richer Claude Code PTY/plugin path and accept the extra moving parts

Read next:
- [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md)
- [`CLAUDE-PROVIDER-PROFILES.md`](./CLAUDE-PROVIDER-PROFILES.md) (if you want to configure provider profiles)

### Start with Antigravity if...
- Gemini/Antigravity access is the key reason you want this repo
- you are comfortable with a subprocess-per-turn runtime path
- replay/history are good enough even without full live tool visibility
- you understand that disposable live-validation servers disable Antigravity;
  checks may touch the real `~/.gemini` conversation state

Read next:
- [`ANTIGRAVITY-INTEGRATION.md`](./ANTIGRAVITY-INTEGRATION.md)

## Capability summary

| Capability | Pi Coding Agent | Claude Code | OpenCode | Antigravity | Command Code |
|---|---|---|---|---|---|
| Unified sidebar session | Yes | Yes | Yes | Yes | Yes |
| History replay | Yes | Yes | Yes | Yes | Normalized journal |
| Follow-up turns | Yes | Yes | Yes | Yes | New turn |
| Mid-turn steer | Yes | Yes (SDK only, next tool boundary)¹ | No | No | Yes (interrupt + redirect)¹ |
| Approvals in UI | Extension/path dependent | SDK `AskUserQuestion` / channel permissions; not direct-CLI interactive approval | Yes | No | No |
| Native effort control | Generic thinking levels | Generic thinking levels | Runtime-specific | No | Per-model, from the committed effort table² |
| Best companion ecosystem | Strongest | Limited | Good with plugins | Limited | None |

¹ Steer semantics differ by runtime; see [`STEERING-RUNTIME-RESEARCH.md`](./STEERING-RUNTIME-RESEARCH.md) and [`INTERNAL-API.md`](./INTERNAL-API.md) prompt `mode` table (`prompt` / `follow_up` / `steer`). Claude steer is SDK-backend only and joins at the next tool boundary; Command Code steer interrupts the turn and re-delivers as the next prompt.

² Command Code catalogue is the CLI's advertised models minus a committed 19-model premium exclusion list (denylist, fails open), regenerated by `npm run commandcode:refresh-models`; a model with empty `effortLevels` remains runnable without a `selector` (weekly refresh). Generic `thinkingLevel` and native `effort` are distinct.

Command Code is one direct `cmd` subprocess per session with ordinary host
networking, gated by a single `COMMAND_CODE_ENABLED` flag and a CWD root
policy. The catalogue is denylist-based (advertised minus a committed
19-model premium exclusion list) and fails open; effort selectors come from a
committed table regenerated by `npm run commandcode:refresh-models`. Command
Code remains out of MCP and disposable `--runtime all` validation.

## Practical recommendations

### For the simplest serious adoption
Choose:
- **Pi Coding Agent-only**, or
- **OpenCode-only**

### For a stronger mixed setup
Choose:
- **Pi Coding Agent + Claude Code**, or
- **Pi Coding Agent + OpenCode**

### For the fullest multi-runtime philosophy
Choose:
- **Pi Coding Agent + Claude Code + OpenCode + Antigravity**

But only if you already know why each one belongs.

## Persistence and source of truth

| Runtime family | Primary persistence |
|---|---|
| **Pi Coding Agent** | `~/.pi/agent/sessions/` |
| **Claude Code** | `~/.pi-web-ui/claude-sessions/` + Claude native session JSONL |
| **OpenCode** | OpenCode runtime owns transcript storage; Pi Web UI stores registry metadata and replay transforms |
| **Antigravity** | `~/.pi-web-ui/antigravity-sessions/` + agy-owned conversation DBs |
| **Command Code** | `~/.pi-web-ui/command-code/` private records/journals + per-session native homes |

> **Operator note — human pin budget (2026-09-02, `d617d4b`):** the browser/UI allows **five human pins per runtime**; a 6th human claim is rejected with `SESSION_PIN_LIMIT` / `RETENTION_RESIDENT_CAPACITY_EXHAUSTED`. Command Code now enforces the same limit. Source-owned Internal API retention leases (`retention:{mode,ownerId}` → `INTERNAL_API_PIN_DIR`) and watch claims (`watch:<id>` / `watch-target:<id>`) are **independent** of that budget and do not consume human slots. The legacy `internal-api:` control pin is now an expiring `internal-api:` claim. Lease counts and residency are surfaced separately in `GET /sessions/:id/evidence` and `GET /sessions/:id/info` (`retention`); compare `retention.leases[]` with human pins when diagnosing capacity. See [`INTERNAL-API.md`](./INTERNAL-API.md) (retention), [`DURABILITY-MATRIX.md`](./DURABILITY-MATRIX.md), and [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) (pin-limit symptom).

## Companion repos

These can make a major difference to the richness of Pi and OpenCode workflows:

- **Pi Coding Agent extensions:** [valtterimelkko/pi-extensions-public](https://github.com/valtterimelkko/pi-extensions-public)
- **OpenCode plugins:** [valtterimelkko/opencode-plugins](https://github.com/valtterimelkko/opencode-plugins)

See [`RUNTIME-COMPANIONS.md`](./RUNTIME-COMPANIONS.md).

## Related docs

- [`GETTING-STARTED.md`](./GETTING-STARTED.md)
- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md)
- [`OPENCODE-DIRECT-INTEGRATION.md`](./OPENCODE-DIRECT-INTEGRATION.md)
- [`ANTIGRAVITY-INTEGRATION.md`](./ANTIGRAVITY-INTEGRATION.md)
