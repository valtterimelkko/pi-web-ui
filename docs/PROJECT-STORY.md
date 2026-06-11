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

## Why Pi came first

Pi Coding Agent was the first serious foundation because it was minimal, hackable, and teachable.

That mattered for two reasons:
1. it was affordable and flexible enough to experiment with
2. it made it easier to learn how coding-agent harnesses actually work

Pi Web UI therefore started first as a browser-accessible interface for the Pi runtime. That solved a second major problem as well: the need to use agent workflows from different places and devices, not just from a single terminal session on one machine.

## Why the runtime mix expanded

The repo then evolved as upstream model/platform policies changed.

### Pi runtime
The Pi SDK path remained the most native and extensible route. It is the path where custom extensions, richer tools, and workflow-specific interaction patterns were most deeply developed.

### Claude runtime
Claude was added because it remained valuable for harder, more complex coding work, but direct usage patterns and policy constraints around subscription-backed harness integration changed over time. That forced the project to evolve a more wrapper-oriented Claude path rather than treating Claude as a normal external API-backed coding surface.

### OpenCode runtime
OpenCode was added because some providers and plans were friendlier to it than to Pi, especially in the Z.AI / GLM context. Even when Pi was preferred as a harness, OpenCode became strategically useful because it unlocked access that was not always available through Pi.

### Antigravity runtime
Antigravity was added as another way to bring subscription-backed Gemini-style agent use into the same browser surface. Like Claude, it is not the same kind of first-class extension ecosystem as Pi. The integration is therefore more wrapper-like and operationally sensitive.

## How it is used in practice

This is not just a showcase repo. It is a live working interface used in day-to-day agent workflows.

Typical personal usage patterns include:
- using stronger premium runtimes for the hardest coding/research tasks
- using cheaper or higher-quota runtimes for medium-complexity work
- switching between runtimes without switching browser surface
- continuing work from mobile devices or while away from a desk
- using voice dictation and Drive Mode when typing is inconvenient or impossible
- combining the browser UI with companion Pi extensions and OpenCode plugins to get richer planning, memory, goal-tracking, and orchestration behaviour

## Why the repo feels the way it does

Some aspects of the architecture and docs only make sense when viewed through that personal working context.

For example:
- the repo keeps a strong operational/runbook flavour because it is actually used live
- multiple runtime paths coexist because no single harness/provider combination was sufficient
- the Pi path is richer in extensions because that was the most modifiable foundation
- Claude and Antigravity are documented with more caveats because they rely more on wrapper-style integration
- mobile, dictation, and read-aloud features exist because the workflow is intentionally not desk-bound

## Public-release philosophy

The public version of this repo is meant to be both:
- a genuinely usable self-hosted project for others
- an honest record of a real, evolving personal agent workspace

It is not trying to pretend that all runtimes are equally clean, equally official, or equally extensible. The project is strongest when understood as a practical multi-runtime interface shaped by real usage constraints, changing upstream policies, and a preference for owning more of the interface layer personally.
