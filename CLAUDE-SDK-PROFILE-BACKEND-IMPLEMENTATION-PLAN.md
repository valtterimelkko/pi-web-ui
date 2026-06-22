# Claude SDK / Direct CLI Provider Profiles — Implementation and Validation Plan

**Audience:** a future implementation agent with fresh context.  
**Repository:** `/root/pi-web-ui`  
**Primary goal:** make GLM 5.2 usable at high quality through a Claude Code-style harness inside Pi Web UI, without manual `~/.claude/settings.json` editing, while keeping native Claude subscription usage and channel fallback available.

---

## 0. Context, intent, and why this exists

### 0.1 What happened before this plan

This plan comes after a GLM 5.2 harness comparison in which the same underlying GLM 5.2 model was exercised through different Pi Web UI runtime paths. The important findings were:

- **GLM 5.2 behaved better inside a Claude Code-style harness than inside default OpenCode for several quality dimensions**: more autonomous skill use, more self-verification, richer tool use, stronger frontend/product execution, and more willingness to run checks before claiming success.
- **OpenCode was operationally reliable**, and it does have access to the same global skills, but GLM 5.2 through the default OpenCode build agent still appeared more prone to under-using skills and doing less verification.
- **The Claude channel-backed path became unreliable when Claude Code was routed to GLM 5.2 / non-Anthropic endpoints**. In the comparison run, Claude channel sessions could acknowledge prompts and then hang or fail to initiate useful work. Direct Claude CLI use outside the channel path remained workable.
- **The existing channel-backed path also has Web UI visibility limitations for the user**: it can show a prompt and final result while hiding or under-reporting detailed tool activity.
- **The user’s practical motivation is cost and quota**: native Claude models are excellent but expensive/limited under heavy use; GLM 5.2 has much more generous usage limits and may be “good enough” if placed inside the right harness.

The conclusion is not “replace OpenCode forever”. The conclusion is that the fastest path to high-quality, cheap GLM 5.2 for this user is likely a **Claude Code-style SDK/direct backend with explicit provider profiles**, while keeping OpenCode available separately.

### 0.2 Intent of the implementation

The implementation should make Pi Web UI able to run Claude-family sessions through explicit profiles such as:

- native Claude subscription via Claude Agent SDK,
- GLM 5.2 via Claude Agent SDK using an Anthropic-compatible provider profile,
- GLM 5.2 via direct `claude -p` fallback,
- existing channel-backed Claude mode as a fallback/escape hatch.

The user should not have to manually edit `~/.claude/settings.json` or switch global Claude configuration to move between native Claude and GLM. Profile selection should be a Pi Web UI concept and should persist per session.

### 0.3 Economic constraint

Do **not** treat Anthropic API-key / pay-per-use Claude as a normal fallback. The user explicitly does not want this because subscription usage is dramatically cheaper for their workload. If subscription-backed SDK/CLI becomes unavailable, report that and ask the user rather than silently falling back to API-key billing.

---

## 1. Executive summary

Pi Web UI currently has a `claude` runtime family with two backend modes:

1. **Legacy direct mode** built around `claude -p` subprocesses.
2. **Channel-backed mode** built around a long-lived Claude Code PTY plus `pi-claude-channel`.

The channel-backed path is useful for interactive Claude Code semantics but has shown severe fragility when Claude Code is routed to non-Anthropic models such as GLM 5.2. It also often gives poor Web UI visibility: the user sees the original prompt, a working indicator, and the final answer, but not always detailed tool activity.

The desired direction is to add a new preferred backend:

3. **Claude Agent SDK subscription backend** using the local Claude Code binary/agent loop, subscription auth, filesystem skills, hooks/permissions, and structured SDK message events.

Then retain:

4. **Claude Direct CLI fallback** using `claude -p --output-format stream-json --verbose`.
5. **Claude Channel fallback** for cases where channel mode is still useful or if Anthropic policy changes again.

The implementation should introduce a **small Pi Web UI-native provider profile layer**. Do **not** make Clother a hard dependency. Use Clother as a reference implementation and validation baseline, then implement native profile launching/env construction inside Pi Web UI.

The final backend priority for the user is:

1. `claude-sdk-subscription` — primary, if validation proves it works.
2. `claude-cli-direct` — fallback, if SDK + provider profile fails or regresses.
3. `claude-channel` — kept available, but not the GLM 5.2 primary path.

**Do not add or prioritise Anthropic API-key SDK usage.** The user explicitly rejects API-key billing because it is far more expensive than subscription usage. If Anthropic subscription-backed SDK/CLI becomes unusable due to policy changes, the correct behaviour is to report that and let the user decide, not silently fall back to pay-per-use API keys.

---

## 2. Non-negotiable safety and quality rules

### 2.1 Do not disrupt production while validating

By default, do **not** target the production Internal API socket:

```text
~/.pi-web-ui/internal-api.sock
~/.pi-web-ui/internal-api-token
```

Use disposable validation servers via:

```bash
cd /root/pi-web-ui
npm run validate:server -- --dir "$VAL_DIR" --port 0 ...
```

Only use production if the user explicitly authorises it.

### 2.2 No API-key fallback for Claude

When testing or implementing Claude SDK/direct subscription paths:

- Strip `ANTHROPIC_API_KEY` from spawned subprocess environments unless a profile explicitly says otherwise.
- Do not implement API-key Claude as an automatic fallback.
- Do not hide pay-per-use behaviour behind a normal profile.
- If a Claude API-key profile is ever added later, it must be visibly labelled as pay-per-use and disabled by default. This plan does not require it.

### 2.3 No manual global settings mutation as the profile mechanism

The desired final UX is not “edit `~/.claude/settings.json` to switch providers”. Profiles must be represented in Pi Web UI config/session metadata and applied at process/SDK launch time.

If a launch path must rely on global settings, treat that as a validation finding and come back to the user before building around it.

### 2.4 Keep channel backend available

Do not delete the channel backend. The final implementation should make the Claude backend selectable/configurable:

```text
sdk-subscription | cli-direct | channel
```

Channel should remain an escape hatch for Anthropic policy/runtime changes.

### 2.5 Use live validation as a readiness gate

Do not claim completion unless live validation passes through the Pi Web UI Internal API on a disposable validation server.

Unit tests alone are insufficient. The user specifically wants end-to-end runtime validation.

---

## 3. Skills, Claude SDK resources, and docs to consult

Use these skills by name where relevant:

- `claude-sdk` — for Claude Agent SDK and `claude -p` implementation details. Treat it as a starting point; verify important details against current official docs or installed packages.
- `claude-p` — for direct CLI subprocess semantics, stream-json, session locks, `--session-id` vs `--resume`.
- `claude-channels` — for channel fallback and why channel mode differs.
- `pi-web-ui-internal-api-orchestration` — for disposable validation server and Internal API orchestration.
- `systematic-debugging` — if validation or runtime behaviour is unexpected.
- `test-driven-development` — when implementing changes.

### 3.1 Claude SDK official resources

The implementation agent must consult current official resources during pre-validation. Do not assume this plan or local skills are fully up to date.

Primary Claude Agent SDK docs:

```text
https://platform.claude.com/docs/en/agent-sdk/overview
https://platform.claude.com/docs/en/agent-sdk/quickstart
https://platform.claude.com/docs/en/agent-sdk/typescript
https://platform.claude.com/docs/en/agent-sdk/python
https://platform.claude.com/docs/en/agent-sdk/sessions
https://platform.claude.com/docs/en/agent-sdk/permissions
https://platform.claude.com/docs/en/agent-sdk/user-input
https://platform.claude.com/docs/en/agent-sdk/hooks
https://platform.claude.com/docs/en/agent-sdk/skills
https://platform.claude.com/docs/en/agent-sdk/subagents
https://platform.claude.com/docs/en/agent-sdk/mcp
https://platform.claude.com/docs/en/agent-sdk/cost-tracking
```

Public SDK repositories:

```text
https://github.com/anthropics/claude-agent-sdk-typescript
https://github.com/anthropics/claude-agent-sdk-python
```

Specific facts to verify from current docs/source before building:

- How to choose the Claude Code executable path (`pathToClaudeCodeExecutable`, `cli_path`, or current equivalent).
- Whether subscription auth is usable in the intended local/single-user context and how it is detected.
- How to strip or avoid `ANTHROPIC_API_KEY` so pay-per-use API billing is not used accidentally.
- How skills are discovered and enabled (`~/.claude/skills`, `settingSources`, `skills: "all"`, current equivalents).
- How sessions are captured/resumed/forked.
- How tool use, tool result, rate-limit, usage, and result messages are represented.
- How permission modes, callbacks, hooks, and abort/cancellation work.

### 3.2 Pi Web UI repository docs

Also read these repo docs before editing:

```text
/root/pi-web-ui/docs/CLAUDE-BACKENDS.md
/root/pi-web-ui/docs/INTERNAL-API.md
/root/pi-web-ui/docs/INTERNAL-API-CONTRACT.md
/root/pi-web-ui/docs/INTERNAL-API-ORCHESTRATION.md
/root/pi-web-ui/docs/LIVE-VALIDATION.md
/root/pi-web-ui/docs/EVENT-PIPELINE.md
/root/pi-web-ui/docs/SHARP-EDGES.md
/root/pi-web-ui/docs/RUNTIME-OVERVIEW.md
/root/pi-web-ui/docs/OPENCODE-DIRECT-INTEGRATION.md
/root/pi-web-ui/package.json
```

Important source files likely involved:

```text
server/src/claude/claude-service.ts
server/src/claude/claude-process-pool.ts
server/src/claude/claude-event-normalizer.ts
server/src/claude/claude-session-store.ts
server/src/claude/claude-history-replay.ts
server/src/claude/claude-channel-service.ts
server/src/claude/claude-channel-process-manager.ts
server/src/claude/claude-channel-event-adapter.ts
server/src/config.ts
server/src/session-registry.ts
shared/                    # shared runtime/model/session types
client/src/                # model/profile selector UI if needed
scripts/validation-server.ts
scripts/live-validate.ts
```

---

## 4. Current known facts to preserve

### 4.1 Skill directories are already shared across harnesses

The canonical global skill folder is:

```text
/root/.skills-global/skills-global/
```

Known symlinks include:

```text
/root/.pi/agent/skills  -> /root/.skills-global/skills-global
/root/.claude/skills    -> /root/.skills-global/skills-global
/root/.opencode/skills  -> /root/.skills-global/skills-global
/root/.gemini/skills    -> /root/.skills-global/skills-global
```

A temporary `opencode serve` check previously showed OpenCode sees skills such as:

```text
uk-home-diy-product-search
uwe-sharepoint
blackboard-gradebook
```

So do not assume OpenCode underperformed because it lacked skills. The issue is more likely harness behaviour/tool-use policy/verification discipline.

### 4.2 Clother summary and reference repo

Clother is a provider-switching wrapper for Claude Code.

**Reference repository:** <https://github.com/jolehuit/clother>

The implementation agent should use this repo as a **validation/reference source**, not as an unquestioned dependency. Before relying on Clother behaviour, inspect the current README and relevant source/release notes from the repo or installed binary, because wrapper flags and provider launch details may change.

Clother creates provider launchers such as:

```text
clother-native
clother-zai
clother-kimi
```

Under the hood it roughly:

```bash
export ANTHROPIC_BASE_URL="..."
export ANTHROPIC_AUTH_TOKEN="..."
exec /path/to/real/claude "$@"
```

Use Clother as:

1. A **validation baseline**: prove SDK/CLI can run through `clother-zai`.
2. A **reference design**: copy the environment/profile pattern.
3. An **optional command launcher** profile.

Do **not** hard-depend on Clother as the final core architecture unless native profiles fail and the user approves.

### 4.3 Desired provider profile direction

Pi Web UI should own profiles, e.g.:

```json
{
  "id": "glm52-claude-sdk-native-profile",
  "label": "GLM 5.2 via Claude SDK",
  "runtime": "claude",
  "backend": "sdk-subscription",
  "launcherType": "native-env",
  "baseUrl": "https://api.z.ai/api/anthropic",
  "authTokenEnv": "ZAI_API_KEY",
  "model": "glm-5.2",
  "modelMode": "pass-through",
  "settingSources": ["user", "project"],
  "skills": "all",
  "permissionMode": "dontAsk"
}
```

and optionally:

```json
{
  "id": "glm52-clother-sdk",
  "label": "GLM 5.2 via Claude SDK / Clother",
  "runtime": "claude",
  "backend": "sdk-subscription",
  "launcherType": "command",
  "command": "clother-zai",
  "model": "glm-5.2"
}
```

Native Claude profile example:

```json
{
  "id": "claude-sonnet-sdk-subscription",
  "label": "Claude Sonnet via SDK subscription",
  "runtime": "claude",
  "backend": "sdk-subscription",
  "launcherType": "command",
  "command": "claude",
  "authMode": "subscription",
  "model": "sonnet",
  "modelMode": "claude-alias",
  "settingSources": ["user", "project"],
  "skills": "all"
}
```

These structures are illustrative. Adjust to match project conventions.

---

## 5. Pre-validation strategy — do this before building

Pre-validation is mandatory. It prevents wasting time building a backend around assumptions that are false.

### 5.1 Create a pre-validation workspace

Use a timestamped directory, for example:

```bash
RUN_ID="claude-profile-prevalidate-$(date +%Y%m%d-%H%M%S)"
RUN_ROOT="/tmp/$RUN_ID"
ARTIFACT_ROOT="/root/pi-web-ui/$RUN_ID-results"
mkdir -p "$RUN_ROOT" "$ARTIFACT_ROOT"
```

Save:

```text
prevalidation-report.md
sdk-native-claude.log/jsonl
sdk-clother-zai.log/jsonl
cli-clother-zai.log/jsonl
concurrency-results.md/json
available-skills-*.json
```

### 5.2 Verify current installed tools and versions

Record:

```bash
which claude || true
claude --version || true
claude auth status --json || true
which clother-zai || true
which clother-native || true
clother status || true
node --version
npm --version
opencode --version || true
```

If Clother is missing, do not install it without user approval unless it is already an accepted project dependency. You can still continue with native env profile investigation if credentials are available.

### 5.3 Verify current official SDK behaviour

Do not rely only on bundled skill knowledge. Fetch/check current official docs and installed package behaviour.

Read/check:

- Official Agent SDK overview.
- TypeScript SDK reference.
- SDK permissions.
- SDK skills.
- SDK sessions.
- SDK hooks/user input if approval handling is needed.

Important questions to answer in the pre-validation report:

