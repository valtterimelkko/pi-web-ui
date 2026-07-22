# Documentation governance

Pi Web UI has substantial implementation, operations, validation, and historical documentation. This page defines how to keep it useful as the product surface grows.

## Source-of-truth hierarchy

When sources disagree, verify behavior in this order:

1. request/response schemas, shared protocol types, and route validation;
2. capability and contract metadata emitted by the running server;
3. canonical subsystem documentation;
4. operator runbooks and task-oriented guides;
5. `RECENT-CHANGES.md`;
6. completed plans, validation reports, and historical design documents.

Code is not automatically a good user contract, but an old plan must never override the shipped schema or current canonical docs.

## Document classes

- **Landing/chooser** — tells a reader where to go; short and audience-specific.
- **Quickstart** — one safe happy path with copyable steps.
- **Recipe** — task-oriented operational pattern.
- **Canonical subsystem doc** — architecture, semantics, caveats, ownership.
- **Reference/contract** — exact fields, endpoints, errors, versions.
- **Troubleshooting runbook** — symptom/evidence/action ordering.
- **Plan/history** — design and implementation evidence, not current behavior.

Do not make one file serve all classes when it becomes difficult to scan.

## Documentation impact checklist

Every feature or behavior-changing PR should explicitly review:

- [ ] root README/public positioning
- [ ] docs hub and adopter path
- [ ] canonical subsystem document
- [ ] Internal API reference/contract and version metadata
- [ ] troubleshooting symptom map/evidence ladder
- [ ] deployment, security, and `.env.example`
- [ ] agent/maintainer routing
- [ ] feature ownership or companion boundary
- [ ] durability/restart behavior
- [ ] recent changes
- [ ] no documentation change required, with rationale

## Required feature facts

For each meaningful feature, document:

1. intended audience;
2. owner: core, runtime, or companion;
3. supported runtime/backend scope;
4. entry point and minimal example;
5. authentication/trust boundary;
6. persistence owner and restart behavior;
7. limits and failure semantics;
8. troubleshooting evidence;
9. canonical source paths;
10. compatibility/version gate when applicable.

## Plans and historical reports

A completed plan should either move under a historical namespace or begin with a visible status block:

```text
Status: completed / superseded / abandoned
Canonical current doc: <path>
Implemented by: <commit or PR>
Last verified: <date or release>
```

Readers should never need to infer whether a plan is still prospective.

## Avoid duplication

- Keep `AGENTS.md` and `CLAUDE.md` concise and byte-identical.
- Link to canonical docs instead of reproducing endpoint or runtime details.
- Put fast task paths in quickstarts/recipes.
- Put exact compatibility statements in contract/reference docs.
- Use `RECENT-CHANGES.md` as a rolling delta guide, not a second canonical manual.

## Suggested automation

Documentation checks should cover:

- internal Markdown links — implemented: `npm run docs:check-links`;
- `AGENTS.md`/`CLAUDE.md` synchronization — implemented: `npm run docs:check-agent-guides`;
- documented environment variables versus `.env.example`/config schema;
- Internal API route/schema versus reference/contract mirrors;
- stale plan status markers;
- references to removed files or retired patches.

## Review standard

A documentation PR is complete when a new adopter can reach first success, a local API consumer can execute the primary loop, and a troubleshooting agent can identify the first evidence source without reading commit history.