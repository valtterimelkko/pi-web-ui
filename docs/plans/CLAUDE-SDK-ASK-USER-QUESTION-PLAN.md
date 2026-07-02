# Claude SDK `AskUserQuestion` Web UI Support Plan

Status: **Implemented** in commit `25eb290` (first-class AskUserQuestion support). This document is preserved as the implementation record. For the current runtime reference, see [`../CLAUDE-BACKENDS.md`](../CLAUDE-BACKENDS.md), [`../PROTOCOL.md`](../PROTOCOL.md), and [`../EVENT-PIPELINE.md`](../EVENT-PIPELINE.md).

Audience: an execution agent implementing the feature with strict TDD and validation.
Primary runtime target: **Claude SDK backend only**.

## 1. Goal

Implement first-class support for Claude Code's built-in `AskUserQuestion` tool when Pi Web UI is driving Claude through the **Claude Agent SDK** backend.

When Claude emits an `AskUserQuestion` tool call, Pi Web UI should:

1. Surface the question(s) in the browser UI as an interactive dialog.
2. Support Claude's native shape: **1–4 questions**, each with **2–4 options**, optional previews, and `multiSelect`.
3. Let the user answer in the Web UI.
4. Return those answers back into Claude Code through the SDK so the current turn continues.
5. Persist/replay the visible tool use and answer result consistently with the existing Claude replay store.
6. Validate the behaviour with unit tests, frontend tests, and live validation on a **disposable validation server**.

## 2. Non-goals

Do **not** implement this for every Claude backend in the first pass.

- **SDK backend:** in scope.
- **Direct CLI backend (`claude -p`):** out of scope. It has no clean mid-tool answer callback.
- **Channel backend:** out of scope for this plan. It has a different PTY/channel/plugin architecture.
- **Native Pi SDK extension UI:** do not redesign it; only extend/reuse the existing Web UI request surface where appropriate.
- **Raw HTML preview rendering:** out of scope for first pass. Treat preview content as markdown/text unless a separate sanitisation design is implemented.

## 3. Mandatory resource signposts

The execution agent must read these before editing code:

### Project docs

- `AGENTS.md`
- `docs/ARCHITECTURE.md`
- `docs/CODEBASE-MAP.md`
- `docs/CLAUDE-BACKENDS.md`
- `docs/CLAUDE-PROVIDER-PROFILES.md`
- `docs/PROTOCOL.md`
- `docs/EVENT-PIPELINE.md`
- `docs/INTERNAL-API.md`
- `docs/INTERNAL-API-ORCHESTRATION.md`
- `docs/LIVE-VALIDATION.md`
- `docs/TROUBLESHOOTING.md`

### Skills to use by name

- `test-driven-development`
- `pi-web-ui-internal-api-orchestration`
- `webapp-testing` for localhost browser/UI validation
- `systematic-debugging` if any test, typecheck, lint, runtime, or validation failure occurs

Do **not** include or rely on a hard-coded local path to those skills. The execution agent's skill directory may differ.

### Existing backend files

- `server/src/claude/claude-sdk-service.ts`
- `server/src/claude/claude-service.ts`
- `server/src/claude/claude-profiles.ts`
- `server/src/claude/claude-sdk-event-adapter.ts`
- `server/src/claude/claude-session-store.ts`
- `server/src/claude/claude-history-replay.ts`
- `server/src/websocket/connection.ts`
- `server/src/websocket/protocol.ts`
- `server/src/internal-api/routes/sessions.ts`
- `server/src/internal-api/types.ts`
- `server/src/internal-api/event-types.ts`
- `server/src/live-validation/scenarios.ts`
- `scripts/live-validate.ts`

### Existing frontend files

- `client/src/App.tsx`
- `client/src/store/sessionStore.ts`
- `client/src/hooks/useWebSocket.ts`
- `client/src/components/Extensions/ExtensionDialog.tsx`
- `client/src/components/Tools/ToolCallCard.tsx`
- `client/src/components/Tools/CollapsibleToolCard.tsx`
- `client/src/lib/messageAdapter.ts`

### SDK typings / runtime evidence

- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`

Relevant SDK types:

- `Options.canUseTool`
- `Options.permissionMode`
- `Options.allowedTools`
- `Options.toolConfig.askUserQuestion`
- `AskUserQuestionInput`
- `AskUserQuestionOutput`
- `PermissionResult`

## 4. Current evidence and known behaviour

### 4.1 What failed in the real user session

Session: `c372d63b-0ba7-4556-8499-c4b0bbad2546`.

Files inspected:

- Pi-owned replay: `/root/.pi-web-ui/claude-sessions/c372d63b-0ba7-4556-8499-c4b0bbad2546.jsonl`
- Claude native session: `/root/.claude/projects/-root--skills-global/605f273c-ba07-4f9e-88cd-6bbf4c29e9c4.jsonl`

Claude emitted:

```json
{
  "name": "AskUserQuestion",
  "input": {
    "questions": [
      {
        "question": "How should I continue the investigation before we build anything?",
        "header": "Next step",
        "multiSelect": false,
        "options": [
          { "label": "Test Option A feasibility (Recommended)", "description": "..." },
          { "label": "Go straight to Option B design", "description": "..." },
          { "label": "Investigate both in parallel", "description": "..." },
          { "label": "I'll decide after more info", "description": "..." }
        ]
      }
    ]
  }
}
```

The tool result was an error:

```text
Permission to use AskUserQuestion has been denied because Claude Code is running in don't ask mode.
```

### 4.2 Disposable SDK probe result from planning session

A small direct SDK probe showed:

- With `permissionMode: 'dontAsk'`, `AskUserQuestion` is denied before a useful answer can be supplied.
- With `permissionMode: 'default'`, `canUseTool` receives:
  - `toolName: 'AskUserQuestion'`
  - the full `questions` payload
  - `toolUseID`
- Returning a `PermissionResult` shaped like this works:

```ts
return {
  behavior: 'allow',
  updatedInput: {
    ...input,
    answers: {
      'Pick one option': 'B',
    },
  },
};
```

Claude then receives a normal tool result:

```text
Your questions have been answered: "Pick one option"="B". You can now continue with these answers in mind.
```

This is the core implementation strategy.

## 5. Target user experience

### 5.1 One question

Render a modal/dialog with:

- Question header chip/tag.
- Full question text.
- Option cards or radio buttons.
- Option descriptions.
- Optional preview panel rendered as safe markdown/text.
- Optional freeform "Other / notes" field.
- Submit button disabled until a required answer exists.
- Cancel/Skip button.

Do **not** auto-submit on click in the first pass. Requiring Submit avoids accidental answers.

### 5.2 Two to four questions

Render one vertical card/section per question in the same modal:

- Progress text such as `Question 1 of 3` is acceptable but not required.
- Submit enabled only when every question has at least one selected answer or a freeform answer.
- The user can answer in any order.
- Each question keeps its own state.

### 5.3 Multi-select questions

For `multiSelect: true`:

- Render checkboxes or multi-select option cards.
- Allow 1–4 selected options.
- Convert selected labels to a comma-separated string in `answers[question]`, matching SDK output documentation.

Example:

```json
{
  "answers": {
    "Which features should be enabled?": "Search, Attachments"
  }
}
```

### 5.4 Cancel / skip behaviour

For an `AskUserQuestion` cancellation, do **not** send a permission-denied tool result unless there is a strong reason. Prefer returning `allow` with the original input and **no `answers`** so Claude receives its own graceful no-answer behaviour:

```text
The user did not answer the questions.
```

This avoids turning a user skip into a scary permission failure.

### 5.5 Preview content

The SDK supports `toolConfig.askUserQuestion.previewFormat` as `markdown` or `html`.

First-pass requirement:

- Set/keep preview expectations to markdown/text.
- Do not use `dangerouslySetInnerHTML` for previews.
- If using `react-markdown`, do not enable raw HTML rendering.
- Large previews must be collapsible or constrained so the modal remains usable.

## 6. Target protocol/data design

Use the existing Web UI extension/dialog route where possible, but add a specific request type for this richer shape.

### 6.1 Backend normalized event

Add a new normalized event emitted by the Claude SDK service:

```ts
{
  type: 'ask_user_question_request',
  sessionId,
  timestamp,
  data: {
    requestId: string,
    toolCallId: string,
    toolName: 'AskUserQuestion',
    questions: AskUserQuestionInput['questions'],
    timeoutMs: number,
  }
}
```

Rationale:

- It can flow through the same event broker used by WebSocket and Internal API.
- It lets `/events` consumers see the request.
- It keeps this distinct from tool permission prompts.

### 6.2 Browser request

Extend `ExtensionUIRequest` to support:

```ts
type: 'ask_user_question'
params: {
  questions: Array<{
    question: string;
    header: string;
    multiSelect: boolean;
    options: Array<{
      label: string;
      description: string;
      preview?: string;
    }>;
  }>;
  toolCallId?: string;
  toolName?: 'AskUserQuestion';
}
```

### 6.3 Browser response

Use the existing `extension_ui_response` envelope, with `value` carrying structured answers:

```ts
{
  type: 'extension_ui_response',
  response: {
    id: requestId,
    approved: true,
    value: {
      answers: Record<string, string>,
      annotations?: Record<string, { preview?: string; notes?: string }>
    }
  }
}
```

For cancel/skip:

```ts
{
  id: requestId,
  cancelled: true
}
```

Backend maps cancellation to `allow` with original input/no answers for `AskUserQuestion` only.

### 6.4 Internal API approval response

Extend `ApprovalResponseRequest` in `server/src/internal-api/types.ts` beyond `{ approved: boolean }`:

```ts
export interface ApprovalResponseRequest {
  approved: boolean;
  value?: unknown;
  answers?: Record<string, string>;
  annotations?: Record<string, { preview?: string; notes?: string }>;
  cancelled?: boolean;
}
```

The route `POST /api/v1/sessions/:id/approvals/:requestId/respond` should be able to answer an `AskUserQuestion` request observed on `/events`.

This is important for live validation without browser automation.

## 7. Backend implementation plan

Strict TDD rule: **write each failing test first, run it, confirm the expected failure, then implement the minimal production code.**

### 7.1 Add SDK ask-user pending request state

Likely file: `server/src/claude/claude-sdk-service.ts`.

Add internal state similar to:

```ts
private pendingAskUserQuestions = new Map<string, {
  sessionId: string;
  toolCallId: string;
  originalInput: Record<string, unknown>;
  resolve: (result: AskUserQuestionResolution) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}>();