1. Does the SDK still spawn/use a Claude Code binary underneath?
2. Can it use subscription auth from local Claude Code login / token?
3. How does it specify the Claude executable path?
4. Can the executable path point to a wrapper such as `clother-zai`?
5. Can skills be enabled via `skills: "all"` and `settingSources: ["user", "project"]`?
6. How are sessions resumed by ID?
7. What message types represent tool start/result/final result?
8. Can permission callbacks or hooks be used in the chosen language?

### 5.4 Pre-validation test A — SDK + native Claude subscription

Goal: prove the SDK works with native Claude subscription auth and exposes enough events.

Suggested minimal TypeScript or Python script:

- Use SDK `query()` or client equivalent.
- Use `cwd: RUN_ROOT/native-claude`.
- Ensure `settingSources` include user/project.
- Ensure `skills: "all"` if supported.
- Strip `ANTHROPIC_API_KEY` from environment before launch.
- Ask:

```text
List the skill names relevant to UK retail/product scraping and Blackboard/SharePoint workflows. Then load or use the most relevant skill metadata only; do not run external websites. Finally say whether Skill tool access worked.
```

Success criteria:

- SDK starts.
- It uses subscription/local auth, not pay-per-use API key.
- It can see skills from `~/.claude/skills`.
- It streams structured messages including assistant text and/or tool use.
- It exits cleanly.
- The script captures session ID / final result.

Failure handling:

- If SDK cannot use subscription auth, stop and report before implementation.
- If SDK only works with API key, do not proceed with SDK backend unless user approves a different strategy.

### 5.5 Pre-validation test B — SDK + Clother Z.ai / GLM

Goal: prove SDK can use a wrapper executable such as `clother-zai` with GLM 5.2.

Use the SDK executable-path option to point to `clother-zai` or an absolute path resolved by `which clother-zai`.

Prompt:

```text
You are running a compatibility smoke test. Print the effective model identity if available. Then list whether the Skill tool is available. Then load the uk-home-diy-product-search skill and summarise the canonical command from the skill. Do not browse websites.
```

Success criteria:

- SDK launches through `clother-zai`.
- The effective model is GLM/Z.ai or compatible with GLM routing.
- It can invoke/load `uk-home-diy-product-search`.
- Tool events are visible enough to normalize in Pi Web UI.
- It exits cleanly.

Failure handling:

- If SDK + Clother fails due to flags not being passed through, test raw CLI + Clother before concluding GLM is impossible.
- If SDK + Clother works only by mutating global settings, stop and ask user.

### 5.6 Pre-validation test C — CLI direct + Clother Z.ai / GLM

Goal: prove the fallback direct path works with GLM through Clother.

Run something like:

```bash
clother-zai -p "..." \
  --output-format stream-json \
  --verbose \
  --permission-mode dontAsk \
  --allowedTools "Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,Skill,TodoWrite" \
  --model glm-5.2 \
  --session-id "$UUID"
```

Adjust flags based on current Claude CLI/Clother behaviour.

Success criteria:

- Stream JSON emits init/session events.
- Tool use and tool results are visible.
- Skills work.
- Follow-up with `--resume` works.
- Session lock behaviour is understood.

### 5.7 Pre-validation test D — native Pi Web UI-style provider profile without Clother

Goal: determine whether a native Pi profile can replace Clother by setting env vars directly.

Only do this if credentials are available in a safe env var or config. Do not print secrets.

Test a direct spawn of `claude` or SDK executable `claude` with env vars similar to Clother:

```text
ANTHROPIC_BASE_URL=<zai anthropic-compatible endpoint>
ANTHROPIC_AUTH_TOKEN=<from env/secret store>
```

Do not hardcode or log tokens.

Success criteria:

- Same or better behaviour than Clother.
- No global settings mutation required.
- Clear mapping from profile config to env vars.

If this works, prefer native profiles over Clother dependency.

If this fails but Clother works, record why and ask user whether to use Clother as a command profile for now.

### 5.8 Pre-validation test E — concurrent sessions across profiles

Goal: answer the user’s explicit concurrency question before building.

Test at least:

1. SDK native Claude + SDK GLM/Clother in parallel.
2. Two SDK GLM/Clother sessions in parallel.
3. CLI direct GLM/Clother + SDK native Claude in parallel.

Use simple prompts that each run at least one tool and take enough time to overlap, e.g. read/write small files in separate directories:

```text
In your assigned directory only, create a file named profile-test.txt containing your profile label, then read it back, then wait/sleep for 5 seconds via Bash, then report success.
```

Use separate working directories:

```text
$RUN_ROOT/concurrency/native-claude-a
$RUN_ROOT/concurrency/glm-b
$RUN_ROOT/concurrency/glm-c
```

Success criteria:

- No session lock conflicts across distinct session IDs.
- No cross-profile contamination.
- No global settings race.
- Each session writes only its assigned directory.
- Each session’s reported model/profile is correct or at least not obviously wrong.
- Follow-up prompts to each session still route to the same profile.

