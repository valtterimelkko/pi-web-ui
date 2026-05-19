# Agent OS Memory Stability Intent

_Last updated: 2026-04-24_

## Purpose of this document

This document records a specific reflection within the broader Agent OS memory work:

> What should be considered stable enough to enter long-term memory about the user, versus what should remain only project-level memory, short-horizon memory, or recoverable history?

This question matters because an effective memory should not merely store more information. It should store information at the **right level of durability**.

If too much is treated as long-term memory:
- memory becomes noisy
- unrelated contexts mix together
- the system recalls too much irrelevant detail
- trust declines

If too little is treated as long-term memory:
- the user must keep re-explaining major parts of themselves and their work
- the system never truly develops continuity
- every new task still feels like a near-cold start

This file exists to preserve the current thinking about **durability**, **promotion**, and **memory layering by rate of change**.

See also:
- `./INTENT.md` — broader Agent OS intent
- `./MEMORY-INTENT.md` — overall memory intent and layered memory reflection

---

## Core idea

The Agent OS memory should not treat all remembered information as equal.

Different kinds of knowledge change at different rates:
- the user's core identity changes slowly
- major roles change slowly, often over years
- projects change more often
- upcoming priorities change faster still
- raw session activity changes constantly and is usually too noisy for active memory

This leads to an important guiding principle:

> **Memory should be structured around different rates of change.**

A concise current expression of this principle is:

- **identity changes slowest**
- **roles change slowly**
- **projects change more often**
- **short-horizon priorities change fastest**
- **raw history changes constantly and should mostly stay in the background**

This is one of the strongest organising ideas discovered so far.

---

## Important user-specific clarification that shapes this reflection

The user clarified that their **roles do not change often at all**.

Important examples from reflection:
- some roles may remain stable for **2–3 years at a time**
- some roles may remain stable indefinitely or effectively permanently
- examples of highly stable contexts include **home stuff** and **family stuff**
- by contrast, **projects can and will change**

This clarification strongly affects memory design.

It suggests that the memory should confidently treat **roles as long-lived memory objects**, not just as temporary labels.

This makes roles especially important because they can act as a stable middle layer between:
- the user as a whole
and
- the changing set of projects they engage with over time

---

## The main distinction to preserve

A useful way to think about memory durability is to distinguish between at least four levels:

1. **Long-term memory about the user**
2. **Long-term or medium-term memory at the role level**
3. **Project-level working memory**
4. **Short-horizon active memory**
5. **Recoverable history / evidence memory**

These are not yet implementation classes, but they are conceptually valuable.

---

## What seems stable enough to enter long-term memory about the user

These are the kinds of things that currently appear durable enough to belong in memory about the user themselves, rather than only in a project.

### 1. Core identity facts that are unlikely to change often

Examples include:
- the user's name
- high-level professional identity
- enduring life contexts
- major recurring personal responsibilities
- major long-term interests

These are foundational and slow-moving.

They help answer:
- who is this person?
- what kinds of contexts are normal for them?
- what broad assumptions should shape how tasks are interpreted?

These facts should be stable, concise, and high-trust.

### 2. Major roles

Given the user's clarification, major roles clearly belong in durable memory.

Examples discussed in reflection include:
- educator / lecturer / team coach / module leader
- AI builder / agent systems designer / workflow experimenter
- researcher
- public/professional content role
- family/home/property-related role
- investor/trader, where relevant and still active
- other recurring role-clusters that may emerge

These roles are long-lived enough to matter deeply for future task interpretation.

A role should not be treated as an incidental tag. It is a major unit of continuity.

### 3. Durable preferences, stances, and ways of working

Only some preferences should enter long-term memory — specifically the ones that recur often enough to shape how the system should work with the user over time.

Examples may include:
- durable stylistic preferences
- recurring working patterns
- broad preferences about how systems should help
- preference for continuity over repeated setup
- dislike of generic or decontextualised assistance
- desire for practical memory before ornamental knowledge structure

These are part of the user's enduring collaboration model with the system.

### 4. Durable vocabulary anchors tied to stable roles

Some vocabulary is not just project-specific; it is repeatedly relevant within a role.

Examples discussed in reflection include:
- recurring educational / Tiimiakatemia / Team Academy concepts
- recurring academic vocabulary
- recurring AI workflow / agent orchestration vocabulary
- family/home/property vocabulary, where it repeatedly matters

Not every term should enter durable memory. But repeated, role-defining vocabulary likely should.

### 5. Long-term stakeholder or recurring relational context

