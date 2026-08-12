# Execution Plan — Pi Web UI Internal API MCP MVP

> **Status:** completed experimental proof, then retired on 2026-08-12. Local wire, disposable real-runtime, and external ChatGPT Secure MCP Tunnel validation passed. The plugin, local tunnel credentials/profile, disposable state, and all experiment processes were removed. Source and tests are retained but inactive; production tunnel/service enablement was never performed.
>
> **Audience:** a highly capable execution agent working in `/root/pi-web-ui`.
>
> **Prime directive:** build a small, secure, separately launched TypeScript MCP
> server inside this repository, prove every behaviour test-first, then activate
> the compiled MCP process and connect to it for both deterministic local wire
> validation and disposable real-runtime validation. **Do not claim completion
> from unit tests alone.**

---

## 1. Goal

Add a private npm workspace at:

```text
/root/pi-web-ui/packages/internal-api-mcp
```

The workspace will expose a deliberately narrow set of MCP tools over **stdio**.
Those tools will call Pi Web UI's existing authenticated Internal API over its
Unix domain socket. The adapter must let an MCP-capable client discover Pi Web
UI capabilities/models, create a session on one of the four ordinary runtime
families, dispatch detached work, inspect the durable run receipt, and read the
result.

Target topology:

```text
ChatGPT Work/Codex or another MCP client
                 │ MCP over stdio
                 ▼
@pi-web-ui/internal-api-mcp (separate process)
                 │ HTTP over Unix socket + local bearer token
                 ▼
Pi Web UI Internal API
                 ├── Pi
                 ├── Claude
                 ├── OpenCode
                 └── Antigravity
```

For ChatGPT integration, OpenAI Secure MCP Tunnel can launch this stdio server
with `tunnel-client --mcp-command ...`. The code and mandatory local validation
must not depend on OpenAI credentials, but the execution plan includes a separate
operator-authorized external end-to-end phase after local gates pass.

### Success in one sentence

A fresh MCP client can spawn the compiled server, list the locked MVP tools,
create and prompt a real session through a disposable Pi Web UI server, observe
a terminal run receipt, and retrieve a transcript containing a unique marker —
with the production service/socket/session state untouched and no secret written
to MCP output or the repository.

---

## 2. Decisions already made

Do not re-litigate or silently expand these decisions.

| Area | Locked decision | Consequence |
|---|---|---|
| Repository | Same repository | Add a new isolated npm workspace, not a new repository. |
| Process boundary | Separate process | Do not mount MCP routes in the main Express app and do not import runtime services. |
| MCP transport | **stdio only** | No HTTP/SSE/WebSocket listener in the MVP. Compatible with local clients and Secure MCP Tunnel's `--mcp-command`. |
| Internal transport | Existing Unix socket | Use the contracted `/api/v1` Internal API; never bypass it by importing implementation classes. |
| Authentication | Token file only | Read the local Internal API token from a configured file. Never accept the token as an MCP tool argument or print it. |
| Runtime scope | Pi, Claude, OpenCode, Antigravity | Exclude feature-gated Command Code from the MVP. |
| Interaction shape | Detached orchestration | Prompt calls always use `verbosity:"answers"`, `mode:"prompt"`, `detach:true`. Do not hold an MCP call open for a long agent turn. |
| Validation | Disposable only | Live validation must use `npm run validate:server` with explicit non-production socket/token paths. |
| Delivery | MVP | Seven tools only; no generic proxy or explicit delete/abort/control surface. Dispatch remains potentially destructive. |
| API contract | No Internal API change | Do not bump the Internal API contract merely for adding a consumer. |
| External exposure | OpenAI Secure MCP Tunnel | Outbound HTTPS only; do not allocate or open an inbound MCP port. |

### Why stdio is the correct MVP transport

- It keeps the MCP server private and creates no new listening port.
- The official MCP TypeScript SDK has a standard stdio server transport.
- OpenAI Secure MCP Tunnel can launch a local stdio MCP command from this host.
- Deterministic tests can spawn the real compiled process and speak MCP to it.
- Network exposure, OAuth, remote MCP HTTP authentication, and public plugin
  publication remain out of scope; private ChatGPT reachability is provided by
  the official outbound Secure MCP Tunnel instead.

---

## 3. Read before changing code

Read these completely before implementation:

### Repository rules and architecture

- `/root/pi-web-ui/AGENTS.md`
- `/root/pi-web-ui/CLAUDE.md`
- `/root/pi-web-ui/SECURITY.md`
- `/root/pi-web-ui/docs/ARCHITECTURE.md`
- `/root/pi-web-ui/docs/CODEBASE-MAP.md`

Remember: `AGENTS.md` and `CLAUDE.md` must remain byte-identical if either is
touched. This implementation should not need to change them.

### Internal API contract and orchestration

- `/root/pi-web-ui/docs/INTERNAL-API.md`
- `/root/pi-web-ui/docs/INTERNAL-API-CONTRACT.md`
- `/root/pi-web-ui/docs/INTERNAL-API-ORCHESTRATION.md`
- `/root/pi-web-ui/docs/LIVE-VALIDATION.md`
- `/root/pi-web-ui/docs/OBSERVABILITY.md`

Key facts to preserve:

- default production socket: `~/.pi-web-ui/internal-api.sock`;
- default token: `~/.pi-web-ui/internal-api-token`;
- socket mode: owner-only;
- the API is trusted same-host multi-client, **not** multi-tenant;
- possession of the token grants control over all sessions;
- callers must inspect `/capabilities` before dispatch;
- detached prompts return durable `runId` receipts;
- validation must never target production by default.

### MCP implementation references

Use the installed/current official `@modelcontextprotocol/sdk` API rather than
copying stale examples. The execution agent must verify the exact import and
registration signatures in the installed package before implementation. Expected
building blocks include:

- `McpServer`;
- `StdioServerTransport`;
- the SDK client and `StdioClientTransport` for validation;
- Zod schemas;
- MCP tool annotations such as `readOnlyHint`, `destructiveHint`,
  `idempotentHint`, and `openWorldHint` where supported by the pinned SDK.

Add `@modelcontextprotocol/sdk` as a **direct** dependency of the new workspace;
do not rely on a transitive copy already present in `package-lock.json`.

---

## 4. MVP tool contract

Expose **exactly these seven tools**. Names and boundaries are part of the MVP
acceptance contract.

### 4.1 `pi_web_ui_get_capabilities`

**Input**

```json
{}
```

**Internal API**

```text
GET /api/v1/capabilities
```

**Purpose**

- Verify contract identity and current runtime availability.
- Return only the four ordinary runtime capabilities and the automation provider
  policy. Omit Command Code and future unknown runtime fields from the projection.

**Annotation**

- read-only;
- non-destructive;
- closed-world/local.

### 4.2 `pi_web_ui_list_models`

**Input**

```json
{
  "runtime": "pi | claude | opencode | antigravity (optional)"
}
```

**Internal API**

```text
GET /api/v1/models[?runtime=<encoded-runtime>]
```

**Purpose**

- Return only models currently advertised by the Internal API.
- Preserve exact model selectors, including `profile:<id>` Claude selectors.
- Do not expose Command Code entries even if that feature is enabled.

**Annotation:** read-only, non-destructive, closed-world/local.

### 4.3 `pi_web_ui_list_sessions`