Suggested initial concurrency policy if validation passes:

```text
SDK backend: allow 2 concurrent sessions initially.
CLI direct backend: allow 2 concurrent sessions initially with lock backoff.
Channel backend: one active turn globally unless separately proven safe.
```

If concurrency fails:

- Report exact failure.
- Recommend initial single-active Claude profile lock if needed.
- Do not build optimistic parallel support without user approval.

### 5.9 Pre-validation gate report

Before implementation, produce a report with:

```markdown
# Claude Profile Backend Pre-validation Report

## Environment
## SDK docs/package facts checked
## Test A: SDK native Claude
## Test B: SDK Clother Z.ai
## Test C: CLI direct Clother Z.ai
## Test D: native env profile without Clother
## Test E: concurrency
## Recommendation
## Implementation path chosen
## Risks / user decisions needed
```

If the recommended path is not clearly viable, stop and ask the user.

---

## 6. Decision gates before implementation

Proceed only if one of these paths is validated:

### Path 1 — preferred

```text
SDK + native Pi provider profile/env works for GLM 5.2.
SDK + native Claude works.
Concurrency is safe enough or can be managed with a simple limit.
```

Implement SDK backend + native profile launcher.

### Path 2 — acceptable

```text
SDK + Clother works for GLM 5.2.
SDK + native Claude works.
Native env profile does not work yet.
```

Implement SDK backend with command-launcher profiles first, but design config so native env profiles can be added later.

### Path 3 — fallback

```text
SDK + GLM fails, but CLI direct + Clother/native env works.
```

Implement direct CLI profile support first, keep SDK backend behind feature flag or postpone. Ask user before choosing this path.

### Path 4 — stop

```text
Neither SDK nor direct CLI works reliably with GLM 5.2 without unacceptable global mutations or API-key billing.
```

Do not build. Report findings and recommend OpenCode custom agent or another route.

---

## 7. Target architecture

### 7.1 Claude runtime family remains one UI/runtime family

The UI can still expose runtime `claude`, but each Claude session should have metadata:

```ts
backend: 'sdk-subscription' | 'cli-direct' | 'channel'
profileId: string
providerId?: string
model: string
launcherType: 'native-env' | 'command'
```

Existing sessions without these fields should continue to work with the configured default backend.

### 7.2 Add profile configuration

Add a profile config source. Prefer project/server config patterns already used by Pi Web UI. Possible locations:

```text
~/.pi-web-ui/claude-profiles.json
```

and/or env-configured path:

```env
CLAUDE_PROFILES_PATH=/root/.pi-web-ui/claude-profiles.json
CLAUDE_DEFAULT_PROFILE=claude-sonnet-sdk-subscription
CLAUDE_DEFAULT_BACKEND=sdk-subscription
```

The profile schema should support:

```ts
type ClaudeBackend = 'sdk-subscription' | 'cli-direct' | 'channel';
type ClaudeLauncherType = 'command' | 'native-env';
type ClaudeModelMode = 'claude-alias' | 'pass-through';

type ClaudeProfile = {
  id: string;
  label: string;
  backend: ClaudeBackend;
  launcherType: ClaudeLauncherType;
  command?: string;              // e.g. 'claude', 'clother-zai'
  baseUrl?: string;              // native-env only
  authTokenEnv?: string;         // native-env only; name of env var, not value
  authTokenPath?: string;        // optional secret file; be careful with permissions
  authMode?: 'subscription' | 'anthropic-compatible-token' | 'wrapper';
  model: string;
  modelMode: ClaudeModelMode;
  settingSources?: Array<'user' | 'project' | 'local'>;
  skills?: 'all' | string[] | [];
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxConcurrent?: number;
  enabled?: boolean;
  notes?: string;
};
```

Do not log token values. If reading token values, redact in logs/errors.

### 7.3 Native provider profile launcher

Implement a small profile resolver that returns:

```ts
type ResolvedClaudeLaunch = {
  executable: string;
  env: NodeJS.ProcessEnv;
  model: string;
  modelMode: ClaudeModelMode;
  backend: ClaudeBackend;
  sdkOptions?: Record<string, unknown>;
  cliArgsBase?: string[];
};
```

Rules:

- For native Claude subscription profile:
  - executable `claude` or configured path.
  - strip `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` unless intentionally provided.
  - allow stored Claude auth / `CLAUDE_CODE_OAUTH_TOKEN`.
- For GLM/Z.ai native env profile:
  - executable `claude`.
  - set `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` from env/secret.
  - do not mutate `~/.claude/settings.json`.
- For command profile:
  - executable `clother-zai` or another command.
  - still set safe env / strip API key where appropriate.
  - do not assume command is present; validate and show helpful error.

### 7.4 SDK backend service

Add a new SDK-backed service or abstraction under `server/src/claude/`, e.g.:

```text
server/src/claude/claude-sdk-service.ts
server/src/claude/claude-profile-manager.ts
server/src/claude/claude-sdk-event-adapter.ts
```

