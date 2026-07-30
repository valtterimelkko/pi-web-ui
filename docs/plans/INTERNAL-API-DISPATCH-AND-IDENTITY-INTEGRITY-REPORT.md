# Internal API dispatch and identity integrity — implementation report

**Plan:** [`INTERNAL-API-DISPATCH-AND-IDENTITY-INTEGRITY-PLAN.md`](./INTERNAL-API-DISPATCH-AND-IDENTITY-INTEGRITY-PLAN.md)
**Execution date:** 2026-07-29
**Primary baseline:** `fa2fce7` (`master`)
**Companion repo:** `/root/agent-os` (`main`)
**Result:** implemented and validated against disposable servers only; production was not accessed.

## 1. Measured baseline

The repository had advanced beyond the plan's older `1b41f19` baseline. Review of the intervening work did not invalidate any task.

| Gate | Measured baseline |
|---|---:|
| Agent guides | byte-identical, exit 0 |
| Typecheck | exit 0 |
| Lint | 0 errors, 1,226 warnings |
| Tests | server 2,634 + client 862 = 3,496 passed |
| Build | main client JavaScript 214.99 kB gzip |

## 2. Implementation summary

### Phase 1 — truthful dispatch, receipts, and watchdogs

- Idle Pi `follow_up` is promoted to a normal `prompt`; strict idle follow-up and idle `steer` reject with `SESSION_NOT_STREAMING`.
- Busy Pi follow-up uses the native queue and remains `queued` until the SDK queue reports removal of its exact FIFO occurrence and the corresponding user `message_start` arrives; only that delivered turn's later `agent_end` terminalises its receipt. Duplicate text and foreign same-text events are fenced.
- Busy non-Pi follow-up rejects before reservation with `409 SESSION_BUSY` and `Retry-After`.
- Per-session monotonic direct-dispatch claims close check/reservation races.
- Run receipts record requested `mode` and actual `dispatchMode`, support queued recovery, and have terminal waiters.
- Idle and absolute watchdogs produce `TURN_STALLED`, release admission capacity idempotently, and attempt runtime abort.
- Capacity reports active, queued, and stalled state.
- Claude question responses resolve only known, session-bound `requestId`/`toolCallId` aliases. Unknown or cross-session identifiers return 404 rather than false success.

### Phase 2 — observability and capability truth

- Claude SDK keeps bounded, session-scoped pending-question snapshots.
- `/approvals/pending` returns actual pending requests with both identifiers.
- Approval success includes `sessionId`, `requestId`, `toolCallId`, `kind`, and `resolved:true`.
- Evidence bundles include question-open/close control events and close reasons.
- Pi `/wait` consults non-terminal receipts instead of trusting an idle registry snapshot.
- Capabilities describe runtime-specific follow-up, steer-while-busy, and structured-question semantics.

### Phase 3 — Pi identity integrity

- Caller-supplied missing paths require explicit `allowCreate:true`; rehydration always passes `false`.
- Existing files are validated before `SessionManager.open()`: filename id, header id, and SDK manager id must agree.
- Browser session switching performs the same file preflight even when the session is still resident in memory.
- Missing files surface `SESSION_NOT_FOUND`; mismatches surface `SESSION_IDENTITY_MISMATCH`; the client removes stale missing-session entries.
- Validation occurs before SDK construction or browser subscription mutation, preserving the no-write invariant.

### Phase 4 — discoverability, scenarios, and docs

- `debug:where` has an exact, bounded Pi filename fallback when the registry misses.
- The existing Pi file watcher incrementally upserts registry entries on add/change; boot-time full rebuild remains disabled.
- Added/rewrote the six dispatch-integrity scenarios from the plan.
- Published contract `1.13.0` and updated Internal API, orchestration, troubleshooting, live-validation, environment, recent-changes, quickstart/recipe, long-horizon, and maintainer documentation.
- Annotated the historical Phase H diagnosis rather than rewriting it.

### Phase 5 — Agent OS companion

