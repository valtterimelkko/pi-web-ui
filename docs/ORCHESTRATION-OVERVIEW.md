# Multi-harness agent orchestration with Pi Web UI

> The short, public explanation of what I now use Pi Web UI for most: **one standardised layer that lets a parent agent run child agents across Pi Coding Agent, Claude Code, OpenCode, Antigravity and Command Code** (and Codex-subscription models through Pi) without caring which harness each child runs in.
>
> This page is the map. The endpoint reference is [`INTERNAL-API.md`](./INTERNAL-API.md); the step-by-step parent guide is [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md). How the repo got here is in [`PROJECT-STORY.md`](./PROJECT-STORY.md).

## The idea in one paragraph

Every coding-agent harness has its own session format, its own way of streaming, its own idea of "done" and its own way to be driven from outside. Pi Web UI puts all of that behind **one session model and one local HTTP API** (the Internal API, a Unix-socket server on the same machine). A parent agent — say Opus in Claude Code — creates a child on whichever harness and model suits the subtask, sends it work, goes idle, is woken when the child finishes, reads a normalised result, checks the child's claims against the filesystem and cleans up. The parent never needs to know how `agy`, `cmd` or `opencode serve` actually behave. That is what I mean by a **standardisation layer**.

It began as a browser UI for the agents. It turned into this because the API underneath was the part I kept reaching for.

## What it standardises

| Concern | What the layer gives every harness |
|---|---|
| Sessions | One registry, one id, one list — create, prompt, abort, archive, delete, whatever the harness |
| Models | One live catalogue (`GET /models`) with a selector per harness, so a parent picks a route from what is actually available |
| Dispatch | Detached prompts with an idempotency key, a durable run receipt (`runId`) and a typed terminal outcome |
| Waiting | Watches and a long-poll `wait`, with a "wake the parent when the child ends" hook — no polling loops, no sleeping in a turn |
| Results | A normalised transcript, a screen-faithful view, a parsed completion block (`pi-completion/v1`) and evidence pointers |
| Verification | `verify` re-checks a child's claimed commits, files and tests against git and the filesystem (read-only) |
| Capacity | Admission control and `Retry-After`, so a burst of children backs off instead of overloading the host |
| Lineage | Parent/child links, including a Claude Code parent that Pi Web UI does not itself host |
| Goals | A goal engine for long-running children with turn and token budgets |
| Retention | Leases, so a child outlives the parent's turn and is cleaned up by its owner |

Everything above is the same call whichever harness answers it. Where harnesses genuinely differ (mid-turn steering, approvals, live event detail), the API says so honestly through its capabilities rather than pretending — see [`RUNTIME-OVERVIEW.md`](./RUNTIME-OVERVIEW.md).

## The harnesses it can drive

| Harness | How Pi Web UI drives it | Notes |
|---|---|---|
| **Pi Coding Agent** | Native SDK, in-process | The richest path. Also reaches many providers, including OpenRouter models and the `openai-codex` subscription provider (the way I use Codex models) |
| **Claude Code** | Claude Agent SDK with provider profiles, direct `claude -p`, or a channel-backed session | Three backends on purpose. Provider profiles let the Claude Code harness run other models, such as GLM |
| **OpenCode** | `opencode serve`, HTTP and SSE | A supported integration surface; good for OpenCode and Z.AI setups |
| **Antigravity** | `agy` stream-json, a persistent process per session | Gemini-style models. More wrapper-like, so more upkeep when upstream changes |
| **Command Code** | One `cmd` subprocess per session, behind `COMMAND_CODE_ENABLED` | Off by default. See [`COMMAND-CODE-INTEGRATION.md`](./COMMAND-CODE-INTEGRATION.md) |

A parent can itself be any of these. In my own use the parent is usually Claude Code, calling the API through a thin CLI.

## How I use it

This is a personal setup, so treat it as an example rather than a recommendation.

- **A strong parent, cheap children.** A top-tier model plans, splits the work and judges the result. A great deal of the actual work goes to children on much cheaper or higher-quota models — DeepSeek V4.1 Flash and GLM 5.3 Flash are the ones I use most (at the time of writing, October 2026). I call them "children to a parent", and that is also the vocabulary the API uses.
- **The harness is a per-task choice.** The same model can behave differently in different harnesses; GLM, for example, has worked better for me inside the Claude Code harness than in some others. With the layer in the middle, that is a one-line change to the route rather than a rewrite.
- **It changes the economics.** Spreading the work over cheaper, higher-quota children is a large part of why I could stay on a smaller Claude Code plan rather than the largest one.
- **It is not a toy load.** Tracking my own agent use, I counted 1,116 sessions in 30 days (October 2026).
- **Waves, not one giant prompt.** The parent splits work into non-overlapping pieces, gives each child bounded ownership of its files, waits without burning tokens, and does not accept a child's word for it: `verify` and the parent's own checks decide.

## The loop, in `pi-orch`