Potential responsibilities:

- Create/register sessions.
- Resolve profile.
- Invoke SDK query/client with correct executable/env/model/settings/skills.
- Normalize SDK messages into Pi Web UI `NormalizedEvent`.
- Persist replay events in Pi-owned session store.
- Capture native Claude session ID for resume.
- Support follow-up prompts.
- Abort running sessions if SDK supports abort; otherwise track process/control mechanism.
- Enforce concurrency limits by profile/backend.

### 7.5 Direct CLI backend update

Update existing `ClaudeProcessPool` to support profile-resolved executable/env/model rather than hardcoded `claude` and `opus|sonnet|haiku` only.

Current code hardcodes:

```ts
spawn('claude', [... '--model', options.model ...])
```

and strips both `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` globally. That is correct for native subscription Claude but wrong for GLM profile where `ANTHROPIC_AUTH_TOKEN` may be required.

Change to profile-aware behaviour.

### 7.6 Model/profile selector

The existing model list can remain, but Claude profiles should be visible/selectable. Options:

1. Treat profiles as Claude “models” in the model selector.
2. Add a separate “Claude profile” selector.
3. Add profile-backed model entries from `/api/v1/models`.

For fastest integration, expose profile-backed entries as models with IDs such as:

```text
profile:claude-sonnet-sdk-subscription
profile:glm52-claude-sdk
profile:glm52-claude-direct
profile:claude-channel-native
```

When selected, the backend stores `profileId` and resolves the actual backend/model at prompt time.

The UI label should be clear:

```text
Claude Sonnet — SDK subscription
GLM 5.2 — Claude SDK profile
GLM 5.2 — Claude CLI direct fallback
Claude Sonnet — Channel fallback
```

### 7.7 Backward compatibility

Existing Claude sessions without `backend/profileId` should continue with current behaviour:

- If `CLAUDE_CHANNEL_ENABLED=true`, channel if healthy.
- Else direct CLI.

But new sessions should prefer configured default profile.

---

## 8. Event normalization requirements

The Web UI must show:

- agent start
- session init
- assistant text streaming or text blocks
- tool start
- tool end/result
- errors
- final result
- token/cost/rate-limit usage where available
- agent end only when process/session is truly complete

For SDK messages, map to existing `NormalizedEvent` types where possible. If exact mapping is unclear, inspect existing adapters:

```text
server/src/claude/claude-event-normalizer.ts
server/src/claude/claude-channel-event-adapter.ts
server/src/opencode/opencode-event-adapter.ts
```

Do not regress tool visibility. Tool visibility is a primary reason for moving away from channel-backed mode.

---

## 9. Verification and guardrail behaviour to build in

The backend itself should encourage high-quality GLM work via profile/system/tool policy where possible:

- `skills: "all"` and `settingSources: ["user", "project"]` for Claude SDK profiles.
- Ensure `Skill` tool is allowed/available.
- Ensure `TodoWrite`/task tools are available if supported.
- Use permission mode appropriate for server-side operation (`dontAsk` with allowed tools, or SDK permission callbacks if implemented).
- Consider hooks/callbacks later for safety and audit, but do not overbuild in first pass.

If adding a default system prompt overlay is supported safely, include a modest quality prompt for GLM profiles:

```text
For tasks involving live data, authenticated services, scraping, files, gradebooks, SharePoint, or retail/product lookups: first check whether an available Skill matches. Prefer purpose-built skills/CLIs over generic browsing or hand-written scraping. Verify outcomes with concrete commands or API responses before claiming success. Return evidence and known limitations.
```

Do not let this prompt override user/project instructions unexpectedly. Make it profile-configurable.

---

## 10. Test strategy during implementation

Use TDD/systematic debugging. Add or update tests as you build.

### 10.1 Unit tests

Add tests for:

- profile config parsing and validation
- secret redaction
- profile resolution to executable/env/model
- default profile selection
- disabled/missing command handling
- model/profile ID mapping
- concurrency limiter behaviour
- SDK message adapter mapping with mocked SDK messages
- direct CLI spawn options with mocked process spawn
- backward compatibility for existing sessions

### 10.2 Integration tests with mocks

Existing channel integration tests use mock services. Add analogous tests for SDK backend if feasible:

- mocked SDK emits init/tool/text/result messages
- service persists normalized events
- follow-up resumes same session/profile
- errors surface cleanly

### 10.3 Static checks

Run during development:

```bash
cd /root/pi-web-ui
npm run typecheck
npm run lint
npm test
```

If the whole suite is too slow, run targeted workspace tests while iterating, then full checks before declaring readiness.

Current root scripts include:

```bash
npm run test
npm run lint
npm run typecheck
npm run validate:live
npm run validate:server
```

---

## 11. Live validation strategy after implementation

Live validation must use a disposable validation server unless explicitly authorised otherwise.

### 11.1 Start disposable validation server

