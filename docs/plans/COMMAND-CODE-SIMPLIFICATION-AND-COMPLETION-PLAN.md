# Command Code simplification and completion plan

> **Status:** canonical. This is the only active Command Code plan.
>
> **Replaced and already deleted:** `COMMAND-CODE-35-MODEL-MINIMUM-COMPLETION-PLAN.md`,
> `COMMAND-CODE-FIFTH-RUNTIME-IMPLEMENTATION-PLAN.md`,
> `COMMAND-CODE-FRONTEND-INTERNAL-API-ACTIVATION-PLAN.md`,
> `COMMAND-CODE-INTERNAL-API-AND-STEP-7F-SHADOW-ADAPTATION-PLAN.md`.
> They were removed in the same commit that introduced this file, so no competing
> instructions survive. Recover them from git history if evidence is ever needed.
>
> **Scope:** Pi Web UI only — browser frontend, WebSocket path, Internal API.
> Agent OS, MCP exposure, Drive Mode, session transfer expansion and deployment
> architecture are out of scope.

## 1. Why this plan exists

Command Code is the **thinnest** runtime in this repository — one `cmd`
subprocess invoked with `-p --output-format json`, which prints NDJSON and
exits. It is also, today, the **largest** runtime module in the repository:

| Runtime module | Lines |
|---|---|
| `server/src/command-code/` | **4,423** |
| `server/src/claude/` | 6,794 (four backends, SDK, channel, profiles) |
| `server/src/pi/` | 5,311 (pooling, watchers, extensions, parallel) |
| `server/src/opencode/` | 2,852 |
| `server/src/antigravity/` | 1,462 |

That inversion is the defect. Roughly two-thirds of the Command Code module is
access-control and containment machinery that **no other runtime has**, built
for an Agent OS shadow-orchestration use case that is no longer in scope. That
machinery — not the runtime itself — is what has kept the feature broken.

This plan is a **deletion plan first** and a completion plan second.

### 1.1 The reported bug, root-caused

The operator's symptom is: *the Command Code runtime selector opens, but the
model will not stay selected and the session cannot be prompted.*

The chain is:

1. `client/src/components/Session/NewSessionModal.tsx:310` filters the dropdown
   to `commandCodeModels.filter(m => m.browserRunnable === true)`.
2. The effect at `NewSessionModal.tsx:323-337` snaps the selection back to
   `commandCodeBrowserModels[0]`, which is `''` when that list is empty.
3. `browserRunnable` requires `CommandCodeService.isBrowserAvailable()`
   (`server/src/command-code/command-code-service.ts:893`), which is a
   **seven-condition AND**: `browserAuthFile` **&&** `browserEgressExecutablePath`
   **&&** `browserDnsConfigPath` **&&** `browserCaCertificatesPath` **&&**
   `browserRuntimeRoots.length > 0` **&&** `browserAllowedCwdRoots.length > 0`
   **&&** `browserAllowedModels ⊇ all 35` — plus `runner.browserSandboxReady()`.
4. Every one of those defaults to empty or false
   (`command-code-config.ts:158-167`).

So the list is empty, the effect blanks the selection, and create is sent with
no model. **Deleting the network sandbox alone does not fix this** — it clears
only four of the seven conditions. The allowlists must go too.

### 1.2 The "everything unavailable" machine, root-caused

`COMMAND_CODE_EFFORT_SOURCE = 'live-preflight'`
(`command-code-model-catalog.ts:191`). At **every server start**,
`discoverCommandCodeEfforts` spawns a probe subprocess per model, bounded by a
120s total budget (`:305`). Any timeout or inconclusive parse sets
`status: 'unknown'`, which is explicitly fail-closed — the model becomes
unavailable, and for the two legacy models the exhaustive branch issues real
`-p --model X --effort Y` inference calls.

`getModels()` (`:960-989`) then marks a model `runnable` only if
`capabilityReady` is true, and `isSessionRecordAccessible()` (`:930-941`)
**rejects an existing stored session** whose `effortCapabilityHash` no longer
matches current discovery — so sessions silently vanish across a restart when
probe results drift.

This is the mechanism that produces the wall of "unavailable" the operator has
repeatedly rejected. It is deleted here and replaced with a committed static
table that degrades **open**.

## 2. Objective

Command Code works as an ordinary fifth runtime:

