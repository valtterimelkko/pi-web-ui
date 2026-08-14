# Command Code GOAT-eligible fifth-runtime completion plan

> **Status:** implementation-ready plan; **execution is not authorised by this document and has not started**
>
> **Plan date:** 14 August 2026
>
> **Primary repository:** Pi Web UI (`/root/pi-web-ui`)
>
> **Agent OS boundary:** Agent OS implementation is explicitly out of scope for this plan. A separate Agent OS agent owns its code, contract, validator and policy changes. This plan may produce only an optional handoff document listing the reviewed catalogue; it must not modify Agent OS behaviour.
>
> **Installed runtime observed during planning:** Command Code `1.23.2`
>
> **Operator subscription:** Command Code **GOAT, USD 10/month** — not Go, Pro, Provider, Max, Team, or pay-as-you-go premium access
>
> **Current raw CLI catalogue:** 54 models from `cmd --no-auto-update --list-models`
>
> **Current official GOAT entitlement:** 35 models according to the official GOAT plan page checked on 14 August 2026
>
> **Target product catalogue:** the exact intersection of fresh CLI discovery and the reviewed GOAT-entitlement snapshot; at the planning baseline this is 35 models. Active per-model capability evidence is a blocking readiness requirement for making all 35 executable, not a filter that silently hides eligible models.
>
> **Pause rule:** when this plan is complete, stop. Do not implement, build for release, restart, deploy, or live-prompt a provider until the operator separately starts execution.

## 1. Purpose

Complete Command Code as a truthful, usable fifth runtime through both:

1. the authenticated browser frontend/WebSocket path; and
2. the authenticated Unix-socket Internal API path.

The result must:

- expose every model included in the operator's USD 10/month GOAT plan;
- exclude models requiring Pro, Max, pay-as-you-go premium credits, or another plan;
- preserve exact model identity and model-scoped native effort;
- create sessions from an allowed working directory without silently losing the selection;
- complete real provider-backed prompts through the installed Command Code runtime;
- retain the existing security boundaries except where the operator has explicitly superseded them;
- make browser, REST, WebSocket, Internal API, replay, and evidence projections agree within Pi Web UI;
- prevent a newly built frontend from silently running against stale loaded server code;
- replace fixture-only confidence with at least one bounded live observation against the real installed and authenticated Command Code runtime.

This is not merely a dropdown correction. It addresses entitlement, deployment coherence, working-directory policy, browser egress, execution policy, protocol, evidence, documentation, and validation as one release-quality slice.

## 2. Operator authority and superseded authority

### 2.1 Authority granted in this conversation

On 14 August 2026, after the conflicts were presented explicitly, the operator answered **“authorised as stated”**. That authority permits this plan to supersede the following earlier boundaries:

1. **Internal API model cohort:** replace the Qwen/Muse-only attested shadow execution cohort with all models in the reviewed GOAT catalogue; actively detect each model's capability rather than using capability uncertainty to hide it.
2. **Browser network boundary:** replace mandatory provider-blocking `--unshare-net` behaviour with a reviewed outbound-network design that allows the installed Command Code runtime to reach providers while preserving containment.
3. **Canonical documentation and contract:** replace claims that Command Code execution is limited to Qwen/Muse or that a network-isolated browser process is a provider-capable fifth runtime.

The operator then clarified that the subscription is specifically the **USD 10/month GOAT plan** and authorised excluding premium models not included in GOAT from the frontend and Internal API catalogues.

The operator subsequently narrowed the implementation boundary: Agent OS is explicitly excluded from this plan. Another agent will implement the Agent OS-side changes. This plan may provide that agent with a handoff-only catalogue document, but it must not change Agent OS code, types, validators, contract authority, routing policy or runtime behaviour.

### 2.2 Existing authoritative artefacts intentionally overridden

Implementation under this plan must update or clearly supersede the conflicting statements in:

- `docs/plans/COMMAND-CODE-INTERNAL-API-AND-STEP-7F-SHADOW-ADAPTATION-PLAN.md` — two-model shadow cohort;
- `docs/plans/COMMAND-CODE-FIFTH-RUNTIME-IMPLEMENTATION-PLAN.md` — mandatory `--unshare-net` browser boundary and narrow shadow policy;
- `docs/plans/COMMAND-CODE-FRONTEND-INTERNAL-API-ACTIVATION-PLAN.md` — provider-free validation and browser/Internal API narrowness;
- `docs/INTERNAL-API.md` — Qwen/Muse-only Internal API execution;
- `docs/INTERNAL-API-CONTRACT.md` — full visibility separated from pair-only execution;
- `docs/ARCHITECTURE.md` and `docs/RUNTIME-OVERVIEW.md` — provider-capable claims alongside an unshared network namespace;
- current implementation assertions in `command-code-model-catalog.ts`, `command-code-config.ts`, `command-code-service.ts`, and `internal-api/routes/sessions.ts` that enforce the two-model cohort.

Historical Agent OS memory remains historical evidence. This plan does not edit or approve compiled memory. Agent OS remains authoritative for its own implementation and policy; this plan does not override it. The operator's new authority applies to Pi Web UI only, while a separate Agent OS agent owns the consumer-side work. The shipped Pi Web UI repository after implementation becomes the current implementation authority for this scope.

### 2.3 Mandatory conflict rule

**Any conflict between this plan, a later operator instruction, repository policy, security policy, a locked decision, a canonical contract, an existing test, or observed runtime behaviour is a mandatory question.**

The executing agent must not silently:

- prefer an old artefact over the operator;
- prefer this plan over a newer operator instruction;
- weaken a security boundary to make a test pass;
- reinterpret an existing failing test as obsolete;
- mark a premium model eligible because it appears in `--list-models`;
- omit a blocking gate because it is inconvenient;
- report an external limitation as success.

When new authority is provided, add an **Authority amendment** subsection to the execution report, identify the overridden source and exact scope, re-adjudicate every blocked or approval-needed item, and state what was cleared.

### 2.4 Authority amendment A1 — scope, capability and validation budget

The operator resolved the pre-execution questions as follows:

- **Repository scope:** execute only in Pi Web UI. Do not implement or synchronise Agent OS code, types, validators, contract documents, routing policy or runtime behaviour. A separate Agent OS agent owns that work. An optional handoff-only catalogue note may be supplied to that agent, containing the reviewed 35 eligible IDs, 19 exclusions, sources, timestamp and drift rules; it is not an Agent OS implementation change.
- **Catalogue and capability:** all 35 GOAT-eligible models remain in the entitlement catalogue and are expected to be available. Active per-model capability detection must discover each model's exact native effort/thinking capability, including differing effort levels, defaults and non-adjustable models. Capability evidence is a readiness requirement, not a reason to silently hide healthy models. If a known GOAT-eligible model reports unknown capability during execution, stop and fix or investigate detection; do not satisfy the plan by rendering it `unavailable` and reducing the catalogue.
- **Real-runtime budget:** use at most two short included-GOAT validation turns, both on `deepseek/deepseek-v4-flash` unless a later execution question is raised. Verify automatic reload/top-up is disabled, invoke no excluded model, and stop immediately on any upgrade, credit or billing signal.

This amendment supersedes only the conflicting Pi Web UI scope/capability/budget wording; it does not authorise Agent OS implementation or production rollout.

## 3. Locked decisions

The following decisions are **LOCKED** for this implementation unless the operator explicitly amends them:

| ID | Locked decision |
|---|---|
| LD1 | The operator's plan is Command Code **GOAT at USD 10/month**. Never model it as Go, Pro, Max, Provider, premium top-up, or an assumed future upgrade. |
| LD2 | The product model catalogue is entitlement-aware. `cmd --list-models` is raw registry discovery, not proof of GOAT access. |
| LD3 | At the planning baseline, raw discovery is 54 models and GOAT eligibility is 35. The remaining 19 are excluded from selectable frontend and Internal API model catalogues. |
| LD4 | Closed-source does not mean premium-ineligible. GPT-5.6 Luna, Grok 4.5, Grok 4.6, Gemini 3.7 Flash, Muse Spark 1.2, and Muse Spark 1.2 Contributor are GOAT-eligible according to the official GOAT page and must not be excluded merely because of their lab or licence. |
| LD5 | Unknown/new/drifted model IDs fail closed for selection and execution until a reviewed GOAT-entitlement snapshot admits them. They may appear only in bounded diagnostics as unreviewed raw discovery. |
| LD6 | All 35 GOAT-eligible models must remain in the entitlement catalogue and must be available through both the browser path and the attested Internal API path after active per-model capability detection. Unknown capability is a blocking detection/readiness problem, not permission to silently hide a healthy model. |
| LD7 | Exact model IDs are server-validated. Aliases may be accepted only if canonicalised before persistence and evidence; no provider fallback may silently change identity. |
| LD8 | Native Command Code effort remains distinct from generic `thinkingLevel`. Send only freshly discovered supported effort values; automatic means omit `--effort`; never invent a default. |
| LD9 | Browser requests cannot choose executable paths, raw argv, environment, auth paths, native session IDs, permission profiles, `--yolo`, or arbitrary mounts. |
| LD10 | Internal API role/CWD attestations, server-owned permission profiles, private per-session homes, exact executable pinning, bounded subprocess output, prompt-injection checks, admission, receipts, and evidence remain required. Only the model cohort broadens. |
| LD11 | Browser and Internal API session visibility remain separate. Browser-contained records do not silently become Internal-API-addressable records. Internal API callers create their own attested Command Code sessions. |
| LD12 | Command Code remains excluded from MCP, Drive Mode, and the generic disposable `--runtime all` shortcut in this plan. Changing any of those requires a separate explicit operator decision. |
| LD13 | Narrow browser workspace roots remain mandatory. `/root` is not an acceptable convenience root. The UI must guide the user to an allowed path rather than broadening filesystem exposure. |
| LD14 | Browser Command Code stays in plan/read-only permission mode. Provider networking must not imply mutable workspace permissions. |
| LD15 | Provider-capable browser networking will use an isolated network namespace with bounded user-mode egress where physically viable; the preferred implementation is `slirp4netns --configure --disable-host-loopback` attached to the Bubblewrap network namespace. Falling back to host networking is a mandatory operator/security question, not an implicit workaround. |
| LD16 | No premium-ineligible model is invoked for entitlement testing. Official plan evidence and deterministic policy tests establish exclusion; live calls sample eligible models only. |
| LD17 | A provider-free fixture is necessary but insufficient. At least one blocking done-observation must use the real installed `cmd` binary, real authentication, real GOAT entitlement, and a real provider response. Real validation is limited to at most two short included-GOAT turns, with automatic reload/top-up disabled and no excluded model invoked. |
| LD18 | Production service restart, configuration change, or production validation requires fresh explicit approval at execution time. This plan does not grant it. |
| LD19 | Implementation uses strict TDD and records observed RED before GREEN for every behaviour change. Tests written after implementation do not satisfy this plan. |
| LD20 | Completed Pi Web UI-owned changes are committed and pushed on the current branch without creating a new branch, but only after all blocking gates pass and a separate execution has been authorised. Agent OS changes are not part of this commit or plan. |
| LD21 | Every GOAT-eligible model receives active, model-scoped capability evidence. The frontend and Pi Web UI Internal API expose each model's exact native effort levels, default/automatic semantics and non-adjustable state; generic fixed thinking levels are never substituted. |

## 4. Planning-time entitlement evidence

### 4.1 Sources checked

Planning used:

- installed CLI: `cmd --version` → `1.23.2`;
- installed CLI: `cmd --no-auto-update --list-models` → 54 model IDs;
- installed CLI: `cmd status` → authenticated Command Code account;
- official available-model documentation: <https://commandcode.ai/docs/reference/cli/models>;
- official GOAT plan documentation: <https://commandcode.ai/docs/plans/goat>;
- official Pro plan documentation: <https://commandcode.ai/docs/plans/pro>;
- official Max plan documentation: <https://commandcode.ai/docs/plans/max>;
- official pricing comparison: <https://commandcode.ai/pricing>;
- official pricing/limits reference: <https://commandcode.ai/docs/resources/pricing-limits>.

The official GOAT page states **35/54 models** at the planning date. The model registry can change; implementation must record source URL, retrieval time, hash, reviewed IDs, and drift rather than treating “35” as eternally true. The 35-model entitlement catalogue must not be silently reduced because capability detection is incomplete; incomplete capability evidence blocks readiness and triggers investigation.

