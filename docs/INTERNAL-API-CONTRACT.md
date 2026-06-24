# Internal API Contract and Versioning

> Canonical contract policy for Pi Web UI's local Internal API. Read this before changing any `server/src/internal-api/*` route, response shape, or orchestration behaviour.

## Contract identity

The Internal API publishes its contract metadata through both:

- `GET /api/v1/health`
- `GET /api/v1/capabilities`

Current contract:

```json
{
  "name": "pi-web-ui-internal-api",
  "routePrefix": "/api/v1",
  "majorVersion": "v1",
  "contractVersion": "1.4.0",
  "stability": "beta",
  "contractDoc": "docs/INTERNAL-API-CONTRACT.md"
}
```

### Changelog

- **1.4.0** (minor, additive) — added the read-only screen-view projection to the
  transcript endpoint: `GET /sessions/:id/transcript?view=screen` (with optional
  `expand=tools,thinking`) returns a faithful "what the user sees by default"
  view (visible messages, collapsed tool cards, summarized/collapsed thinking,
  tool groups, skill placeholders) as both a structured `screenView` and a
  rendered `markdown` "text screenshot". Strictly read-only and prod-usable.
  Additive: the existing transcript behaviour is unchanged when `view` is
  absent. Old clients ignore the new param. See [`INTERNAL-API.md`](./INTERNAL-API.md).
- **1.3.0** (minor, additive) — added observability and introspection endpoints plus enriched error responses:
  - `GET /api/v1/diagnostics` and `GET /api/v1/sessions/:id/diagnostics` for self-service, secret-scrubbed recent logs.
  - `GET /api/v1/events/types` for a machine-readable catalogue of normalized SSE event kinds.
  - Error responses may now include additive `hint` and `docs` fields for the most actionable codes.
  Old clients can ignore the new endpoints and fields.
- **1.2.0** (minor, additive) — added standalone, time-bounded session pinning
  (`pin`/`pinTtlSeconds` on `POST /sessions` and `POST /sessions/batch`;
  `pinTtlSeconds` on `POST /sessions/:id/control` `pin` action) and detached
  fire-and-forget prompt dispatch (`detach` on `POST /sessions/:id/prompt`,
  returns `202`). API pins carry an absolute expiry surfaced as `pinnedUntil`
  and are revoked automatically (default 24h, hard max 7d). Old clients ignore
  the new fields. See [`INTERNAL-API.md`](./INTERNAL-API.md).
- **1.1.0** (minor, additive) — added the durable watch endpoints
  `POST/GET/DELETE /sessions/:id/watch` for long-horizon validation. Old
  clients can ignore them. See [`LONG-HORIZON-VALIDATION.md`](./LONG-HORIZON-VALIDATION.md).
- **1.0.0** — initial contracted surface.

Implementation source of truth:

- `server/src/internal-api/types.ts` — TypeScript request/response contract and contract metadata constants
- `docs/INTERNAL-API.md` — endpoint reference
- `docs/INTERNAL-API-ORCHESTRATION.md` — orchestration usage patterns
- `/root/.pi/agent/skills/pi-web-ui-internal-api-orchestration/SKILL.md` — reusable agent-facing operational guide on this machine

## Why this matters

The Internal API is no longer only a live-validation helper. It is also a local backend surface for trusted same-machine consumers. One important consumer under active design is a separate Agent OS project that will use Pi Web UI as its runtime control plane while keeping its own memory, project, and work-object state.

Do not assume the web UI frontend is the only consumer of this API.

## Versioning model

Pi Web UI uses two related version identifiers:

### 1. Route major version

The path prefix, currently `/api/v1`, is the coarse compatibility boundary.

Breaking changes require a new route major version, for example `/api/v2`, unless there is an explicit migration window and all known local consumers are updated together.

### 2. Contract version

`contractVersion` is a SemVer-style version for the `/api/v1` contract.

Use it as follows:

- **Patch** — documentation clarifications, bug fixes, or response additions that do not change existing fields or semantics.
- **Minor** — additive endpoint, field, capability, or enum value that old clients can ignore safely.
- **Major** — breaking change. Prefer a new route prefix such as `/api/v2` instead of changing `/api/v1` in place.

While the API is marked `beta`, minor additive changes are expected. Breaking changes still require deliberate migration notes.

## Compatibility rules

For `/api/v1`, preserve these rules:

1. **Additive changes are preferred.** Add fields instead of renaming or removing fields.
2. **Existing field meanings are stable.** Do not silently change semantics of a documented field.
3. **Unknown fields must be safe to ignore.** Consumers should not need to exhaustively parse every object property.
4. **Runtime differences must remain explicit.** Put new runtime capability differences under `/capabilities` before depending on them.
5. **Completion must be machine-detectable.** If an orchestration flow can run work, it must expose a reliable completion path via `/wait`, `/transcript`, or documented SSE events.
6. **Claude channel event caveats stay documented.** Do not imply all runtimes have identical event reliability.
7. **Local-only security boundary stays intact.** Keep Unix-socket + bearer-token assumptions unless a separate public API is intentionally designed.