```

Add public methods:

```ts
isPendingAskUserQuestion(requestId: string): boolean;
respondToAskUserQuestion(requestId: string, response: {
  answers?: Record<string, string>;
  annotations?: Record<string, { preview?: string; notes?: string }>;
  cancelled?: boolean;
}): boolean;
```

Expose through `ClaudeService`:

- `isPendingAskUserQuestion(requestId: string): boolean`
- `respondToAskUserQuestion(sessionId: string, requestId: string, response: ...): boolean`

### 7.2 Refactor `createCanUseTool`

Current method:

```ts
private createCanUseTool(allowedTools?: string[]) { ... }
```

Refactor so it has session/event context:

```ts
private createCanUseTool(params: {
  sessionId: string;
  allowedTools?: string[];
  onEvent: (event: NormalizedEvent) => void;
  askUserTimeoutMs?: number;
})
```

Behaviour:

1. If `toolName !== 'AskUserQuestion'`: preserve current allowlist behaviour.
2. If `toolName === 'AskUserQuestion'`:
   - validate `input.questions` shape defensively.
   - emit `ask_user_question_request` normalized event.
   - wait for response or timeout.
   - if answered, return `allow` with `updatedInput: { ...input, answers, annotations? }`.
   - if cancelled/timed out, return `allow` with original input and no answers.

### 7.3 Effective permission mode

Problem: `permissionMode: 'dontAsk'` denies `AskUserQuestion` before the SDK callback can usefully supply answers.

Requirement:

- For SDK sessions where `AskUserQuestion` support is enabled, do **not** pass `dontAsk` as the effective SDK permission mode.
- Prefer `permissionMode: 'default'` while keeping `canUseTool` and `allowedTools` as the real server-side policy gate.

Important:

- Do not accidentally broaden tool access.
- Tools not in the allowlist must still be denied by `canUseTool`.
- Add `AskUserQuestion` to the effective allowed tools for SDK sessions.

Suggested helper:

```ts
function buildEffectiveSdkPermissionMode(profileMode: string | undefined): Options['permissionMode'] {
  return profileMode === 'dontAsk' ? 'default' : profileMode as Options['permissionMode'];
}
```

Only apply this inside the SDK backend. Do not mutate profile files on disk.

### 7.4 Default allowed tools

Likely file: `server/src/claude/claude-profiles.ts`.

If there is a `DEFAULT_ALLOWED_TOOLS` array, include `AskUserQuestion` for SDK profiles. Do not add it to direct CLI profiles unless direct behaviour is deliberately verified.

If the implementation decides not to change the global default, then `ClaudeSdkService` must append `AskUserQuestion` to the **effective** SDK allowlist before calling `query()`.

### 7.5 WebSocket routing

File: `server/src/websocket/connection.ts`.

Add a branch in `handleClaudePrompt`'s normalized event callback:

```ts
if (normalizedEvent.type === 'ask_user_question_request') {
  // build extension_ui_request with request.type = 'ask_user_question'
  // send to Claude subscribers or fallback client
  // do not also forward as a normal session_event unless deliberate
}
```

Also update `handleExtensionUiResponse`:

1. If `claudeService.isPendingAskUserQuestion(id)`, route the structured response to `respondToAskUserQuestion`.
2. Else preserve existing Claude permission response behaviour.
3. Else preserve OpenCode and Pi extension response behaviour.

Do not break existing `permission_request` handling for Claude channel/OpenCode.

### 7.6 Internal API routing

Files:

- `server/src/internal-api/routes/sessions.ts`
- `server/src/internal-api/types.ts`
- `server/src/internal-api/event-types.ts`

Requirements:

- `ask_user_question_request` must flow into `/sessions/:id/events` when prompt verbosity is `full`.
- `POST /sessions/:id/approvals/:requestId/respond` must be able to answer an SDK AskUserQuestion request with `answers`/`annotations`.
- Event-type catalogue should document `ask_user_question_request` as a control event.
- Existing permission approval responses must remain compatible.

### 7.7 Persistence/replay

Files:

- `server/src/claude/claude-sdk-service.ts`
- `server/src/claude/claude-history-replay.ts`
- `server/src/claude/claude-session-store.ts`

At minimum:

- Existing `assistant tool_use` persistence already stores `AskUserQuestion` as a normal `tool` entry.
- Existing `user tool_result` persistence should store the returned text as `tool_result`.

Add tests to prove:

- Tool start is persisted with `toolName: 'AskUserQuestion'` and full input.
- Tool result is persisted and replayed as closed, not stuck/running.

Do not invent a separate permanent secret-bearing store. User answers may be sensitive; they should only be persisted as part of normal visible transcript/tool result, exactly as Claude Code would persist them.

## 8. Frontend implementation plan

Strict TDD rule applies here too.

### 8.1 Types/store

Files:

- `client/src/store/sessionStore.ts`
- `client/src/components/Extensions/ExtensionDialog.tsx`
- possibly `client/src/components/Extensions/AskUserQuestionDialog.tsx`

Extend the request type:

```ts
type ExtensionUIRequest['type'] =
  | 'confirm'
  | 'select'
  | 'input'
  | 'editor'
  | 'ask_user_question';