1. **Browser:** open New Session → pick Command Code → the model list shows every
   GOAT-eligible model → pick any one → **it stays picked** → the effort selector
   shows that model's real native options → create → prompt → real provider text
   streams back → reload replays it.
2. **Internal API:** `GET /api/v1/models?runtime=commandcode` lists the same
   models with the same effort metadata; create → prompt → terminal receipt and
   transcript; abort/delete cleans up.

Both paths use **one direct `cmd` subprocess with ordinary host networking**,
exactly like the other four runtimes.

## 3. Locked decisions

1. **Delete, do not gate.** Everything removed here is deleted from the tree, not
   parked behind a dormant flag. No dead code, no "historical" branches.
2. **One process, host networking.** No Bubblewrap, no `slirp4netns`, no network
   namespace, no TAP device, no helper process, no DNS/CA mounts, no VM.
3. **No attestation.** The HMAC role-attestation module is deleted outright.
   Authentication for the Internal API is the existing Unix-socket token; the
   browser path is the existing cookie/CSRF auth. Nothing else.
4. **One enable flag.** `COMMAND_CODE_ENABLED`. Not four.
5. **One permission profile.** Server-owned, plan/read-only. Callers never choose
   argv, executable, env, native session id, profile or role.
6. **One catalogue, denylist-based, degrading open.** Eligible = *what the CLI
   advertises* minus a committed 19-model exclusion list. A model the CLI adds
   later just appears; an unknown model is simply not listed. **Nothing ever
   takes the whole runtime down.**
7. **Static effort table.** Generated once by an npm script and committed, like
   `pi:refresh-models` and `opencode:refresh-models`. Zero probing at runtime.
   Unknown effort for a model → hide that model's effort selector and let the CLI
   default apply. Never mark the model unavailable.
8. **Keep only the safeguards every runtime has:** absolute server-owned
   executable path, CWD validated against `COMMAND_CODE_ALLOWED_CWD_ROOTS`,
   prompt-injection detection, bounded prompt/stdout/stderr/wall-time,
   process-group cleanup, private per-session native home, replay.
9. **Simplicity is measurable.** `server/src/command-code/` must end at
   **≤ 2,200 lines**. This is a blocking gate, not an aspiration.
10. **TDD, proportionate.** Behaviour changes get an observed failing test first.
    Deletions are proven by the existing suite staying green plus the new
    behavioural tests in §7.

## 4. The catalogue

The installed CLI (`/root/.npm-global/bin/cmd`, v1.23.2) advertises **54**
models. The operator's plan is **GOAT, USD 10/month**. Premium models excluded
from that plan are the only thing filtered.

### 4.1 The exclusion list — the single source of policy

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

19 entries. `54 − 19 = 35` today, which matches the reviewed GOAT list exactly.

**Why a denylist, not an allowlist.** An allowlist fails closed: the day the CLI
renames or adds a model, the pinned list no longer matches and the runtime goes
dark — which is precisely the failure mode that has consumed the last three
days. A denylist fails open: a newly added premium model would surface and fail
on that *one* model with `COMMANDCODE_PLAN_INELIGIBLE` or an upgrade error from
the CLI, which is a vastly cheaper failure than the whole runtime disappearing.
Note `gpt-5.6-luna`, `google/gemini-3.7-flash`, `meta/muse-spark-1.2`,
`meta/muse-spark-1.2-contributor`, `xai/grok-4.5` and `xai/grok-4.6` **are**
eligible — do not exclude a whole vendor.

### 4.2 The effort table

New file `server/src/command-code/command-code-model-efforts.json`, generated by
a new `npm run commandcode:refresh-models` (`scripts/command-code-refresh-models.ts`).

The generator reuses the existing **provider-free** probe: invoke
`cmd -p --output-format json --model <id> --max-turns 1 --trust --skip-onboarding
--no-auto-update --effort __pi_web_ui_capability_probe__` and parse the CLI's
"supported values" rejection. The CLI rejects before contacting a provider, so
this costs nothing and bills nothing. **The exhaustive per-effort branch that
issues real inference calls is deleted.**

Shape:

```json
{
  "generatedAt": "2026-08-14T00:00:00.000Z",
  "cliVersion": "1.23.2",
  "models": {
    "qwen/qwen3.8-max": { "effortLevels": ["low", "medium", "xhigh"], "defaultEffort": "medium" },
    "meta/muse-spark-1.2-contributor": { "effortLevels": [] }
  }
}
```

