# Observation: bare `query()` SDK client loop aborts at ~2s (kit-independent)

> **VERDICT (2026-09-04):** root-caused — the repro/smoke scripts called the pre-0.3 positional `query(prompt, options)` against the SDK 0.3.x single-object `query({ prompt, options })` signature; the abort is caller-side misuse, pi-web-ui is unaffected, and a separate live issue (dead host OAuth grant) was found. Full analysis and fix sequence: [`2026-09-04-SDK-QUERY-LOOP-ABORT-VERDICT.md`](./2026-09-04-SDK-QUERY-LOOP-ABORT-VERDICT.md). Original observation below, unedited.

> **File type:** external observation report, filed by the Agent OS injection-programme execution agent (D1) on 2026-09-04, at the owner's request, for a fixing agent to pick up. This documents a *host/SDK-level* reproducible condition found while live-validating the Agent OS Claude Code injection kit. It is **not** caused by Agent OS code — it reproduces with no Agent OS component present.
> **Repro artifacts preserved:** `/root/backups/injection-d1-smokes/` (logs, transcripts) and `/tmp/sdk-smoke-rDKi/` (scripts; volatile), `/tmp/claude-smoke-cfg-kaur/` (disposable config dir with the one debug file; volatile).

## What was observed

A minimal, documented-usage `query()` loop in a standalone Node script reliably aborts ~2 seconds after spawn:

```js
import { query } from '@anthropic-ai/claude-agent-sdk';
const q = query('Reply with exactly: SMOKE-SDK-OK', {
  cwd: '/root/agent-os',
  pathToClaudeCodeExecutable: '/root/.local/bin/claude',   // system claude 2.1.259
  settingSources: ['user', 'project'],
});
for await (const msg of q) {
  console.log('MSG', msg.type, msg.subtype ?? '');
  if (msg.type === 'result') break;
}
```

Typical observed output before the abort:

```
MSG system hook_started
LOOP-ERROR: Claude Code process aborted by user
DONE ms: 2025          ← deterministic ~2000–2100ms
```

The error comes from the SDK's own abort controller (`errorClass: 'aborted'`, raised in the SDK's `ChildProcess` exit handler because `this.abortController.signal.aborted` is already true). No `result` message is ever surfaced to the caller. In the SDK's bundled/minified `sdk.mjs` there is a `2000` constant used in the transport `close()` SIGTERM-escalation path — the deterministic 2s smells like something calling `close()`/timing out the initialization ~2s in, but this is unverified; the fixing agent should confirm from source.

## How it showed up (timeline, all 2026-09-04 ~16:40–16:55 UTC)

1. **Setup A — fresh disposable `CLAUDE_CONFIG_DIR`** (settings.json with hooks, symlinked `.credentials.json`, **no `.claude.json`**): `query()` sessions **hung before doing anything visible** — no init message, no hooks, no stderr. The one debug file written ends at `installPluginsForHeadless: no marketplaces declared`. Killed by external timeouts (90–150s). Reproduced with both the SDK's embedded claude (2.1.260) and the system claude (2.1.259).
2. **Manual protocol replay of the SDK's exact invocation** — same binary, same argv (`--output-format stream-json --verbose --input-format stream-json --setting-sources=user,project --permission-mode dontAsk`), env `CLAUDE_CODE_ENTRYPOINT=sdk-ts`, driven by hand over stdin (`initialize` control_request, then a user message) — **works perfectly**: SessionStart hooks fire, context is delivered, the model answers, `result` comes back. So the claude binary, the config dir, hooks, and the stream-json protocol are all healthy.
3. **Setup B — after copying onboarding state** (a `.claude.json` with `hasCompletedOnboarding: true` + oauth account, `projects`/`mcpServers` stripped, into the disposable config dir): `query()` sessions now get **further** — the SessionStart hook **fires and delivers** (verified in Agent OS kit logs; the claude child completes its whole turn — model reply + Stop hook), but the client-side `for await` loop **still aborts at ~2.0–2.1s**, before any `result` surfaces.
4. **Isolation sweeps (all still abort ~2s):** no `settingSources` option; instant stub hooks (rule out hook duration); hook-free empty config dir (rules out Agent OS entirely); argument order swapped; full pi-web-ui option parity (`canUseTool` callback, `skills: 'all'`, `permissionMode: 'dontAsk'`, `includePartialMessages: false`); detached `nohup` run with no pipes/tty; fresh `npm i @anthropic-ai/claude-agent-sdk@0.3.185` in a temp dir **and** pi-web-ui's own installed 0.3.185.