**Input**

```json
{}
```

**Internal API**

```text
GET /api/v1/sessions
```

**Purpose**

Return a bounded metadata projection suitable for selecting an existing session:

- canonical `sessionId`;
- runtime;
- status;
- model/model selector when present;
- creation/last-activity timestamps;
- a bounded first-message preview only if already supplied by the endpoint.

Do not return runtime-native transcript paths, token paths, credentials,
diagnostic payloads, or filesystem locators.

**Annotation:** read-only, non-destructive, closed-world/local.

### 4.4 `pi_web_ui_create_session`

**Input**

```json
{
  "runtime": "pi | claude | opencode | antigravity",
  "model": "optional exact selector returned by pi_web_ui_list_models"
}
```

**Internal API**

```text
POST /api/v1/sessions
```

**Locked behaviour**

- Accept only the four ordinary runtime values.
- Optional `model` is bounded to 200 characters, matching the upstream Internal
  API create-session contract.
- Do not accept `cwd`, profile-specific parallel fields, retention, pinning,
  thinking level, native effort, invocation role, environment, executable paths,
  or raw request fragments as tool input.
- If `PI_WEB_UI_MCP_DEFAULT_CWD` is configured at process start, send that fixed
  value; otherwise omit `cwd` and let Pi Web UI apply its server default.
- Return the canonical session id, runtime, model selector and created-at data.

**Annotation:** write action, non-destructive, non-idempotent, closed-world/local.
ChatGPT should therefore require confirmation by default.

### 4.5 `pi_web_ui_dispatch_prompt`

**Input**

```json
{
  "sessionId": "canonical UUID",
  "message": "1..16000 characters",
  "idempotencyKey": "optional 1..128 character key"
}
```

**Internal API**

```text
POST /api/v1/sessions/:sessionId/prompt
```

**The adapter must construct, not accept, these fields**

```json
{
  "verbosity": "answers",
  "mode": "prompt",
  "detach": true
}
```

**Locked behaviour**

- Encode `sessionId` as a path segment even after schema validation.
- Forward an optional valid idempotency key; if omitted, generate a UUID for the
  call and return the used key so the caller can reuse it on a deliberate retry.
- Return immediately with `sessionId`, `runId`, detached/duplicate state, receipt
  summary when present, and the idempotency key used.
- Do not implement synchronous answers, SSE streaming, `follow_up`, `steer`,
  batch prompt, or arbitrary verbosity in the MVP.

**Annotation:** write action, **potentially destructive**,
idempotency-supported, closed-world/local. A prompt can cause runtime tools to
modify files, access services, or incur provider cost. MCP annotations and client
confirmation UX are advisory safeguards, not an authorization boundary.

### 4.6 `pi_web_ui_get_run`

**Input**

```json
{
  "runId": "canonical UUID"
}
```

**Internal API**

```text
GET /api/v1/runs/:runId
```

**Purpose**

Return a payload-free receipt projection:

- run/session/runtime/model identity;
- status and lifecycle timestamps;
- stable error code/hint when present;
- token usage when present;
- `outputEvidence`;
- bounded liveness/cessation summary.

Do not invent success from terminality. Preserve `no-text`, `unknown`,
`unconfirmed`, and failure states honestly.

**Annotation:** read-only, non-destructive, closed-world/local.

### 4.7 `pi_web_ui_get_transcript`

**Input**

```json
{
  "sessionId": "canonical UUID",
  "scope": "visible_recent | visible_full (optional; default visible_recent)"
}
```

**Internal API**

```text
GET /api/v1/sessions/:sessionId/transcript?scope=<encoded-scope>
```

**Purpose**

- Read runtime-neutral visible output after checking the run receipt.
- Apply separate transport and tool-output ceilings:
  - if the raw Internal API HTTP body exceeds its receive ceiling before parsing,
    abort and return a bounded `RESPONSE_TOO_LARGE` error; do not claim an exact
    original size or excerpt from an incomplete body;
  - after a valid response is parsed and projected, if the selected transcript
    content exceeds the MCP tool-output ceiling, return an explicit structured
    truncation result with the exact projected byte count and a UTF-8-safe
    excerpt.
- Never emit malformed or byte-chopped JSON.

Transcript content is intentionally user/agent content and may be sensitive.
Document that clearly; do not falsely label it sanitized.

**Annotation:** read-only, non-destructive, closed-world/local.

---

## 5. Explicitly out of scope

Do not add any of these to the MVP:

- a generic `request`, `fetch`, `curl`, or arbitrary-path tool;
- MCP HTTP, SSE, WebSocket, or public ingress;
- OAuth implementation;
- public MCP endpoint creation or live ChatGPT installation automation;
- silently creating an OpenAI tunnel, Platform API key, firewall rule, or
  production service without the operator-authorized external phase;
- Command Code runtime or role attestations;
- session delete, abort, control, model refresh, transfer, batch, watch,
  notifications, approvals, diagnostics, evidence, or raw history tools;
- arbitrary cwd or filesystem access;
- exposing the Internal API token or accepting it from MCP input;
- parent/child orchestration state or a scheduler;
- a new database, queue, or background daemon;
- changes to browser WebSocket/shared runtime protocol;
- production deployment, production restart, or production live validation.

A narrow adapter is a feature, not a deficiency. Expand only after the MVP has
proved the ChatGPT tool-call path and the maintainer approves a second scope.

---

## 6. Proposed workspace and files

Use this shape unless repository facts discovered during implementation require
a small justified adjustment:

```text
packages/internal-api-mcp/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md
├── src/
│   ├── index.ts                  # shebang + bootstrap only
│   ├── server.ts                 # construct/register MCP server
│   ├── config.ts                 # validated process configuration
│   ├── internal-api-client.ts    # fixed-operation Unix-socket client
│   ├── internal-api-types.ts     # narrow DTOs used by this adapter
│   ├── tool-schemas.ts           # strict Zod input schemas
│   ├── tools.ts                  # exact seven tool registrations
│   ├── projections.ts            # bounded, secret-safe output projections
│   └── errors.ts                 # stable internal error normalization
├── tests/
│   ├── config.test.ts
│   ├── internal-api-client.test.ts
│   ├── projections.test.ts
│   ├── tools.test.ts
│   └── stdio-protocol.test.ts
└── scripts/
    ├── validate-wire.ts          # fake-UDS + real compiled MCP process
    └── validate-live.ts          # explicit disposable socket + real runtime
```

Expected repository edits:

- `/root/pi-web-ui/package.json`
  - add `packages/internal-api-mcp` to workspaces;
  - include the workspace in root build/typecheck/test/coverage scripts;
  - add root convenience commands for MCP start/wire/live validation.
- `/root/pi-web-ui/package-lock.json`
  - generated npm workspace/dependency changes only.
- `/root/pi-web-ui/API.md`
  - index/link the MCP adapter; do not describe it as a new network API;
  - if its displayed Internal API contract version is stale, correct it from the
    canonical contract document while touching the file.
- `/root/pi-web-ui/docs/CODEBASE-MAP.md`
  - add the workspace and its boundary.
- `/root/pi-web-ui/docs/INTERNAL-API.md`
  - add a short local-consumer note linking to the MCP guide; do not duplicate
    the full MCP contract.
