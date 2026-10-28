# The orchestration fixture set

> Pi Web UI's Internal API is powerful on its own. It works **well** because it is used with a small set of fixtures around it: a thin client, four skills and a wake mechanism. This page says what each piece is, why you want all of them, how to install them and how to hand them to an agent.
>
> Short version: **take all four rows below.** Each one removes a specific way orchestration goes wrong.

## The four pieces

| Piece | Repository | What it fixes |
|---|---|---|
| **Pi Web UI** — the server and Internal API | [`pi-web-ui`](https://github.com/valtterimelkko/pi-web-ui) (this repo) | Gives every harness one session model, one model catalogue, run receipts, watches, goals, leases and capacity control |
| **`pi-orch`** — the thin parent client | [`pi-orch`](https://github.com/valtterimelkko/pi-orch) | Parents stop hand-writing `curl`, guessing request shapes and polling. Documented exit codes. A `wait` that never polls |
| **The skills** — the discipline | [`agent-workflow-skills`](https://github.com/valtterimelkko/agent-workflow-skills) → the [orchestration pack](https://github.com/valtterimelkko/agent-workflow-skills/blob/main/packs/pi-web-ui-orchestration-pack/README.md) | Agents orchestrate the way experience says they should: bounded children, evidence before acceptance, safe waiting, no leaked secrets |
| **The watch-wake companions** — the wake mechanism | [`companions/watch-wake`](https://github.com/valtterimelkko/agent-workflow-skills/tree/main/companions/watch-wake) | An idle parent is woken when a child finishes, at **zero token cost**, with a model-free deadline as backstop |

## Why watch-wake is the piece people miss

An agent that dispatches a child must then wait. Without a wake mechanism it has three bad choices: sleep inside its turn (burning a long-held turn and context), poll in a loop (burning tokens and rate limit), or end its turn and hope somebody prompts it again (nobody does). The server can wake sessions it manages, but it cannot prompt a bare `claude` or `pi` CLI that you started yourself.

The watch-wake companions close that gap. The parent registers a durable server-side watch on the child, **ends its turn**, and goes idle. A local, model-free poller reads the watch ledger. When the child's turn ends, the poller delivers a new prompt into the idle parent, which then reconciles the child against its receipt and carries on. A second primitive, `wake_deadline`, is a model-free timer: a backstop for the case where the watch never fires. Together they are what lets one parent supervise several children for hours without watching them.

A wake means "go look", not "done". The skills teach the parent to reconcile against durable evidence before it acts.

## How an agent uses them

1. **The parent loads the orchestration skill.** `pi-web-ui-internal-api-orchestration` starts with a one-page parent card (rules that have cost real time, copy-paste sequences per harness, what to do on a wake). It is the only must-read before dispatching; the rest is reference.
2. **It checks what the server offers.** `pi-orch capabilities`, `models` and `capacity`. Model lists are live; never trust a remembered one.
3. **It spawns children** in their own working directories, each with a retention owner id, and sends each a brief that **mandates the child skill** (`agent-os-child`) in the prompt itself. Harnesses do not inject skills into API-created sessions; only the prompt does.
4. **Before it dispatches, it arms the wait:** a watch on each child (`watch_wake_register`) and one deadline (`wake_deadline`), per `long-horizon-waiting-strategies`. Then it dispatches, writes down what it is waiting for, and ends its turn.
5. **On a wake, it reconciles:** `pi-orch status`, the run receipt, the child's completion block. It treats stale or spurious wakes as noise.
6. **It verifies instead of trusting.** `pi-orch verify` re-checks claimed commits and files read-only; the parent re-runs the brief's gates itself.
7. **It cleans up:** cancel the watches, then `pi-orch cleanup --owner <id>`.

A prompt that starts this off can be as short as: *"Use the `pi-web-ui-internal-api-orchestration` skill. Split this task into independent lanes, run each as a child on a cheap model, wait with the watch-wake tools, verify each child, then report."*

## Install, in order

1. **Pi Web UI** with at least two runtimes configured: [`FIRST-RUN.md`](./FIRST-RUN.md), then [`GETTING-STARTED.md`](./GETTING-STARTED.md). Confirm `~/.pi-web-ui/internal-api.sock` and `~/.pi-web-ui/internal-api-token` exist.
2. **`pi-orch`:** `git clone https://github.com/valtterimelkko/pi-orch`, then put `bin/pi-orch` on your `PATH`. Node 22.18 or newer; nothing to install. Check with `pi-orch capabilities`.
3. **The skills:** copy the four folders named in the [pack README](https://github.com/valtterimelkko/agent-workflow-skills/blob/main/packs/pi-web-ui-orchestration-pack/README.md) into your harness's skills folder (`~/.claude/skills/` for Claude Code, `~/.pi/agent/skills/` for Pi, any readable folder for others).
4. **The watch-wake companion for your parent's harness:** follow [`companions/watch-wake`](https://github.com/valtterimelkko/agent-workflow-skills/tree/main/companions/watch-wake). It has a Pi extension and a Claude Code mod. If your parent is a session that Pi Web UI itself manages, the server's own `onFire` wake already reaches it and you can skip this step; for a bare CLI parent it is what makes idle waiting work. Antigravity and Command Code parents have no companion; the waiting skill describes what to use instead (a reactive background task with a schedule backstop for Antigravity, a capped `sleep` for Command Code).
5. **Run a small first task** against a disposable validation server (`npm run validate:server`) rather than your live one: one child, one prompt, watch, wake, result, cleanup.

## What you lose if you skip a piece

| Skipped | What goes wrong |
|---|---|
| `pi-orch` | Hand-written requests drift from the contract; no safe long-poll wait; no uniform exit codes |
| The orchestration skill | Children are dispatched without bounds, owned paths or frozen success criteria; completion claims are taken on trust |
| The waiting skill | Parents poll, sleep or end their turn with nothing armed; windows end with nobody awake |
| The child-worker skill | Children drift into narrative, omit command exit statuses and sign themselves off |
| Watch-wake | A bare CLI parent cannot go idle safely; waiting costs tokens or never ends |

## Adopting outside the author's setup: what to ignore

Pi Web UI and `pi-orch` are the author's own working tools, published as they are rather than forked into a "public edition", so a few things in them assume his private setup. None of it is needed, and none of it breaks if you leave it alone:

| You will see | What it is | What to do |
|---|---|---|
| The child skill is called `agent-os-child`, and `pi-orch`'s directive begins "You are dispatched as an Agent OS child worker" | Agent OS is the author's private memory and coordination layer, and this skill's name predates the public release. The public copy of the skill has none of that layer's mechanics | Use it as is. The name is only a name |
| The directive tells the child to "declare presence on the board" and "leave the board" | A shared task board in the author's layer | If you have no board, ignore it: the child skill tells a child without one to write a one-line note file in the hand-back directory instead |
| `pi-orch spawn --agent-os-capture enabled\|disabled` | Switches Agent OS's session capture for a child | Do not pass it. The flag is only sent when you give it |
| `agent-os provider-usage` in the `pi-orch` README (route-cap overflow text) and in the older docs | The author's quota read-out | Check your providers' own dashboards. Pi Web UI's `/capacity` and `/models` are the live sources inside the API |
| "The command centre (Wheelhouse)" notes in the `pi-orch` README, `AGENTS.md` and a few docs | A private consumer of the same API, signposted so the author does not break it | Ignore. It documents flags and exit codes that stay stable anyway |
| `AGENTS.md`/`CLAUDE.md`, the Agent OS contract mirror, host paths in older plans | Maintainer guidance for the author's host | Read only if you maintain a fork |

The public skills in [`agent-workflow-skills`](https://github.com/valtterimelkko/agent-workflow-skills) are derived from the author's private skill library with those mechanics removed. They can lag his private versions; the Pi Web UI and `pi-orch` docs and code are the same ones he runs.

## Honest limits

- The skills were written for one operator's way of working and then made harness-neutral. Expect to adapt wording, not the method.
- Which models you route children to, and what they cost, is your call. The skills tell you to read the live catalogue and capacity rather than hard-coding anything.
- The companions need a local poller process inside your parent harness; they cannot resurrect a dead parent session.
- All of this assumes one trusted operator on one machine. See [`../SECURITY.md`](../SECURITY.md).

## Related

[`ORCHESTRATION-OVERVIEW.md`](./ORCHESTRATION-OVERVIEW.md) · [`INTERNAL-API-QUICKSTART.md`](./INTERNAL-API-QUICKSTART.md) · [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md) · [`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md)
