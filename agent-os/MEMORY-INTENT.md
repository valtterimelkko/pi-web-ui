# Agent OS Memory Intent

_Last updated: 2026-04-24_

## Purpose of this document

This document records the current **intent**, **needs**, **design direction**, and **emerging structure** for the memory of the Agent OS.

It exists separately from `INTENT.md` so that memory thinking can deepen without overloading the main intent record.

This file is for a future agent or collaborator who needs to understand:
- what problem the Agent OS memory is trying to solve
- what kind of memory the user actually wants
- what kinds of memory matter most
- what sort of architecture currently seems promising
- what principles and patterns should likely be preserved in a future plan

This is **not** yet an implementation plan and **not** a locked architecture. It is a careful intent capture.

See also:
- `./INTENT.md` — broader Agent OS intent

---

## Core memory intent

The Agent OS memory is intended to create **trusted continuity** across sessions so the user does not need to repeatedly rebuild context from scratch.

The memory should allow the user to work more naturally by saying things like:
- "let's continue project A"
- "work on thing X in project A"
- "build on top of what we've already done"
- "do this in the context of role Y"
- "use the right understanding for this stakeholder/person/context"

and have the system already know enough to begin productively.

The memory is therefore not just about storing facts. It is about:
- continuity
- practical recall
- context carryover
- role/project separation
- near-future readiness
- trusted reuse of prior work

The key desired shift is from:
- cold session startup
- long contextualisation prompts
- repeated file naming and repeated explanation

toward:
- warm starts
- project-aware continuation
- role-aware understanding
- recall of prior work and likely next work

---

## What problem this memory is meant to solve

At present, even with a strong AI stack and OS-like composition, a lot of effort is still lost when starting work because the agent often does not already know enough relevant context.

Current pain includes:
- writing long prompts to re-establish context
- telling the system which files to read
- re-explaining what the project is about
- re-explaining what has already been done
- re-explaining what role/context the work belongs to
- re-explaining the user's identity, vocabulary, and priorities

This means the memory must not be evaluated mainly by how much it stores, but by whether it materially reduces re-contextualisation effort while preserving correctness.

---

## The memory should know the user as a whole person, but without collapsing everything together

The user wants the memory to remember more than only coding context or only work context.

An effective memory should remember at least the important outlines of:
- the user's name and professional identity
- main work and roles
- key interests and ongoing intellectual themes
- hobbies and wider domains of engagement
- family-linked responsibilities and practical non-work projects

Example of important non-work/family-linked context explicitly mentioned in reflection:
- engagement in purchasing a property in the UK on behalf of the family

This matters because the usefulness of the Agent OS depends on understanding the user's actual life/project landscape, not just one narrow work domain.

At the same time, the memory should **not** flatten these into one undifferentiated pool. It should remember the whole person while still distinguishing contexts well.

---

## The key requirement: distinguish without over-isolating

The memory should ideally:
- distinguish one project from another
- distinguish one role from another
- know what belongs where
- know which vocabulary and stakeholders belong to which context
- know which prior work belongs to the current task

But it should also retain some ability to:
- cross-reference related projects
- reuse relevant patterns across projects
- recognise when two projects under the same role share important context
- selectively surface useful analogies or prior work from nearby contexts

So the memory should neither be:
- a single undifferentiated memory blob
nor
- a set of completely sealed silos

It should preserve **boundaries with selective permeability**.

---

## Memory should be more "memory" than "wiki" in the beginning

A major insight from reflection so far is that the first need is not an elaborate knowledge wiki.

The first need is an **effective operating memory**.

This means the memory should first optimise for:
- trusted continuation
- fast startup
- knowing the user
- knowing the project
- knowing what has been done
- knowing what is likely to matter soon

A richer wiki-like layer may later become useful for:
- browseable terminology
- person/role/context vocabulary
- longer-term knowledge compounding
- human exploration of memory contents

But the first standard of success is more practical:

> can the system remember enough of the user, the role, the project, the prior work, and the upcoming work that starting a task feels continuous rather than cold?

---

## The memory should support conversational context collection over time