## Error code catalog

Every error response has the stable shape `{ error, code }` (plus optional
additive `hint`/`docs`, see below). The `code` strings are a **contracted** set:
consumers (live-validation scripts, the orchestration skill, Agent OS-style
local tools) switch on their exact values, so they must never change. Adding a
new code is additive and safe; renaming or removing one is a breaking change.

The single source of truth is `server/src/internal-api/error-codes.ts`
(`ErrorCode` constants + `ERROR_CODE_INFO` metadata). Routes reference
`ErrorCode.SESSION_NOT_FOUND` etc.; raw `code: '…'` literals must not be
re-introduced.

| Code | HTTP | Meaning | Typical cause |
|---|---|---|---|
| `UNAUTHORIZED` | 401 | Missing/invalid bearer token | No/wrong `Authorization: Bearer <token>` |
| `METHOD_NOT_ALLOWED` | 405 | HTTP method unsupported for endpoint | e.g. `PUT` on a GET-only route |
| `NOT_FOUND` | 404 | Unknown endpoint / API version | Path not matched, or version ≠ `/api/v1` |
| `INVALID_REQUEST` | 400 | Missing/malformed required field | e.g. no `runtime`; `detach:true` with streaming verbosity |
| `SESSION_NOT_FOUND` | 404 | No session with that id | Wrong/expired id, or session deleted |
| `SESSION_BUSY` | 409 | Session already processing a prompt | A session runs one prompt at a time |
| `SESSION_CREATE_FAILED` | 500 | Session creation failed | Runtime threw while provisioning |
| `RUNTIME_UNAVAILABLE` | 503 | Runtime not installed/enabled | Binary missing, disabled via env, or unhealthy |
| `OPENCODE_UNAVAILABLE` | 503 | OpenCode backend unavailable | OpenCode not enabled, or recycle failed |
| `RUNTIME_ERROR` | 500 | Runtime failed mid-prompt | Provider/model/tool/abort error |
| `PROMPT_INJECTION` | 400 | Prompt blocked by safety filter | Injection-like text detected pre-runtime |
| `UNSUPPORTED_OPERATION` | 400 | Op not supported for this runtime/config | e.g. `steer` outside Pi |
| `NOT_IMPLEMENTED` | 501 | Endpoint exists but runtime path unimplemented | e.g. replay history for unsupported runtime |
| `INTERNAL_ERROR` | 500 | Unexpected internal error | Unhandled exception in a route |
| `WATCH_NOT_FOUND` | 404 | No long-horizon watch for session | GET/DELETE `/watch` before POST, or post-restart |
| `TRANSFER_DISPATCH_FAILED` | 500 | Transfer could not be dispatched | Target creation / injection / IO failure |
| `EMPTY_TRANSCRIPT` | 404 | No visible transcript yet | `/transcript` before any turn produced content |

### Additive error enrichment (`hint`, `docs`)

The most actionable codes additionally include a `hint` (an
agent/human-actionable next step) and/or a `docs` anchor. These fields are
**additive** — existing `{ error, code }` consumers ignore them. See
[`docs/OBSERVABILITY.md`](./OBSERVABILITY.md).

```json
{ "error": "Session not found", "code": "SESSION_NOT_FOUND", "hint": "List current sessions with GET /api/v1/sessions …" }
```

## Required workflow for API changes

When changing the Internal API:

1. Update TypeScript types in `server/src/internal-api/types.ts`.
2. Update route implementation under `server/src/internal-api/routes/`.
3. Update or add unit tests under `server/tests/unit/internal-api/`.
4. Update `docs/INTERNAL-API.md` for endpoint/reference changes.
5. Update `docs/INTERNAL-API-ORCHESTRATION.md` if orchestration behaviour changes.
6. Update this contract document if compatibility/versioning rules change.
7. If the change affects known local consumers such as Agent OS, update their contract notes before merging or record an explicit migration task.
8. Run at least the relevant Internal API tests and typecheck before committing.

## Agent OS coordination note

Agent OS should treat Pi Web UI as a runtime gateway, not as its own source of truth. Agent OS should store durable work state itself and record Pi Web UI session IDs as execution/evidence references.

Pi Web UI should expose stable enough session, event, transcript, transfer, and usage primitives for that local consumer without importing Agent OS concepts into the Pi Web UI data model.

Practical contract boundary:

```text
Agent OS owns: identity/role/project/thread/horizon memory, durable work objects, conductor state.
Pi Web UI owns: runtime adapters, live sessions, normalized events, replay/transcript access, local runtime orchestration API.
```

## Agent-facing skill

For agents operating on this machine, the reusable operational guide is:

```text
/root/.pi/agent/skills/pi-web-ui-internal-api-orchestration/SKILL.md
```

Use that skill for orchestration workflows and keep it aligned with this contract when endpoint behaviour changes.
