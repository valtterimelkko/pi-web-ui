# Agent OS Intent

_Last updated: 2026-04-23_

## Purpose of this document

This document records the current **intent**, **conceptual direction**, and **influences** behind the planned Agent OS.

Related file:
- `./MEMORY-INTENT.md` — dedicated reflection on what the Agent OS memory is for and how it may be structured

It is written so that a future agent with **no prior chat context** can quickly understand:
- what the Agent OS is trying to become
- what problem it is primarily trying to solve
- which ideas have influenced the direction so far
- which ideas have already been explicitly de-emphasised or rejected for v1
- which local files, repositories, and concepts should be consulted next

This is **not** an implementation plan and **not** a concrete proposal. It is a careful snapshot of the emerging product/system intent.

---

## Core intent

The Agent OS is intended to become a **task-based operating layer for AI work** built around the user's real projects, real roles, real ongoing work, and real professional context.

The goal is **not** to create just another chat interface or a generic multi-agent dashboard.

The goal is to create a system where the user can increasingly work in a way such as:
- "let's continue project A"
- "work on thread X in project A"
- "build on top of the things we already did earlier"
- "do this in the context of my role Y"
- "use the right vocabulary for this audience/person/context"

without having to repeatedly re-brief the system from scratch.

The Agent OS should therefore make work feel more like **continuous collaboration** and less like repeatedly opening a cold session and reloading context manually.

---

## The main problem it is trying to solve

The biggest bottleneck identified so far is **lack of trusted continuity**.

Current pain point:
- starting a fresh session often requires extensive contextualisation
- the user must write long prompts
- the user must name the right files manually
- the user must ask the agent to read many files manually
- the user must repeatedly explain who they are, what project this is, what has already been done, and what context matters now

This means the system is already powerful in composition, but it does **not yet feel like a true Agent OS** because it does not yet reliably remember enough to support natural task-based continuation.

### Current bottleneck statement

The most important missing capability is an **effective memory** that lets the system know, with sufficient reliability:
- who the user is professionally
- what roles the user occupies
- which projects are active
- what has already been done on those projects
- what vocabulary matters in different project/role/person contexts
- what should carry forward between sessions without being re-explained

---

## Current conceptual direction

### 1. Task-based, not terminal-based

The Agent OS direction is task-oriented.

It should increasingly organise work around:
- tasks
- goals
- projects
- roles
- ongoing threads of work

rather than around:
- raw terminal sessions
- low-level runtime mechanics
- generic agent processes as the primary user-facing abstraction

### 2. Memory-first continuity is more important than a flashy dashboard

A dashboard or command-centre may matter, and a kanban-like visual surface is appealing, but the deeper requirement is **memory-backed continuity**.

Without strong memory, the UI would still require too much re-contextualisation.

### 3. More "memory" than "wiki" in v1

A major insight from reflection so far:
- a wiki-like knowledge layer may be useful later
- but v1 most urgently needs **effective memory**, not a full knowledge wiki

The first memory goal is practical continuity, such as:
- remembering professional identity
- remembering project state
- remembering prior work threads
- remembering role/person-specific vocabulary
- reducing startup friction when beginning a new task

A wiki may later become useful as an additional layer for:
- browseable knowledge
- terminology
- role-specific vocabulary
- person/context-specific understanding
- longer-term compounding knowledge

But wiki richness should not displace the immediate need for **trusted recall and continuation**.

### 4. Built on top of an existing OS-like substrate, not Claude Code

The Agent OS is **not** intended to be built on top of Claude Code as the harness.

Instead, current thinking is that **Pi Web UI plus the surrounding Pi extension ecosystem** may act as the backend substrate.

This matters because Pi Web UI already provides an OS-like composition:
- multiple runtimes
- unified sessions
- common event language
- persistent session handling
- real-time streaming
- backend abstraction over different runtimes

So the Agent OS should likely evolve from the existing Pi-based stack rather than imitate Claude Code-centric architectures literally.

### 5. Structured capabilities may matter more than one generic agent

There is active interest in organising the system around:
- categories of tasks
- domains of work
- structured capabilities/skills
- project/role-aware workflows

rather than only relying on one generic agent with every skill attached.

This direction is still exploratory, but it has already influenced the conceptual framing.

---

## What the Agent OS should eventually make possible

The intended experience is that the user can work more naturally by referring to:
- a project
- a type of work
- a prior thread
- a role
- a stakeholder/person/context