- `/root/pi-web-ui/docs/LIVE-VALIDATION.md`
  - document the disposable MCP validation command and safety boundary.
- `/root/pi-web-ui/docs/MCP-SERVER.md`
  - canonical operator/developer guide.
- `/root/pi-web-ui/docs/MAINTAINER-INDEX.md`
  - link the canonical MCP guide if consistent with the index structure.

No existing file under `server/src/internal-api/` should need functional changes.
If the agent believes one is required, it must stop, show the missing contract,
and obtain approval before widening scope.

### Workspace package expectations

Use a private ESM package such as:

```json
{
  "name": "@pi-web-ui/internal-api-mcp",
  "private": true,
  "type": "module",
  "bin": {
    "pi-web-ui-internal-api-mcp": "dist/index.js"
  }
}
```

Required scripts:

- `build`;
- `typecheck`;
- `test`;
- `test:coverage`;
- `start`;
- `validate:wire`;
- `validate:live`.

Align TypeScript, Vitest and Zod versions with repository-compatible versions.
Add the MCP SDK as a direct dependency and inspect the lockfile diff for
unexpected dependency churn.

---

## 7. Configuration and startup safety

### 7.1 Supported process configuration

Use adapter-specific environment variables:

| Variable | Default | Rule |
|---|---|---|
| `PI_WEB_UI_MCP_SOCKET_PATH` | `~/.pi-web-ui/internal-api.sock` | Absolute Unix-socket path. |
| `PI_WEB_UI_MCP_TOKEN_PATH` | `~/.pi-web-ui/internal-api-token` | Absolute regular owner-only token file. |
| `PI_WEB_UI_MCP_DEFAULT_CWD` | omitted | Fixed process-level cwd sent on create; never an MCP argument. |
| `PI_WEB_UI_MCP_TIMEOUT_MS` | bounded sensible default, e.g. 15s | Per Internal API request, not agent-run completion. |
| `PI_WEB_UI_MCP_MAX_RESPONSE_BYTES` | bounded sensible default, e.g. 1 MiB | Hard receive ceiling before projection. |
| `PI_WEB_UI_MCP_MAX_TOOL_OUTPUT_BYTES` | bounded sensible default, e.g. 128 KiB | Serialized MCP tool result ceiling. |

Validate numeric ranges. Reject empty, relative, malformed, or unreasonably large
values. Expand `~` only in configuration code, never in tool arguments.

### 7.2 Filesystem checks

Before **every** Internal API request, fail closed if:

- the socket path is absent, a symlink, not a Unix socket, not owned by the MCP
  process uid, or has any group/world permission bits;
- the token path is absent, a symlink, not a regular file, not owned by the MCP
  process uid, or has any group/world permission bits;
- token content is empty or exceeds a small maximum.

Read the token through a securely opened descriptor (`O_NOFOLLOW` where the
platform supports it), then `fstat` and compare its `(dev, ino, uid, mode)` with
an immediate `lstat`. Capture the socket `(dev, ino, uid, mode)` immediately
before connecting and re-check it after the request; fail the operation if the
pathname identity changed. Node cannot make a pathname-based Unix-socket API
perfectly race-free against a malicious same-uid process, and a same-uid process
can already read the token, but the adapter must detect ordinary replacement and
symlink races rather than relying on one startup check. Add deterministic tests
for token/socket replacement between validation and use.

Disposable validation paths must pass the same checks.

### 7.3 Logging

- **stdout is reserved exclusively for MCP JSON-RPC traffic.**
- Send bounded lifecycle/error diagnostics to stderr only.
- Never log bearer headers, token contents, prompts, transcript bodies, cookies,
  session dumps, or full raw Internal API response bodies.
- Error logs should include low-cardinality operation names and stable error
  codes, not sensitive payloads.

---

## 8. Internal API client design

Implement the smallest typed client needed by the seven tools.

### Required properties

1. Use Node's HTTP client with `socketPath`; do not expose a TCP fallback.
2. Export named operations, not a public generic request method:
   - `getCapabilities()`;
   - `listModels(runtime?)`;
   - `listSessions()`;
   - `createSession(input)`;
   - `dispatchPrompt(sessionId, input)`;
   - `getRun(runId)`;
   - `getTranscript(sessionId, scope)`.
3. Construct every route internally from constants and encoded identifiers.
4. Add `Authorization: Bearer <token>` internally.
5. Enforce request deadline and abort the socket on timeout/cancellation.
6. Enforce a response byte ceiling while streaming, before JSON parsing.
7. Reject non-JSON success responses.
8. Preserve HTTP status plus stable Internal API `code`, `hint`, and `docs` when
   present; do not pass arbitrary raw error bodies to MCP.
9. Validate the important response shapes with Zod or equivalent narrow parsing.
10. Before each tool operation, verify contract identity via `/capabilities`:
    - `contract.name === "pi-web-ui-internal-api"`;
    - `contract.routePrefix === "/api/v1"`;
    - `contract.majorVersion === "v1"`.
11. Parse `contractVersion` as semver and require at least `1.6.0`, because the
    locked MVP depends on durable `runId`, idempotent dispatch and
    `GET /runs/:runId`. Treat liveness fields as optional before `1.14.0` and
    `outputEvidence` as optional before `1.19.0`; never fabricate either.
12. Do not cache compatibility across tool calls. The check is a cheap local
    Unix-socket request and this avoids trusting a restarted/replaced server.
13. Propagate MCP request cancellation to the Internal API HTTP request where the
    SDK provides an abort signal.

Do not require exact contract version `1.19.0` for ordinary operation. This
adapter consumes `/api/v1`; additive minor versions at or above the minimum
should remain usable. The mandatory live validation in this repository should
run against current contract `1.19.0+` so it can assert output evidence.

---

## 9. MCP response and error contract

### Successful tools

Prefer MCP structured output when supported cleanly by the pinned SDK. Also
include a concise JSON text content block for broad client compatibility. The
text must be valid JSON, not prose wrapped around JSON.

Each result should include an adapter envelope such as:

```json
{
  "ok": true,
  "tool": "pi_web_ui_get_run",
  "data": {}
}
```

### Failed tools

Return `isError: true` with a bounded envelope:

```json
{
  "ok": false,
  "tool": "pi_web_ui_dispatch_prompt",
  "error": {
    "code": "SESSION_BUSY",
    "message": "The session is currently busy.",
    "retryable": true,
    "retryAfterSeconds": 2
  }
}
```

Requirements:

- distinguish schema/input errors, incompatible contract, transport timeout,
  authentication failure, Internal API rejection, and oversized response;
- preserve stable Internal API codes where safe;
- never include token/header values or raw stack traces;
- do not convert `failed`, `cancelled`, `interrupted`, `no-text`, `unknown`, or
  `unconfirmed` into success prose;
- do not retry mutating requests automatically inside the adapter;
- let the caller retry `dispatch_prompt` deliberately using the returned
  idempotency key.

---

## 10. TDD order of work — mandatory

Use strict red → verify red → green → verify green → refactor for every behaviour.
No production implementation before its failing test. Minimal build/test config
may be scaffolded only far enough to execute the first failing test.

The execution report must retain a concise RED/GREEN ledger: test name, expected
failure reason, and focused passing command. A test that passed on first run is
not RED evidence and must be corrected before implementation proceeds.

### Increment 1 — workspace and configuration

**RED tests**

