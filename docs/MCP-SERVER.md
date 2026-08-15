# Pi Web UI Internal API MCP Server (experimental, inactive)

> **Lifecycle status (2026-08-12): validated experiment, retained but disabled.**
> The adapter passed deterministic wire, disposable real-runtime, and external
> ChatGPT tests. The disposable tunnel and validation server have been stopped,
> the ChatGPT developer plugin has been deleted, and local tunnel credentials
> and disposable state have been removed. No MCP or tunnel service is installed
> or enabled, and production was never connected. The source, tests, and
> runbooks remain in the repository for possible future use.

## Purpose and boundary

`@pi-web-ui/internal-api-mcp` is a private, separately launched TypeScript MCP
server. It exposes exactly seven tools over **stdio** and calls the existing
Pi Web UI Internal API over its authenticated Unix socket:

```text
MCP client (stdio)
  -> @pi-web-ui/internal-api-mcp (child process)
  -> HTTP over Unix socket + local bearer token
  -> Pi Web UI Internal API
  -> Pi / Claude / OpenCode / Antigravity runtime services
```

The adapter does not mount MCP routes in the Express application, import runtime
services, open a TCP listener, or provide a generic HTTP proxy. A client that
can launch this process receives the same trusted same-host control authority as
any holder of the configured Internal API token. The MCP process is therefore a
high-trust local integration, not a tenant-isolation boundary. Command Code is
deliberately excluded from the adapter's runtime projection — its sessions are
driven through the browser UI and the Internal API directly.

## The seven-tool MVP

The tool catalogue is deliberately closed:

| Tool | Operation | Safety annotation |
|---|---|---|
| `pi_web_ui_get_capabilities` | Read `/api/v1/capabilities`; only the four ordinary runtimes (Command Code is deliberately excluded) and provider policy are projected | read-only |
| `pi_web_ui_list_models` | Read `/api/v1/models`, optionally filtered by `pi`, `claude`, `opencode`, or `antigravity` | read-only |
| `pi_web_ui_list_sessions` | Read bounded, runtime-neutral session metadata | read-only |
| `pi_web_ui_create_session` | Create one ordinary runtime session; optional model must be an advertised selector | write, non-destructive |
| `pi_web_ui_dispatch_prompt` | Dispatch `answers` + `prompt` + `detach:true` with an idempotency key | write, **potentially destructive** |
| `pi_web_ui_get_run` | Read a payload-free durable run receipt and lifecycle/output evidence | read-only |
| `pi_web_ui_get_transcript` | Read `visible_recent` or `visible_full` runtime-neutral visible output | read-only |

Inputs are strict and bounded. The adapter does not accept arbitrary `cwd`,
retention, pinning, control, delete, abort, transfer, batch, watch, approval,
raw request, endpoint, method, verbosity, or environment fields. The process
may send a fixed `PI_WEB_UI_MCP_DEFAULT_CWD` on session creation, but a tool
caller cannot choose it.

MCP annotations and a client's confirmation UI are advisory safeguards only;
they are not an authorisation boundary. A dispatched prompt can run runtime
tools, modify files, access services, and incur provider usage. The existing
Internal API authentication, prompt-injection detection, admission checks and
Pi provider policy remain authoritative.

## Output and privacy

Successful results contain a JSON text content block and structured content in
an adapter envelope:

```json
{"ok":true,"tool":"pi_web_ui_get_run","data":{}}
```

Failures are `isError: true` with a bounded `{ ok: false, tool, error }` envelope.
Stable Internal API error codes are preserved where safe; credentials, bearer
headers, raw stacks and raw API error bodies are not. HTTP responses have a
receive ceiling before JSON parsing. Tool results have a separate output
ceiling. Transcript overflow is an explicit structured truncation result with
the exact projected byte count and a UTF-8-safe excerpt; it is never a chopped
JSON document.

Session lists and transcripts can contain sensitive operator, project, user and
agent content. Transcript content is **not sanitised** by this adapter. Do not
send it to an untrusted MCP client or assume that a bounded projection makes it
safe to disclose.