Runtime rules:

- model present with non-empty `effortLevels` → show the selector with exactly
  those values, preselect `defaultEffort`;
- model present with empty `effortLevels` → **no** effort selector, omit
  `--effort`;
- model absent from the table → **no** effort selector, omit `--effort`, model
  is still fully runnable;
- a supplied effort not in that model's `effortLevels` → reject before spawn with
  `COMMANDCODE_EFFORT_UNSUPPORTED`.

## 5. Work packages

Execute in order. Each package ends green (`npm run typecheck && npm test`)
before the next begins.

### WP0 — Reset the abandoned sandbox work in progress

The working tree currently carries **~1,682 uncommitted lines** implementing the
Bubblewrap/`slirp4netns` sandbox — the change that took the host's networking
down. It is being deleted anyway, so discarding it is free.

1. `git status --short` and `git diff > /tmp/claude-*/scratchpad/abandoned-sandbox.patch`
   (outside the repo) purely as a reference copy.
2. Move the untracked `server/tests/unit/command-code/command-code-goat-policy.test.ts`
   out of the repo to the same scratchpad — it is reference material for WP2 and
   will be rewritten, not kept.
3. Discard the working tree: `git checkout -- .` then confirm
   `git status --short` is empty.
4. Confirm the suite is green at HEAD before touching anything.

Note that the sandbox is only *partly* uncommitted — HEAD still contains
Bubblewrap references in `command-code-process-runner.ts` and
`command-code-config.ts`. WP1 removes those.

### WP1 — Delete the containment and access-control machinery

**RED first:** add `server/tests/unit/command-code/command-code-simplicity.test.ts`
asserting (a) `buildCommandCodeArgs` output contains no `bwrap`, `slirp4netns`,
`--unshare-net` or `--yolo` token for any input, and (b) a browser create and an
Internal API create both spawn exactly one process with the same argv shape.

**Delete these files outright:**

- `server/src/command-code/command-code-role-attestation.ts`
- `server/tests/unit/command-code/command-code-role-attestation.test.ts`
- `scripts/command-code-browser-validation.mjs`
- `scripts/validate-command-code-browser.mjs`
- `server/tests/unit/scripts/validate-command-code-browser.test.ts`

**Delete from `command-code-process-runner.ts`** (target ≤ 250 lines, from 975):

`CommandCodeBubblewrapNamespaceInfo`, `assertDistinctCommandCodeNetworkNamespace`,
`setBrowserPolicyRoots`, `pinExecutable`, `pinBrowserSandbox`, `pinBrowserEgress`,
`pinBrowserDnsConfig`, `pinBrowserCaCertificates`, `browserSandboxReady`,
`buildBrowserLaunch`, `readBubblewrapNamespaceInfo`, `readNetworkNamespaceIdentity`,
`openNetworkNamespaceHandle`, `browserLibrarySearchPath`, `isBroadWorkspaceRoot`,
`isBroadRuntimeRoot`, `overlapsRoot`, `openPinnedDirectory`, `openPinnedExecutable`,
`openPinnedFile`, `closePinnedFile`, `openDirectoryBelowPinnedRoot`,
`closePinnedDirectories`, `sameFileIdentity`, and every `PinnedFile`/`PinnedDirectory`
type. What remains is: validate the absolute executable path, `spawn` with
`controlledEnvironment`, bounded stdout/stderr, wall-time timeout, process-group
kill, `isRunning`, `activeSessionIds`, `redactSensitive`, `boundedTail`.

**Delete from `command-code-config.ts`** (target ≤ 90 lines, from 170):

All four `CommandCodePermissionProfile` values and the `getCommandCodeProfile`
switch — replace with one constant `COMMAND_CODE_ARGS = ['--trust',
'--skip-onboarding', '--no-auto-update', '--plan']`. Delete
`browserSandboxExecutablePath`, `browserEgressExecutablePath`,
`browserDnsConfigPath`, `browserCaCertificatesPath`, `browserRuntimeRoots`,
`browserAllowedModels`, `browserAllowedCwdRoots`, `browserAuthFile`,
`browserEnabled`, `shadowEnabled`, `internalApiEnabled`, `expectedVersion`.
`buildCommandCodeArgs` loses its `permissionProfile` parameter and its
`assertCommandCodeModel` historical-route branch.