### 4.2 GOAT-eligible baseline: 35 models

These are the 35 models that must be selectable and executable at the planning baseline once active capability readiness has passed:

```text
deepseek/deepseek-v4-pro
deepseek/deepseek-v4-flash
moonshotai/kimi-k3
moonshotai/kimi-k2.7-code
moonshotai/kimi-k2.7-code-highspeed
moonshotai/kimi-k2.6
moonshotai/kimi-k2.5
zai-org/glm-5.2
zai-org/glm-5.2-fast
zai-org/glm-5.1
zai-org/glm-5
minimaxai/minimax-m3
minimaxai/minimax-m2.7
minimaxai/minimax-m2.5
xiaomi/mimo-v2.5-pro
xiaomi/mimo-v2.5
qwen/qwen3.8-max
qwen/qwen3.7-max
qwen/qwen3.7-plus
qwen/qwen3.7-flash
qwen/qwen3.6-max-preview
qwen/qwen3.6-plus
stepfun/step-3.7-flash
stepfun/step-3.5-flash
tencent/hy3-paid
nvidia/nemotron-3-ultra-550b-a55b
thinkingmachines/inkling
thinkingmachines/inkling-small
poolside/laguna-s-2.1-free
gpt-5.6-luna
google/gemini-3.7-flash
meta/muse-spark-1.2
meta/muse-spark-1.2-contributor
xai/grok-4.5
xai/grok-4.6
```

### 4.3 Premium-ineligible baseline: 19 models

These are present in the raw 54-model CLI registry but must not be selectable or executable under GOAT:

```text
claude-sonnet-5
claude-sonnet-4-6
claude-fable-5
claude-opus-5
claude-opus-4-8
claude-opus-4-7
claude-haiku-4-5
gpt-5.6-sol
gpt-5.6-terra
gpt-5.5
gpt-5.4
gpt-5.3-codex
gpt-5.4-mini
google/gemini-3.6-flash
google/gemini-3.5-flash
google/gemini-3.5-flash-lite
google/gemini-3.1-flash-lite
sakana/fugu-ultra
meta/muse-spark-1.1
```

### 4.4 Entitlement classification rules

1. Store a reviewed, exact GOAT-entitlement snapshot in repository-owned public metadata; it contains IDs, plan `goat`, source URLs, checked timestamp, and source-content hash—never credentials or usage balances.
2. Keep raw CLI discovery, entitlement eligibility and capability readiness as separate domains.
3. Compute:

   ```text
   goatCatalogue = rawDiscovered ∩ reviewedGoatEligible
   excludedPremium = rawDiscovered ∩ reviewedNotGoat
   missingEligible = reviewedGoatEligible − rawDiscovered
   unreviewed = rawDiscovered − reviewedGoatEligible − reviewedNotGoat
   capabilityReadiness = every id in goatCatalogue has safe, non-unknown active capability evidence
   ```

4. `goatCatalogue` is the complete selectable entitlement catalogue. At the planning baseline it contains all 35 IDs; it must not shrink merely because capability evidence is incomplete.
5. `capabilityReadiness` is a blocking readiness condition for execution. When false, diagnose/fix detection and report the runtime as not ready; do not replace healthy GOAT entries with a mass `unavailable` projection to make the UI appear safe.
6. `excludedPremium`, `missingEligible`, and `unreviewed` are diagnostics, not selectable model entries.
7. If the official GOAT page and installed CLI disagree, preserve bounded evidence, keep uncertain IDs excluded, and ask the operator before revising the reviewed snapshot.
8. Do not scrape plan pages on every server startup. Use a deterministic refresh/audit command with reviewable output and explicit update workflow.
9. Do not send test prompts to determine premium eligibility; that could consume top-up credits or trigger upgrade/payment paths.

## 5. Current defects this plan resolves

| Defect | Current evidence | Required outcome |
|---|---|---|
| Stale server process | running process predates later server build/fix; frontend assets can update independently | immutable build identity and mismatch detection; release restart loads matching server/client |
| Selection appears not to persist | failed creation leaves no active session; effect resets non-runnable model | valid selection persists; rejected create stays visible and actionable |
| Model rejected after selection | running backend retained pair-only browser execution | every GOAT-catalogue model passes browser policy |
| CWD rejected | UI used `/root`; browser root was `/root/pi-web-ui` | preflight/allowed-path UX and stable `COMMANDCODE_CWD_REFUSED` |
| Browser prompt cannot reach provider | Bubblewrap includes `--unshare-net`; fixture is local | isolated bounded egress and real provider turn |
| Internal API pair restriction | route/service/config/attestation hard-code Qwen/Muse | every GOAT-catalogue model can create/prompt via attested Internal API |
| Raw catalogue conflates availability and entitlement | 54 global IDs were treated as target product catalogue | 35-model GOAT catalogue with 19 excluded at baseline and capability readiness tracked separately |
| Fixture overclaims | provider-free fixture passes without provider networking | fixture verdict labelled correctly; real-runtime gate mandatory |
| Protocol/docs drift | protocol omits Command Code fields; overview has contradictions | canonical docs and shared schema match shipped behaviour |
| Generic create error | browser catches all create failures as `COMMANDCODE_CREATE_FAILED` | stable model/entitlement/cwd/network/auth/capacity codes and useful UI |

## 6. Non-negotiables converted into quality gates

### 6.1 Operator-defined non-negotiables

- GOAT means the USD 10/month plan.
- Include every GOAT-eligible model, regardless of whether it is open or closed.
- Exclude premium models outside GOAT from frontend and Internal API catalogues.
- Do not require or assume an upgrade.
- Full browser and Internal API usability for the complete GOAT catalogue, with exact per-model capability metadata.
- Comprehensive plan first; no implementation until separately authorised.
- Strict TDD, live validation, effective gates, and observable definition of done.
- At least one real installed-runtime observation, not an agent-authored fixture.
- Conflicts require a question.
- Explicitly document operator authority when overriding authoritative artefacts.

### 6.2 Repository and global non-negotiables

