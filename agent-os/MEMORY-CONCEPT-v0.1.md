# Agent OS Memory Concept v0.1

_Last updated: 2026-04-28_

## Purpose of this document

This document is a bridge between:
- the broader Agent OS intent
- the memory-specific intent work
- the stronger architectural patterns observed in AAMS

It does **not** define an implementation plan.
It does **not** lock a final architecture.
It does, however, make the memory direction more concrete than the current intent files.

Its purpose is to stabilise a **concept-level memory model** that remains faithful to the Agent OS philosophy while selectively adopting the AAMS patterns that genuinely strengthen it.

See also:
- `./INTENT.md`
- `./MEMORY-INTENT.md`
- `./MEMORY-STABILITY-INTENT.md`
- `./CONCEPTUAL-PATTERNS.md`
- `/root/pi-enhancement/aams/ARCHITECTURE.md`

---

## Core framing

A concise current framing is:

> The Agent OS memory should become an **operating memory for trusted continuity**, not primarily a knowledge wiki.

This means the memory exists first to help the system:
- start warm rather than cold
- remember enough of the user and their work to reduce re-briefing
- separate contexts without isolating them completely
- retrieve the right amount of context before work begins
- govern capability activation through continuity context

A wiki-like layer may still become useful later.
But the primary standard of success remains practical:

> does the system remember enough of the right context that work feels continuous?

---

## What is being adopted from AAMS

AAMS should not be copied wholesale into the Agent OS.
It is too rich, too wiki-like, and too project-memory-centric to be taken literally as the Agent OS memory shape.

However, several AAMS patterns are highly valuable and should be preserved conceptually.

### 1. Separate raw capture from compiled memory

This is the strongest pattern to adopt.

The Agent OS memory should distinguish between:
- **raw memory** — evidence of what happened, what was said, what was worked on
- **compiled memory** — the useful remembered context that should shape future work

This distinction matters because raw activity is noisy and often unsuitable as direct working memory.
At the same time, raw evidence remains valuable for:
- traceability
- later repair
- re-mining
- confidence in what the system thinks it knows

### 2. Layered retrieval

Memory should not all be loaded at once.

The Agent OS should retrieve context progressively, starting with the most durable and broadly relevant layers, then narrowing toward the current work context, and only reaching deeper evidence when needed.

This supports:
- lower startup clutter
- better relevance
- stronger trust
- more disciplined capability activation

### 3. Deterministic capture, LLM judgment

The capture layer should record information mechanically and reliably.
It should not try to perform rich judgment about what matters.

The judgment layer should instead decide:
- what is important
- what belongs at which level
- what should be promoted
- what should cool down
- what remains history only

This pattern is important because it improves trust while avoiding overconfidence from brittle heuristics.

### 4. Active/hot memory layer

AAMS's hot-cache idea maps strongly to the Agent OS need for a short-horizon active layer.

The Agent OS should preserve a distinct layer for:
- current focus themes
- likely upcoming work
- active threads
- contexts that should stay warm over the next days or weeks

This layer is likely to be one of the most practically useful parts of the entire memory system.

### 5. Traceability and provenance

The memory should not only remember things; it should support confidence about where remembered things came from.

This does not require maximal citation machinery in early versions.
But it does suggest the memory should preserve enough provenance to distinguish between:
- raw evidence
- compiled conclusion
- stable fact
- tentative inference
- current horizon item
- cooled or superseded memory

### 6. Human-readable inspectability

AAMS's markdown-native approach remains highly compatible with Agent OS intent.

The memory should remain:
- inspectable
- editable
- understandable
- portable
- suitable for human review and correction

This supports trust and makes the system easier to refine over time.

### 7. A co-evolving memory contract

AAMS's schema idea is useful when translated into Agent OS terms.

The memory will likely need an explicit and evolving contract for:
- what kinds of memory exist
- what belongs at each level
- what promotion rules matter
- what should stay local vs become reusable
- how cooling or expiry should work for short-horizon material

This should remain a user-steerable layer, not a rigid hidden mechanism.

---

## What is not being adopted directly from AAMS

The following should not currently be treated as the core shape of Agent OS memory:
- a wiki-first identity
- a project-wing-first hierarchy
- rich room proliferation as the main goal
- heavy cross-linking as an early priority
- full autonomous dream complexity as a prerequisite for value
- broad knowledge-compounding as the main purpose of memory v1

These may become useful later.
But they should not displace the more important early goal of practical continuity.

---

## The primary Agent OS memory structure

The strongest current structural intuition is that Agent OS memory should be organised around **continuity containers**, not mainly around knowledge pages.

A concise shape is:

- **User / identity**
- **Roles**
- **Projects**
- **Threads**
- **Horizon**
- **Raw history / evidence**

This structure is more faithful to the Agent OS intent than a project-only memory or a flat personal memory blob.

### Why this structure matters

It allows the system to:
- remember the user as a whole person
- treat roles as stable middle layers
- keep project continuity intact
- preserve thread-level working continuity
- maintain short-horizon readiness
- keep raw evidence available without turning it into active memory by default

It also helps with selective permeability:
- identity can influence many contexts
- role context can be shared across related projects
- project context stays mostly local
- threads stay specific
- horizon stays timely rather than permanent
- raw evidence stays available in the background

---

## Continuity containers

This section defines the concept-level containers the memory is likely to need.

### 1. Identity memory

This is the slowest-changing layer.

It should hold concise, high-trust context such as:
- who the user is
- major stable roles
- durable responsibilities
- enduring preferences about how assistance should work
- long-term domains of engagement

Its purpose is not to hold everything important.
Its purpose is to establish the broad interpretive context for all later retrieval.

### 2. Role memory

