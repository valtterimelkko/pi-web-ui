# Security

> Canonical security reference for Pi Web UI. See [`README.md`](./README.md) for system context and [`AGENTS.md`](./AGENTS.md) for must-follow implementation rules.

## Core Security Model

Pi Web UI protects both a normal web application surface and a high-privilege agent/runtime surface.

The important consequence is: **changes to auth, WebSocket routing, file access, or runtime forwarding can become security-sensitive very quickly.**

## Practical deployment posture

Pi Web UI is best understood first as a **self-hosted, operator-controlled tool**.

The safest default assumption is:
- one trusted operator or a very small trusted context
- careful control of which runtimes are enabled
- a reverse proxy and HTTPS if exposed beyond localhost
- awareness that some runtime paths are more wrapper-oriented or permission-sensitive than others

This repo is not documented as a turnkey multi-tenant SaaS product.

## Main Defences

### 1. Cookie-based authentication

- Auth is handled with session tokens (JWT) stored in httpOnly cookies.
- A single long-lived session token is issued on login (default 30 days).
- A long-lived session token is issued on login (default 30 days), with exact deployment posture controlled by the operator.
- Protected REST routes use `cookieAuthMiddleware`.
- Token generation and verification live under:
  - `server/src/security/auth.ts`
  - `server/src/middleware/auth.ts`

### 2. CSRF protection

- WebSocket and state-changing flows require CSRF validation.
- Do not remove or weaken the auth + CSRF handshake.
- Relevant files:
  - `server/src/security/csrf.ts`
  - `server/src/websocket/connection.ts`

### 3. Origin validation / WebSocket protection

- WebSocket upgrades validate origin against `ALLOWED_ORIGINS`.
- This protects against cross-site WebSocket hijacking.
- Preserve this when changing WebSocket auth or reverse-proxy behaviour.

### 4. Prompt-injection detection

- User prompts are screened before being forwarded to Pi Coding Agent, Claude Direct, or OpenCode.
- Detection currently uses pattern-based checks in:
  - `server/src/security/prompt-injection.ts`
- Do not bypass this stage when adding new runtime paths or prompt-like entry points.

### 5. File/path validation

- File operations must validate paths before access.
- Never trust client-supplied paths.
- Validate against allowed roots and use resolved/real paths where relevant.

### 6. Internal API token auth

- The Internal API is exposed over a Unix domain socket, not the public network.
- It still requires a bearer token from `~/.pi-web-ui/internal-api-token`.
- This is the preferred local automation boundary for agents and live validation.
- Relevant code:
  - `server/src/internal-api/server.ts`
  - `server/src/internal-api/middleware/auth.ts`

### 7. Rate limiting

- HTTP and WebSocket surfaces are rate-limited.
- Relevant code:
  - `server/src/security/rate-limit.ts`

## Threat Model Summary

### Cross-site WebSocket hijacking
Mitigation:
- origin allowlist
- authenticated WebSocket session
- CSRF token handshake

### Cross-site request forgery
Mitigation:
- CSRF token validation
- cookie auth middleware on protected routes

### XSS
Mitigation:
- React escaping by default
- no direct unsafe HTML rendering for user content
- security headers via Helmet / server config

### Prompt injection / runtime manipulation
Mitigation:
- prompt-injection detection before forwarding to runtimes
- runtime routing stays server-side
- permission/approval flows remain explicit

### Path traversal / arbitrary file access
Mitigation:
- explicit path validation
- constrained file APIs
- avoid raw filesystem access from unvalidated request data

### Resource abuse / denial of service
Mitigation:
- rate limiting
- worker/session cleanup rules
- runtime-specific lifecycle guards
- pinned-session limits

## Runtime-specific Security Notes

### Pi Coding Agent
- Pi sessions and tools can access local resources via approved tool calls.
- Preserve extension approval and session lifecycle protections.

### Claude Direct
- Runs `claude -p` subprocesses server-side.
- Treat subprocess spawning, environment inheritance, and abort handling as sensitive.

### OpenCode
- Uses a local `opencode serve` backend.
- If enabled, OpenCode availability and permission approval must stay server-mediated.
- Do not expose OpenCode backend credentials or control surfaces directly to the browser.
- `OPENCODE_TRUSTED_PERMISSIONS=true` is intentionally a higher-trust operating mode. It can be useful for trusted autonomous maintenance/deployment sessions, but operators should understand the trust implications before enabling it.

### Antigravity
- Uses `agy -p` server-side and currently runs with `--dangerously-skip-permissions` in this integration path.
- Treat this as an operator-trust decision, not a casual default. If you enable the Antigravity runtime, understand that it is not following the same approval model as Pi or richer Claude/OpenCode flows.

## Headers and Browser Protections

The app uses standard browser-hardening controls such as:
- CSP-related protection
- frame protections
- MIME sniffing protections

Check server bootstrap/config if these need to change, and treat changes as security-sensitive.

## Audit / Logging Expectations

Security-relevant events should remain visible in logs where appropriate, for example:
- login success/failure
- invalid auth/CSRF attempts
- suspicious prompt-injection hits
- runtime availability failures
- unusual permission/approval behaviour

## Rules for Contributors

Do not:
- remove `cookieAuthMiddleware` from protected routes
- bypass CSRF checks for convenience
- forward user text directly to runtimes without prompt-injection checks
- trust client file paths without validation
- weaken origin validation to “make local testing easier” without a narrowly scoped reason
- remove Internal API bearer-token checks just because the socket is local-only

Do:
- validate request bodies with Zod or equivalent
- preserve auth/origin/CSRF checks during refactors
- keep runtime-specific permission bridges server-side
- use the Internal API for local automation/live validation instead of weakening browser auth
- update this doc when the security model materially changes

## Files Worth Reading Before Security-sensitive Changes

- `server/src/middleware/auth.ts`
- `server/src/security/auth.ts`
- `server/src/security/csrf.ts`
- `server/src/security/prompt-injection.ts`
- `server/src/security/rate-limit.ts`
- `server/src/websocket/connection.ts`
- `server/src/routes/files.ts`
- `server/src/routes/config.ts`