- Protected REST routes use `cookieAuthMiddleware`.
- Inputs use Zod or equivalent validation.
- File paths are canonicalised and validated before access.
- Prompt-injection detection precedes forwarding user text to any runtime.
- WebSocket auth, origin, CSRF, and rate-limit protections remain intact.
- Credentials, auth files, cookies, transcripts, session artefacts, and secrets are never committed or logged.
- Browser workspace roots remain narrow and non-symlinked.
- Runtime/provider claims require actual entry-point evidence, not unit tests alone.
- Behaviour changes use observed RED → minimal GREEN → refactor.
- `AGENTS.md` and `CLAUDE.md` remain byte-identical.
- Relevant lint, typecheck, build, tests, docs checks, and live validation must pass.
- Production is not restarted, reconfigured, deployed, or validated without fresh approval.
- Only owned files are staged/committed; repository status/diffs/secrets are checked before commit/push.

## 7. Quality gates

### 7.1 Blocking gates

A blocking gate must pass before completion. **At implementation start, before production code or substantive content/documentation work, every blocking gate that can physically be represented as an automated test must first be added or changed so it fails against the baseline. Record the command, failure, and reason as RED evidence.**

For gates that cannot physically be turned into a conventional test first—such as operator authority, a real paid provider observation, or production restart approval—create the validator/assertion harness, evidence schema, or checklist first, run it at the earliest safe point, and record why a normal pre-code test was impossible. “Difficult” is not “impossible”.

| ID | Category | Blocking gate | Required proof / initial RED |
|---|---|---|---|
| B-AUTH-1 | Authority | Operator authority and superseded artefacts are recorded exactly as §2 | Plan/report assertion; any new conflict pauses for a question |
| B-ENT-1 | Entitlement | Snapshot classifies all 54 baseline IDs into exactly 35 GOAT eligible and 19 excluded, with no overlap/unknown | failing catalogue-policy unit test before policy code |
| B-ENT-2 | Entitlement | Premium-ineligible IDs never appear in frontend REST models, WebSocket availability models, or Internal API selectable models | failing route/WS/client tests using representative and full-set assertions |
| B-ENT-3 | Entitlement | All 35 eligible IDs appear in the same canonical order on all intended model surfaces | failing parity test |
| B-ENT-4 | Entitlement | Unknown/new model is excluded by default and produces bounded drift evidence | failing unknown-model test |
| B-ENT-5 | Entitlement | No implementation path probes excluded models with a provider request | static/behavioural tests against discovery/validator spies |
| B-MODEL-1 | Execution | Every eligible model passes shared exact model policy for browser and Internal API; hard-coded Qwen/Muse checks are gone from generic execution paths | parameterised failing tests over all 35 IDs |
| B-MODEL-2 | Execution | Excluded/missing/unreviewed models fail before spawn with stable `COMMANDCODE_PLAN_INELIGIBLE` or drift code | failing no-spawn tests |
| B-EFFORT-1 | Capability | Effort is model-scoped, exact, freshly evidenced, and never mapped to generic thinking | parameterised failing capability tests including adjustable/non-adjustable/automatic |
| B-CAP-1 | Capability | All 35 GOAT-eligible models receive non-unknown active capability evidence; their exact effort levels/default/automatic/non-adjustable state is exposed consistently to the frontend and Pi Web UI Internal API | parameterised failing tests over all 35 IDs; unknown capability blocks readiness rather than rendering healthy models unavailable |
| B-UI-1 | Frontend | Selecting a non-shadow GOAT model remains selected after rerender and equivalent catalogue refresh | failing component test using DeepSeek or another non-pair model |
| B-UI-2 | Frontend | Create sends exact model and effort; modal closes only on correlated `session_created` | failing component/store/protocol test |
| B-UI-3 | Frontend | Failed model/cwd/network/auth creation keeps modal open, preserves choices, and displays actionable stable error | failing component test |
| B-UI-4 | Accessibility | Runtime/model controls have correct labels, disabled state, keyboard operation, error announcement, and focus retention | failing accessibility/component assertions |
| B-CWD-1 | Workspace | `/root` is refused; an allowed canonical child path succeeds; symlink escape and broad-root configuration fail closed | failing service/process tests |
| B-CWD-2 | Workspace UX | UI can preflight or otherwise determine allowed/refused cwd without exposing credentials or raw permission controls | failing route/WS/UI tests |
| B-NET-1 | Networking | Browser process retains a distinct network namespace and gains outbound DNS/TLS through bounded user-mode egress | failing process-runner integration test with local disposable HTTPS endpoint |
| B-NET-2 | Networking | Browser sandbox cannot reach host loopback services; `slirp4netns --disable-host-loopback` or equivalent is proven | failing loopback-denial integration test |
| B-NET-3 | Networking | Egress helper readiness is condition-based; provider process cannot start before network is configured; timeout/exit cleans both processes | failing lifecycle/race tests |
| B-NET-4 | Networking | No host-network fallback occurs silently; missing helper makes browser availability fail with actionable health | failing missing-helper test |
| B-SEC-1 | Security | Browser cannot choose executable, argv, env, auth, native ID, profile, mount, or yolo; browser remains plan/read-only | existing plus new negative tests |
| B-SEC-2 | Security | Auth file and executable/runtime/workspace bindings remain pinned, non-symlinked, private, and TOCTOU-resistant | process-runner tests |
| B-SEC-3 | Security | Auth/origin/CSRF/rate-limit/prompt-injection/path validation still applies on actual browser/Internal API entry points | route/upgrade/prompt boundary tests |
| B-API-1 | Internal API | Attested create/prompt supports every eligible model and refuses excluded models before spawn | failing route/orchestration tests over all 35/19 |
| B-API-2 | Internal API | Browser-contained records remain absent from shadow session/evidence/diagnostic/receipt routes | existing isolation tests retained and expanded |
| B-API-3 | Internal API | Model, effort, role, cwd, execution instance, terminal usage and output evidence persist through receipt/replay/restart | failing store/receipt/recovery tests |
| B-API-4 | Contract | Contract version is bumped appropriately; Pi Web UI shared types, validators and canonical docs agree | failing Pi Web UI contract/type tests; no Agent OS artefact is changed or required |
| B-WS-1 | Protocol | Shared protocol includes Command Code availability, model, entitlement metadata, create request ID, effort, stable errors, session create/switch/replay | failing protocol/store tests |
| B-LIFE-1 | Lifecycle | Abort/delete/timeout/process failure/helper failure release child, slirp process, descriptors, admission and capacity exactly once | failing lifecycle tests |
| B-DEPLOY-1 | Deployment | Server and frontend expose immutable matching build identities; mismatch is detected and visible | failing server/client test |
| B-DEPLOY-2 | Deployment | Release procedure cannot claim completion after build without loaded-server identity readback after restart | script/doc assertion and disposable release test |
| B-VAL-1 | Fixture live validation | Disposable provider-free browser fixture proves selection, create, stream, replay, containment and cleanup for a non-pair eligible model | updated validator with explicit `fixture-only` verdict |
| B-VAL-2 | Fixture live validation | Disposable Internal API fixture proves all 35 eligible routes at policy/create boundary and representative prompt/replay/evidence paths | scenario matrix; no excluded spawn |
| B-VAL-3 | Real runtime | Real installed `cmd` binary, real auth, GOAT-eligible model, real network and real provider response complete through browser WebSocket path | bounded live scenario on disposable server; not fixture |
| B-VAL-4 | Real runtime | Real installed `cmd` binary completes through attested Internal API path with exact model/receipt/transcript identity | bounded live scenario on disposable server; not fixture |
| B-VAL-5 | Reality check | At least one real eligible non-pair model—default target `deepseek/deepseek-v4-flash`—passes both B-VAL-3 and B-VAL-4; no premium model is called | saved redacted evidence bundle |
| B-DOC-1 | Documentation | Canonical docs describe five runtimes, GOAT 35/54 baseline, dynamic entitlement refresh, browser egress, Internal API expansion, limits and validation truthfully | docs/link/keyword assertions where practical plus review |
| B-DOC-2 | Documentation | Old plans have visible historical/superseded status and cannot be mistaken for current authority | docs governance check/manual review |
| B-GATE-1 | Repository | focused tests, full tests, lint, typecheck, build, guide sync/check, docs/link checks and diff check pass | actual command outputs |
| B-GATE-2 | Security hygiene | no secrets, tokens, cookies, auth dumps, private transcripts, session artefacts, runtime state or personal data in diff/stage | explicit scan and staged-path review |
| B-GATE-3 | Independent verification | a reviewer independent of implementation inspects changes and evidence against every blocking gate | written findings, all critical/major resolved |
| B-TDD-1 | Process | Every physically automatable blocking behaviour has recorded baseline RED before implementation and GREEN after minimal change | RED/GREEN ledger in execution report |

