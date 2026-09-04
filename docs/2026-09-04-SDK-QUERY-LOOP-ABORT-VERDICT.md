# Verdict: bare `query()` SDK loop abort — root cause found, pi-web-ui NOT affected; separate dead OAuth grant IS live

> **File type:** analysis verdict + fix sequence for [`2026-09-04-SDK-QUERY-LOOP-ABORT-OBSERVATION.md`](./2026-09-04-SDK-QUERY-LOOP-ABORT-OBSERVATION.md). Resolves its OQ ("does a real claude session currently work in the web UI?") and its load-bearing question about pi-web-ui's production Claude runtime. Analysed 2026-09-04 by the pi-web-ui fixing agent, no execution yet — fix sequence at the end, awaiting owner go.

## Executive summary

| # | Finding | Real? | Affects pi-web-ui? |
|---|---|---|---|
| F1 | Deterministic ~2s abort of the bare `query()` loop | Yes, 100% reproducible — **but it is a caller-side API misuse, not an SDK/host/pi-web-ui defect** | **No** — server code already uses the correct signature |
| F2 | pi-web-ui production Claude SDK path broken by F1 | **No** — disproven. Single call site uses the correct object signature; corrected-signature bare script completes init→assistant→result in ~1s on this host | n/a |
| F3 | Host Claude subscription OAuth grant is **dead** (access token expired 2026-09-03T16:19Z, refresh now rejected as revoked) | **Yes — real, live, and independent of F1** | **Yes, operationally**: any NEW subscription-auth Claude session (incl. pi-web-ui `sdk-subscription` backend) fails authentication until re-login. Provider-profile backends (glm53, API-key) unaffected. Last subscription session ran Aug 31, so production has not hit it yet |

**Bottom line:** the report's headline suspicion (pi-web-ui / Internal API defect) is cleared. The smoke script that produced the report was itself the defect (F1). Separately, the report's question "does a real claude session currently work in the web UI?" uncovers a genuine live problem (F3) — but it is host auth state, not code.

## F1 — Root cause: pre-0.3 positional `query(prompt, options)` called against SDK 0.3.x object signature

### The signature change

`@anthropic-ai/claude-agent-sdk` 0.3.x declares (installed copy, `sdk.d.ts:2437`):

```ts
export declare function query(_params: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: Options;
}): Query;
```

All nine D1 smoke scripts (`/tmp/sdk-smoke-rDKi/sdk-smoke*.mjs`, preserved copies in `/root/backups/injection-d1-smokes/`) call the pre-0.3 positional form:

```js
const q = query('Reply with exactly: SMOKE-SDK-OK', {   // ← string first arg
  cwd: '/root/agent-os',
  pathToClaudeCodeExecutable: '/root/.local/bin/claude',
  ...
});
```

### The exact failure chain (instrumented on 2026-09-04, ~19:00 UTC)