Some relational context may be stable enough to belong to long-term memory about the user's work-life structure.

This may include:
- recurring institutional contexts
- recurring stakeholder types
- important relationship categories
- stable contextual actors that repeatedly shape tasks inside a role

The important principle is not to overstore every person, but to preserve the kinds of relational context that materially shape interpretation over time.

---

## What seems stable enough only for role-level memory

Role memory currently appears to be one of the most important and useful layers.

This is because roles are long-lived, but still more specific than the user as a whole.

Role-level memory may include:
- what kinds of work belong to that role
- recurring stakeholders for that role
- role-specific vocabulary
- role-specific priorities and stance
- shared context across multiple projects under the role
- recurring constraints, expectations, and rhythms in that role

### Why role memory matters so much

Role memory solves an important problem:
- not everything should be promoted directly into permanent personal memory
- but many useful patterns should not remain trapped inside one project either

Role memory is therefore a powerful middle layer.

It can hold things that are:
- more durable than a project
- less universal than the user's whole identity

This seems especially well-suited to the user's life and work because their roles are relatively stable while projects change.

---

## What seems appropriate for project-level memory

These are things that matter greatly for continuity, but should primarily remain local to a project unless they prove to have broader relevance.

### 1. What a specific project is

Project memory should know things like:
- the purpose of the project
- the scope of the project
- the status of the project
- key stakeholders in the project
- important artifacts and outputs
- what has already been done
- major decisions and conclusions
- unfinished threads

This is extremely important, but it is not automatically long-term memory about the user.

### 2. Local project vocabulary

Some terminology only matters inside one project.

This should usually remain project-local unless it recurs enough to become role-level vocabulary.

### 3. Project-specific lessons and patterns

A lesson discovered on one project should initially stay local.

Only if it:
- recurs across multiple projects
- clearly generalises within a role
- repeatedly shapes future work

should it be considered for promotion upward.

### 4. Project-linked people and stakeholder details

Some people matter only inside one project.

They should not be promoted automatically.

They should remain project-level unless they become recurring context across the role.

---

## What seems appropriate for short-horizon active memory

This layer emerged as especially valuable in reflection.

The user described wanting the system to know what may be engaged with over the **next two weeks to month**.

This is not best thought of as a strict task list. It is better understood as a time-sensitive horizon layer.

### Short-horizon memory may include:
- likely upcoming work
- current focus themes
- expected project threads
- near-future priorities
- things the user wants the system to stay ready for
- temporary context boosts that matter right now

### Why this layer is important

This layer may be disproportionately helpful in reducing startup friction.

It helps the system stay prepared for work that has not yet fully started or may recur soon, such as:
- themes likely to come up this month
- projects that need to stay hot
- contexts the user expects to return to soon

### Important durability principle

Short-horizon memory should be treated as important but **not automatically permanent**.

It should remain active while relevant, but expire, cool down, or require reinforcement if it is not revisited.

---

## What should remain mostly as recoverable history, not active memory

This distinction is crucial.

A common failure mode in memory systems is treating everything that happened as if it deserves to become active memory.

That would be a mistake here.

### Likely history-only material includes:
- raw activity traces
- lists of commands run
- transient file reads/writes
- exploratory dead ends
- ephemeral conversational fragments
- abandoned directions that produced no durable lesson
- narrow incidental facts that do not help future interpretation

### Why preserve it at all?

Because history still matters for:
- traceability
- later re-mining
- memory repair
- grounding
- evidence when needed

But most of it should not be part of the memory that actively shapes future task startup.

---

## The promotion ladder: a useful conceptual model

Rather than treating memory promotion as binary, it may be more useful to think in terms of a ladder.

### Level 1 — Short-lived / horizon-only

Characteristics:
- probably useful now
- not yet durable enough for long-term memory
- relevant for near-future readiness
- may fade within days or weeks if not revisited

Examples:
- things likely to matter this month
- themes expected in the next two weeks
- temporary contextual priorities

### Level 2 — Project-stable

Characteristics:
- clearly useful across multiple sessions in one project
- important for continuity there
- still mostly local to that project

Examples:
- project scope
- prior work done on that project
- recurring project-specific stakeholders
- important project decisions

### Level 3 — Role-stable

Characteristics:
- recurs across multiple projects or tasks within a role
- helps interpret future tasks in that role
- not yet universal to the user's whole identity

Examples:
- role-specific vocabulary
- recurring stakeholder context in a role
- shared patterns across projects under a role
- role-specific ways of working

### Level 4 — Identity-stable