**Blocking semantics:** if a physically possible gate is red, skipped, replaced by a fixture, or merely inferred, the task is not done. The status is `blocked` or `incomplete` unless the operator explicitly changes scope or authority.

### 7.2 Advisory gates

Advisory gates improve quality but do not permit a blocking failure to be ignored.

| ID | Category | Advisory gate |
|---|---|---|
| A-ENT-1 | Entitlement | Provide a dry-run refresh report that clearly explains added, removed, and plan-changed IDs before snapshot update. |
| A-UI-1 | UX | Group eligible models by maker/serving lane and show useful search without copying volatile pricing into runtime UI. |
| A-UI-2 | UX | Show concise “GOAT eligible” and capability labels without implying unlimited usage. |
| A-UI-3 | UX | Preserve recent successful Command Code model/cwd locally, provided stale/invalid values still fail closed. |
| A-NET-1 | Networking | Measure slirp startup and prompt latency versus the Internal API direct path; explain material overhead. |
| A-NET-2 | Networking | Add bounded egress destination telemetry without recording prompts, URLs containing secrets, or provider payloads. |
| A-VAL-1 | Runtime coverage | Sample a second inexpensive eligible family such as Muse Contributor or Laguna after the mandatory DeepSeek validation, if credits/capacity allow. |
| A-VAL-2 | Runtime coverage | Exercise one eligible model with adjustable effort and one without effort against the real runtime. |
| A-PERF-1 | Performance | No material New Session render regression and no >1% unexplained client gzip increase. |
| A-OBS-1 | Observability | Health makes entitlement source age and drift visible without leaking auth/account details. |
| A-DOC-1 | Documentation | Add a compact maintainer runbook for refreshing GOAT eligibility after Command Code releases or plan changes. |
| A-OPS-1 | Operations | Add a pre-restart release summary showing server/client SHA, expected GOAT snapshot and validation evidence. |

## 8. Required TDD order

Implementation must follow this order:

1. Create the execution report and RED/GREEN ledger.
2. Reconfirm authority, clean/owned repository state, installed CLI version, official GOAT page, and baseline catalogue without changing production.
3. Add all physically possible blocking tests from §7.1 before production code or substantive documentation changes.
4. Run those tests against the baseline and record genuine RED evidence. Characterisation tests that are already green must be labelled as such; they do not substitute for missing regression RED.
5. Implement the minimum entitlement-domain changes to turn entitlement tests green.
6. Implement the minimum model-policy/Internal API changes to turn execution-policy tests green.
7. Implement browser selection/acknowledgement/cwd UX changes.
8. Implement bounded browser egress and lifecycle handling.
9. Update Pi Web UI protocol/contracts and shared types; do not modify Agent OS.
10. Update fixtures/validators, then run disposable fixture gates.
11. Run the real installed-runtime validations only after local security and fixture gates are green.
12. Update canonical documentation from observed final behaviour.
13. Run full quality gates and independent review.
14. Ask separately before any production restart/configuration/deployment/production validation.
15. Commit and push only when execution is authorised and all blocking gates are green.

Do not combine multiple hypotheses in one fix. If three attempted fixes fail, stop and revisit the architecture with the operator rather than layering a fourth workaround.

## 9. Implementation work packages

### WP0 — Baseline, authority and evidence ledger

**RED/gate preparation**

- Create `docs/plans/COMMAND-CODE-GOAT-CATALOGUE-IMPLEMENTATION-REPORT.md` when execution begins.
- Record baseline commit, dirty/owned paths, CLI version, raw list hash/count/order, official GOAT source hash/count, process/build identities, and focused test results.
- Build the gate matrix and mark each item `red`, `green`, `blocked`, `not-yet-run`, or `not-applicable-with-authority`.
- Recheck that production has not been modified.