and the system can infer enough relevant context to start productively.

Examples of the type of continuity desired:
- continuing a known project without re-explaining its history
- building on prior outputs Y and Z when asked to do X
- knowing the user's professional identity well enough to adopt appropriate context
- knowing enough role/person-specific vocabulary that the user does not need to repeatedly define terms
- allowing context to be collected once and then carried forward autonomously as much as possible

---

## What has already been explicitly observed or decided conceptually

These are not final implementation decisions, but they are meaningful directional conclusions from reflection so far.

### A. The current system is already OS-like in composition

The current stack already contains many OS-like layers:
- runtime/backend layer
- orchestration/delegation layer
- planning layer
- memory layer
- native tools/web tools layer
- session/UI layer

This means the Agent OS idea is not starting from zero; it is emerging from an already OS-like composition.

### B. Weak memory is the main blocker to becoming a true task-based Agent OS

The biggest blocker identified so far is not primarily:
- lack of orchestration
- lack of integrations
- lack of UI

It is the lack of **effective, trustworthy, persistent memory** that reduces re-briefing and preserves continuity.

### C. Trusted continuity is the threshold

A key threshold for success is whether the user can trust the system to remember enough that new work feels continuous rather than cold-started.

### D. The professional context should not rely only on manual documentation

The user has attempted to document professional context manually, but maintaining that by hand is time-consuming and difficult.

This has already influenced thinking in an important way:
- the system should help **collect, stabilise, and reuse** professional context over time
- rather than depending mainly on the user to write and maintain one large master context file manually

### E. AAMS has strong ideas, but currently appears too complex for Agent OS v1

AAMS has materially influenced the thinking and is seen as a strong source of ideas, especially around memory quality and continuity.

However, current reflection is that:
- AAMS contains many valuable ideas
- but it likely exceeds what is needed for v1 of the Agent OS
- therefore v1 should probably focus on **effective memory first**, not the full wiki-like architecture

This is an important directional conclusion.

---

## Key influences and signposts

The following items directly shaped the current intent.

### 1. YouTube inspiration videos

#### Video 1
- URL: https://youtu.be/pfPi04pIfaw?si=Xt-HnuGb6N6GVeJP
- Influence on intent:
  - highlighted the importance of **memory**
  - highlighted **skills** as reusable, structured capability
  - suggested thinking in terms of **domains/functions/categories of work**
  - reinforced the idea of a **dashboard/command-centre** as an access layer
  - also served as a contrast: the Agent OS should **not** simply be a Claude Code-based clone

#### Video 2
- URL: https://youtu.be/uhMCy25NBfw?si=6AAUiRKVUUR3R478
- Influence on intent:
  - strengthened the idea that the system should be **task-oriented**
  - strengthened interest in a **kanban-like/dashboard** interaction model
  - reinforced the idea of managing **goals/tasks instead of terminals/sessions**
  - highlighted the value of a command-centre layer while also clarifying that backend/runtime abstraction matters

### 2. Pi Web UI as backend substrate

#### Primary documents consulted
- `/root/pi-web-ui/README.md`
- `/root/pi-web-ui/docs/ARCHITECTURE.md`

#### Influence on intent
These documents established that Pi Web UI already functions as a runtime abstraction layer with:
- Pi SDK
- Claude Direct
- OpenCode Direct
- a unified session registry
- a common event language
- runtime-specific complexity kept on the backend

This strongly influenced the idea that the Agent OS could use the **Pi Web UI backend as its runtime substrate**, rather than replacing or duplicating that backend logic and rather than depending on Claude Code as the main harness.

### 3. Current Pi extension ecosystem

#### Extension directory consulted
- `/root/.pi/agent/extensions`

#### Extensions seen as relevant to Agent OS direction
- `/root/.pi/agent/extensions/memory`
- `/root/.pi/agent/extensions/enhanced-plan-mode`
- `/root/.pi/agent/extensions/subagent`
- `/root/.pi/agent/extensions/subagent-evaluator`
- `/root/.pi/agent/extensions/parallel-orchestrator`
- `/root/.pi/agent/extensions/web-tools`
- `/root/.pi/agent/extensions/agent-discovery`
- `/root/.pi/agent/extensions/cli-anything`

#### Influence on intent
These extensions reinforced the understanding that the current stack already contains:
- planning
- orchestration
- delegation
- memory
- web access
- capability discovery