## Local trust model and configuration

The MCP process reads the Internal API bearer token only from a local file. It
never accepts a token as a tool argument and never prints the token. Before
every request it requires:

- an owner-only, non-symlink Unix socket owned by the process uid;
- an owner-only, non-symlink regular token file owned by the process uid;
- token content that is non-empty and bounded;
- socket identity checks before connection and after the response, with secure
  descriptor/stat checks for the token file.

Defaults point to the normal Pi Web UI installation. For validation or another
isolated install, always pass explicit absolute paths:

| Variable | Default | Purpose |
|---|---|---|
| `PI_WEB_UI_MCP_SOCKET_PATH` | `~/.pi-web-ui/internal-api.sock` | Internal API Unix socket |
| `PI_WEB_UI_MCP_TOKEN_PATH` | `~/.pi-web-ui/internal-api-token` | owner-only bearer-token file |
| `PI_WEB_UI_MCP_DEFAULT_CWD` | unset | fixed process-level create-session cwd |
| `PI_WEB_UI_MCP_TIMEOUT_MS` | `15000` | per-request deadline, not turn completion |
| `PI_WEB_UI_MCP_MAX_RESPONSE_BYTES` | `1048576` | hard HTTP receive ceiling |
| `PI_WEB_UI_MCP_MAX_TOOL_OUTPUT_BYTES` | `131072` | serialized MCP result ceiling |

Numeric values are range-validated. The token file and socket remain local
machine credentials/control surfaces; protect the process launcher and its
stdio peer accordingly.

## Build and manual start

This is an **opt-in experimental component**, not part of normal Pi Web UI
startup. There is no systemd unit, autostart entry, cron job, or other
persistent launcher for it. Building the repository compiles the retained
workspace, but nothing runs until an operator explicitly launches an MCP client
or the command below.

From the repository root:

```bash
npm install
npm run build --workspace=@pi-web-ui/internal-api-mcp
npm run mcp:start
```

`mcp:start` launches the compiled stdio process using its configured socket and
token defaults. Stdout is reserved for MCP JSON-RPC traffic; lifecycle/failure
diagnostics go to stderr. The process exits when its stdio peer closes it.

To launch the compiled binary explicitly with a non-production target:

```bash
env \
  PI_WEB_UI_MCP_SOCKET_PATH=/absolute/disposable/internal-api.sock \
  PI_WEB_UI_MCP_TOKEN_PATH=/absolute/disposable/internal-api-token \
  node /root/pi-web-ui/packages/internal-api-mcp/dist/index.js
```

Do not replace the placeholders above with a production socket/token in an
unreviewed remote launcher. A tunnel or other remote client crosses the local
trust boundary and needs a separate operator decision.

A local MCP client can use the official SDK transport with placeholders:

```ts
const transport = new StdioClientTransport({
  command: 'node',
  args: ['/absolute/path/to/pi-web-ui/packages/internal-api-mcp/dist/index.js'],
  env: {
    PI_WEB_UI_MCP_SOCKET_PATH: '/absolute/disposable/internal-api.sock',
    PI_WEB_UI_MCP_TOKEN_PATH: '/absolute/disposable/internal-api-token',
  },
});
const client = new Client({ name: 'local-client', version: '1.0.0' });
await client.connect(transport);
```

## Validation

### Deterministic compiled wire proof

This command creates an owner-only temporary token and Unix socket, starts a
fake Internal API, launches the **compiled** MCP process, and drives it with the
official SDK client:

```bash
npm run validate:mcp:wire
```

It proves initialization, the exact seven tools and annotations, fixed routes,
bearer handling, schema rejection, structured API errors, protocol-only stdout,
stderr/token secrecy and cleanup. It never targets the production socket.

### Disposable real-runtime proof

Start an isolated Pi Web UI validation server and use the exact printed paths:

```bash
VALIDATION_DIR="$(mktemp -d /tmp/pi-web-ui-mcp-validation-XXXXXX)"
npm run validate:server -- --dir "$VALIDATION_DIR" --port 0 \
  >"$VALIDATION_DIR/server.log" 2>&1 &
VALIDATION_PID=$!

npm run validate:mcp:live -- \
  --socket "$VALIDATION_DIR/internal-api.sock" \
  --token-path "$VALIDATION_DIR/internal-api-token" \
  --runtime pi

kill "$VALIDATION_PID" 2>/dev/null || true
wait "$VALIDATION_PID" 2>/dev/null || true
rm -rf "$VALIDATION_DIR"
```

The live validator refuses missing paths, relative paths, the canonical
production socket/token, `--allow-production`, and Antigravity (which is not
safe for the disposable server). It starts the compiled MCP process, calls all
orchestration actions through MCP, waits for a terminal receipt, requires
truthful `outputEvidence.disposition=text` (and Pi `agentEndAt`), reads a unique
marker from the transcript, repeats receipt/transcript readback after a bounded
grace interval, then deletes only the disposable session through a narrowly
scoped direct cleanup request. It does not add a delete MCP tool.

The disposable server isolates Pi Web UI production service/socket/registry and
session state. It may still reuse real provider authentication and model
resources from the host, so a live turn can have provider-side effects or cost.
The validation report must disclose this and must never print the prompt,
transcript body, token, or credentials. Stop the validation server and remove
its directory after the command, even after a failed assertion.

## Secure MCP Tunnel (historical experiment; disabled)

The external experiment used this outbound-only path:

```text
ChatGPT/OpenAI hosted tunnel
  -> tunnel-client on this host (outbound HTTPS TCP 443)
  -> local stdio MCP child
  -> Unix socket Pi Web UI Internal API
```

No inbound MCP port, free public port, TCP socket proxy, or inbound firewall
rule is needed. Do not bind this server to `0.0.0.0` or `::`. Keep any tunnel
admin/metrics surface loopback-only. The only required network path is outbound
DNS plus TCP 443 to the OpenAI control plane (`api.openai.com:443`, or the
explicitly configured `mtls.api.openai.com:443`).

Before an external attempt, on the actual deployment host:

```bash
command -v ufw || true
sudo ufw status verbose             # only when ufw exists and permission is available
ss -ltnp                            # informational; no MCP port is selected
curl -sS -o /dev/null -w '%{http_code}\n' \
  --connect-timeout 10 --max-time 15 \
  https://api.openai.com/v1/models
```

An unauthenticated HTTP `401` proves DNS/TLS/outbound-443 reachability. If UFW
already allows outgoing traffic, make no firewall change. If egress is denied,
stop and obtain explicit operator permission before considering a narrowly
explained outbound rule; never add an inbound MCP rule and never hard-code a
one-time OpenAI IP address.

Reactivation is not a routine operational step. It requires a fresh operator
need and authorisation, a new disposable validation environment, new/revalidated
OpenAI tunnel credentials, and a repeat of the wire and live gates. Do not reuse
identifiers or secrets from the 2026-08-12 experiment; its local credential and
profile files were deleted and its ChatGPT developer plugin was removed.

External prerequisites cannot be manufactured by this repository:

1. an OpenAI Platform `tunnel_id` associated with the intended ChatGPT
   workspace and organisation;
2. Tunnel Read + Use permission for the runtime identity;
3. a Platform API key delivered through an owner-only secret mechanism, never
   chat, shell history, source control, logs or a committed env file;
4. ChatGPT developer-mode/plugin access in the target workspace.

After local wire and disposable real-runtime gates pass, install and verify the
official `openai/tunnel-client` release (including its published checksum or
signature when available). Use placeholders and explicit disposable paths:

```bash
tunnel-client init \
  --profile pi-web-ui-mcp-disposable \
  --tunnel-id '<operator-supplied-tunnel-id>' \
  --mcp-command 'env PI_WEB_UI_MCP_SOCKET_PATH=<explicit-disposable-socket> PI_WEB_UI_MCP_TOKEN_PATH=<explicit-disposable-token-file> node /root/pi-web-ui/packages/internal-api-mcp/dist/index.js'
tunnel-client doctor --profile pi-web-ui-mcp-disposable --explain
tunnel-client run --profile pi-web-ui-mcp-disposable
```