```

Define typed question/option helpers instead of repeatedly using `Record<string, unknown>`.

### 8.2 Dedicated component preferred

Create a dedicated component rather than overloading the existing dialog too much:

- `client/src/components/Extensions/AskUserQuestionDialog.tsx`

Props:

```ts
interface AskUserQuestionDialogProps {
  questions: AskUserQuestion[];
  onSubmit: (value: { answers: Record<string, string>; annotations?: AskUserAnnotations }) => void;
  onCancel: () => void;
}
```

The existing `ExtensionDialog` can delegate to it when `request.type === 'ask_user_question'`.

### 8.3 Rendering rules

Must support:

- 1 question.
- 2–4 questions.
- single-select options.
- multi-select options.
- optional preview.
- option descriptions.
- freeform "Other / notes".
- keyboard accessibility: labels, focusable controls, buttons.
- mobile-width usability: modal should scroll internally if content is tall.

### 8.4 Answer shaping

For each question:

- Single-select answer: selected option label.
- Multi-select answer: comma-separated selected labels.
- Freeform answer: typed text.
- Notes/preview annotations: optional.

Response sent by `App.tsx` should remain the existing envelope:

```ts
client.send({ type: 'extension_ui_response', response });
```

Do not create a second browser WebSocket action unless there is a strong reason.

## 9. Test plan: required RED/GREEN sequence

The execution agent must not implement production code before the relevant failing tests exist and fail for the expected reason.

### 9.1 Server unit tests: SDK service

File to add or extend:

- `server/tests/unit/claude/claude-sdk-service-integration.test.ts`

Required tests:

1. **Effective permission mode**
   - Given a profile with `permissionMode: 'dontAsk'`.
   - When SDK query options are built/sent.
   - Then the effective SDK `permissionMode` is not `dontAsk` when AskUserQuestion support is enabled.
   - It should be `default` unless the final implementation uses a better documented value.

2. **AskUserQuestion is included in effective allowlist**
   - Capture `query({ prompt, options })` mock call.
   - Assert `options.allowedTools` includes `AskUserQuestion`.

3. **AskUserQuestion emits request and resolves with answers**
   - Mock `query` to capture `options.canUseTool`.
   - Invoke `canUseTool('AskUserQuestion', input, { toolUseID: 'toolu_ask', signal })`.
   - Assert an `ask_user_question_request` event is emitted with exact questions.
   - Call service response method with answers.
   - Assert returned `PermissionResult` is `allow` and `updatedInput.answers` matches.

4. **Cancel/timeout does not produce permission-denied error**
   - Trigger AskUserQuestion.
   - Resolve as cancelled or advance fake timers to timeout.
   - Assert returned `PermissionResult` is `allow` with no answers.

5. **Non-allowed tool remains denied**
   - With allowlist `['Read']`, call `canUseTool('Bash', ...)`.
   - Assert `deny` and message explains the allowlist.

6. **Cleanup after completion**
   - After answer/cancel/timeout, pending map no longer contains request.

### 9.2 Server unit tests: ClaudeService delegation

File to add or extend:

- `server/tests/unit/claude/claude-service-*.test.ts`

Required tests:

- `ClaudeService.isPendingAskUserQuestion` delegates to SDK service when present.
- `ClaudeService.respondToAskUserQuestion` delegates to SDK service and returns a success boolean.
- Existing `sendPermissionResponse` for channel permissions still works or remains untouched.

### 9.3 Server unit tests: WebSocket routing

Files to add/extend:

- `server/tests/unit/websocket/connection.test.ts`
- or a focused new file: `server/tests/unit/websocket/claude-ask-user-question.test.ts`

Required tests:

1. `ask_user_question_request` normalized event becomes top-level `extension_ui_request` for current Claude subscribers.
2. Request has `type: 'ask_user_question'` and contains the full `questions` array.
3. `extension_ui_response` with structured answers calls `claudeService.respondToAskUserQuestion`.
4. Existing Claude permission request route still calls `sendPermissionResponse`.
5. Existing OpenCode permission response route still calls `opencodeService.resolvePermission`/equivalent.

### 9.4 Server unit tests: Internal API

Files to add/extend:

- `server/tests/unit/internal-api/*` if present, or create focused tests following current patterns.
- `server/tests/unit/websocket/protocol.test.ts` only if protocol guards change.
- `server/src/internal-api/event-types.ts` should have test coverage if an event-type test exists.

Required tests:

1. `ApprovalResponseRequest` accepts `answers`/`annotations` while preserving `approved`.
2. `handleRespondApproval` routes pending Claude AskUserQuestion answers to `claudeService.respondToAskUserQuestion`.
3. If not an AskUserQuestion request, existing Claude permission response route remains unchanged.
4. Event catalogue includes `ask_user_question_request`.

### 9.5 Frontend component tests

Add tests near the new component, for example:

- `client/src/components/Extensions/AskUserQuestionDialog.test.tsx`

Required tests:

1. **Single question / single select**
   - Render one question with two options.
   - Submit disabled initially.
   - Select option B.
   - Submit calls `onSubmit({ answers: { [question]: 'B' } })`.

2. **Three questions**
   - Render three questions.
   - Submit disabled until all three are answered.
   - Submit returns all answers keyed by exact question text.

3. **Multi-select**
   - Render `multiSelect: true`.
   - Select A and C.
   - Submit answer is `A, C`.

4. **Cancel**
   - Clicking cancel calls `onCancel` and does not submit partial answers.

5. **Preview safety**
   - Preview text containing HTML is not executed as raw HTML.
   - No `dangerouslySetInnerHTML` unless a sanitizer is explicitly introduced and tested.

### 9.6 Frontend integration test

Add or extend a test for `ExtensionDialog`:

- Given request `{ type: 'ask_user_question', params: { questions } }`.
- It renders `AskUserQuestionDialog`.
- It returns an `ExtensionUIResponse` with `approved: true` and the expected `value`.

## 10. Live validation plan

Live validation must use a **disposable validation server**. The execution agent must not use `~/.pi-web-ui/internal-api.sock` or the production Web UI unless it asks the user for explicit permission and receives it.

### 10.1 Use the orchestration skill

Use the skill named `pi-web-ui-internal-api-orchestration` before creating live-validation scripts or running Internal API checks.

### 10.2 Disposable server only

Start:

```bash
VALIDATION_DIR=$(mktemp -d)
npm run validate:server -- --dir "$VALIDATION_DIR" --port 0
```

Use the printed:

- `$VALIDATION_DIR/internal-api.sock`
- `$VALIDATION_DIR/internal-api-token`

Tear the server down at the end.

### 10.3 Backend live-validation scenario

Add a scenario to `server/src/live-validation/scenarios.ts`, for example:

- `claude-ask-user-question`

Scenario flow:

1. Create a Claude session using an SDK-backed profile/model. Prefer the cheapest available working subscription route, e.g. a Haiku or Sonnet profile if listed by `/models`.
2. Open/consume full events, or send prompt with full verbosity.
3. Prompt Claude with a constrained instruction:

```text
Integration validation only. Use AskUserQuestion exactly once. Ask three questions:
1. Pick a colour: Red, Blue.
2. Pick a size: Small, Large.
3. Pick features, multi-select: Search, Attachments, Export.
After receiving the answers, reply in exactly this format:
ASK_VALIDATION_RESULT colour=<answer>; size=<answer>; features=<answer>
Do not use any other tools.
```

4. Wait for `ask_user_question_request` event.
5. Assert it contains exactly three questions and the third has `multiSelect: true`.
6. Respond through:

```http
POST /api/v1/sessions/:id/approvals/:requestId/respond
```

with body like:

```json
{
  "approved": true,
  "answers": {
    "Pick a colour": "Blue",
    "Pick a size": "Large",
    "Pick features": "Search, Export"
  }
}
```

Use the exact question text emitted by Claude, not guessed text, when building the response.

7. Wait for `agent_end`.
8. Read transcript.
9. Assert final assistant text contains:

```text
ASK_VALIDATION_RESULT colour=Blue; size=Large; features=Search, Export
```

If Claude slightly varies punctuation, update the prompt or assertion; do not weaken the validation so much that it could pass without answers being returned.

### 10.4 Browser/UI validation

Because this feature is user-facing, backend validation is not enough.

Use `webapp-testing` for localhost/disposable UI validation.

Minimum browser check:

1. Start a disposable validation server and a local client pointed at it, following existing project patterns.
2. Create or open an SDK Claude session.
3. Trigger `AskUserQuestion` with a prompt.
4. Confirm the dialog appears.
5. Answer a single-select and a multi-select question.
6. Confirm the dialog closes.
7. Confirm Claude continues and incorporates the selected answers.

If full browser automation against a real Claude turn is too slow or flaky, do both:

- a real backend Internal API validation proving the SDK answer loop works, and
- a frontend component/browser test proving the dialog works.

Do not claim full end-to-end browser live validation unless a real browser flow was actually run.

### 10.5 Production validation rule

The execution agent must ask explicit user permission before any production validation. It must say exactly what it wants to do and why disposable validation is insufficient.

Without that permission:

- Do not call `~/.pi-web-ui/internal-api.sock`.
- Do not restart `pi-web-ui.service`.
- Do not modify production `~/.pi-web-ui/claude-profiles.json`.
- Do not use `--allow-production`.

## 11. Required validation commands before completion

At minimum, run targeted checks first, then full checks.

### 11.1 Targeted tests during TDD

Server examples:

```bash
npm run test --workspace=server -- server/tests/unit/claude/claude-sdk-service-integration.test.ts
npm run test --workspace=server -- server/tests/unit/websocket/claude-ask-user-question.test.ts
```

Client examples:

```bash
npm run test --workspace=client -- client/src/components/Extensions/AskUserQuestionDialog.test.tsx
```

### 11.2 Full repo quality gates

Before claiming done, run:

```bash
npm run docs:check-agent-guides
npm run lint
npm run typecheck
npm run build
npm test
```

And the live validation scenario on a disposable server:

```bash
npm run validate:live -- \
  --socket "$VALIDATION_DIR/internal-api.sock" \
  --token-path "$VALIDATION_DIR/internal-api-token" \
  --runtime claude \
  --scenario claude-ask-user-question \
  --json
```

If a new dedicated validator script is added, document and run it.

## 12. Definition of done

The feature is **not done** unless all of these are true:

### Backend correctness

- [ ] SDK sessions no longer deny `AskUserQuestion` due to `dontAsk`.
- [ ] Non-AskUserQuestion tools still obey the allowlist/denylist.
- [ ] AskUserQuestion emits a structured request with full question data.
- [ ] Browser/WebSocket response returns `updatedInput.answers` to SDK.
- [ ] Cancel/timeout is graceful and does not leave the session permanently streaming.
- [ ] Pending request state is cleaned up after answer, cancel, timeout, abort, or error.
- [ ] Internal API can observe and respond to AskUserQuestion requests.

### Frontend correctness

- [ ] Dialog supports 1 question.
- [ ] Dialog supports 2–4 questions.
- [ ] Dialog supports `multiSelect`.
- [ ] Dialog returns answers keyed by exact question text.
- [ ] Dialog does not execute raw HTML previews.
- [ ] Dialog works on narrow/mobile-ish width with scrollable content.
- [ ] Existing confirm/select/input/editor extension dialogs still work.

### Replay/display correctness

- [ ] AskUserQuestion tool card does not remain stuck in Running after answer/cancel.
- [ ] Session replay after refresh shows the closed tool result.
- [ ] Existing Claude replay tests still pass.

### Validation correctness

- [ ] Unit tests were written before implementation and observed failing.
- [ ] All targeted server and client tests pass.
- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm run build` passes.
- [ ] `npm test` passes.
- [ ] Disposable-server live validation passes.
- [ ] If browser live validation was not run, the final report explicitly says so and explains what was run instead.

### Security / operations

- [ ] No Anthropic API key path is introduced.
- [ ] `ANTHROPIC_API_KEY` stripping for native subscription SDK sessions is preserved.
- [ ] No tokens, cookies, session dumps, browser profiles, or local secrets are committed.
- [ ] `git status --short`, `git diff --stat`, and relevant diffs are inspected before final report.

## 13. Failure modes the execution agent must handle

Do not claim victory if any of these happens:

1. **The model asks in plain text instead of using `AskUserQuestion`.**  
   That does not validate this feature.

2. **The dialog appears but answers are not returned to Claude.**  
   UI-only success is not enough.

3. **The SDK returns a permission-denied tool result.**  
   The permission mode/allowlist bridge is still wrong.

4. **The tool stays Running after refresh.**  
   Replay/persistence is incomplete.

5. **Only unit tests pass.**  
   A real disposable-server validation is still required unless there is a documented blocker.

6. **Validation hits production without permission.**  
   This is a hard process failure.

7. **The fix relies on `ANTHROPIC_API_KEY`.**  
   This violates the project's Claude subscription-auth constraint.

## 14. Suggested implementation order

1. Read all resources in section 3.
2. Add failing server tests for SDK `canUseTool`/AskUserQuestion handling.
3. Implement minimal backend SDK bridge.
4. Add failing WebSocket routing tests.
5. Implement WebSocket routing.
6. Add failing Internal API approval/event tests.
7. Implement Internal API routing and event catalogue update.
8. Add failing frontend component tests.
9. Implement frontend dialog.
10. Add/adjust replay tests if needed.
11. Add live-validation scenario.
12. Run disposable live validation.
13. Run full quality gates.
14. Inspect git status/diffs and report honestly.

## 15. Final report requirements for the execution agent

The final implementation report must include:

- Files changed.
- Tests added.
- Exact validation commands run.
- Disposable validation server socket/token paths used, or explicit statement that production was not used.
- Live validation verdict with evidence.
- Any skipped validation and why.
- Known limitations.
- Confirmation that no secrets/session artifacts were added.

Suggested live validation wording:

```markdown
✅ LIVE-VALIDATED — Claude SDK AskUserQuestion round trip
Ran on: disposable validation server (production server untouched)
Checked: Claude emitted ask_user_question_request, Internal API answered it, Claude continued with selected answers
Evidence: final transcript contained `ASK_VALIDATION_RESULT colour=Blue; size=Large; features=Search, Export`
```