**Stop condition:** any new authority conflict or another agent actively owning relevant files.

### WP1 — Separate raw discovery from GOAT eligibility

**Tests first**

- exact 35/19 partition;
- representative closed-but-eligible models remain included;
- Claude/GPT premium examples remain excluded;
- unknown additions fail closed;
- removed eligible IDs report missing/drift;
- malformed/duplicate/oversized discovery fails closed;
- no provider spawn during entitlement refresh.

**Implementation**

- Replace the monolithic “full executable catalogue” concept with:
  - raw discovered registry;
  - reviewed GOAT entitlement snapshot;
  - complete GOAT catalogue plus capability-readiness state;
  - bounded drift diagnostics.
- Add a deterministic refresh/audit script that fetches or ingests official GOAT model evidence and emits a reviewable proposed snapshot; it must not auto-approve changes.
- Keep plan metadata public and credential-free.
- Remove premium IDs from frontend/Internal API model projections while preserving diagnostic truth.

**Likely files**

- `server/src/command-code/command-code-model-catalog.ts`
- new public entitlement snapshot near the command-code domain
- `server/src/command-code/command-code-service.ts`
- model route/protocol/shared types and tests
- refresh/audit script and tests

### WP2 — Generalise execution policy and capability detection to the complete GOAT set

**Tests first**

- parameterised all-35 create/command-construction policy tests;
- all-19 excluded no-spawn tests;
- attestation accepts exact eligible IDs and rejects excluded/unknown IDs;
- persisted eligible sessions survive restart; policy drift invalidates safely;
- browser and Internal API use the same eligibility authority but separate permission/session profiles.

**Implementation**

- Replace `assertCommandCodeModel()` pair semantics with clear domain functions such as:
  - exact syntactic runtime ID;
  - raw discovered ID;
  - GOAT-eligible executable ID whose capability readiness is proven;
  - historical Step 7F cohort, only where historical scoring still needs it.
- Remove hard-coded pair checks from Internal API create, service accessibility and command construction.
- Generalise role-attestation model binding without weakening role/CWD/lease/parent evidence.
- Keep invocation profiles server-owned.
- Actively detect each eligible model's native effort/thinking capability, including exact levels, automatic/default semantics and non-adjustable state; do not use a fixed pair-derived capability table.
- Expose the same model-scoped capability metadata through the browser catalogue and Pi Web UI Internal API. Unknown capability blocks readiness and investigation; it must not silently downgrade the model to `unavailable`.
- Do not modify Agent OS. Technical availability in Pi Web UI does not make a model an Agent OS finalist or default; the separate Agent OS agent owns that policy.

### WP3 — Frontend model selection and correlated creation

**Tests first**

- select `deepseek/deepseek-v4-pro` or another non-pair eligible model and retain value across rerender/catalogue refresh;
- send exact model/effort/cwd/request ID;
- wait for matching `session_created` before closing;
- preserve values and focus on stable failure;
- excluded IDs never become options;
- disconnected/reconnected socket does not falsely complete creation.

**Implementation**

- Memoise derived catalogue arrays.
- Add request correlation to `new_session` and `session_created`/error responses, additively if compatibility requires.
- Represent creation as explicit idle/pending/succeeded/failed state.
- Disable duplicate creates while pending.
- Keep settings from sending model changes when there is no active session.
- Retain existing session immutability: start a new Command Code session to change model.

### WP4 — CWD policy and UX

**Tests first**

- `/root` refusal;
- configured `/root/pi-web-ui` success in fixture;
- symlink traversal and broad-root rejection;
- safe preflight metadata;
- actionable UI and stable error code.

**Implementation**

- Add a safe browser cwd eligibility check, either:
  - server-side preflight for a candidate path; or
  - bounded workspace-root metadata if security review approves path disclosure.
- Prefer boolean/refusal + stable reason over exposing raw permission internals.
- Default or guide Command Code users to an allowed recent/project path.
- Add `COMMANDCODE_CWD_REFUSED` and preserve model/cwd in the open modal.

### WP5 — Provider-capable browser network containment

**Preferred architecture**

Keep Bubblewrap filesystem/user/PID/IPC/UTS/cgroup/network isolation and attach `slirp4netns` to the sandbox network namespace with:

- `--configure`;
- `--disable-host-loopback`;
- readiness FD/condition rather than sleep;
- exit FD tied to the subject process;
- bounded startup timeout;
- server-owned binary path pinned/validated like Bubblewrap;
- DNS/TLS outbound support;
- no inbound listener or free host port;
- no host loopback access;
- cleanup on normal completion, abort, timeout, spawn error and shutdown.

**Tests first**

- no outbound before helper readiness;
- disposable external HTTPS endpoint reachable after readiness;
- host-loopback endpoint unreachable;
- helper missing/drift/early exit fails availability;
- child/helper lifecycle and descriptor cleanup;
- no shell invocation or caller-controlled network args.

**Implementation notes**

- Extend process-runner launch ownership to manage both Bubblewrap and slirp processes as one turn.
- Use Bubblewrap info/synchronisation descriptors or a small server-owned launcher protocol so Command Code cannot begin until network configuration is ready.
- Scrub helper diagnostics.
- Expose precise health such as `network_helper_missing`, `network_setup_failed`, and `provider_network_unavailable`.
- If slirp cannot meet requirements, stop and ask. Do not delete `--unshare-net` and inherit host networking without new authority.

### WP6 — Internal API full GOAT execution

**Tests first**

- full eligible model projection;
- excluded models absent from selectable catalogue;
- all-35 attested create boundary;
- representative real run receipt/replay/evidence;
- browser session isolation;
- batch/admission/capacity behaviour;
- stable error mapping for plan ineligibility, credits, rate limit, network and provider failure.

**Implementation**

- Update Internal API schemas/types/routes/service resolution.
- Keep role attestation mandatory and exact.
- Make `/models` distinguish the complete GOAT executable catalogue and capability metadata from diagnostic drift metadata.
- Update capability metadata with entitlement plan/source/checkedAt and counts without account secrets.
- Preserve receipts, run-scoped usage, output evidence, cessation and replay.
- Bump the additive contract minor version if public fields/accepted model cohort change under repository versioning rules.
- Do not synchronise or modify Agent OS. If useful, prepare only the optional handoff-only catalogue note described in §2.4 for the separate Agent OS agent.