**Delete from `command-code-service.ts`** (target ≤ 500 lines, from 1,484):

`isShadowEnabled`, `isShadowAvailable`, `isInternalApiEnabled`, `isBrowserEnabled`,
`isBrowserAvailable`, `getShadowModels`, `getBrowserModels`,
`getShadowEffortCapabilities`, `getShadowSession`, `listShadowSessions`,
`findShadowSession`, `listBrowserSessions`, `isBrowserSession`, `getBrowserSession`,
`isBrowserModelAllowed`, `isBrowserSessionRecord`, `validateBrowserPolicy`,
`removeInaccessibleBrowserHomes`, `setRoleAttestationSecret`, and the
`browserPolicyReady` / `browserAuthHandle` / `browserAuthIdentity` /
`executableIdentity` / `browserSandboxIdentity` / `roleAttestationSecret` fields.
`isSessionRecordAccessible` collapses to: record exists, not deleted, cwd within
`allowedCwdRoots`. The `effortCapabilityHash` check is **deleted**.

**Delete from `command-code-session-store.ts`:** `CommandCodeInvocationRole`,
`permissionProfile`, `effortCapabilityHash`, and any shadow/browser partitioning
on the record.

**Delete `COMMAND_CODE_MODELS`** (the two-model historical Agent OS route),
`assertCommandCodeModel`, `COMMAND_CODE_EFFORT_LEVELS_BY_MODEL`, and the
`enforceHistoricalRoute` parameter threaded through `assertCommandCodeEffort`
and `resolveEffort`.

**Delete error code** `COMMANDCODE_ROLE_REFUSED` from
`server/src/internal-api/error-codes.ts` and its catalog entry.

### WP2 — One catalogue, one effort table

**RED first**, in `command-code-catalogue.test.ts`:

- given a stubbed `--list-models` fixture of all 54 ids, `getModels()` returns 35
  and contains **none** of the 19 excluded ids;
- adding an unknown id to the fixture makes it appear in `getModels()` (fails
  open) and does **not** change `isAvailable()`;
- removing a previously known id from the fixture does **not** make the runtime
  unavailable;
- a model absent from the effort table is `runnable` with `effortLevels: []`;
- `buildCommandCodeArgs` with an effort not in that model's `effortLevels` throws
  before spawn.

**Implementation:**

- Replace the four catalogues in `command-code-model-catalog.ts`
  (`COMMAND_CODE_MODELS`, `COMMAND_CODE_GOAT_MODEL_CATALOGUE`,
  `COMMAND_CODE_PREMIUM_MODEL_CATALOGUE`, `COMMAND_CODE_FULL_MODEL_CATALOGUE`)
  with a single `COMMAND_CODE_EXCLUDED_MODELS` denylist from §4.1 and
  `isCommandCodeEligible(id) = !COMMAND_CODE_EXCLUDED_MODELS.includes(id)`.
- Delete `discoverCommandCodeEfforts`, `probeEffortList`, `classifyEffortProbe`,
  `effortCapabilityHash`, `CommandCodeEffortCapability`,
  `CommandCodeEffortCapabilities`, `COMMAND_CODE_EFFORT_SOURCE` and
  `COMMAND_CODE_DISCOVERY_TOTAL_TIMEOUT_MS` from the runtime path. Move the
  invalid-value probe into `scripts/command-code-refresh-models.ts`.
- Keep `discoverCommandCodeModels` (one `--version` + one `--list-models` call at
  startup) and `parseCommandCodeModelList`. Delete the version-disagreement
  throw — report the version, never fail on it.
- Add `command-code-model-efforts.json` and load it synchronously at module load.
- `getModels()` returns `{ id, displayName, provider, reasoning, effortLevels,
  defaultEffort }`. Delete `runnable`, `status`, `browserRunnable`,
  `supportsEffort`, `effortCapabilityHash` and `catalogue` from the shape, and
  delete the `CommandCodeCatalogueMetadata` type everywhere it flows
  (`shared/src/types.ts`, `server/src/internal-api/types.ts`, `protocol.ts`,
  `sessionStore.ts`, `routes/models.ts`, `routes/capabilities.ts`).