If a future experiment is approved, use the tunnel first for typed read-only
capabilities/models calls, then an explicitly confirmed disposable
create/dispatch/run/transcript marker flow.
Desktop Voice testing is an operator/workspace action. Current ChatGPT product
limits mean direct mobile plugin/MCP support must not be claimed; mobile can
only reach this indirectly through a supported remote-desktop host unless
OpenAI changes that boundary. If any prerequisite or Voice rollout is absent,
external status is **BLOCKED**, while successful local validation remains valid.

Pointing a tunnel at the default production socket/token or installing an
always-on service is a separate trust-boundary decision. It requires fresh
explicit operator authorisation, a security review, owner-only secret delivery,
`NoNewPrivileges=true`, restrictive umask, bounded logs, restart backoff,
stop/restart/revocation checks and a documented rollback. This experiment did
not enable that path.

## 2026-08-12 experiment outcome and shutdown

The external proof reached the disposable Pi validation server through OpenAI's
Secure MCP Tunnel and ChatGPT developer mode. ChatGPT discovered exactly seven
tools with their intended read/write annotations. A typed Pi turn completed and
stable repeated receipt/transcript reads returned the exact assistant marker
`blue lantern 8241`. Backend evidence independently correlated the run and
confirmed that no production socket, token, registry, or session was used.

The experiment was then retired deliberately:

- the outbound tunnel, its MCP child, and the disposable validation server were
  terminated;
- the ChatGPT developer plugin `Pi Web UI — Disposable Test` was deleted;
- the disposable runtime directory and test session state were removed;
- local tunnel API-key, tunnel-ID, and profile files were removed;
- persistence checks found no MCP/tunnel systemd unit, user unit, timer, cron
  entry, desktop autostart entry, listener, or surviving process;
- the separately installed `tunnel-client` executable may remain as inert tooling,
  but it has no profile or credentials and does not run by itself.

The OpenAI control plane may retain an orphaned tunnel metadata record. Deleting
that remote record requires an authenticated Platform admin session/key and is
not necessary for reachability after the plugin, runtime credentials, profile,
and local process have been removed. A future operator with Platform admin
access may delete it as account hygiene; it must not be treated as active.

## Troubleshooting and limitations

- **Missing socket:** start Pi Web UI or an isolated `validate:server`, then use
  the exact printed socket path. Do not guess a production path for validation.
- **Unsafe token/socket permissions:** both paths must be non-symlink, owner-only
  and owned by the MCP process uid. Fix permissions or use a fresh disposable
  directory; the adapter fails closed.
- **Incompatible contract:** the adapter requires the `pi-web-ui-internal-api`
  name, `/api/v1`, `v1`, and contract version `>=1.6.0`. It rechecks capabilities
  before every tool operation and does not cache compatibility across calls.
- **Authentication failure:** the token is read only from the configured file;
  never pass it through MCP input or add it to logs.
- **Timeout/oversize:** the request deadline and HTTP receive ceiling are
  separate from the MCP tool-output ceiling. Increase only within the validated
  configuration bounds and prefer smaller transcript scopes.
- **Runtime unavailable:** call capabilities/models first and choose an
  advertised, enabled runtime/model. The adapter does not silently substitute a
  different runtime.
- **MCP client cannot see tools:** verify the client launches `node` against the
  compiled `dist/index.js`, keeps stdout untouched, and captures diagnostics from
  stderr. Run `npm run validate:mcp:wire` first.

MVP limitations are intentional: stdio only; no public MCP HTTP/SSE/WebSocket
endpoint; no OAuth; no generic proxy; no delete/abort/control/follow-up/batch/
watch/approval/notification tools; no scheduler or parent-child state; and no
production tunnel/service packaging. Future additions require a separately
approved scope and security review.