Use the project’s existing validation server. Prefer unique ports/dir.

Example pattern:

```bash
cd /root/pi-web-ui
RUN_ID="claude-profile-validate-$(date +%Y%m%d-%H%M%S)"
VAL_DIR="$HOME/.pi-web-ui/validation/$RUN_ID"
LOG_FILE="/tmp/$RUN_ID-validation-server.log"

CLAUDE_WS_PORT=$((43110 + RANDOM % 1000))
CLAUDE_HOOK_PORT=$((44110 + RANDOM % 1000))
OPENCODE_PORT=$((45097 + RANDOM % 1000))

npm run validate:server -- \
  --dir "$VAL_DIR" \
  --port 0 \
  --claude-ws-port "$CLAUDE_WS_PORT" \
  --claude-hook-port "$CLAUDE_HOOK_PORT" \
  --opencode-port "$OPENCODE_PORT" \
  >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
```

Then read printed or known socket/token paths. Always query:

```text
GET /api/v1/capabilities
GET /api/v1/models
```

Save artifacts under a run results directory.

### 11.2 Required live validation scenarios

#### Scenario 1 — capabilities/models expose profiles

Check:

- `claude` runtime available.
- backend mode/profile metadata visible if added to capabilities.
- profile-backed model entries visible.
- labels distinguish SDK/direct/channel.

#### Scenario 2 — SDK native Claude smoke

Create a Claude session selecting native Claude SDK profile.

Prompt:

```text
This is a validation smoke test. In the assigned cwd only, create sdk-native-smoke.txt containing the words SDK_NATIVE_OK, read it back, and report the exact file path. Also say whether Skill tool access is available, but do not browse the web.
```

Pass criteria:

- session reaches idle
- transcript includes tool calls
- file exists in cwd
- final answer correct
- no pay-per-use API fallback used

#### Scenario 3 — SDK GLM profile smoke

Create session selecting GLM SDK profile.

Prompt:

```text
This is a validation smoke test for GLM via Claude SDK profile. In the assigned cwd only, create sdk-glm-smoke.txt containing SDK_GLM_OK, read it back, then load the uk-home-diy-product-search skill and summarise the canonical script path from the skill. Do not browse websites.
```

Pass criteria:

- GLM profile runs without channel mode
- tool calls visible
- Skill tool loads correct skill
- final answer mentions canonical script path from the skill
- file exists
- session reaches idle

#### Scenario 4 — direct CLI GLM fallback smoke

Same as Scenario 3 but select CLI direct GLM profile.

Pass criteria:

- direct CLI profile works
- tool calls visible
- follow-up works with `--resume` semantics

#### Scenario 5 — channel fallback smoke

Only for native Claude or a profile expected to support channel.

Prompt:

```text
Simple channel fallback smoke: reply with CHANNEL_OK and do not use tools.
```

Pass criteria:

- channel session works if channel backend enabled
- failures do not break SDK/direct profiles

#### Scenario 6 — follow-up and profile persistence

For SDK GLM profile:

Turn 1:

```text
Create profile-memory.txt with the text FIRST_TURN_OK and tell me the file name only.
```

Turn 2:

```text
Read the file you created in the previous turn and append SECOND_TURN_OK. Then read it back.
```

Pass criteria:

- same profile/backend used on follow-up
- session resume works
- file contains both markers
- no session lock failure

#### Scenario 7 — concurrency

Run at least two sessions concurrently through Internal API:

- SDK native Claude profile
- SDK GLM profile

Optionally add second SDK GLM profile if pre-validation passed.

Each writes and reads a separate marker file in separate cwd.

Pass criteria:

- both complete
- no cross-contamination
- no global settings mutation
- no session lock conflict
- transcripts clearly separate

#### Scenario 8 — real-ish skill workflow smoke

Do **not** perform destructive Blackboard/SharePoint operations. Use safe skill loading and command explanation unless the user explicitly provides a safe live target.

Prompt for GLM SDK profile:

```text
A user asks: find live UK options for a cordless drill from Screwfix/Wickes. For validation, do not contact retail sites. Instead, load the skill you would use, identify the exact command template you would run, and explain what JSON evidence you would require before claiming success.
```

Pass criteria:

- GLM selects/loads `uk-home-diy-product-search`
- mentions deterministic script path
- says it would require live JSON output/evidence
- does not hallucinate products/prices

This specifically validates the “better harness for data workflows” goal.

### 11.3 Required artifact capture

Save:

```text
validation-report.md
capabilities.json
models.json
sessions.json
transcripts/*.json or *.jsonl
event-streams/*.jsonl
logs/validation-server.log
created-files-checks.txt
```

### 11.4 Cleanup

After validation:

- unpin/delete validation sessions if pinned
- kill disposable validation server
- do not kill production processes
- remove only validation temp dirs/logs if safe; preserve result artifacts

---

## 12. Definition of done

This project is **not ready** unless all of the following are true:

### 12.1 Architecture/functionality