- default path expansion produces absolute expected paths;
- explicit disposable paths override defaults;
- relative paths are rejected;
- empty/out-of-range numeric configuration is rejected;
- token symlink/non-regular/world-readable/wrong-owner cases fail closed;
- socket symlink/non-socket/non-owner-only/wrong-owner cases fail closed;
- token or socket inode replacement between check and use fails closed.

**GREEN**

Implement only config parsing and filesystem guard helpers.

### Increment 2 — fixed Unix-socket HTTP client

**RED tests against a fake owner-only Unix-socket HTTP server**

- sends the expected method and exact fixed route;
- sends the bearer token read from the file;
- percent-encodes identifiers/query values;
- parses a valid bounded JSON response;
- maps a structured Internal API error without leaking raw response data;
- times out and closes a stalled request;
- rejects oversized response bodies before parsing;
- rejects malformed/non-JSON success bodies;
- supports cancellation;
- rejects incompatible contract identity.

**GREEN**

Implement named client methods and the minimum internal shared transport.

### Increment 3 — projections and secret boundaries

**RED tests**

- session projection omits native paths and unknown fields;
- model projection excludes Command Code;
- receipt projection preserves failure/liveness/output-evidence distinctions;
- raw HTTP body overflow returns a bounded error without pretending to know the
  unseen original size;
- post-parse transcript tool-output overflow remains valid JSON, reports exact
  projected bytes, and never splits a UTF-8 character;
- sentinel bearer tokens, cookies, local token paths and fake credentials never
  appear in projected errors or metadata;
- list output has deterministic count/size bounds.

**GREEN**

Implement explicit allowlist projections. Do not use object spread from raw API
responses into MCP results.

### Increment 4 — tool schemas and handlers

Write handler tests with an injected fake typed client, not a mocked MCP wire.

**RED tests**

- tool catalogue is exactly the seven locked names;
- all schemas reject unknown keys (`strict` schemas);
- runtime enum excludes Command Code;
- IDs, model selector, message and idempotency key enforce bounds;
- create-session cannot supply cwd/control/retention/raw fields;
- dispatch always constructs `answers + prompt + detach:true`;
- omitted idempotency key is generated and returned;
- read tools carry read-only annotations;
- create-session is a write action and dispatch is explicitly marked potentially
  destructive; neither is incorrectly marked read-only;
- tests state that annotations/confirmation are advisory and are not treated as
  server-side authorization;
- Internal API stable errors become `isError:true` results;
- handlers never throw raw secrets/stacks into MCP output.

**GREEN**

Register the seven tools with the minimum handler logic.

### Increment 5 — real stdio protocol

**RED subprocess/SDK-client tests**

Spawn the compiled or source entrypoint as a subprocess and verify:

- MCP `initialize` succeeds and reports stable server name/version;
- `tools/list` returns exactly seven tools with schemas and annotations;
- a read tool call traverses MCP → fake Unix socket → MCP result;
- invalid tool arguments return a protocol-valid tool error;
- unknown tools receive the expected MCP error;
- stdout contains no banner or non-protocol data;
- stderr contains no sentinel token/prompt/transcript;
- client close leads to clean bounded server shutdown.

**GREEN**

Add `McpServer`, tool registration and `StdioServerTransport` bootstrap. Keep
`src/index.ts` tiny and preserve the executable shebang in `dist/index.js`.

### Increment 6 — validation runners

Write tests for the validation scripts' target-safety parsing before allowing
live use:

- missing `--socket` or `--token-path` fails;
- the canonical production socket or token path fails unconditionally;
- there is no `--allow-production` escape hatch;
- explicit temporary paths pass;
- cleanup is attempted on success, assertion failure and timeout;
- reports redact tokens and transcript bodies.

Only after these tests are red/green may the agent run the validators.

---

## 11. Mandatory validation layer A — local MCP wire proof

Add a deterministic root command, suggested:

```bash
npm run validate:mcp:wire
```

This is not just another unit test. It must:

1. Build the MCP workspace.
2. Create a temporary `0700` directory.
3. Create a sentinel token file with `0600` mode.
4. Start a fake Internal API HTTP server on an owner-only Unix socket.
5. Spawn the **compiled** `dist/index.js` MCP server with explicit temporary
   socket/token environment variables.
6. Connect using the official MCP SDK client over stdio.
7. Perform MCP initialization.
8. Call `tools/list` and assert exactly the seven locked tools, including
   read-only annotations on read tools and a potentially-destructive annotation
   on dispatch.
9. Call at least:
   - `pi_web_ui_get_capabilities`;
   - `pi_web_ui_list_models`;
   - `pi_web_ui_list_sessions`.
10. Assert the fake API observed:
    - correct fixed paths/methods;
    - correct bearer auth;
    - no unexpected endpoint.
11. Exercise one rejected schema and one structured API failure.
12. Close client/server, confirm bounded clean exit, and remove the temp directory.
13. Scan captured stdout/stderr/report text for the sentinel token and fail if it
    appears.

### Required wire-validation evidence

The command should print a concise, secret-free report containing:

- MCP protocol/client initialization success;
- server name/version;
- exact tool count and names;
- fake socket path under `/tmp` (never the token);
- fixed-route assertions passed;
- schema/error assertions passed;
- stdout protocol cleanliness passed;
- secret sentinel scan passed;
- cleanup passed.

A handler called directly in-process is **not** sufficient for this gate.

---

## 12. Mandatory validation layer B — disposable real-runtime proof

A green fake-wire test is still insufficient. The execution agent must activate
the MCP server and drive a real Pi Web UI runtime through it.

### 12.1 Safety contract

- Never target `~/.pi-web-ui/internal-api.sock`.
- Never read `~/.pi-web-ui/internal-api-token` for validation.
- Never add an `--allow-production` option to the MCP live validator.
- Never stop, restart, redeploy or reconfigure `pi-web-ui.service`.
- Start `npm run validate:server` with a unique temporary directory.
- Antigravity is not disposable-safe; do not select it for this validation.
- Prefer Pi for the MVP proof. If Pi is unavailable for a genuine environmental
  reason, use Claude or OpenCode and state the exact reason/runtime. At least one
  real runtime must complete before victory.
- State truthfully that a disposable server isolates Pi Web UI production
  service/socket/registry/session state but can reuse real provider
  authentication and model resources; a live turn may have real provider-side
  effects or cost.

### 12.2 Live validator interface

Add a command such as:

```bash
npm run validate:mcp:live -- \
  --socket /tmp/<validation-dir>/internal-api.sock \
  --token-path /tmp/<validation-dir>/internal-api-token \
  --runtime pi
```

The command must require both explicit paths and refuse production-equivalent
resolved paths. It must spawn the compiled MCP process itself and connect via the
MCP SDK client; it must not call tool handlers directly.

### 12.3 Required real sequence — all orchestration actions through MCP

1. Start a disposable validation server and retain its PID, socket, token path,
   validation directory and logs.
2. Build the MCP workspace.
3. Spawn the MCP process with the disposable socket/token env values.
4. Initialize an MCP client over stdio.
5. Call `pi_web_ui_get_capabilities`.
   - Assert contract name/major version.
   - Assert selected runtime is available.
6. Call `pi_web_ui_list_models` for the selected runtime.
   - Choose an actually advertised, automation-allowed model or omit the model
     only when the runtime's documented default is appropriate.