Characteristics:
- shapes understanding of the user broadly
- unlikely to change quickly
- should persist over long periods
- relevant across many contexts

Examples:
- major roles
- core professional identity
- durable responsibilities
- enduring working preferences

### Why this ladder matters

This model provides a way to think about **promotion** without immediately forcing everything into either:
- permanent memory
or
- ephemeral memory

It creates a more nuanced understanding of how memory can mature.

---

## Roles appear to be the key promotion boundary

This may be one of the most important reflections in this document.

Because the user's roles are stable, roles provide a natural intermediate layer for deciding what gets promoted.

Instead of asking only:
- should this remain in the project?
- or should this become permanent memory about the user?

it becomes possible to ask:
- is this only local to this project?
- or is it actually characteristic of the whole role-context?

This is powerful because it prevents two opposite mistakes:

### Mistake 1 — Promoting too much directly into personal memory
If everything useful gets promoted straight into memory about the user, that layer becomes noisy, generic, and confused.

### Mistake 2 — Trapping reusable context inside one project forever
If everything remains local to the project where it first appeared, the system never develops reusable role intelligence.

Role memory helps avoid both mistakes.

---

## Examples using the user's context

These examples are illustrative and should not yet be treated as final classifications.

### Likely long-term / identity-stable
- the user's name
- the user's major stable roles
- that family/home/property forms a recurring context
- that AI workflows and agent systems are a major recurring domain
- that academic / team-coaching identity is a major enduring role
- durable preferences about how assistance should work

### Likely role-stable
- role-specific educational vocabulary
- recurring institutional/stakeholder context for academic work
- recurring concepts for the AI-builder / agent-systems role
- recurring property/home vocabulary and decision context for family/home-related work

### Likely project-stable
- Pi Web UI history, active threads, and relevant artifacts
- a specific dissertation or research strand
- a specific property purchase process
- a specific content system initiative
- a specific educational delivery project

### Likely short-horizon
- things expected in the next two weeks to month
- focus themes for the current period
- projects the user wants to keep warm
- likely upcoming engagements not yet fully active

### Likely history-only unless promoted
- specific command sequences
- minor exploratory browsing paths
- dead-end task investigations
- incidental detail that never shaped future work

---

## Quality criteria for deciding what belongs where

A useful reflection is to ask not just "is this true?" but also "at what level does this truth belong?"

### Long-term about the user if it:
- recurs across many contexts
- is unlikely to change quickly
- materially helps interpret future tasks
- reflects who the user is, how they work, or what roles they occupy

### Role-level if it:
- recurs across multiple projects or tasks within a stable role
- helps the system interpret future work in that role
- is broader than one project but not universal to the whole person

### Project-level if it:
- matters repeatedly within one project
- is important for continuity there
- does not yet clearly generalise beyond that project

### Short-horizon if it:
- is likely to matter soon
- helps with readiness in the next days or weeks
- may stop mattering without reinforcement
- is better understood as active focus than durable memory

### History-only if it:
- happened
- may be useful for traceability or later recovery
- does not deserve to shape normal future task startup by default

---

## Emotional and operational design principle

A good memory should feel:
- **stable where the user's life is stable**
- **flexible where the user's work is fluid**
- **fresh where priorities are moving**
- **quiet where detail does not deserve active space**

This is an important design quality.

An effective memory should not feel like:
- a giant archive of random facts
- a log dump
- a noisy collection of everything that happened

It should feel more like:
- an understanding of the durable structure of the user's life and work
- with changing projects and emerging priorities placed inside that structure

---

## Architecture-level intuition preserved from this reflection

Although this file is not yet an implementation plan, it strongly supports the broader memory structure reflected elsewhere.

This reflection points toward a memory architecture where:
- personal/identity memory is the slowest-changing layer
- role memory is a long-lived and highly important middle layer
- project memory is dynamic and specific
- short-horizon memory keeps the system ready for what matters soon
- raw/history memory remains available but mostly backgrounded

This aligns well with the broader memory-intent idea that the Agent OS memory should be layered, not flat.

---

## Concise current conclusion

The strongest current conclusion is:

> **Projects change, roles change slowly, identity changes slowest — so memory should be structured around those different rates of change.**

A good Agent OS memory should therefore:
- store the most durable facts about the user in long-term personal memory
- treat major roles as long-lived memory objects
- keep project knowledge specific and dynamic
- maintain a short-horizon layer for the next 2–4 weeks of likely work
- keep raw history available without promoting it into active memory by default

This distinction should be preserved when future planning begins.
