# Command Code 35-model minimum completion plan

> **Status:** canonical replacement plan; implementation requires a separate execution instruction.
>
> **Replaces:** `COMMAND-CODE-FULL-CATALOGUE-MINIMAL-SOLUTION-PLAN.md` in full. The replaced plan is deleted because its custom Bubblewrap/slirp4netns networking design, B-NET gates and disposable-VM requirements are no longer authorised.
>
> **Scope:** Pi Web UI only. Agent OS changes, MCP exposure, Drive Mode and unrelated deployment architecture are out of scope.

## 1. Objective

Make Command Code a fully functional fifth Pi Web UI runtime through:

1. the browser WebSocket/frontend path; and
2. the authenticated Internal API path.

Both paths must:

- expose exactly the 35 reviewed USD 10/month GOAT-eligible models;
- exclude the 19 models outside that plan;
- expose and validate each model's native Command Code effort/thinking options;
- create a session with the selected model, effort and working directory;
- accept a prompt, stream/terminalise it, and replay the result;
- use the same straightforward direct-subprocess and ordinary host-network model as the other Pi Web UI runtimes.

The priority is completion with the fewest new concepts and the smallest maintainable diff.

## 2. Locked simplicity decisions

1. **One direct runtime process.** Pi Web UI launches the installed absolute `cmd` executable directly. There is no secondary networking helper.
2. **Ordinary host networking.** Command Code inherits normal outbound networking, consistent with the other runtime integrations.
3. **No custom network sandbox.** Remove Bubblewrap browser launching, `slirp4netns`, `--unshare-net`, TAP devices, routes, namespace descriptors, helper readiness and helper cleanup.
4. **No VM requirement.** Standard disposable Pi Web UI validation state on this host is sufficient. Validation must not target the production socket or production session state.
5. **One model authority.** Browser and Internal API consume the same reviewed GOAT catalogue and model-scoped native effort metadata.
6. **Server-owned invocation.** Browser/Internal API callers cannot choose executable paths, raw arguments, environment, authentication paths, native session IDs, permission profiles or unrestricted/yolo flags.
7. **Keep simple existing safeguards.** Preserve exact model/effort validation, prompt-injection checks, bounded input/output/timeouts, process-group cleanup, narrow configured CWD roots, private per-session state, receipts and replay.
8. **Browser remains plan/read-only.** Ordinary networking does not grant mutable browser workspace permissions.
9. **No unrelated expansion.** Do not add entitlement daemons, billing UI, dynamic plan scraping, build-identity architecture, destination telemetry, new orchestration surfaces or additional runtime abstractions.
10. **Strict TDD.** Behaviour changes receive an observed failing regression test before implementation.

## 3. Exact catalogue

### 3.1 GOAT eligible: 35

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

### 3.2 Excluded from GOAT: 19

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

The reviewed lists are static repository policy. At startup, CLI discovery confirms that all 35 eligible IDs still exist. Unknown, missing or newly discovered IDs fail closed and produce a bounded diagnostic; they do not trigger automated plan-page scraping or silent catalogue changes.

## 4. Native thinking/effort behaviour

For every eligible model, use the installed Command Code CLI's discovered model capability:

- expose only the exact native effort values supported by that model;
- expose automatic/default semantics by omitting `--effort` when appropriate;
- show no effort selector for a non-adjustable model;
- reject a supplied unsupported effort before spawning;
- persist and replay requested, accepted and effective effort metadata without translating it into generic Pi thinking levels.

Capability discovery is provider-free. If capability for any eligible model is unknown, Command Code reports not ready rather than exposing a misleading selector.

## 5. Minimum work packages

### WP1 — Delete the custom network path

**RED tests first**

- Browser Command Code launches exactly one process.
- Launch arguments contain neither Bubblewrap nor `slirp4netns` nor `--unshare-net`.
- No helper, TAP, namespace, DNS/CA mount or inherited namespace FD is created.
- Abort, timeout and shutdown terminate the direct process group once.

**Implementation**

- Collapse browser-contained and Internal API execution onto the existing direct `cmd` subprocess runner.
- Delete network-helper configuration, pinning, environment variables, validation guards and documentation.
- Retain server-owned plan/read-only browser arguments and ordinary bounded process lifecycle.

### WP2 — Finish the shared 35-model catalogue

**RED tests first**

- Parameterised policy tests cover all 35 eligible models.
- Parameterised rejection tests cover all 19 excluded models and prove no spawn.
- Every eligible model has known capability metadata.
- Unsupported effort fails before spawn.