### WP7 — Deployment coherence

**Tests first**

- server and frontend same build SHA succeeds;
- mismatch produces explicit health/UI warning and blocks misleading “ready” claim;
- a new static build beside an old process cannot be reported as a coherent release.

**Implementation**

- Embed build identity in server and client bundles.
- Expose non-secret server identity through existing health/bootstrap data.
- Compare in the client and show a reload/restart-required state.
- Update release process to build once, verify artefacts, restart only with approval, then read back loaded identity.
- Prefer immutable release directories/atomic pointer if proportionate; at minimum prevent silent split-brain claims.

### WP8 — Protocol, documentation and historical-plan governance

**Tests/checks first where physically possible**

- shared protocol type failures for missing Command Code create/availability/error fields;
- docs checks for four-runtime stale wording and missing Command Code protocol;
- guide byte-identity check.

**Required documentation updates**

- `README.md` — truthful fifth-runtime and GOAT scope;
- `AGENTS.md` + `CLAUDE.md` — five-runtime overview and Command Code file map, byte-identical;
- `docs/ARCHITECTURE.md` — entitlement and slirp/Bubblewrap egress boundary;
- `docs/RUNTIME-OVERVIEW.md` — five-runtime recommendations and capability matrix;
- `docs/CODEBASE-MAP.md` and `docs/MAINTAINER-INDEX.md` — ownership/discovery path;
- `docs/EVENT-PIPELINE.md` — Command Code normalization/replay;
- `docs/PROTOCOL.md` — fifth runtime, request correlation, availability, model, effort and errors;
- `docs/INTERNAL-API.md` and `docs/INTERNAL-API-CONTRACT.md` — GOAT-effective model contract and superseded pair restriction;
- `docs/LIVE-VALIDATION.md` — fixture versus installed-runtime proof;
- `docs/TROUBLESHOOTING.md` — session evidence ladder plus entitlement/cwd/network/build identity;
- `docs/SHARP-EDGES.md` — CLI list is not entitlement, fixture is not provider proof, build skew;
- `DEPLOYMENT.md` and `.env.example` — egress helper and coherent restart/readback;
- optional handoff-only catalogue note for the separate Agent OS agent, if requested; it must not alter Agent OS contract or behaviour.

Mark the three older Command Code plans listed in §2.2 as historical/superseded for current product execution while preserving their historical rationale.

## 10. Live-validation plan

### 10.1 Safety boundary

- Default to fresh disposable validation directories, socket, token, state, ports, workspace and Command Code session homes.
- Never use the production Internal API socket implicitly.
- Never restart/reconfigure production without fresh approval.
- Real-runtime validation may reuse the installed Command Code binary and authenticated GOAT credential through a deliberately prepared private validation home; do not print/copy credential contents.
- Bound real validation to the smallest sufficient number of turns and eligible models.
- Do not invoke premium-ineligible models.

### 10.2 Layer A — deterministic fixture validation

Run the provider-free fixture first:

1. assert raw 54, GOAT entitlement 35, excluded 19, and active capability evidence for all 35;
2. assert all 19 excluded IDs are absent from selectable routes;
3. select a non-pair GOAT-catalogue model in the actual browser UI;
4. create under a valid disposable cwd;
5. prompt, stream, terminalise, replay and switch;
6. verify read-only workspace, private home, pinned auth and cleanup;
7. verify browser-contained Internal API isolation;
8. label verdict **fixture-only: provider connectivity not proven**.

### 10.3 Layer B — network-containment validation

Using a disposable local test service and the real Bubblewrap/slirp launcher:

1. prove sandbox namespace differs from host;
2. prove outbound DNS/TLS works;
3. prove host loopback is blocked;
4. prove no inbound/free port is opened;
5. prove child and network helper terminate and release descriptors/admission;
6. preserve redacted structured evidence.

### 10.4 Layer C — mandatory real installed-runtime browser observation

After Layers A/B and all relevant security tests pass:

1. use installed `cmd` and verify expected version/status without exposing identity details;
2. start a disposable Pi Web UI server configured with the real browser Command Code credential and narrow disposable workspace;
3. use authenticated browser/Playwright WebSocket/UI path;
4. verify catalogue contains the exact 35-model GOAT set and excludes all 19 premium IDs;
5. select `deepseek/deepseek-v4-flash` by default because it is GOAT-eligible, inexpensive, and the Command Code default;
6. create and prompt once with a deterministic short marker;
7. observe exact model in `session_created`, real normalized deltas, terminal result, and stable replay;
8. prove the response came from the real binary/provider, not the fixture, via runtime version, process executable identity, absence of fixture source/paths, native terminal evidence, and network-helper evidence;
9. tear down disposable state.

This is blocking. A fixture result cannot replace it.

### 10.5 Layer D — mandatory real installed-runtime Internal API observation

On a separate or safely reused disposable server:

1. obtain valid server-owned attestation for the exact eligible model and cwd through the normal test/orchestration mechanism;
2. create an Internal API `commandcode` session using `deepseek/deepseek-v4-flash`;
3. dispatch one bounded prompt;
4. observe accepted receipt and exact model identity;
5. wait for terminal completion;
6. read receipt, evidence, `visible_full` transcript and screen projection;
7. require text disposition and exact marker;
8. verify browser-contained sessions remain hidden from Internal API surfaces;
9. abort/delete/tear down and prove capacity release.

This is blocking and must use the real installed runtime.

### 10.6 Optional real samples

If inexpensive and within available GOAT credits, sample:

- `meta/muse-spark-1.2-contributor` to prove non-adjustable effort;
- `qwen/qwen3.8-max` to prove adjustable effort;
- `google/gemini-3.7-flash` or `xai/grok-4.6` to prove closed-source-but-GOAT classification.

These are advisory unless a changed code path needs them for a blocking claim.

### 10.7 Production observation

Production rollout/validation is **not part of the authority granted by this plan**. If requested later:

1. show exact dry-run/restart/config plan;
2. obtain fresh approval;
3. inspect status/diff/secrets;
4. build and restart coherently;
5. read back matching server/client identities;
6. run one bounded eligible-model browser observation;
7. stop on any anomalous credit, entitlement, auth, network or session result.