7. Call `pi_web_ui_create_session`.
   - Record the returned canonical session id.
8. Generate a unique marker such as `MCP_LIVE_OK_<uuid>`.
9. Call `pi_web_ui_dispatch_prompt` with a minimal deterministic instruction:
   - ask the runtime to reply with the marker;
   - record returned `runId` and idempotency key;
   - assert detached acceptance.
10. Poll `pi_web_ui_get_run` with bounded backoff and an absolute deadline.
    - Require a terminal successful receipt;
    - for ordinary Pi work, require correct `agent_end`-backed completion evidence;
    - require `outputEvidence.disposition === "text"` when the contract supplies it;
    - fail honestly on `failed`, `cancelled`, `interrupted`, stalled, timeout,
      `no-text`, or `unknown` evidence.
11. Call `pi_web_ui_get_transcript` only after terminal receipt evidence.
    - Assert the marker is present;
    - do not print the full transcript in the validation report.
12. After a short bounded grace interval, read the receipt and transcript again.
    Require terminal status/output evidence and transcript marker/hash or counts
    to remain unchanged across the two observations. Scope the claim to stable
    gateway/transcript evidence; do not infer arbitrary nested-process or
    external-side-effect quiescence.
13. Close the MCP client and process cleanly.
14. Clean up the created session through a narrowly scoped **direct disposable
    Internal API cleanup request**. Do not add a delete MCP tool merely for tests.
15. Stop the disposable validation server and remove its directory.

### 12.4 Required live evidence report

The validator/final implementation report must include, without secrets or raw
prompt/transcript bodies:

```text
✅ MCP LIVE-VALIDATED
Ran on: disposable Pi Web UI validation server (production service/socket/session state untouched; real provider auth/model resources may be used)
MCP transport: compiled stdio process + official SDK client
Contract: pi-web-ui-internal-api / v1 / <contractVersion>
Runtime/model: <selected runtime> / <selected model>
Session: <canonical UUID>
Run: <run UUID>
Dispatch: detached accepted
Receipt: completed, outputEvidence=text, agent_end=<timestamp when applicable>
Transcript assertion: unique marker observed and stable across bounded repeat read
Cleanup: session removed, MCP exited, validation server stopped, temp dir removed
```

The validation command must exit non-zero if any assertion or cleanup step fails.
If the environment lacks valid credentials or no disposable runtime can complete,
report **BLOCKED**, preserve diagnostics, and do not claim live validation.

### 12.5 Operator-authorized external end-to-end phase — Secure MCP Tunnel

Local validation proves the MCP implementation. It does not prove that the
operator's ChatGPT workspace can discover or invoke it. After all local gates
pass, perform this separate phase when the operator supplies/authorizes the
required OpenAI Platform and ChatGPT workspace prerequisites.

#### No inbound port is required

The intended network path is:

```text
ChatGPT/OpenAI
      │ OpenAI-hosted tunnel endpoint
      ▼
tunnel-client on this Linux host
      │ outbound HTTPS long-poll/response traffic
      │ TCP 443 to api.openai.com
      │ (or mtls.api.openai.com when explicitly configured)
      ▼
local stdio MCP child process
      │ Unix socket (no TCP)
      ▼
Pi Web UI Internal API
```

Therefore:

- do **not** search for or reserve a free public port;
- do **not** bind the MCP server to `0.0.0.0` or `::`;
- do **not** add `ufw allow <port>` or any inbound firewall rule;
- do **not** expose the Internal API socket through a TCP proxy;
- keep any `tunnel-client` admin UI/metrics listener loopback-only;
- the only required internet path is outbound DNS plus TCP 443 to the OpenAI
  tunnel control plane.

At plan-authoring time, this execution namespace had no `ufw`, `nft`, or
`iptables` binary visible, `tunnel-client` was not installed, and an HTTPS probe
to `https://api.openai.com/v1/models` returned HTTP `401` — proving DNS/TLS/
outbound 443 reachability without credentials. The host may enforce UFW outside
this namespace, so the execution agent must re-check the actual deployment host
rather than assuming there is no firewall.

#### Firewall and network preflight

Run and capture:

```bash
command -v ufw || true
sudo ufw status verbose             # when ufw exists on the actual host
ss -ltnp                            # informational only; no MCP port is selected
curl -sS -o /dev/null -w '%{http_code}\n' \
  --connect-timeout 10 --max-time 15 \
  https://api.openai.com/v1/models
```

Accept `401` from the unauthenticated probe as successful network reachability.
Do not send or print a real API key in this probe.

If UFW reports the normal `allow (outgoing)` default, make **no firewall change**.
If outbound traffic is denied, stop and obtain explicit operator permission
before adding a narrowly explained outbound rule. The broad fallback command is:

```bash
sudo ufw allow out 443/tcp comment 'OpenAI Secure MCP Tunnel outbound HTTPS'
```

Use it only after approval and only when required. UFW does not provide durable
hostname-based filtering, while OpenAI endpoint IPs can change; do not hard-code
an IP from a one-time DNS lookup. If an upstream corporate/cloud firewall owns
egress, request allowlisting for `api.openai.com:443` (or
`mtls.api.openai.com:443`) there. Never add an inbound rule for this design.

#### OpenAI prerequisites and human checkpoint

The execution agent cannot manufacture these safely. Require the operator to
confirm/provide them through the official UI/secret mechanism:

1. a Platform `tunnel_id` created in OpenAI Platform tunnel settings;
2. the tunnel associated with the intended ChatGPT workspace and Platform
   organization;
3. Tunnels **Read + Use** permissions for the runtime identity;
4. a runtime Platform API key delivered without placing it in chat, logs, shell
   history, source control, or the plan;
5. ChatGPT developer-mode/plugin access in the target workspace.

If any prerequisite is unavailable, report external validation **BLOCKED** while
retaining the successful local-validation verdict. Do not weaken the design by
opening a public port.

#### Install and validate `tunnel-client`

- Install only from the latest official `openai/tunnel-client` release linked by
  OpenAI's Secure MCP Tunnel documentation.
- Do not use `curl | sh`, an unofficial package, or a hard-coded stale binary.
- Verify release checksum/signature when the release publishes one; record the
  version and source URL.
- Keep the runtime API key in an owner-only secret source (`0600` file or systemd
  credential), not an inline command or committed environment file.

Build the MCP package, then create a tunnel profile with explicit paths. For the
first external test, use a disposable Pi Web UI validation socket/token and keep
the validation server alive for the duration of the ChatGPT test:

```bash
export CONTROL_PLANE_API_KEY="$(< /secure/operator-provided-key-file)"

tunnel-client init \
  --profile pi-web-ui-mcp-disposable \
  --tunnel-id '<operator-provided-tunnel-id>' \
  --mcp-command 'env PI_WEB_UI_MCP_SOCKET_PATH=<explicit-disposable-socket> PI_WEB_UI_MCP_TOKEN_PATH=<explicit-disposable-token-file> node /root/pi-web-ui/packages/internal-api-mcp/dist/index.js'

tunnel-client doctor --profile pi-web-ui-mcp-disposable --explain
tunnel-client run --profile pi-web-ui-mcp-disposable
```

Use a secure non-history mechanism instead of the illustrative `export` where
available. Never print the key. The MCP command must contain explicit socket and
token-file paths so a typo cannot silently fall back to production.