- Proven-terminal continuations now send `mode:"prompt"`.
- `QuestionRequestId` and `ToolCallId` are distinct branded types.
- Answer evidence tracks prepared, HTTP accepted, SDK resolved, assistant resumed, and terminal-turn states separately.
- `ownerAnswerDeliveredAt` is written only after a matching `resolved:true` response.
- Agent OS mirrors contract `1.13.0`, queued receipts, dispatch capabilities, pending approvals, and structured approval responses.

## 3. RED → GREEN evidence

| Task(s) | RED evidence | GREEN evidence |
|---|---|---|
| 1–5 | New prompt-mode suite: 13 failed/1 passed. Idle Pi work was lost, busy Claude returned 202, queued receipts were terminalised by a foreign `agent_end`, races overlapped, and stalled runs retained capacity. Approval suite: 4 expected failures for false-success/alias/session routing. Later reviewer-driven tests went RED for the real normalized `data.message` shape and for a foreign same-text event before SDK queue removal. | Initial focused/broad suites passed. Final correlation uses the SDK's normalized queue-removal sequence plus FIFO occurrence indexes; duplicate and foreign same-text tests pass, and a real busy Pi follow-up moved `queued` → `completed` live (`d2804c1c-0222-4465-8343-23d982c9bf48`). |
| 6–9 | 7 expected failures/92 passes: no pending snapshot/list route, no question evidence, Pi wait masked receipts, and capability fields were absent. Task 23 was already GREEN because Phase 1 necessarily persisted mode fields. | 99/99 focused tests; then 409/409 broad Internal API + Claude tests. |
| 10 | Identity tests 28/29 proved missing paths were recreated and mismatched headers were opened. Client stale-entry test failed. The first disposable browser-WebSocket deletion check timed out because an in-memory session bypassed rehydration validation. | Missing/mismatch/create unit tests pass; client test passes. Browser switch now preflights the file even for resident sessions. Disposable WS missing and mismatch checks returned the expected structured errors and unchanged/non-existent files. |
| 11 | `debug:where` exited 1 for an exact on-disk Pi id absent from registry; watcher made zero upserts. | Debug fallback and watcher focused suites pass; no directory-wide scan was introduced. |
| 12 | Scenario registry test showed five scenarios absent and idle promotion did not assert `dispatchMode`. | Scenario registry/behaviour tests pass; all six scenarios passed live or met their explicit strict rejection contract. |
| 14–16 | Agent OS continuation still emitted `follow_up`; question-delivery tests initially failed at module load because branded ids/evidence helpers did not exist. A later session-mismatch test also failed because a successful response was not bound back to the attempt session. | Distinct ids and stages are implemented; matching `resolved:true` now requires session + both identifiers, and ambiguous transport outcomes are recorded separately. Final Agent OS suite count is recorded in the exit table. |

Detailed command output was retained during execution in `/tmp/pi-web-ui-phase{1,2,3,4}-tdd.md` and `/tmp/agent-os-phase5-tdd.md`.

## 4. Disposable live validation

All servers used short `/tmp/pi-di*` roots, isolated `PI_AGENT_DIR`, imported only `GLM_CODING_PLAN_TOKEN`, and used capture notifications. No production socket, service, preferences, registry, or session data was touched.

### Required integrity scenarios

| Scenario | Runtime / profile | Result | Run id / evidence |
|---|---|---|---|
| `follow-up` | Pi, OpenAI GPT-5.5 | pass; idle request promoted and second turn completed | `3770d1ae-336a-4d22-897c-84cd8c845e16` (later sweep: `f0c0f0ab-243b-4b18-9b15-3488ad4d927a`) |
| `follow-up-strict` | Pi | pass; `409 SESSION_NOT_STREAMING` | rejection occurs before run reservation |
| `prompt-mode-busy` | Claude SDK, GLM profile | pass; `409 SESSION_BUSY`, receipt count unchanged | parent run `ccc22a9f-dadf-406d-b7d0-238ddb15362c` |
| `approval-wrong-id` | Claude SDK, GLM profile | pass; 404, pending request preserved, assistant resumed after valid answer | `6c51a188-5663-469b-a86e-c17bb8c27bdf` |
| `approval-by-toolcall-id` | Claude SDK, GLM profile | pass; `resolved:true`, assistant resumed | `5adf0103-f6dd-4546-b076-9b2aa8738188` |
| `stalled-run-reaped` | Pi, 2-second disposable watchdog | pass; `TURN_STALLED`, active turns returned to zero | `321ca514-672a-4754-bf52-f7522b546107` |
| Busy native follow-up correlation (additional) | Pi, OpenAI GPT-5.5 | pass; real SDK queue receipt moved `queued` → `completed` after its own queue removal/message/terminal sequence | `d2804c1c-0222-4465-8343-23d982c9bf48` |

