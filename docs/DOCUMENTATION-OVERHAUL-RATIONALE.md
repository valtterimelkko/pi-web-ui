# Documentation information-architecture overhaul: rationale

```text
Status: completed
Class: plan/history (not current behavior)
Canonical current doc: docs/DOCS-GOVERNANCE.md
Implemented by: the documentation information-architecture overhaul branch
Last verified: 2026-07-21
```

This is a history/rationale record, not a contract. For the live rules that govern documentation, see [`DOCS-GOVERNANCE.md`](./DOCS-GOVERNANCE.md).

## Decision

Preserve the existing detailed subsystem documentation and add a task-oriented layer above it.

## Problem

Pi Web UI's documentation depth grew with the codebase, but the reader experience did not scale at the same rate. Important facts were accurate yet distributed across:

- the root README and docs hub;
- long canonical subsystem documents;
- API contract and orchestration material;
- recent-change summaries;
- implementation plans and validation reports;
- commit history.

This created four practical problems:

1. adopters had no single narrow golden path to first success;
2. Internal API consumers had a strong reference but no compact primary loop or recipe set;
3. troubleshooting agents had evidence tools but lacked a symptom-first entry point;
4. newer features such as terminal self-notification, Files editing, goal extension UI lifecycle, and durability boundaries were easier to understand from commits than from the public docs path.

## Approach

The overhaul introduces four kinds of document:

- **quickstarts** for the minimum safe happy path;
- **recipes** for common operational patterns;
- **decision trees and matrices** for troubleshooting, ownership, and persistence;
- **governance rules** to prevent future documentation drift.

Canonical subsystem documents remain the source for exact behavior. The new layer routes readers into them with enough context to choose correctly.

## Audiences served

### New adopters

A first-run guide reduces the initial decision surface to Linux plus one runtime, then points outward to deployment and multi-runtime material.

### Local API consumers and orchestrating agents

A compact socket-to-result loop and recipes expose the durable run/evidence model without requiring the reader to consume the entire API manual first.

### Operators and troubleshooting agents

A symptom map translates user reports into the evidence ladder: alias resolution, evidence bundle, screen transcript, receipts, scoped diagnostics, runtime files, and only then broad logs.

### Notification and terminal-harness users

A dedicated self-notification guide makes `scripts/notify.sh` a supported, discoverable workflow and separates it from automatic session opt-in.

### Maintainers

Feature ownership, durability, companion boundaries, and documentation-impact rules make future changes easier to document consistently.

## Preservation principle

No deep canonical document was removed. Architecture, contracts, runtime caveats, security, deployment, validation evidence, and historical plans remain available. This avoids losing implementation knowledge while improving the first path through it.

## Future follow-up

The next high-value improvements are mechanical rather than another prose expansion. An internal-link check now ships in this change (`npm run docs:check-links`); the remaining mechanical work is:

- route/schema-to-reference checks for the Internal API;
- environment-variable documentation checks;
- status metadata for completed or superseded plans;
- tested runtime/CLI version matrices;
- screenshots or a compact first-run UI walkthrough;
- generated or reusable Internal API client schemas.

This document records the rationale so future maintainers do not collapse the task-oriented layer back into one monolithic manual or duplicate canonical contract material across quickstarts.