#### External end-to-end acceptance sequence

1. Local wire and disposable real-runtime validations are already green.
2. Start the disposable validation server and tunnel profile.
3. In ChatGPT Plugins, create/select the developer-mode app using **Tunnel** and
   the intended `tunnel_id`.
4. Typed read-only smoke first:
   - call `pi_web_ui_get_capabilities`;
   - call `pi_web_ui_list_models`;
   - verify the disposable contract/runtime projection.
5. Typed write smoke after explicit confirmation:
   - create one disposable session;
   - dispatch a unique marker prompt;
   - poll the run and retrieve the marker transcript.
6. Desktop Voice proof, performed with the operator:
   - begin a new Voice conversation in Work/Codex with the app enabled;
   - ask Voice to call `pi_web_ui_get_capabilities`;
   - then explicitly approve one create/dispatch marker flow;
   - verify the matching session/run/receipt on the disposable server.
7. Do not claim direct mobile support: current ChatGPT plugin documentation says
   plugins are unavailable on mobile. Mobile can only reach this indirectly
   through a supported Remote desktop host until OpenAI changes that product
   boundary.
8. Remove the ChatGPT test app/profile if temporary, stop `tunnel-client`, stop
   the disposable server, and remove temporary credentials/state.

Required external report:

```text
✅ MCP EXTERNALLY LIVE-VALIDATED (or BLOCKED with exact prerequisite)
Exposure: OpenAI Secure MCP Tunnel, outbound HTTPS only
Inbound MCP port/UFW rule: none
Tunnel client: <version>, doctor=ready
Target: explicit disposable socket/token paths
Typed tools: capabilities/models/create/dispatch/run/transcript passed
Desktop Voice: <passed | blocked by plan/rollout/workspace>
Mobile direct MCP: unsupported by current ChatGPT product surface
Production service/socket/session state: untouched
Credential/log scan and cleanup: passed
```

#### Production enablement is a separate decision

After disposable external proof, do not repoint the tunnel at
`~/.pi-web-ui/internal-api.sock` or install an always-on service without fresh,
explicit operator authorization. That action grants the remote ChatGPT app the
MCP tool capabilities over real sessions and runtimes.

If authorized later, first run the profile in the foreground, then create a
hardened service under the same Unix user that owns the Pi Web UI socket/token.
Use restart backoff, owner-only credentials, `NoNewPrivileges=true`, a restrictive
umask, bounded logs, and loopback-only health/admin surfaces. Validate stop/
restart/revocation and document rollback. Never embed a live key in the unit
file or repository.

---

## 13. Documentation requirements

Create `/root/pi-web-ui/docs/MCP-SERVER.md` as the canonical guide. It must cover:

1. purpose and architecture;
2. exact seven-tool MVP contract;
3. stdio-only boundary;
4. local token/socket trust model;
5. data exposure warning for session lists and transcripts;
6. build/start commands;
7. adapter environment variables;
8. local MCP client example with placeholders only;
9. OpenAI Secure MCP Tunnel command shape using placeholders, for example:

   ```bash
   tunnel-client init \
     --profile pi-web-ui-mcp \
     --tunnel-id '<tunnel-id>' \
     --mcp-command 'env PI_WEB_UI_MCP_SOCKET_PATH=<explicit-socket> PI_WEB_UI_MCP_TOKEN_PATH=<explicit-token-file> node /root/pi-web-ui/packages/internal-api-mcp/dist/index.js'
   ```

   Do not include real API keys, tunnel IDs, workspace IDs or tokens. Do not
   present the default production socket/token as an innocuous example: a tunnel
   makes the selected MCP tools remotely callable and therefore crosses the
   same-host trust boundary. Enabling a tunnel against production requires a
   separate explicit operator decision and security review.
10. explicit statement that ChatGPT/mobile availability is a product-surface
    concern outside the server implementation;
11. wire and disposable live-validation commands;
12. production safety warning;
13. troubleshooting for missing socket, unsafe token permissions, incompatible
    contract, auth failure, timeout, response cap and runtime unavailable;
14. known MVP limitations and future candidates;
15. the outbound-only Secure MCP Tunnel architecture, exact TCP 443 egress
    requirement, UFW preflight, and explicit statement that no inbound/free port
    is needed;
16. operator prerequisites, disposable external-validation sequence, current
    mobile limitation, production opt-in and rollback/service guidance.

Update existing docs by linking to this guide rather than copying it extensively.
Run link checks.

---

## 14. Security review checklist

The implementation is not complete until an explicit security review answers all
of these with evidence:

### Boundary and authentication

- [ ] No MCP HTTP/TCP listener exists.
- [ ] No generic Internal API proxy exists.
- [ ] Bearer token comes only from the configured local file.
- [ ] Token path is a non-symlink regular file owned by the process uid with no
      group/world permission bits.
- [ ] Socket path is a non-symlink Unix socket owned by the process uid with no
      group/world permission bits, and replacement checks are tested.
- [ ] Every Internal API call uses the Unix socket only.
- [ ] No browser auth, cookie or CSRF protection was weakened.

### Input controls

- [ ] All MCP schemas are strict and reject unknown keys.
- [ ] Runtime is an enum excluding Command Code.
- [ ] Session/run IDs, models, messages and idempotency keys are bounded.
- [ ] Identifiers/query values are encoded.
- [ ] Cwd is not model-controlled.
- [ ] Endpoint, method, verbosity, mode and detach semantics are not model-controlled.

### Output and secret controls

- [ ] stdout contains MCP protocol only.
- [ ] Tokens/headers/cookies/stacks/raw API errors never reach MCP output or logs.
- [ ] Raw API objects are projected through field allowlists.
- [ ] Tool output and HTTP input are byte-bounded.
- [ ] Transcript truncation remains valid structured JSON and is explicit.
- [ ] Documentation does not promise transcript content is sanitized.

### Action safety

- [ ] Read tools have correct read-only annotations.
- [ ] Create/dispatch tools are write actions and not marked read-only.
- [ ] No delete/abort/control/transfer/batch/watch/approval tool exists.
- [ ] Dispatch is detached and idempotency-aware.
- [ ] No mutating request is automatically retried.
- [ ] Dispatch is treated as potentially destructive/cost-incurring, and neither
      annotations nor client confirmation are claimed as an authorization boundary.
- [ ] Existing Internal API prompt-injection and provider policy remain in force.

### Validation safety

- [ ] Live validator requires explicit socket and token paths.
- [ ] Production paths are refused with no override.
- [ ] Antigravity is not selected in disposable validation.
- [ ] Production service/socket/session state was not touched.
- [ ] The report discloses that disposable validation can reuse real provider
      authentication/model resources and may incur provider-side effects/cost.
- [ ] Temporary tokens, sockets, sessions and logs were removed.

---

## 15. Quality gates — non-negotiable

Run from `/root/pi-web-ui` and retain actual output in the implementation report.
A summarized “all green” statement without command evidence is insufficient.

### Focused TDD gates

- [ ] Every production behaviour was preceded by a focused failing test.
- [ ] Each RED failed for the expected missing behaviour, not a syntax/setup error.
- [ ] Focused workspace tests pass after each increment.
- [ ] No skipped, `.only`, quarantined or silently weakened tests remain.
- [ ] Tests assert observable behaviour and real wire boundaries where practical,
      not just mock call counts.