The user has already tried to document professional context manually, but maintaining large master context documents by hand is time-consuming and difficult.

This leads to an important memory intent:
- the system should help collect and stabilise context **through use and conversation over time**
- the memory should not depend primarily on one-off manual documentation efforts

The user is willing to explain context and train the system, especially early on, but only if that effort compounds and is remembered later in a trustworthy way.

The memory should therefore support the long-term experience of:
- explaining important context once or a few times
- having that context retained appropriately
- carrying it forward into future work autonomously as much as possible

---

## What the memory should remember

Below is the current best reflection on the main classes of memory the system should hold.

### 1. Core identity memory

This is the most stable layer.

It should remember things like:
- the user's name
- high-level professional identity
- main recurring roles
- durable preferences about work and style
- major domains of interest and engagement
- important non-work responsibilities that generate projects or tasks

This should be concise, high-trust, and relatively stable.

Its purpose is to answer:
- who is this user?
- what kinds of contexts are normal for them?
- what major identity cues should shape interpretation of a task?

### 2. Role memory

This seems likely to be one of the most valuable layers.

The memory should know the user's major roles, for example:
- academic / lecturer / team coach / module leader
- AI builder / agent systems designer / workflow experimenter
- researcher
- public/professional content creator
- family/property-related actor
- investor/trader, where relevant
- other recurring role-clusters that emerge over time

For each role, the memory should gradually know:
- what kinds of work belong there
- what kinds of projects sit under that role
- typical stakeholders
- domain-specific vocabulary
- the user's priorities and stance within that role
- shared context between projects in that role

Role memory is important because it can reduce both over-mixing and over-fragmentation.

### 3. Project memory

For each project, the memory should know at least:
- what the project is
- what it is for
- what role it belongs to
- what has already been done
- what key artifacts/outputs exist
- what important decisions or conclusions have already been reached
- who the key stakeholders are
- what kinds of tasks have already been undertaken
- what unfinished threads exist

This is the layer that should most directly support project-based continuation.

### 4. Fresh horizon memory

This is a distinct and very important layer.

The user described wanting the system to know what may be engaged with over roughly the next two weeks to month.

This is not just a task list. It is better understood as:
- current focus themes
- likely upcoming work
- expected project threads
- near-future priorities
- things the user wants the system to stay ready for

This might be refreshed through lightweight weekly capture, including dictated or audio-recorded updates.

This layer should help the system stay ready for what is likely to matter soon, so the user does not need to repeatedly load that context at the moment of starting.

### 5. Raw history / evidence memory

There should likely be a lower layer that preserves raw history or raw evidence of what happened.

This is not the layer that should be injected directly into normal work.

Its purpose is instead to:
- preserve traceability
- support later extraction/improvement
- allow memory repair when needed
- ground higher-level memory in actual prior work

This layer is important, but should remain subordinate to the more useful structured memory above it.

---

## Emerging structural intuition

One of the strongest structural intuitions from reflection so far is that memory may want to be organised roughly like:

- the user at the root
  - major roles
    - projects under each role
      - active threads / recent work / fresh horizon items

This is not confirmed architecture, but it is currently a very promising conceptual structure.

### Why this structure feels promising

It helps solve multiple needs at once:
- the memory can remember the user as a whole person
- projects do not become detached from the role-context that gives them meaning
- related projects can share context through their parent role
- cross-reference can be stronger within a role than across unrelated roles
- separation can be preserved without complete isolation

This feels more natural than either:
- one flat personal memory
or
- a purely project-only memory with no higher organising layer

---

## Imagined layered architecture (not yet a plan)

The following layered view currently seems valuable.

### Layer A — Stable personal memory
A small, high-trust layer that captures durable identity context.

Possible contents:
- who the user is
- main roles
- durable preferences
- major recurring interests and responsibilities

### Layer B — Role memory
A layer per major role that captures shared context across projects under that role.

Possible contents:
- role description
- common vocabulary
- recurring stakeholders
- role-specific priorities and constraints
- nearby projects
- reusable context and patterns