### Browser-WebSocket identity checks

| Check | Result |
|---|---|
| Valid session switch + ordinary prompt | `OK agent_end` |
| Delete backing JSONL, then switch | `SESSION_NOT_FOUND`; file remained absent |
| Header/filename id mismatch, then switch | `SESSION_IDENTITY_MISMATCH`; SHA-256 unchanged (`d5f93833972ab2fcda546fccdeff92096d2bb2506adf3d60d2b68d17a6a9c5c7`) |

### Regression sweep

- Pi all-scenario sweep passed with `openai/gpt-5.5`; capability-inapplicable scenarios skipped with reasons. Earlier GLM sweeps exposed provider-output flakiness (terminal events with empty exact-text output); focused reruns passed, and the final OpenAI sweep was green.
- Claude all-scenario sweep passed on `profile:glm52-claude-sdk-native-profile`; heartbeat and short-timeout-only cases skipped with explicit capability/config reasons.
- OpenCode all-scenario sweep passed; runtime-inapplicable scenarios skipped with reasons.
- Antigravity remained unavailable by design in disposable mode.

Raw JSON verdicts are retained outside the repository under `/tmp/pi-dispatch-live-evidence/` for this execution session.

## 5. Exit gates

| Gate | Result | Comparison |
|---|---|---|
| Agent guides | pass; byte-identical | unchanged |
| Typecheck | pass | all workspaces |
| Lint | pass; 0 errors, 1,224 warnings | 2 below 1,226 baseline |
| Tests | pass; server 2,670 + client 863 = 3,533 | +37 over 3,496 baseline; exceeds +32 floor |
| Build | pass; main JS 215.07 kB gzip | +0.08 kB; below +1% ceiling |
| Agent OS | 416/416 tests after integrating current `origin/main` and the post-implementation 1.13 identity/evidence audit; typecheck/docs pass | green |
| Live validation | required scenarios and final runtime sweeps pass/skip-with-reason | disposable only |
| Diff integrity | `git diff --check` passed in both repos; staged-stat and secret/path review repeated immediately before commit | see commit record |

## 6. Post-implementation contract audit

A final consumer-side audit found and fixed stale current-version labels plus
Agent OS evidence-boundary gaps that the original implementation suite did not
cover. Agent OS now rejects health/capability contract drift, requires advertised
retention/admission features, validates prompt/session/run/runtime/execution
identity before persistence or lease release, preserves `mode`/`dispatchMode`
(including duplicate idempotent responses), treats request/tool identifiers as
distinct opaque values, handles follow-up admission refusal deterministically,
and mirrors an identity-bound receipt before exact-deadline timeout handling.
Regression coverage is in
`/root/agent-os/tests/conductor-contract-113-integrity.test.ts` and the existing
Step 7/7B suites.

## 7. Deferred or intentionally excluded

- **Production validation/deployment during implementation:** not performed before the original completion because the operator had not authorised production access. A later explicitly authorised deployment is recorded separately from the disposable scenario evidence.
- **Antigravity live execution:** skipped because validation mode disables it; the plan explicitly permits this skip.
- **Boot-time Pi directory rebuild:** intentionally not added. Discoverability is exact-fallback plus incremental watcher upsert, as specified.
- **Historical production incidents:** not repaired or modified; they remain evidence.