Suggested commands:

```bash
npm test --workspace=@pi-web-ui/internal-api-mcp
npm run test:coverage --workspace=@pi-web-ui/internal-api-mcp
```

Set and meet meaningful workspace coverage thresholds. Recommended minimum:

- statements: 85%;
- lines: 85%;
- functions: 85%;
- branches: 80%.

Coverage is a backstop, not a substitute for the required behavioural tests.

### Repository gates

The root scripts must include the new workspace so these verify the MCP code too:

```bash
npm run docs:check-agent-guides
npm run docs:check-links
npm run lint
npm run typecheck
npm run build
npm test
npm run test:coverage
```

If the repository has a documented pre-existing warning baseline, record it
exactly; do not introduce new warnings or dismiss errors as pre-existing.

### Executable validation gates

```bash
npm run validate:mcp:wire
```

Then start an isolated server and run the explicit MCP live validator:

```bash
npm run validate:server -- --dir /tmp/pi-web-ui-mcp-validation-<unique>

npm run validate:mcp:live -- \
  --socket /tmp/pi-web-ui-mcp-validation-<unique>/internal-api.sock \
  --token-path /tmp/pi-web-ui-mcp-validation-<unique>/internal-api-token \
  --runtime pi
```

Use the actual socket/token paths printed by `validate:server`; the illustrative
paths above are not permission to guess.

### Conditional external integration gate

When the operator supplies the OpenAI tunnel/workspace prerequisites, §12.5 is a
required end-to-end gate before claiming the MCP is usable from ChatGPT:

```bash
sudo ufw status verbose             # if available on the deployment host
curl -sS -o /dev/null -w '%{http_code}\n' https://api.openai.com/v1/models
tunnel-client doctor --profile pi-web-ui-mcp-disposable --explain
tunnel-client run --profile pi-web-ui-mcp-disposable
```

The evidence must show outbound TCP 443 reachability, no inbound MCP port/rule,
typed MCP calls, and the desktop Voice result. If a plan/rollout/workspace/secret
prerequisite is missing, report this gate **BLOCKED** rather than substituting a
public listener. Local implementation can remain live-validated, but do not call
it externally end-to-end validated.

### Independent review gates

After implementation and before final validation:

1. request a code/security review focused on token handling, stdout cleanliness,
   schema escape hatches, route construction and production-target safety;
2. request a test/QA review focused on false-positive tests, cleanup, timeouts and
   whether the live path truly traverses MCP stdio;
3. fix every material finding test-first;
4. re-run focused and final gates after fixes.

### Git and artifact gates

Before any commit/push operation requested by the owner:

```bash
git status --short
git diff --stat
git diff --cached --stat
```

Also inspect the full relevant diff and verify no:

- Internal API token;
- OpenAI key or tunnel credential;
- cookies/auth dumps;
- `.env` file;
- session JSONL/transcript;
- validation socket/token/temp directory;
- local machine credential/config file;
- production logs;
- generated coverage/build output not intended for source control

is staged.

Do not deploy to production, restart `pi-web-ui.service`, create a real OpenAI
tunnel, commit, or push unless the owner separately asks for that action.

---

## 16. Acceptance matrix

| Requirement | Unit/integration proof | Executable proof |
|---|---|---|
| Standard MCP stdio server | protocol tests | compiled process initialized by SDK client |
| Exact seven tools | catalogue test | `tools/list` exact match |
| Unix-socket-only API calls | fake UDS client tests | fake server observes expected routes |
| Token secrecy | sentinel leak tests | stdout/stderr/report secret scan |
| Contract compatibility | capabilities parser tests | disposable `/capabilities` result |
| Four ordinary runtime selectors | schema/projection tests | selected disposable runtime listed |
| Create session | handler request test | real session UUID returned through MCP |
| Detached dispatch | exact body test | real `202`/runId through MCP |
| Durable monitoring | receipt projection tests | terminal real receipt through MCP |
| Result readback | separate HTTP-overflow and post-parse transcript-cap tests | unique marker stable across repeated MCP transcript reads |
| No destructive control MCP tools | exact catalogue test | validator cleans up directly, not via MCP |
| Production isolation | target guard tests | report names disposable socket, discloses real provider-resource reuse, and confirms production service/socket/session state untouched |
| Clean lifecycle | subprocess close tests | MCP/server/temp cleanup confirmed |

---

## 17. Risks and required responses

### Token grants broad local control

**Risk:** any MCP client allowed to use the server can inspect/control sessions.

**Response:** stdio only, local token file, strict tools, write annotations,
confirmation, no generic proxy, explicit documentation.

### Prompting a session can execute tools and incur provider usage

**Risk:** dispatch can directly lead a runtime to modify files, call services or
incur provider charges.

**Response:** mark dispatch as potentially destructive, retain Internal API
provider policy and prompt-injection checks, keep confirmation enabled as UX only,
and document that neither annotations nor confirmation replace authorization.
Document runtime costs and side effects.

### Long-running agent turns exceed ordinary MCP request latency

**Risk:** synchronous tool call blocks or times out.

**Response:** detached dispatch returns immediately; monitor with `get_run`, then
read transcript.

### SDK/API drift

**Risk:** copied MCP examples or exact contract-minor assumptions become stale.

**Response:** use installed official SDK types/tests, direct dependency,
protocol-level validation, and major-contract compatibility checks.

### Output volume or sensitive transcript content

**Risk:** a transcript floods context or reveals sensitive session content.

**Response:** bounded projections, recent scope by default, explicit full-scope
choice, valid truncation envelope, privacy warning.

### Validation accidentally reaches production

**Risk:** real sessions or service are disturbed.

**Response:** explicit required paths, canonical production-path refusal, no
allow-production override, disposable runtime only, cleanup assertions, and
truthful disclosure that disposable isolation protects Pi Web UI production
state but can still reuse real provider credentials/model resources.

### A live model does not echo the marker exactly

**Risk:** false failure or brittle test.

**Response:** use a unique marker and assert it appears in the final visible
transcript, not that the entire response byte-equals the marker. Still require
terminal text evidence.

---

## 18. Definition of Done

The MVP is done only when all of the following are true:

1. `packages/internal-api-mcp` is a private, independently launched npm workspace.
2. The compiled bin starts a standard stdio MCP server with protocol-only stdout.
3. `tools/list` exposes exactly the seven locked tools and no generic or explicit
   delete/abort/control escape hatch; dispatch is truthfully marked potentially
   destructive.
4. Every tool input is strict and bounded; every output is allowlist-projected
   and byte-bounded.
5. The token remains local to the process and never appears in MCP content,
   stdout, stderr, test reports, diffs or staged files.
6. The client uses only authenticated HTTP over the configured Unix socket and
   fails closed on incompatible contract or unsafe local files.
7. All implementation increments have recorded RED-before-GREEN evidence.
8. Workspace coverage meets the agreed thresholds.
9. `npm run validate:mcp:wire` activates the compiled server, connects through a
   real MCP client, and passes all route/protocol/secret assertions.
10. Disposable live validation activates the compiled MCP server and completes
    the full MCP → Internal API → real runtime → receipt → transcript path.
11. The live transcript contains the unique marker, and receipt/transcript
    evidence remains stable across a bounded repeat-read window.