[`pi-orch`](https://github.com/valtterimelkko/pi-orch) is a small zero-dependency client for the Internal API. These are the verbs a parent actually uses:

```bash
pi-orch capabilities                                   # is the API there, which contract version?
pi-orch models --runtime pi --match flash              # which routes are live right now?
session=$(pi-orch spawn --runtime pi --cwd ~/proj \
  --model-selector <provider>/<model> --thinking low \
  --owner my-run --ttl 1800 --id-only)                 # create a child
run=$(pi-orch prompt "$session" --message "…the brief…" --id-only)
pi-orch wait "$session"                                # one long poll, no sleep loop
pi-orch result "$run" --final                          # the answer, normalised
pi-orch verify "$session" --since <base-commit>        # check its claims against git
pi-orch cleanup "$session"                             # release the lease, delete the child
```

Swap `--runtime pi` for `claude`, `opencode`, `antigravity` or `commandcode` (check `pi-orch capabilities` for what your server exposes) and nothing else about the loop changes.

## Adopting it

You do not have to take all of it. There are three levels, and each works on its own.

1. **Just the API.** Run Pi Web UI on a Linux or macOS machine you control, configure **two** runtimes you already use (start with two, not five), and call the Internal API yourself. Start at [`INTERNAL-API-QUICKSTART.md`](./INTERNAL-API-QUICKSTART.md), then [`INTERNAL-API-RECIPES.md`](./INTERNAL-API-RECIPES.md). Setup is in [`FIRST-RUN.md`](./FIRST-RUN.md) and [`GETTING-STARTED.md`](./GETTING-STARTED.md); you can ignore the browser UI entirely once the server is up.
2. **Plus `pi-orch`.** Clone [`pi-orch`](https://github.com/valtterimelkko/pi-orch) so a parent agent stops hand-writing `curl` and `sleep` loops. Node 22.18 or newer, no install step.
3. **Plus the skills and the wake mechanism.** (This is where it starts to work well; the full set and install order are in [`ORCHESTRATION-FIXTURE-SET.md`](./ORCHESTRATION-FIXTURE-SET.md).)

   **The skills.** The discipline around the API — how a parent plans a wave, briefs a child, waits safely, demands evidence and keeps secrets out of anything published — is packaged as four portable `SKILL.md` skills in the [Pi Web UI orchestration pack](https://github.com/valtterimelkko/agent-workflow-skills/blob/main/packs/pi-web-ui-orchestration-pack/README.md). Copy them into your harness's skills folder. They are harness-neutral and need nothing else from my setup.

   **The wake mechanism.** The [watch-wake companions](https://github.com/valtterimelkko/agent-workflow-skills/tree/main/companions/watch-wake) (a Pi extension and a Claude Code mod) let a bare CLI parent register a watch on a child, end its turn and be woken when the child finishes, at zero token cost, with a model-free deadline as backstop. Without them a parent has to sleep or poll.

You do **not** need Agent OS (my private coordination and memory layer), a cloud account, or any extra daemon.

### Before you point a parent at it

- **The token is full control.** Any holder of the Internal API bearer token can drive every session on the server. It is a same-host, single-operator interface, not multi-tenant. Read [`../SECURITY.md`](../SECURITY.md).
- **Do not test against your live server.** Start a disposable validation server (`npm run validate:server`) and use its socket and token. See [`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md).
- **Children cost real money and real quota.** Set `--ttl`, goal turn and token budgets, and a route cap before you fan out. Check `pi-orch capacity` first.
- **Children can edit files.** Give each one its own working directory or worktree and name the paths it owns. Two children in one checkout is how work gets lost.

## Honest caveats

- It is a working personal system that I have made public, so parts are messy and the docs carry a lot of operational detail. Read [`INTERNAL-API-QUICKSTART.md`](./INTERNAL-API-QUICKSTART.md) and this page first and ignore the rest until you need it.
- The harnesses are not equally official. Pi Coding Agent and OpenCode are supported integration surfaces; Claude Code and Antigravity are wrapper-oriented and need maintenance when upstream CLIs change; Command Code is off by default.
- Harnesses differ in what they can do mid-turn (steering, approvals, live events). The capabilities endpoint reports the real answer for your server.
- The contract version moves often. Read it from `/health` or the [contract changelog](./INTERNAL-API-CONTRACT.md), not from a README.

## Where to go next

| You want to… | Read |
|---|---|
| Make a first API call | [`INTERNAL-API-QUICKSTART.md`](./INTERNAL-API-QUICKSTART.md) |
| Copy a working pattern (durable dispatch, fan-out, evidence, transfer) | [`INTERNAL-API-RECIPES.md`](./INTERNAL-API-RECIPES.md) |
| Run a parent properly: waves, waiting, supervision | [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md) |
| Look up an endpoint or a version | [`INTERNAL-API.md`](./INTERNAL-API.md), [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md) |
| Choose which harnesses to enable | [`RUNTIME-OVERVIEW.md`](./RUNTIME-OVERVIEW.md) |
| Understand why the repo looks like this | [`PROJECT-STORY.md`](./PROJECT-STORY.md), [`VISION.md`](./VISION.md) |
| Adopt the parent-side discipline | [Orchestration pack](https://github.com/valtterimelkko/agent-workflow-skills/blob/main/packs/pi-web-ui-orchestration-pack/README.md), [`pi-orch`](https://github.com/valtterimelkko/pi-orch) |