### WP3 — Collapse the effort metadata sprawl

`server/src/websocket/protocol.ts` currently carries **nine** effort fields on
`session_created` / `session_switched` / `effort_changed`: `effort`,
`requestedEffort`, `acceptedEffort`, `effortLevels`, `effortSource`,
`defaultEffort`, `effectiveEffort`, `effortEvidenceMethod`,
`effortCapabilityHash`.

Reduce to **three**: `effort` (what is in force), `effortLevels` (what the
selector may offer), `defaultEffort`. Delete the other six from `protocol.ts`,
`shared/src/types.ts`, `client/src/store/sessionStore.ts`,
`command-code-session-store.ts`, `command-code-service.ts` (`resolveEffort`,
`recordEffectiveEffort`), `internal-api/types.ts`, `routes/sessions.ts` and the
run-receipt store. Delete `currentRequestedEffort`, `currentAcceptedEffort`,
`currentEffectiveEffort` from the client store.

### WP4 — Make the browser path work

**RED first**, in `client/tests/unit/components/Session/NewSessionModal.test.tsx`:

- with 35 models in the store, the `commandcode-model-select` renders 35 options
  and none of the 19 excluded ids;
- selecting a non-first model and rerendering **keeps** that selection (this is
  the regression test for the reported bug);
- selecting a model with `effortLevels: []` renders no effort selector;
- selecting a model with `effortLevels: ['low','medium','xhigh']` renders exactly
  those three and preselects `defaultEffort`;
- create emits `new_session` with the selected `sdkType`, `model`, `effort`,
  `cwd` and a `requestId`;
- the modal stays open until the matching `session_created` arrives, and a
  rejection preserves the user's selections and shows the error.

**Implementation, `NewSessionModal.tsx`:**

- Delete `commandCodeBrowserModels` (line 310) and the reset effect
  (lines 323-337). Render `commandCodeModels` directly.
- Model default: initialise to `commandCodeModels[0]?.id` **once** when the
  Command Code runtime is selected. Never re-derive it from a filtered list.
- `onChange` sets the model and sets effort to that model's `defaultEffort`
  (or `''` when it has none). No effect fights the user's choice.
- Delete the `sdkType === 'commandcode' && currentPath === '/root'` special case
  (lines 222-227). Command Code uses the same CWD control as every other runtime,
  validated server-side against `COMMAND_CODE_ALLOWED_CWD_ROOTS`.
- Delete `browserRunnable` from the option-rendering logic (line 592) and from
  `shared/src/types.ts`.

**`server/src/websocket/connection.ts`:** the `commandcode_available` payload
becomes `{ available, enabled, models, error }` — drop `availabilityStatus`,
`checkedAt`, `source`. `getModels()` replaces `getBrowserModels()` at line 1759
and in `session-transfer/transfer-service.ts:615`. Collapse the service
construction (lines 292-314) to the eight surviving config keys.

**`server/src/routes/models.ts`:** the `commandcode` branch returns
`{ models: service.getModels() }` when enabled — delete the `browserEnabled`
indirection and the `catalogueMetadata` envelope.

**`client/src/store/sessionStore.ts`:** keep `commandCodeEnabled`,
`commandCodeAvailable`, `commandCodeError`, `commandCodeModels`. Delete
`commandCodeAvailabilityStatus`, `commandCodeCatalogueCheckedAt`,
`commandCodeCatalogueSource`.

### WP5 — Make the Internal API path work

**RED first**, in `command-code-routes.test.ts`:

- `GET /api/v1/models?runtime=commandcode` returns the 35 eligible ids with
  matching `effortLevels`, and none of the 19;
- `POST /api/v1/sessions` with `runtime: 'commandcode'` succeeds **without any
  `attestation` field**;
- creating with an excluded id returns 400 `COMMANDCODE_PLAN_INELIGIBLE` and
  spawns nothing;
- creating with an effort outside that model's levels returns 400
  `COMMANDCODE_EFFORT_UNSUPPORTED` and spawns nothing;
- prompt → terminal receipt + transcript carrying the exact model and effort;
- `DELETE` releases the process and admission capacity.

**Implementation, `server/src/internal-api/routes/sessions.ts`:**

- Delete the `invocationRole` requirement, the `verifyCommandCodeRoleAttestation`
  call and the `COMMANDCODE_ROLE_REFUSED` branch.