**Consistency: 100% — ~10 deliberate attempts, deterministic ~2s abort in every one.** It is not transient and not correlated with any server event.

## Why this is NOT the pi-web-ui restart / not Agent OS

- None of the repro scripts touched the Pi Web UI server or its Internal API — they spawn the claude binary directly. The concurrent pi-web-ui agent's deploy/restart activity cannot have caused runs that never contacted the server (and the repro still reproduces after their 1.34.0 deploy).
- Agent OS kit fully removed from the loop (hook-free config) → still aborts.
- The claude **child** is healthy in every failing run: it fires hooks, calls the model, writes its session transcript, and exits normally. Only the SDK **client loop** dies.

## How it impacted the D1 work (context for severity)

- **No impact on delivery**: the injection kit's delivery through SDK-spawned sessions is proven (hooks fired, packet present in the SDK session transcript — evidence `claude-sdk-path-session.jsonl` in the evidence dir).
- **Blocked**: only the cosmetic client-side assertion of the SDK-path smoke (asserting the `result` text from a bare script). Worked around with the protocol replay + transcript evidence.
- **Unknown / load-bearing question for this repo**: whether **pi-web-ui's production claude runtime** is currently affected. Pi Web UI spawns Claude via this same SDK (`claude-sdk-service.ts` → `query()`-equivalent options incl. `pathToClaudeCodeExecutable`, `settingSources`, `canUseTool`). The last recorded claude session on this host is **Aug 31** (`/root/.pi-web-ui/claude-sessions/` newest file), so there is no recent production evidence either way. **First thing for the fixing agent to establish: does a real claude session currently work in the web UI?** If yes, diff what the server context provides that a bare script lacks (its env, its node version, the real `canUseTool` wiring); if no, this is a live production breakage of the claude runtime.

## Environment snapshot

| Component | Version |
|---|---|
| node | v24.20.0 |
| `@anthropic-ai/claude-agent-sdk` | 0.3.185 (both fresh install and pi-web-ui's) |
| system `claude` (`/root/.local/bin/claude`) | 2.1.259 |
| SDK embedded claude (linux-x64) | 2.1.260 |
| config | disposable `CLAUDE_CONFIG_DIR` (see repro artifacts); host `~/.claude` untouched |
| OS | Linux, root user |

## Suggested 5-minute repro for the fixing agent

```bash
mkdir -p /tmp/sdk-repro && cd /tmp/sdk-repro && npm init -y >/dev/null && npm i @anthropic-ai/claude-agent-sdk@0.3.185
CFG=$(mktemp -d); ln -s ~/.claude/.credentials.json $CFG/.credentials.json
node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(process.env.HOME+"/.claude.json"));delete d.projects;delete d.mcpServers;fs.writeFileSync(process.env.CFG+"/.claude.json",JSON.stringify(d))' # export CFG first
CFG=$CFG node -e "
import('@anthropic-ai/claude-agent-sdk').then(async ({query}) => {
  const q = query('Say OK', { cwd: '/tmp', pathToClaudeCodeExecutable: '/root/.local/bin/claude', settingSources: ['user','project'] });
  for await (const m of q) { console.log('MSG', m.type); if (m.type === 'result') break; }
  console.log('DONE'); process.exit(0);
});"
# Expected if still broken: one 'MSG system hook_started' then 'aborted by user' at ~2s, exit before DONE.
```

Things worth bisecting: claude 2.1.260-embedded vs 2.1.259-system; an older SDK (if cached) vs 0.3.185; node version; with/without a real `canUseTool`; whether the SDK's initialize handshake expects a control_request response the claude side only sends under conditions the bare script doesn't meet (compare against the server's working path, if the server path works).

## Ownership

Filed for a fixing agent appointed by the owner. Agent OS programme contact: the D1 execution session (`pi-glmagentosinjection-127`); completion record `/root/agent-os/docs/reviews/2026-09-04-INJECTION-D1-CORE-AND-EMITTERS.md` §7 OQ-1.