This is likely the most important middle layer.

A role is more durable than a project but more specific than the whole person.
Role memory may hold:
- what kinds of work belong to the role
- recurring vocabulary
- recurring stakeholder context
- shared patterns across projects under that role
- role-specific priorities and stance

Roles matter because they provide the main promotion boundary between:
- what should stay local to one project
and
- what should become reusable continuity across a broader area of the user's life or work

### 3. Project memory

This layer should support direct project continuation.

Project memory may hold:
- what the project is
- what it is for
- what has already been done
- key outputs and artifacts
- important decisions
- unresolved areas
- relevant stakeholder context
- project-local vocabulary and patterns

This is probably the most directly used layer during ordinary project work.

### 4. Thread memory

Threads should likely become explicit memory objects.

A thread is narrower than a project and closer to active work continuity.
It may represent:
- an active line of inquiry
- a workstream
- an unfinished sub-problem
- a recurring strand of development inside the project

Thread memory matters because many startup needs are not only project-level. They are often:
- “continue that line of work inside this project”
- “resume the unresolved thing we were doing there”

This suggests thread memory may be one of the most important bridges between memory and task routing.

### 5. Horizon memory

This is the short-horizon active layer.

Its function is to keep the system ready for what is likely to matter over roughly the next two to four weeks.
It may include:
- likely upcoming work
- current focus themes
- active or warming projects
- expected threads
- temporary contextual priorities

This layer should remain active but not automatically permanent.
It should cool down if not revisited.

### 6. Raw history / evidence memory

This is the background evidence layer.

It should preserve what happened in a way that supports:
- traceability
- later re-mining
- correction
- confidence
- reconstruction of how a conclusion was reached

This layer should usually stay out of normal startup memory unless deeper evidence is needed.

---

## Two memory forms

A useful concept-level distinction is:

### Form A — Raw memory

Characteristics:
- append-only or close to append-only
- evidence-oriented
- not heavily interpreted at capture time
- not normally injected directly into working context
- useful for audit, repair, and deeper retrieval

### Form B — Compiled operating memory

Characteristics:
- selective
- concise
- structured around continuity containers
- suitable for startup retrieval
- actively useful for routing and continuation

This distinction is central.
Without it, the memory either becomes too noisy or too thin.

---

## Promotion by stability

The Agent OS memory should not treat all useful information as equally durable.

The strongest current principle is:

> memory should be structured by rate of change

A useful promotion ladder is:

### 1. Horizon-stable
Useful now or soon, but not yet durable.

### 2. Project-stable
Useful across repeated work in one project.

### 3. Role-stable
Useful across multiple tasks or projects within one stable role.

### 4. Identity-stable
Broadly characteristic of the user and likely durable over long periods.

This ladder should guide memory promotion.
The key question is not only:
- is this true?

But also:
- at what level of continuity does this truth belong?

This is one of the clearest concept-level distinctions currently available.

---

## Retrieval order

A likely retrieval order for normal work startup is:

1. **Identity**
2. **Relevant role**
3. **Relevant project**
4. **Relevant thread**
5. **Current horizon**
6. **Deeper evidence/history only when needed**

This sequence matters because it expresses the Agent OS philosophy clearly:
- broad continuity first
- active context next
- evidence on demand

This also implies a broader operating rule:

> context retrieval should happen before capability activation is fully decided

In other words:
- memory should help determine what kind of work is being invoked
- memory should help determine which operating unit becomes relevant
- memory should not merely annotate a routing choice made without sufficient continuity context

---

## Cross-context reuse

The memory should support reuse, but selectively.

The strongest current intuition is:
- reuse should often flow **through roles**
- not mainly through one undifferentiated memory pool
- and not through complete project isolation either

This means:
- related projects under one role may share vocabulary, patterns, and stakeholder understanding
- unrelated roles should cross-reference more selectively
- identity context may influence many areas
- horizon may temporarily raise the salience of certain contexts across projects

This preserves the principle of boundaries with selective permeability.

---

## Memory and capability activation

One of the strongest Agent OS principles should remain:

> continuity should govern capability activation

This means memory is not only for recollection after the fact.
It is part of the operating logic that shapes what happens next.

In practice, this suggests:
- the system interprets a request through identity/role/project/thread/horizon context
- the conductor uses that context to determine the nature of the work
- only then are relevant skills, workflows, tools, or integrations activated with confidence

This keeps the Agent OS from collapsing into a capability-first tool launcher.

---

## What this concept should stabilise now

The following points now appear strong enough to preserve as concept-level decisions:

1. **Agent OS memory is operating memory first, wiki second.**
2. **Raw memory and compiled operating memory should remain distinct.**
3. **The primary continuity structure should be user → role → project → thread, with horizon and raw history as additional layers.**
4. **Memory promotion should follow stability and rate-of-change, not just importance in the abstract.**
5. **Retrieval should be layered, progressive, and minimal by default.**
6. **Role memory is a critical middle layer and likely the main promotion boundary.**
7. **Thread memory should likely become an explicit object in the Agent OS concept.**
8. **Short-horizon readiness is a core part of useful memory, not an optional extra.**
9. **Traceability matters because continuity must be trusted, not merely asserted.**
10. **Memory retrieval should influence capability activation before routing is finalised.**

---

## Status of this document

This document should currently be treated as:
- more concrete than intent
- less concrete than architecture
- a bridge toward future planning

It does not yet answer:
- the final file structure
- the final retrieval mechanism
- the final stabilisation/consolidation workflow
- the final UI surface
- the final conductor implementation

But it does make one major thing clearer:

> the Agent OS memory should be designed around continuity containers and promotion by stability, using selected AAMS patterns in service of operating memory rather than wiki richness.
