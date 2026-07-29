# Internal API quickstart

Use this page when you want a working local automation flow quickly. For full semantics and caveats, continue to [`INTERNAL-API.md`](./INTERNAL-API.md), [`INTERNAL-API-CONTRACT.md`](./INTERNAL-API-CONTRACT.md), and [`INTERNAL-API-ORCHESTRATION.md`](./INTERNAL-API-ORCHESTRATION.md).

## Safety boundary

The default socket belongs to the running Pi Web UI instance. Do not use production sessions for live validation unless the operator explicitly authorized it. Validation normally starts an isolated server with `npm run validate:server` and uses that server's socket and token.

## Connect

Default paths:

```bash
SOCKET="$HOME/.pi-web-ui/internal-api.sock"
TOKEN_PATH="$HOME/.pi-web-ui/internal-api-token"
TOKEN="$(cat "$TOKEN_PATH")"
```

The API is HTTP over a Unix domain socket. It is local-only, but every token holder can control all sessions; there is no per-client RBAC.

A convenient shell helper:

```bash
api() {
  curl --silent --show-error --unix-socket "$SOCKET" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    "$@"
}
```

## 1. Check contract and runtime health

```bash
api http://localhost/api/v1/health
api http://localhost/api/v1/capabilities
api http://localhost/api/v1/capacity
```

Read the advertised contract version and capability-gate optional behavior instead of assuming that every installation has the newest endpoint set. For contract `1.12.0` orchestration, preflight `/capacity`, but still handle prompt-time `429 ADMISSION_CAPACITY_EXHAUSTED` and its `Retry-After` header.

## 2. Discover models

```bash
api http://localhost/api/v1/models
```

Choose a runtime/model combination returned by the server. Model catalogues are live and may differ between installations.

## 3. Create a session

Consult the canonical reference for the exact create body supported by the selected runtime. A typical flow is:

```bash
api -X POST http://localhost/api/v1/sessions \
  -d '{"runtime":"pi","cwd":"/path/to/project","retention":{"mode":"resident","ttlSeconds":3600,"ownerId":"example-runner"}}'
```

Store both the returned **canonical internal session id** and
`retention.leaseId`. `resident` keeps the runtime loaded; use `durable` when
restart-safe recoverability is enough. Required create-time retention is atomic:
if the lease cannot be persisted/applied, the unused new session is removed.
Runtime-native ids and paths remain useful locators, but the canonical id is the
safest key for follow-up calls.

## 4. Send a prompt

Use an idempotency key for retriable automation:

```bash
api -X POST http://localhost/api/v1/sessions/SESSION_ID/prompt \
  -H 'Idempotency-Key: example-run-001' \
  -d '{"message":"Inspect the repository and summarize its architecture."}'
```

Every accepted dispatch returns or is associated with a durable `runId`. Persist it. It is a better unit for retry and completion tracking than inferring state from a connection.

## 5. Wait or poll the receipt

```bash
api http://localhost/api/v1/runs/RUN_ID
```

For orchestration, prefer documented wait/receipt mechanisms over keeping a fragile client connection open. Claude channel sessions in particular may be safer to monitor with `/wait` plus transcript readback than with event streaming.

## 6. Read what the user sees

```bash
api 'http://localhost/api/v1/sessions/SESSION_ID/transcript?view=screen'
```

The screen projection is the preferred low-noise, runtime-neutral result surface. Expand tools or thinking only when required.

## 7. Troubleshoot with one bounded evidence read

```bash
api http://localhost/api/v1/sessions/SESSION_ID/evidence
```

The evidence bundle resolves aliases and combines canonical metadata, runtime locators, bounded diagnostics, receipt summary, warnings, and links to deeper reads. Start here before global log or filesystem searches.

Offline alias resolution is also available:

```bash
npm run debug:where -- --json SESSION_ID_OR_PATH
```

## 8. Release retention and clean up

After positive run quiescence, release the exact lease you own:

```bash
api -X POST http://localhost/api/v1/sessions/SESSION_ID/control \
  -d '{"action":"release_retention","retentionLeaseId":"LEASE_ID","ownerId":"example-runner"}'
```

Delete disposable child sessions when finished using the canonical delete
endpoint. Explicit deletion also clears API/watch claims and disposes loaded
runtime state. Do not delete operator sessions unless the workflow explicitly
owns them.

## Next recipes

See [`INTERNAL-API-RECIPES.md`](./INTERNAL-API-RECIPES.md) for detached prompts, parallel children, idempotent retries, evidence-first diagnosis, transcript transfer, and explicit notifications.