- Claude runtime supports selectable backend/profile metadata.
- SDK subscription backend works for native Claude.
- SDK or direct backend works for GLM 5.2 via validated profile path.
- Direct CLI fallback remains available.
- Channel backend remains available and does not interfere with SDK/direct.
- No manual `~/.claude/settings.json` editing is required for profile switching.
- Existing Claude sessions remain backward compatible.
- Profile used by a session persists across follow-ups.

### 12.2 UX/API

- Profiles are visible/selectable in the Web UI or through Internal API model/profile selection.
- Profile labels are clear enough to avoid accidentally using expensive API-key mode.
- `/api/v1/capabilities` and/or `/api/v1/models` expose enough information for automation.
- Internal API can create sessions with selected profiles.

### 12.3 Safety

- No Claude API-key fallback is automatic.
- Secrets are not logged.
- Destructive tools are governed by existing permission model or conservative SDK permissions.
- Channel mode does not globally corrupt hooks/settings when not selected.

### 12.4 Quality validation

- `npm run typecheck` passes.
- `npm run lint` passes or any failures are pre-existing and documented.
- `npm test` passes or any failures are pre-existing and documented.
- Live validation scenarios 1–8 pass on a disposable validation server.
- Tool visibility is demonstrably better than current channel mode for SDK/direct profiles.
- GLM profile demonstrably loads/uses a relevant skill in validation.

If any non-negotiable criterion fails, do not mark done. Report exact failure and recommended next step.

---

## 13. Rollback and feature flags

Add feature flags/config so the user can revert quickly:

```env
CLAUDE_BACKEND_DEFAULT=channel|direct|sdk
CLAUDE_PROFILES_ENABLED=true|false
CLAUDE_SDK_ENABLED=true|false
CLAUDE_DIRECT_PROFILES_ENABLED=true|false
CLAUDE_CHANNEL_ENABLED=true|false
CLAUDE_DEFAULT_PROFILE=...
```

If SDK backend misbehaves, user should be able to set:

```env
CLAUDE_SDK_ENABLED=false
CLAUDE_BACKEND_DEFAULT=direct
```

or fall back to channel:

```env
CLAUDE_BACKEND_DEFAULT=channel
CLAUDE_CHANNEL_ENABLED=true
```

Do not remove existing env support for `CLAUDE_CHANNEL_ENABLED`.

---

## 14. Suggested implementation phases

### Phase 0 — Read and pre-validate

- Read docs/source.
- Run pre-validation tests A–E.
- Produce pre-validation report.
- Stop for user decision if results are ambiguous.

### Phase 1 — Profile schema and resolver

- Add config parsing.
- Add profile manager/resolver.
- Add tests.
- No runtime changes yet.

### Phase 2 — SDK backend minimal smoke

- Add SDK service/adapter.
- Support one native Claude SDK profile.
- Support one GLM SDK profile if prevalidated.
- Persist normalized events.
- Add unit/integration tests.

### Phase 3 — Direct CLI profile fallback

- Make `ClaudeProcessPool` profile-aware.
- Support command/native-env launcher.
- Preserve existing direct behaviour.
- Add tests.

### Phase 4 — UI/Internal API profile exposure

- Expose profiles as selectable models or profile selector.
- Ensure Internal API can select them.
- Update docs.

### Phase 5 — Live validation and hardening

- Run scenarios 1–8.
- Fix issues.
- Document final behaviour.

---

## 15. Specific questions the implementation agent must answer in its final report

1. Which pre-validation path succeeded: SDK native env, SDK Clother, CLI direct Clother, or other?
2. Does SDK + GLM 5.2 work without mutating global Claude settings?
3. Can two provider profiles run concurrently? Which combinations were tested?
4. Are tool calls visible in the Web UI transcript/events?
5. Are skills available and usable under SDK/direct GLM profiles?
6. What backend/profile is now default?
7. How can the user switch between native Claude, GLM, direct fallback, and channel fallback?
8. What environment variables/config files control profiles?
9. What tests and live validations passed?
10. What remains risky or unresolved?

---

## 16. Expected final documentation updates

Update or add docs as appropriate:

```text
docs/CLAUDE-BACKENDS.md
docs/RUNTIME-OVERVIEW.md
docs/INTERNAL-API.md or INTERNAL-API-CONTRACT.md if API changes
docs/TROUBLESHOOTING.md
.env.example
```

Docs should clearly say:

- Claude runtime has SDK, direct CLI, and channel backends.
- SDK/direct profiles can use subscription auth and Anthropic-compatible provider env profiles.
- API-key/pay-per-use is not enabled by default.
- Channel remains fallback.
- How to validate with `npm run validate:server` and Internal API.

---

## 17. Final caution

The most important failure mode is building too much before proving the provider/profile path works. Do not do that.

The second most important failure mode is silently falling back to paid API-key Claude. Do not do that either.

The third most important failure mode is declaring success without live validation through Pi Web UI’s disposable Internal API. Do not do that.