**Implementation**

- Retain the reviewed 35/19 policy already implemented where correct.
- Keep raw CLI discovery separate from eligibility.
- Project the same eligible model/capability records to WebSocket and Internal API model responses.
- Remove only stale two-model restrictions and network-specific readiness dependencies.

### WP3 — Make browser creation and prompting work

**RED tests first**

- The New Session modal shows exactly the 35 eligible models.
- Selecting a model preserves it across rerenders and catalogue refresh.
- The effort control reflects that selected model's exact native options.
- Create sends exact model, effort, CWD and request ID.
- The modal closes only after the matching `session_created` response.
- Rejection preserves the user's selections and presents an actionable error.
- A created session can prompt, stream, terminalise and replay.

**Implementation**

- Keep one explicit pending create state and request correlation.
- Validate CWD against configured allowed roots; guide the user to an allowed project path rather than broadening to `/root`.
- Send prompts through the same Command Code service/event pipeline already used by replay.

### WP4 — Finish Internal API execution

**RED tests first**

- `/models` returns all and only the 35 eligible models with matching effort metadata.
- Attested create accepts every eligible model and rejects every excluded/unknown model before spawn.
- Dispatch produces a terminal receipt, transcript and exact model/effort evidence.
- Abort/delete releases the direct process and admission capacity.

**Implementation**

- Retain authenticated Unix-socket access, server-owned roles, CWD validation, receipts, evidence and transcript projections.
- Remove pair-only and custom-network restrictions.
- Keep browser sessions separate from Internal API-addressable sessions.

### WP5 — Validate and activate

Run in this order:

1. focused runner, catalogue, service, route and frontend tests;
2. full server, client and Internal API MCP tests;
3. typecheck, build, lint, guide checks, documentation links and `git diff --check`;
4. provider-free browser WebSocket fixture: create, prompt, stream, terminal result and replay;
5. provider-free Internal API fixture: create, dispatch, receipt, transcript and cleanup;
6. one short real `deepseek/deepseek-v4-flash` browser turn;
7. one short real `deepseek/deepseek-v4-flash` Internal API turn;
8. changed-path secret/runtime-artifact scan and independent review;
9. commit and push the owned Pi Web UI changes on the current branch;
10. request fresh approval before production configuration/restart;
11. after approval, restart once and verify the actual Web UI can create and prompt a Command Code session.

Real validation must use an eligible model, automatic top-up/reload must remain disabled, and any billing/upgrade signal stops the run. No excluded model is invoked.

## 6. Explicit deletions from the abandoned design

The implementation must remove, not preserve behind dormant flags:

- Bubblewrap as a Command Code browser launcher;
- `slirp4netns` and all helper process ownership;
- network namespace PID/FD/identity parsing;
- TAP names, routes, readiness pipes and exit pipes;
- browser DNS/CA mount configuration introduced for that sandbox;
- validation namespace attestation environment variables;
- B-NET-0 through B-NET-4;
- disposable-VM/separate-host requirements;
- privileged-container networking evidence as a release gate;
- custom network error/status taxonomy that has no remaining production call path.

Tests, examples and documentation asserting those behaviours must be deleted or rewritten. Do not leave contradictory historical instructions in an active plan.

## 7. Definition of done

The task is complete only when:

1. the frontend and Internal API expose exactly the 35 eligible models and no excluded model;
2. every eligible model has truthful model-scoped effort metadata;
3. unsupported model/effort requests fail before spawn;
4. the frontend creates a Command Code session and receives real provider text;
5. the Internal API creates, dispatches and returns terminal receipt/transcript evidence;
6. both paths preserve exact model and effort identity through replay;
7. abort, timeout, delete and shutdown clean up the direct process;
8. fixture and real validations pass without custom network infrastructure;
9. repository tests/checks and independent review pass;
10. the change is committed and pushed;
11. production remains untouched until separately approved, then loaded behaviour is read back after the approved restart.

## 8. Stop conditions

Stop and ask only if:

- the installed CLI no longer exposes one or more reviewed eligible models;
- capability discovery cannot determine an eligible model's native effort options;
- Command Code requires an upgrade, premium credit or automatic top-up;
- direct execution would require mutable/yolo browser permissions;
- production restart/configuration is required before approval;
- another agent owns the same files.

Do not introduce a new sandbox, helper, daemon, network architecture or cross-repository dependency to work around a failure. Diagnose the direct runtime path first.
