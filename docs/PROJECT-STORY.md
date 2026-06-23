# Project Story

Pi Web UI began as a practical response to the limits of relying on a single coding-agent product.

## The original problem

The immediate pain point was cost, quota, and flexibility.

At the time, the workflow depended heavily on vibe coding and increasingly frequent agent use. A single premium agent subscription was not enough: some tasks genuinely benefited from a top-tier model, but many others only needed a capable, reasonably agentic model with much higher available usage. The need was not just “a better model”, but a **better mixture** of:
- subscriptions
- API-backed providers
- coding harnesses
- usage budgets
- reasoning strengths

The goal was to assemble a practical working set rather than stay loyal to one runtime surface.

## Why Pi Coding Agent came first

Pi Coding Agent was the first serious foundation because it was minimal, hackable, and teachable.

That mattered for two reasons:
1. it was affordable and flexible enough to experiment with
2. it made it easier to learn how coding-agent harnesses actually work

Pi Web UI therefore started first as a browser-accessible interface for the Pi Coding Agent path. That solved a second major problem as well: the need to use agent workflows from different places and devices, not just from a single terminal session on one machine.

## Why the runtime mix expanded

The repo then evolved as upstream model/platform policies changed.

### Pi Coding Agent path
The Pi Coding Agent path remained the most native and extensible route. It is the path where custom extensions, richer tools, and workflow-specific interaction patterns were most deeply developed.

### Claude Code
Claude was added because it remained valuable for harder, more complex coding work, but direct usage patterns and policy constraints around subscription-backed harness integration changed over time. That forced the project to evolve a more wrapper-oriented Claude path rather than treating Claude as a normal external API-backed coding surface.

A later twist was that Anthropic publicly signalled possible changes to how headless / SDK-style Claude Code usage might count against subscription access, then later backed away while reconsidering policy. That kind of uncertainty made it important not to build around only one Claude integration shape. Pi Web UI therefore evolved toward **three Claude backend paths** kept deliberately available:
- **SDK backend** — preferred when possible
- **direct CLI backend** — a practical fallback
- **channel-backed backend** — an escape hatch when the richer Claude Code path is still worth it

That flexibility is not just defensive. In practice, GLM 5.2 has also proved more effective inside the Claude Code harness than in some other harnesses, which is why provider profiles and GLM-through-Claude support became strategically important.

### OpenCode runtime
OpenCode was added because some providers and plans were friendlier to it than to Pi Coding Agent, especially in the Z.AI / GLM context. Even when Pi Coding Agent was preferred as a harness, OpenCode became strategically useful because it unlocked access that was not always available through Pi Coding Agent.

That remains true, but the story later became more nuanced: GLM access did not need to stay tied to only one harness. Once Pi Web UI gained Claude provider profiles, GLM could also be used through the Claude Code harness — which, for some coding tasks, turned out to be a better fit than default OpenCode behaviour.

### Antigravity runtime
Antigravity was added as another way to bring subscription-backed Gemini-style agent use into the same browser surface. Like Claude, it is not the same kind of first-class extension ecosystem as Pi Coding Agent. The integration is therefore more wrapper-like and operationally sensitive.

## How it is used in practice

This is not just a showcase repo. It is a live working interface used in day-to-day agent workflows.

Typical personal usage patterns include:
- using stronger premium runtimes for the hardest coding/research tasks
- using cheaper or higher-quota runtimes for medium-complexity work
- switching between runtimes without switching browser surface
- continuing work from mobile devices or while away from a desk
- using voice dictation and Drive Mode when typing is inconvenient or impossible
- combining the browser UI with companion Pi Coding Agent extensions and OpenCode plugins to get richer planning, memory, goal-tracking, and orchestration behaviour

A concrete example: the OpenCode path has been useful with Z.AI / GLM coding plans because that provider/runtime combination was practical there even when the same route was not available through Pi Coding Agent. That kind of pragmatic provider choice is part of the reason the project evolved into a multi-runtime surface rather than staying loyal to a single harness.

## Why the repo feels the way it does

Some aspects of the architecture and docs only make sense when viewed through that personal working context.

For example:
- the repo keeps a strong operational/runbook flavour because it is actually used live
- multiple runtime paths coexist because no single harness/provider combination was sufficient
- the Pi Coding Agent path is richer in extensions because that was the most modifiable foundation
- Claude and Antigravity are documented with more caveats because they rely more on wrapper-style integration
- mobile, dictation, and read-aloud features exist because the workflow is intentionally not desk-bound

## Public-release philosophy

The public version of this repo is meant to be both:
- a genuinely usable self-hosted project for others
- an honest record of a real, evolving personal agent workspace

It is not trying to pretend that all runtimes are equally clean, equally official, or equally extensible. The project is strongest when understood as a practical multi-runtime interface shaped by real usage constraints, changing upstream policies, and a preference for owning more of the interface layer personally.

It should also be understood as a platform people may reasonably fork and adapt. Some adopters may simply track the upstream repo and selectively pull changes. Others may use it as a starting point, keep the pieces they like, and evolve it around their own providers, models, runtime preferences, or operational constraints. That is a feature of the project, not a misuse of it.
