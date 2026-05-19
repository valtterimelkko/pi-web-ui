# Agent OS Memory Implementation Patterns

_Last updated: 2026-05-19_

## Purpose of this document

This document records **implementation patterns worth borrowing** for the Agent OS memory without changing the core intent already established in:
- `./INTENT.md`
- `./MEMORY-INTENT.md`
- `./MEMORY-CONCEPT-v0.1.md`
- `./CONCEPTUAL-PATTERNS.md`

It exists to preserve a crucial distinction:
- the Agent OS needs a strong **memory ontology** of continuity
- but it may borrow useful **memory mechanics** from existing systems that solved adjacent implementation problems well

This file is therefore not a replacement for the memory concept.
It is a bridge between:
- the continuity-first design already defined
- and practical implementation patterns that may strengthen v1 memory quality

---

## Governing boundary

The strongest rule to preserve is:

> borrowed mechanics must not redefine the ontology of the Agent OS

In practice this means:
- the Agent OS should not become session-first
- the Agent OS should not become repository-first
- the Agent OS should not become capability-first
- the Agent OS should not inherit a coding-agent worldview as its primary memory shape

The core continuity ontology should remain:
- **user / identity**
- **roles**
- **projects**
- **threads**
- **horizon**
- **raw evidence / history**

Borrowed implementation patterns should sit **under** that structure, not replace it.

---

## Patterns worth borrowing

## 1. Deterministic raw capture

A strong pattern is to capture raw activity mechanically and reliably before interpretation.

Why it is useful:
- improves traceability
- reduces reliance on fragile importance heuristics at capture time
- creates a repairable evidence base for later consolidation

How it should map into Agent OS:
- raw hooks, events, tool traces, and outcome records should feed the **evidence layer**
- they should not automatically become active startup memory

---

## 2. Hybrid retrieval infrastructure

A strong retrieval pattern is to combine:
- lexical retrieval
- semantic/vector retrieval
- relationship/graph-aware retrieval

Why it is useful:
- improves recall quality across exact terms, paraphrases, and concept relationships
- reduces dependence on one retrieval mode only
- supports better warm starts with bounded context

How it should map into Agent OS:
- retrieval should first identify the right continuity container
- only then should it pull the best supporting evidence and summaries from the lower memory layers

This means retrieval should serve:
- identity context
- role context
- project context
- thread context
- horizon context

not bypass them.

---

## 3. Token-bounded context assembly

A strong pattern is to assemble startup context under an explicit size budget.

Why it is useful:
- prevents overloading startup prompts with raw history
- encourages relevance-first retrieval
- improves practical warm-start behaviour

How it should map into Agent OS:
- the startup context should be layered and selective
- broad continuity should appear first
- deeper evidence should be included only when necessary

A likely order remains:
1. identity
2. role
3. project
4. thread
5. horizon
6. evidence on demand

---

## 4. Consolidation from raw to compiled memory

A strong pattern is to periodically consolidate noisy traces into more useful memory forms.

Why it is useful:
- prevents active memory from becoming a log dump
- allows repeated observations to mature into more durable conclusions
- supports promotion by stability rather than by one-off salience

How it should map into Agent OS:
- raw evidence should remain available
- compiled memory should be promoted by durability level
- promotion should follow the Agent OS stability ladder:
  - horizon-stable
  - project-stable
  - role-stable
  - identity-stable

This is one of the most useful implementation patterns to borrow.

---

## 5. Replay, audit, and provenance

A strong pattern is to preserve inspectable provenance for what the system believes and why.

Why it is useful:
- supports trust
- supports correction
- supports memory repair
- helps distinguish evidence from conclusion

How it should map into Agent OS:
- every important compiled memory should ideally remain traceable to supporting evidence
- replay and audit should be treated as trust surfaces, not only debugging tools

---

## 6. Lightweight deduplication and supersession

A useful pattern is to detect near-duplicate memories and allow newer, better formulations to supersede older ones.

Why it is useful:
- reduces fragmentation
- keeps memory cleaner over time
- helps preserve the latest stable formulation without discarding evidence

How it should map into Agent OS:
- supersession should happen within the appropriate continuity container
- replacing a project-level formulation should not silently overwrite role-level or identity-level memory

---

## 7. Human-visible memory surfaces

A useful pattern is to keep memory visible through:
- exportable markdown
- inspectable summaries
- replay tools
- correction-friendly surfaces

Why it is useful:
- keeps the system legible
- lets the user verify and repair memory
- avoids black-box memory behaviour

How it should map into Agent OS:
- inspectability should remain part of the memory design from early versions
- even if the final UI is undecided

---

## Patterns that should not be adopted as-is

## 1. Session-first memory ontology

The Agent OS should not treat sessions as the main organising truth.

Sessions may be useful evidence objects.
They should not replace:
- roles
- projects
- threads
- horizon structures

---

## 2. Repository/project as the only meaningful context

The Agent OS must support more than coding-repo continuity.

It should work across:
- professional roles
- research contexts
- stakeholder-specific vocabulary
- family/home/property contexts
- other durable non-code domains

So project or repository memory alone is not enough.

---

## 3. Capability-first expansion

The Agent OS should not define itself mainly by a large menu of tools or memory operations.

Borrowed memory mechanics are useful.
But the system should still feel like:
- continuity-first
- context-governed
- task-oriented

rather than:
- feature-led
- tool-led
- memory-dashboard-led

---

## 4. Direct injection of raw activity into warm-start context

Raw logs are evidence, not default startup memory.

The Agent OS should continue to prefer:
- compressed continuity summaries
- handoff packets
- stabilised role/project/thread understanding

before raw traces.

---

## Mapping borrowed mechanics into Agent OS layers

A useful translation table is:

| Borrowed mechanic | Agent OS layer |
|---|---|
| hook/lifecycle capture | raw evidence layer |
| lexical/vector/graph retrieval | retrieval infrastructure |
| bounded context builder | warm-start assembly |
| consolidation / reflection passes | promotion by stability |
| replay / audit / provenance | trust and repair layer |
| deduplication / supersession | memory hygiene layer |

This table expresses the main design rule:
- useful mechanics may be borrowed freely
- the continuity model still governs how those mechanics are used

---

## Recommended implementation stance for v1

The strongest current stance is:

1. keep the Agent OS continuity model native
2. borrow memory mechanics selectively
3. place borrowed capture/search/consolidation underneath the continuity containers
4. treat role memory as a major promotion boundary
5. treat horizon as a first-class active layer, not an afterthought
6. preserve replay/audit surfaces so trust can grow over time

A concise summary is:

> build the Agent OS memory model around continuity containers, and let borrowed infrastructure improve evidence capture, retrieval quality, and trust without redefining what the memory is actually for