- **Compatibility shim (deliberate, two lines):** keep `invocationRole` and
  `attestation` as `.optional()` in the Zod schema and **ignore** them, so an
  existing Agent OS caller does not hard-fail on an unknown-field rejection.
  This is strictly fewer branches than verifying them. Mark it with a
  `// TODO(remove once Agent OS drops the fields)` comment.
- Delete the `getShadowSession` / `getNonCommandCodeRegistryEntry` split — Command
  Code sessions are ordinary registry sessions. Delete the browser-vs-Internal-API
  session partition; a session is a session.
- Replace the `isInternalApiEnabled() ?? isShadowEnabled()` ladder at lines
  903-904 with `service.isEnabled() && service.isAvailable()`.

**`server/src/internal-api/routes/capabilities.ts`:** collapse lines 43-52 to
`enabled = service?.isEnabled()`, `available = enabled && service?.isAvailable()`,
`modelCatalogue = enabled ? service.getModels() : []`. Delete the
`getEffortCapabilities` / `getShadowEffortCapabilities` fallback chain,
`supportsEffort` and the `catalogue` envelope.

**Contract:** bump `docs/INTERNAL-API-CONTRACT.md` to **1.20.0** and record one
line: *Command Code session creation no longer requires `invocationRole` or a
role attestation; both are accepted and ignored. The `catalogue`,
`browserRunnable` and `supportsEffort` fields are removed from the Command Code
model projection.* Do **not** edit the Agent OS mirror — the operator is running
that scope separately. Leave a note in the contract doc's Agent OS coordination
section pointing at this change.

### WP6 — Configuration and documentation

**`server/src/config.ts` + `.env.example`** — the Command Code surface becomes
exactly eight variables:

```
COMMAND_CODE_ENABLED=false
COMMAND_CODE_EXECUTABLE_PATH=/root/.npm-global/bin/cmd
COMMAND_CODE_STATE_DIR=
COMMAND_CODE_NATIVE_HOME_DIR=
COMMAND_CODE_ALLOWED_CWD_ROOTS=
COMMAND_CODE_MAX_TURNS=8
COMMAND_CODE_MAX_WALL_TIME_MS=900000
COMMAND_CODE_CONCURRENCY=1
```

Delete `PI_INTERNAL_API_COMMANDCODE_ENABLED`, `PI_COMMAND_CODE_BROWSER_ENABLED`,
`PI_COMMAND_CODE_BROWSER_ALLOWED_MODELS`,
`PI_COMMAND_CODE_BROWSER_ALLOWED_CWD_ROOTS`, `PI_COMMAND_CODE_BROWSER_AUTH_FILE`,
`PI_COMMAND_CODE_BROWSER_RUNTIME_ROOTS`,
`PI_COMMAND_CODE_BROWSER_EGRESS_EXECUTABLE_PATH`,
`PI_COMMAND_CODE_BROWSER_DNS_CONFIG`, `PI_COMMAND_CODE_BROWSER_CA_CERTIFICATES`,
`COMMAND_CODE_EXPECTED_VERSION`, and the three
`PI_COMMAND_CODE_BROWSER_VALIDATION_*` entries (`.env.example:302-304`), together
with `parseModelAllowlist` if it has no other caller.

**Documentation** — Command Code is the only runtime with no canonical doc:

- Create `docs/COMMAND-CODE-INTEGRATION.md` covering: what the runtime is, the
  one-subprocess invocation, the denylist catalogue and how to refresh the effort
  table, the eight env vars, the error codes, and how to validate. Keep it the
  length of `docs/ANTIGRAVITY-INTEGRATION.md`, not longer.
- Add a Command Code row to the "If you need to change X, read Y" table in
  `AGENTS.md`, then run `npm run docs:sync-agent-guides` and
  `npm run docs:check-agent-guides` so `CLAUDE.md` stays byte-identical.
- Strip sandbox/attestation/shadow language from `docs/ARCHITECTURE.md`,
  `docs/RUNTIME-OVERVIEW.md`, `docs/INTERNAL-API.md`, `docs/LIVE-VALIDATION.md`
  and `docs/INTERNAL-API-ORCHESTRATION.md`.
- The four superseded plan files are already deleted; if any document still links
  to them, repoint it at this plan.