### Layer C — Project memory
A layer for each project that captures the working understanding of that project.

Possible contents:
- project summary
- what has been done
- key artifacts
- key stakeholders
- active threads
- major prior conclusions

### Layer D — Fresh horizon memory
A time-sensitive layer that captures what is likely to matter soon.

Possible contents:
- next 2–4 week themes
- likely upcoming engagements
- near-future project directions
- reminders of what the user expects to tackle soon

### Layer E — Raw history / evidence
A lower layer that preserves the evidence base behind memory.

Possible contents:
- captured session traces
- raw extracts
- activity history
- source material for later consolidation or repair

This layered architecture is not final, but it currently appears to fit the user's stated needs well.

---

## Valuable memory principles to preserve in a future plan

Even without naming previous architecture work explicitly, the following patterns feel especially worth preserving.

### 1. Separate raw capture from useful memory

The system should distinguish between:
- raw material about what happened
and
- useful memory that should shape future work

This is important because raw activity alone is noisy and often not suitable as direct working memory.

### 2. Use layered retrieval

Not all memory should be loaded all the time.

A good memory should support something like:
- stable user identity first
- then role context
- then project context
- then fresh horizon
- then deeper/raw retrieval only when needed

This reduces clutter and helps keep recall relevant.

### 3. Preserve boundaries and attribution

The memory must avoid mixing unrelated projects and roles.

This means future architecture should care strongly about:
- correct attribution
- boundary clarity
- low contamination
- recoverability when something is misfiled

### 4. Keep a human-readable and inspectable memory surface

The user should be able to understand what the memory contains.

This supports:
- trust
- correction
- learning how the system works
- identifying when memory is wrong or incomplete

### 5. Preserve a hot/active layer

A time-sensitive active memory is likely disproportionately valuable.

The system should know not only what the long-term project memory is, but also what is likely to matter soon.

### 6. Allow selective cross-reference

Cross-reference should exist, but not indiscriminately.

It should likely be:
- stronger within a role cluster
- more selective across unrelated roles

### 7. Prefer practical continuity over conceptual richness in v1

The first memory should help the user start work quickly and correctly.

Any richer knowledge organisation should remain secondary to this goal in the early versions.

---

## How the memory might look in practice

This is still reflection, not a proposal.

### Markdown feels promising

Markdown currently seems like a strong fit because it is:
- inspectable
- editable
- portable
- versionable
- easy for agents to read
- low lock-in

This matters because the user likely needs to be able to see the memory directly.

### Obsidian feels promising as a viewing surface

Obsidian seems valuable not necessarily because the memory should become a full wiki immediately, but because it provides:
- visibility into memory contents
- navigability
- trust through inspectability
- easy human inspection and correction

So an important current intuition is:
- the memory may be markdown-based
- and also Obsidian-readable

This would help the user understand how the memory works and what it currently believes.

---

## What success would feel like

An effective Agent OS memory would let the user increasingly work in a way where:
- the user names a project or context briefly
- the system already knows what that project is about
- the system already knows what has been done before
- the system already knows what role the project belongs to
- the system already knows nearby stakeholder/vocabulary context
- the system may already know what near-future work is expected there

The result should be a strong reduction in startup friction and repeated explanation.

The emotional threshold here matters:
- the user should begin to feel that the system actually remembers them and their work in a useful way
- not merely that it stores notes somewhere

---

## What should remain true as planning begins later

When this memory is later turned into a concrete plan, the plan should preserve the following intent:
- memory exists to create trusted continuity
- the user should not need to repeatedly re-brief the system
- the memory must know the user, the roles, the projects, and the near-future themes
- the memory should preserve separation without preventing useful cross-reference
- the memory should be practical first and rich second
- the memory should remain visible enough that the user can inspect and correct it

---

## Relationship to the broader Agent OS intent

This memory intent should be read alongside the broader Agent OS intent file.

See:
- `./INTENT.md`

The broader file explains:
- why the Agent OS exists
- why trusted continuity is central
- what other systems and references have influenced the thinking
- why memory is the key bottleneck

This file deepens only the memory side of that reflection.