## 11. Definition of done: observable outcomes

Done is defined as observations an LLM agent can reproduce and the operator can also observe. Implementation is complete only when every blocking observation below is evidenced.

| ID | Observable done state |
|---|---|
| DO1 | Opening New Session shows Command Code as the fifth runtime when enabled and healthy. |
| DO2 | The model picker contains exactly the current reviewed GOAT catalogue—35 at the baseline—not all 54 raw models—and all 35 have completed capability detection before readiness is claimed. |
| DO3 | Claude, premium GPTs other than Luna, older premium Gemini models, Fugu Ultra and Muse 1.1 are absent from selectable frontend and Internal API catalogues. |
| DO4 | GOAT-eligible closed models such as Luna, Grok 4.6, Gemini 3.7 Flash and Muse 1.2 remain visible. |
| DO5 | Selecting DeepSeek V4 Pro/Flash or another former non-pair model remains visibly selected after rerender/catalogue refresh. |
| DO6 | Create remains pending visibly, then closes only after a matching successful server acknowledgement. |
| DO7 | Selecting `/root` for Command Code produces an actionable allowed-workspace error without losing model/cwd selection; selecting an allowed canonical workspace succeeds. |
| DO8 | Browser-created Command Code session displays the exact selected model and cannot be switched silently. |
| DO9 | Browser prompt through the real installed runtime returns real provider text, streams/replays correctly, and does not use fixture code. |
| DO10 | The browser sandbox has outbound provider access while host-loopback access remains blocked and workspace stays read-only. |
| DO11 | Internal API `/models` exposes all and only the reviewed 35-model GOAT catalogue as executable, with matching per-model capability metadata. |
| DO12 | Attested Internal API create/prompt on a former non-pair eligible model completes with exact identity, terminal receipt, text evidence and transcript. |
| DO13 | Attempting an excluded premium model fails before spawn with a stable entitlement error and no credit-spending request. |
| DO14 | Qwen-style effort and Muse-style no-effort semantics remain truthful; unsupported effort fails before spawn. |
| DO15 | Browser sessions remain absent from Internal API session/evidence/receipt surfaces. |
| DO16 | Abort/delete/timeout/helper failure release runtime, egress helper, capacity, descriptors and state exactly once. |
| DO17 | Frontend and server show the same immutable build identity; deliberately mismatched builds visibly report the mismatch. |
| DO18 | Canonical docs describe the observed GOAT catalogue, browser egress, Internal API scope and validation limits without contradicting each other. |
| DO19 | Focused/full tests, lint, typecheck, build, docs/guide checks, security scan and independent review are green. |
| DO20 | The execution report contains genuine RED-before-GREEN evidence for every physically automatable blocking change and clearly identifies any non-automatable gate. |

At least DO9 and DO12 must be observed against the **real installed Command Code runtime**, not an agent-authored fixture.

## 12. Final repository quality commands

Use the repository's actual scripts at execution time; reconcile renamed commands rather than copying stale syntax. Expected gate set:

```bash
npm run docs:sync-agent-guides
npm run docs:check-agent-guides
npm run lint
npm run typecheck
npm run build
npm test
# focused Command Code/client/protocol/security suites
# relevant browser E2E through webapp-testing
# disposable fixture live validators
# real installed-runtime browser + Internal API validators
# no Agent OS implementation, contract or client tests; a separate owner handles that scope
git diff --check
git status --short
git diff --stat
git diff --cached --stat
```

Before commit/push, explicitly inspect staged paths and scan for credentials, auth data, cookies, session artefacts, transcripts, local billing/usage data, runtime homes and generated temporary evidence.

## 13. Evidence bundle and execution report

The future execution report must include:

- operator authority and any amendments;
- baseline and final commit/build identities;
- raw 54 and reviewed GOAT 35/19 snapshot evidence with source date/hash;
- RED/GREEN ledger mapped to every blocking testable gate;
- exact test/build/lint/typecheck/docs commands and results;
- fixture validation reports labelled fixture-only;
- real installed-runtime browser and Internal API evidence, redacted;
- exact model/effort/receipt/transcript identity for real runs;
- network namespace/egress/loopback/cleanup evidence;
- independent review findings and resolutions;
- remaining advisory limitations;
- production status explicitly stated as untouched unless separately approved;
- final git status/staged-path/secret-scan evidence.

Do not include prompt bodies beyond harmless deterministic markers, credentials, auth paths/content, account usage/billing details, private transcripts, or provider payloads not needed for proof.

## 14. Stop/escalation conditions

Stop and ask the operator if:

- official GOAT entitlement differs materially from the 35-model baseline;
- `cmd --list-models` adds/removes/reorders IDs and the reviewed snapshot cannot classify them confidently;
- an eligible model actually returns a plan-upgrade/premium error;
- slirp cannot provide provider access while blocking host loopback;
- implementation would require dropping network isolation entirely;
- role attestation cannot be generalised without weakening authority boundaries;
- a canonical test or policy conflicts with this plan;
- production validation/restart/configuration appears necessary;
- real validation could invoke premium/top-up billing;
- credentials or private data might enter logs/evidence;
- another agent owns relevant files;
- three attempted fixes fail and indicate an architectural problem.

Never convert these into silent scope reduction or an unrecorded workaround.

## 15. Out of scope

- upgrading the operator from GOAT;
- buying or enabling premium/top-up credits;
- calling excluded premium models;
- Command Code MCP exposure;
- Drive Mode integration;
- adding Command Code to generic `--runtime all`;
- mutable browser/yolo execution;
- all Agent OS implementation, contract, validator, routing and runtime changes; a separate agent owns that scope;
- making Command Code models Agent OS finalists/defaults merely because they are technically executable;
- production rollout without new approval;
- broad `/root` workspace access;
- dynamic billing/usage UI or storing private account balances;
- automated approval of entitlement changes scraped from the web.

## 16. Completion and pause instruction

When this plan document is fully written and validated as documentation:

1. report the plan path;
2. summarise the 35 eligible / 19 excluded finding and official sources;
3. state that operator authority is recorded;
4. state that no implementation, runtime prompt, build/restart, deployment, configuration change, or production validation was performed;
5. **pause and wait for a separate execution instruction.**