This contributed to the conclusion that the current system is already **OS-like in composition**.

### 4. Current memory system and its weaknesses

#### Memory code consulted
- `/root/.pi/agent/extensions/memory/index.ts`
- `/root/.pi/agent/extensions/memory/extractor.ts`
- `/root/.pi/agent/extensions/memory/storage.ts`

#### Current memory outputs inspected
- `/root/.pi/agent/memory/`
- `/root/.pi/agent/session-memory/`
- examples included:
  - `/root/.pi/agent/memory/pi-web-ui/MEMORY.md`
  - `/root/.pi/agent/memory/pi-enhancement/MEMORY.md`
  - `/root/.pi/agent/memory/root/MEMORY.md`

#### Influence on intent
Inspection of the current memory system produced a key conclusion:
- the mechanics work
- but the quality is uneven
- useful memories do exist
- however, the system also produces junk, fragmentation, mixed contexts, and excessive activity logging

This strongly influenced the conclusion that **memory quality and trust** are the main blockers to task-based continuity.

### 5. AAMS as a strong but too-rich v1 influence

#### Architecture consulted
- `/root/pi-enhancement/aams/ARCHITECTURE.md`

#### Influence on intent
AAMS influenced the direction significantly by contributing ideas such as:
- better memory structure
- raw vs compiled separation
- Obsidian compatibility
- more deliberate retrieval and consolidation thinking
- stronger continuity models

But it also directly influenced a caution:
- it currently appears too complex/rich for v1 of the Agent OS
- it feels closer to a sophisticated memory/wiki system than the minimal effective memory needed first

Current reflection therefore treats AAMS as:
- a strong conceptual source
- a valuable longer-term memory direction
- but not the immediate shape of v1 memory for the Agent OS

### 6. Professional identity / role context document

#### Document consulted
- `/root/postpilot/knowledge/professional-context.md`

#### Influence on intent
This file highlighted both:
- the richness of the user's professional context
- and the difficulty of maintaining such a context manually in document form

It directly influenced the understanding that:
- the Agent OS must eventually know a lot about the user professionally
- the memory should help accumulate and stabilise that context over time
- the system should not rely only on large manually maintained context files
- a future trustworthy system could collect this context conversationally and carry it forward autonomously

---

## Clarified distinction: memory vs wiki

A major conceptual clarification from this reflection:

For the fuller memory-specific reflection, see:
- `./MEMORY-INTENT.md`


### Effective memory (needed early)
Should primarily help with:
- continuity
- recall of relevant project/work context
- reduced re-briefing
- project/role/person-aware task startup
- remembered prior work and current direction

### Wiki layer (potentially useful later)
May help with:
- browseable long-term knowledge
- terminology
- structured professional context
- role-specific language and conceptual organisation
- cross-linking and human inspection

The current direction is that **effective memory should come first**.

---

## Why this document exists

If work stops here and another agent continues later, that future agent should understand:
- the Agent OS idea is emerging from an already OS-like Pi-based stack
- the main bottleneck is trusted memory-backed continuity
- the aim is to reduce repeated contextualisation and make project-based continuation natural
- Pi Web UI is currently seen as a likely backend substrate
- AAMS is influential but too complex for v1
- v1 should likely prioritise practical memory over a full wiki architecture
- the user's professional identity/context is central to the system's usefulness

This document should be treated as a **continuity anchor** for future reflection and design work.

---

## Related local signposts for future exploration

- Pi Web UI overview: `/root/pi-web-ui/README.md`
- Pi Web UI architecture: `/root/pi-web-ui/docs/ARCHITECTURE.md`
- Current memory extension: `/root/.pi/agent/extensions/memory/`
- Current extensions ecosystem: `/root/.pi/agent/extensions/`
- AAMS architecture: `/root/pi-enhancement/aams/ARCHITECTURE.md`
- Professional context draft: `/root/postpilot/knowledge/professional-context.md`

---

## Status at time of writing

The Agent OS is currently in an early reflection/design phase.

At this point:
- no concrete implementation proposal has been locked
- no final memory design has been chosen
- no final UI/dashboard design has been chosen
- no final task/category/agent model has been chosen

But the intent is now much clearer:
- build toward a task-based Agent OS
- grounded in persistent continuity
- with effective memory as the most important missing layer
- using the existing Pi-based stack as the likely foundation