12. The created validation session, MCP process, disposable server and temporary
    directory are cleaned up.
13. Lint, typecheck, build, full tests, coverage and documentation checks pass.
14. Independent security and QA reviews have no unresolved material findings.
15. Documentation explains local operation and the placeholder Secure MCP Tunnel
    path without exposing credentials or silently defaulting a tunnel to the
    production socket/token; it describes tunnel enablement as a separate
    trust-boundary decision.
16. Production was not accessed, restarted, redeployed or modified.
17. The documented external path uses Secure MCP Tunnel over outbound TCP 443;
    no inbound MCP port or firewall rule is introduced.
18. When operator tunnel/workspace prerequisites are available, the disposable
    typed and desktop-Voice external sequence in §12.5 passes. Otherwise the
    external status is explicitly **BLOCKED**, never inferred from local tests.
19. Git status/diff and secret/artifact audits are clean.

If any item is unproven, the correct status is **incomplete** or **blocked**, not
“should work.”

---

## 19. Future work — record only, do not implement

After the MVP and ChatGPT Voice proof, possible separately approved additions are:

- safe session follow-up semantics;
- retention leases;
- bounded abort/release controls;
- task-status summaries;
- approval inspection/response where runtime support is truthful;
- parent/orchestration labels maintained by the MCP layer;
- an authenticated remote Streamable HTTP MCP deployment;
- richer structured output/UI components;
- production service packaging for `tunnel-client` and the MCP process;
- provider/runtime allowlists configurable by the operator;
- a browser-native realtime voice client independent of ChatGPT.

None of these belongs in the MVP implementation described by this plan.

---

## 20. Execution report — 2026-08-11

### Implementation and activation result

The implementation is complete in `packages/internal-api-mcp`. The compiled
`dist/index.js` was activated as a real stdio MCP child in both validation gates;
no MCP listener was added to the main server. The adapter exposes exactly the
seven locked tools and uses only authenticated HTTP over the configured Unix
socket. The local activation path is therefore proven, while the production
MCP process/tunnel remains an explicit operator-controlled launch decision.

### Focused RED/GREEN ledger

| Behaviour | RED evidence | GREEN evidence |
|---|---|---|
| Owner-only parent directory for token/socket paths | `tests/config.test.ts`: unsafe-parent case resolved instead of rejecting | `npm test --workspace=@pi-web-ui/internal-api-mcp -- --run tests/config.test.ts` — 21 passed |
| Oversized token rejected before content read | `tests/config.test.ts`: oversized-token case had no rejection | Same config command — 21 passed |
| Disposable validation target provenance | `tests/validation-safety.test.ts`: outside-temp and split-parent paths did not throw | `npm test --workspace=@pi-web-ui/internal-api-mcp -- --run tests/validation-safety.test.ts` — 9 passed |
| Assistant-only live marker assertion | `containsAssistantMarker` test failed because the helper was absent | Same validation-safety command — 9 passed |
| Aggregate structured/text output ceiling | `tests/tools.test.ts`: result measured 2,324 bytes against a 1,024-byte ceiling | `npm test --workspace=@pi-web-ui/internal-api-mcp -- --run tests/tools.test.ts` — 10 passed |
| Excluded-runtime dispatch and receipt/transcript readback | focused runtime tests rejected no `commandcode` path before the guard/projection | `npm test --workspace=@pi-web-ui/internal-api-mcp -- --run tests/tools.test.ts tests/projections.test.ts` — 18 passed |
| Compiled cleanup and all seven wire calls | wire path initially had swallowed exit failures and only read-tool calls | `npm run validate:mcp:wire` — compiled official-SDK wire proof passed |

The first four rows are direct failing-test observations; the fifth is the
captured pre-fix assertion; the last two also incorporate the independent
review fixes and their focused green checks. No test is skipped or `.only`.

### Independent review cycles and fixes

A bounded security review found socket/ancestor safety, excluded-runtime
identifier paths, misleading dispatch idempotency annotation, duplicated
structured/text output budget, and unbounded token-file reads. A bounded QA
review found false-positive marker matching, swallowed cleanup failures, weak
disposable-target provenance, soft per-call deadlines, setup-leak risk, and
wire coverage gaps. The implementation was revised test-first where applicable:

- owner-only parent-directory checks and descriptor-size checks now fail closed;
- dispatch preflights the ordinary-runtime session index, while run/transcript
  projections reject excluded runtimes;
- dispatch is marked `idempotentHint:false` because omitted keys are generated
  afresh; supplied keys remain supported for deliberate retries;
- structured and text representations share one aggregate output budget;
- live validation requires assistant transcript output, has bounded SDK/build
  deadlines, uses a real DELETE timeout, and reports cleanup failures;
- validation targets must be absolute paths inside one OS-temporary disposable
  directory; the live marker helper ignores user-prompt occurrences;
- the compiled wire validator now invokes all seven tools and proves clean exit.

The remaining pathname race against a malicious same-uid process is documented
and bounded by owner-only parents plus pre/post socket identity checks; such a
process can already read the owner-only token under the locked same-host trust
model.

### Validation evidence

- Workspace tests: 8 files, 71 tests passed.
- Final post-review workspace coverage: 94.63% lines/statements, 80.44%
  branches, and 88.54% functions.
- `npm run validate:mcp:wire`: passed against a fake owner-only Unix socket;
  official SDK initialization, exact catalogue, annotations, all seven compiled
  tool calls, fixed routes, auth, schema/error paths, stdout/stderr secrecy and
  cleanup passed.
- Disposable real-runtime run: passed through MCP stdio -> Internal API -> real
  Pi runtime -> completed receipt -> assistant marker transcript, with stable
  repeated receipt/transcript readback and disposable cleanup. Evidence included
  `outputEvidence.disposition=text` and Pi `agentEndAt`.
- Production service/socket/session state was not targeted or modified.

### External phase result and retirement

The initially blocked external phase was subsequently completed on 2026-08-12
with operator-authorised OpenAI prerequisites. Official `tunnel-client` v0.0.11
was checksum-verified and connected outbound over HTTPS to a disposable Pi Web
UI server only. ChatGPT developer mode discovered exactly the seven locked
tools and preserved the intended read/write/destructive annotations. A typed Pi
turn completed, and stable repeated receipt/transcript reads returned the exact
assistant marker `blue lantern 8241`. Independent backend evidence correlated
the run and confirmed that production socket, token, registry, and sessions were
not accessed. No inbound listener or firewall rule was added.

The experiment was then intentionally retired. The tunnel/MCP/validation
processes were stopped, the ChatGPT developer plugin was deleted, disposable
state was removed, and local tunnel API-key, tunnel-ID, and profile files were
deleted. Persistence checks found no systemd service, user service, timer, cron,
autostart entry, listener, or surviving MCP/tunnel process. The adapter source,
tests, npm scripts, and this evidence are retained for possible future use, but
it is inactive by default. Any reactivation—including any production target—
requires a fresh explicit decision, new credentials/profile, disposable gates,
and the security review described in this plan.

An orphaned remote tunnel metadata record may remain in the OpenAI control
plane because deleting it requires a separately authenticated Platform admin
session/key. With the ChatGPT plugin deleted and all local credentials, profile,
and processes removed, it has no path to this host and must not be described as
active.