1. `query('STRING', {options})` → the SDK receives `_params = 'STRING'` (arity 1; the options object is silently discarded as a second argument). Destructuring a string yields `prompt: undefined, options: undefined`.
2. With `options: undefined`, `rw()` (options normaliser) uses **all defaults**: no `cwd`, no `settingSources`, and — critically — **`pathToClaudeCodeExecutable` is ignored, so the embedded 2.1.260 binary is spawned, not the requested system claude 2.1.259**. Every run in the report that believed it was testing "system claude" was actually testing the embedded binary. That bisect is void.
3. `nw(queryInstance, transport, prompt=undefined, abortController)` → `typeof undefined !== 'string'` → else-branch `streamInput(undefined)` → `for await (const r of undefined)` throws `TypeError: Cannot read properties of undefined (reading 'Symbol(Symbol.asyncIterator)')` (caught as `abort(reason)` — **the SDK aborts its internal controller at construction, ~20ms in**; the original TypeError survives as the abort reason).
4. The child had already been spawned by the defaults path and boots normally (alive and healthy at 379/663/983ms in a `ps` poll). ~1.1s later the SDK's `readMessages` cleanup runs `performCleanup → transport.close()` → SIGTERM to the child → child exit handler sees `abortController.signal.aborted === true` → the caller's `for await` throws.
5. Which message surfaces depends on which exit/cleanup path wins the race: `AbortError("Claude Code process aborted by user")` (the report's variant, `errorClass: 'aborted'`) or `Error("Operation aborted")` (my variant). Both are post-abort bookkeeping artifacts of the same construction-time abort. The deterministic "~2s" is config-dependent child boot time before the SIGTERM lands; it is not a timer in the SDK.

Evidence anchors (from this session's runs):
- `abort()` called at **22ms** with reason stack `TypeError ... at Lh.streamInput (sdk.mjs:63:2805) ← at nw (sdk.mjs:116:11) ← at VCe (sdk.mjs:116:1382)` — i.e. the exported `query` itself.
- Loop error at 1078–1214ms thrown from the ChildProcess exit handler (`waitForExit`'s aborted branch).
- The report's own environment contained the answer: D1's `/tmp/sdk-smoke-rDKi/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2922` declares the object signature.

### Proof of fix (bare script, same host, same SDK, same binary family)

Changing only the call shape:

```js
const q = query({ prompt: 'Reply with exactly: SMOKE-SDK-OK', options: { ... } });
```

produces a clean run: `MSG system init` (691ms) → `MSG assistant` (994ms) → `MSG result` (999ms) → clean loop completion. Wire protocol, transport, binary, and stream-json handling are all healthy.

### Why this also explains every isolation sweep in the report

- "no `settingSources`", "hook-free config", "arg order swapped", "full pi-web-ui option parity", "detached nohup", "fresh npm install": all nine variants kept the positional call → all guaranteed to abort identically.
- "Setup A hangs" (fresh config dir, no `.claude.json`): the child blocks on onboarding state — a separate, benign non-interactive-CLI behaviour; the client loop was already dead from step 3 regardless.
- "child is healthy in every failing run": correct — the child is killed by the SDK client's cleanup, never fails on its own.
- "manual protocol replay works perfectly": also correct — hand-driving stdin doesn't use `nw`/`streamInput` at all.
- "SDK's 2000 constant smells like a timeout": coincidental — the `2000` is the `close()`-path SIGTERM→SIGKILL grace / cleanup-exit race (`Yo(2000, …)`), not the trigger. Nothing in the plain `query()` path has a 2s timer (the only real init timeout is WarmQuery's 60s `initializeTimeoutMs`).

## F2 — pi-web-ui itself is NOT affected

- `server/src/claude/claude-sdk-service.ts:376` — the repo's **only** `query()` call site — already uses the correct form: `query({ prompt: steerStream.stream, options: sdkOptions })` (an `AsyncIterable` prompt, supported by the same signature). Written against 0.3.x from its introduction (c03bffc).
- The canonical `claude-sdk` skill (`/root/.skills-global/skills-global/claude-sdk/SKILL.md`) uses `query({` in all 4 examples, zero positional calls — future agents copying the skill are safe.
- No other repo, script, or test in pi-web-ui imports or calls the SDK.
- No Internal API / contract / wire-schema implication whatsoever. Contract stays 1.34.0; no production restart is required for F1/F2.

## F3 — Real and live: host Claude subscription OAuth grant is dead

Discovered while proving F2 (the corrected-signature canary returned `result.is_error: true`):

- `~/.claude/.credentials.json` (last written 2026-09-03 08:19 UTC): access token `expiresAt = 2026-09-03T16:19:04Z` — expired; refresh token valid until 2026-09-30 (not natural expiry).
- Every fresh child session now fails auth: API says `401 authentication_failed: "OAuth access token has been revoked"`; refresh attempt fails (`"Failed to authenticate: OAuth session expired and could not be refreshed"`), and the CLI rewrites the credentials file smaller (drops the dead grant) — verified on a **copy** in a disposable config dir; the real `~/.claude` was not modified.
- "Revoked" with an unexpired refresh window strongly suggests the grant was rotated/invalidated elsewhere (e.g. a login on another device/CLI instance) — the operator should recognise whether they re-logged-in somewhere after Sep 3 08:19.
- **Impact on pi-web-ui production:** `sdk-subscription` backend sessions (and the default `claude` CLI) will fail every turn with the auth error surfaced through a normal `result` message (is_error), not a crash. Provider-profile backends (glm53-*, API-key via `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`) are unaffected. Production default profile is glm53, and the newest subscription session transcript is from Aug 31 21:18 — so nothing in production has hit this yet.
- Note: this also means the report's Setup-B claim "child completes its whole turn — model reply" could not have included a real model reply after Sep 3 16:19; what it observed was the synthetic 401-failure turn (which still fires hooks and writes a transcript).

## Fix sequence (analysis only — awaiting owner go)

No pi-web-ui code defect exists, so there is no urgent repo fix. The sequence below is small, ordered by value:

### Phase 1 — pi-web-ui repo hardening (cheap, TDD, no production impact)
1. **RED**: unit test importing the installed `@anthropic-ai/claude-agent-sdk` asserting the object-parameter shape (e.g. `query.length === 1`, plus a behavioural assert that `query(<string>, …)` aborts with the undefined-asyncIterator TypeError — pinning the failure mode so a future signature flip on `npm update` is caught by the suite, since TS types alone don't protect JS callers).
2. **GREEN**: no production change needed (test-only). If the pin ever turns red on a dependency bump, fix the call site per the then-current signature.
3. Append a verdict cross-reference to the observation doc (docs-only).
4. Gates: `npm run lint`, `npm run typecheck`, targeted test file, `npm run docs:check-agent-guides` if any guide touched.

### Phase 2 — host OAuth repair (OWNER action; credential boundary, not agent-executable unattended)
1. Owner runs `/root/.local/bin/claude` interactively and completes login (`/login`) — this rotates the grant and rewrites `~/.claude/.credentials.json`.
2. Verify: `expiresAt` now in the future; re-run the corrected-signature canary expecting `is_error: false`.
3. Only then can subscription-backend live validation mean anything.

### Phase 3 — live validation in this repo (when owner permits)
1. Disposable validation server (`npm run validate:server`) + real Claude SDK session via a **provider profile** (glm53, API-key) — proves the server path end-to-end today, independent of F3.
2. Subscription-backend scenario re-run after Phase 2.
3. Optionally codify the corrected bare-SDK canary as a tiny script under `scripts/` for future auth-state checks (the 5-minute repro, fixed).

### Phase 4 — Agent OS hand-off (their repo; NOT this agent's to touch — another agent is active there)
1. D1 smoke scripts switch to `query({ prompt, options })` in the canonical kit location (the `/tmp` copies are volatile; `/root/backups/injection-d1-smokes/` is archival).
2. Retire the void bisects (node version, tty/nohup, arg order, system-vs-embedded binary) from the completion record §7 OQ-1 — resolved by this verdict.
3. Optional process lesson: smoke scripts should assert the installed SDK's documented signature (or at minimum print the SDK's own type declaration) before bisecting host state.

### Phase 5 — optional upstream draft (do NOT file without owner approval)
Draft (not file) an upstream issue for claude-agent-sdk-typescript: `query()` called with a positional string first arg silently constructs, discards options, and self-aborts with a misleading "aborted by user"/"Operation aborted" ~1–2s later; a fail-fast `TypeError` at entry ("query() takes a single { prompt, options } parameter object") would have made this a 10-second diagnosis.

### Explicitly NOT needed
- No contract bump (stays 1.34.0), no production restart, no Internal API change, no change to `claude-sdk-service.ts`.

## Ownership

- Analysed and authored by the pi-web-ui fixing agent, 2026-09-04, at the owner's request ("analyse, no execution"). Evidence runs in `/tmp/sdk-repro-x/` (volatile) with key outputs quoted above; D1 artefacts untouched.
- Phase 4 belongs to the Agent OS injection-programme owner; Phase 2 belongs to the operator (credential boundary).