- Run `npm run docs:check-links`.

## 6. Simplicity gates (blocking)

These fail the task if unmet:

| Gate | Threshold |
|---|---|
| `wc -l server/src/command-code/*.ts` total | **≤ 2,200** (from 4,423) |
| `grep -ric "bwrap\|slirp4netns\|unshare-net\|bubblewrap\|attestation\|shadow" server/src client/src scripts .env.example` | **0** |
| Command Code env vars in `.env.example` | **8** |
| `CommandCodePermissionProfile` values | **0** (type deleted) |
| Effort fields in `protocol.ts` | **3** |
| Model catalogues in `command-code-model-catalog.ts` | **1** denylist |
| Subprocesses spawned per browser session | **1** |

## 7. Validation ladder

Run in this order. Steps 1-6 are blocking; step 8 needs fresh approval.

1. `npm run lint && npm run typecheck && npm run build`
2. `npm test` (server, client, shared, `packages/internal-api-mcp`)
3. The §6 simplicity gates, as a shell check pasted into the final report
4. `npm run docs:check-agent-guides && npm run docs:check-links`
5. **Real browser turn.** Start a disposable validation server per
   `docs/LIVE-VALIDATION.md` with `COMMAND_CODE_ENABLED=true` and an isolated
   `PI_AGENT_DIR`/prefs (see `docs/SHARP-EDGES.md` — a shared-env server will
   touch production Pi state). Drive the real UI with `webapp-testing`:
   open New Session → Command Code → assert the dropdown has 35 options and no
   excluded id → select a **non-first** model → assert it is still selected after
   the list re-renders → assert the effort selector matches that model → switch to
   `deepseek/deepseek-v4-flash` → create → send "Reply with the word READY and
   nothing else." → assert real provider text arrives → reload → assert replay.
   Capture screenshots.
6. **Real Internal API turn.** Against the same disposable socket:
   `GET /api/v1/models?runtime=commandcode` (assert 35, no excluded ids, effort
   metadata present) → create with `deepseek/deepseek-v4-flash` and **no**
   attestation → prompt → assert terminal receipt + transcript with the exact
   model → `DELETE` → assert the process is gone.
7. `git status --short`, `git diff --stat`, `git diff --check`, and an explicit
   scan of every changed path for tokens, cookies, auth files, session dumps or
   local machine paths. Then commit and push on the current branch. **Do not
   create a branch.**
8. Ask the operator for fresh approval, then `sudo systemctl restart
   pi-web-ui.service` once, set `COMMAND_CODE_ENABLED=true` in the production
   env, and read back the live behaviour (see `prod-deploy-topology`: systemd
   `pi-web-ui.service` on port 3456 is production).

Real validation uses only eligible models. Automatic top-up/reload stays
disabled. **Any billing or upgrade prompt stops the run and is reported.**

## 8. Definition of done

Operator-verifiable, in the real Web UI:

1. The Command Code model dropdown lists 35 models and none of the 19 excluded.
2. Selecting any model — including one that is not first in the list — **keeps**
   that model selected.
3. The effort selector shows exactly that model's native options, or is absent
   when the model has none.
4. Creating a session and sending a prompt returns **real provider text**.
5. Reloading the page replays the session with the same model and effort.
6. The Internal API creates, prompts and returns a receipt for the same model
   without any attestation.
7. `wc -l server/src/command-code/*.ts` totals ≤ 2,200.
8. `npm run lint`, `typecheck`, `build`, `test`, `docs:check-agent-guides` and
   `docs:check-links` all pass.
9. The change is committed and pushed on `master`; production is untouched until
   step 8 of §7 is separately approved.

## 9. Stop conditions

Stop and ask the operator only if:

- the installed CLI stops advertising models entirely, or `--list-models` fails;
- Command Code demands an upgrade, premium credit or automatic top-up;
- a required deletion turns out to have a live non-Agent-OS consumer that would
  break;
- production restart or configuration is needed before approval;
- another agent holds uncommitted work in the same files.

**Do not** introduce a sandbox, helper process, daemon, namespace, allowlist,
attestation, capability hash, readiness gate or new abstraction to work around a
failure. Every one of those has already been tried and is the reason this plan
exists. Diagnose the direct subprocess path first, and if a simplification looks
impossible, ask rather than rebuild.
