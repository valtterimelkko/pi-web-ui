# Model Switching Test Report

Test target: `https://pi.letsautomate.work`

Test date: `2026-03-14`

Instruction followed: issues were **not fixed**; this file reports findings only.

## Scope and method

- Reviewed `README.md` and repo context before testing.
- Used `playwright-cli` with Firefox session `model-switch-audit`.
- Logged in with the provided password and opened the existing session `are you here?`.
- Correlated UI behavior with backend JSONL evidence from:
  - `/root/.pi/agent/sessions/--root--/2026-03-11T18-38-38-421Z_e2b43666-8ee3-41a1-993c-2b6777b4f656.jsonl`
- Captured transient Playwright snapshots during execution to validate UI state; those scratch artifacts were later removed during cleanup so only this written report remains in git.

## Key finding summary

The model picker UI can display the intended target model **inside the settings modal before save**, but saving does not reliably apply the change to the live session.

Observed behavior across the required models:

- The footer/status bar remained `Gpt 5.4` after attempted switches to `Claude Sonnet 4.6`, `Kimi K2.5`, and `GLM-5`.
- The backend session file continued to show `github-copilot/gpt-5.4` as the effective model.
- Assistant messages also remained tagged as `gpt-5.4` in the backend.
- Chat responses in the tested session were failing with `413 failed to parse request`, so the assistant did not provide a natural-language self-identification response.

## Evidence

Session file used for backend verification:

```json
{"type":"model_change","id":"73a0a561","parentId":null,"timestamp":"2026-03-11T18:38:38.422Z","provider":"kimi-subscription","modelId":"kimi-for-coding"}
{"type":"model_change","id":"f64cdafb","parentId":"1183e8ef","timestamp":"2026-03-11T18:40:58.282Z","provider":"github-copilot","modelId":"gpt-5.4"}
{"type":"model_change","id":"26c406a1","parentId":"5f2dfe92","timestamp":"2026-03-14T22:08:50.590Z","provider":"github-copilot","modelId":"gpt-5.4"}
{"type":"message","id":"4fb4a342","parentId":"26c406a1","timestamp":"2026-03-14T22:11:51.106Z","message":{"role":"user","content":[{"type":"text","text":"What model are you? Reply with just your model name."}],"timestamp":1773526311012}}
{"type":"message","id":"40bf0028","parentId":"4fb4a342","timestamp":"2026-03-14T22:11:52.298Z","message":{"role":"assistant","content":[],"api":"openai-responses","provider":"github-copilot","model":"gpt-5.4","stopReason":"error","errorMessage":"413 failed to parse request"}}
```

Important UI observations captured during the run:

- The target models were present in the dropdown, including `Claude Sonnet 4.6`, `GPT-5.4`, `Kimi K2.5`, and `GLM-5`.
- After attempted switches to Claude, Kimi, and GLM, the footer still showed `Gpt 5.4`.
- In the conversation view, assistant model badges repeatedly showed `Gpt 5.4`.
- Re-selecting GPT kept the footer at `Gpt 5.4`, which matched the backend baseline.

## Test: GPT 5.4 (`github-copilot/gpt-5.4`)

### Phase 1: UI Selection

- Status: ✅ PASS
- Details:
  - The session loaded already showing `Gpt 5.4` in the footer.
  - Re-selecting `GPT-5.4` in the modal succeeded visually inside the modal.
  - After save, the footer still showed `Gpt 5.4`, which is consistent for this baseline model.
- Evidence:
  - Live UI observation during the run: footer remained `Gpt 5.4` after explicit GPT re-selection.

### Phase 2: Backend Verification

- Status: ✅ PASS
- Session file:
  - `/root/.pi/agent/sessions/--root--/2026-03-11T18-38-38-421Z_e2b43666-8ee3-41a1-993c-2b6777b4f656.jsonl`
- Expected:
  - `github-copilot/gpt-5.4`
- Actual:
  - Latest observed `model_change` remained:

```json
{"type":"model_change","id":"26c406a1","parentId":"5f2dfe92","timestamp":"2026-03-14T22:08:50.590Z","provider":"github-copilot","modelId":"gpt-5.4"}
```

### Phase 3: Chat Verification

- Status: ⚠️ PARTIAL / FAIL
- Details:
  - Backend tracked assistant output as `model: "gpt-5.4"`.
  - However, the chat response itself failed with `413 failed to parse request`, so the model did not answer with its own name.
  - Existing message badges in the UI showed `Gpt 5.4`.
- Backend evidence:

```json
{"type":"message","id":"40bf0028","parentId":"4fb4a342","timestamp":"2026-03-14T22:11:52.298Z","message":{"role":"assistant","provider":"github-copilot","model":"gpt-5.4","stopReason":"error","errorMessage":"413 failed to parse request"}}
```

### Phase 4: Cross-Reference Verification

- Status: ✅ PASS
- Details:
  - The backend message entry and the UI badge both pointed to GPT 5.4.
  - The remaining issue here is the request failure, not a model mismatch.

### Overall

- Overall: ⚠️ Baseline mostly consistent, but chat execution is unhealthy due to `413 failed to parse request`.

## Test: Claude Sonnet 4.6 (`github-copilot/claude-sonnet-4.6`)

### Phase 1: UI Selection

- Status: ❌ FAIL
- Details:
  - The modal selection changed internally to `Claude Sonnet 4.6github-copilot` before save.
  - After clicking `Save Changes` and waiting 5 seconds, the footer still showed `Gpt 5.4`.
  - No reliable success toast was captured.
- Evidence:
  - Live UI observation during the run: footer remained `Gpt 5.4` after the Claude save attempt.

### Phase 2: Backend Verification

- Status: ❌ FAIL
- Expected:
  - `github-copilot/claude-sonnet-4.6`
- Actual:
  - The latest new `model_change` observed after the save was still GPT:

```json
{"type":"model_change","id":"26c406a1","parentId":"5f2dfe92","timestamp":"2026-03-14T22:08:50.590Z","provider":"github-copilot","modelId":"gpt-5.4"}
```

### Phase 3: Chat Verification

- Status: ❌ FAIL
- Details:
  - After the Claude switch attempt, the prompt `What model are you? Reply with just your model name.` was sent.
  - Backend recorded the assistant as `github-copilot` / `gpt-5.4`, not Claude.
  - The assistant response again failed with `413 failed to parse request`.
  - The UI snapshot shows repeated `Gpt 5.4` badges.
- Evidence:
  - Live UI observation during the run: assistant badges in the conversation stayed `Gpt 5.4`.

### Phase 4: Cross-Reference Verification

- Status: ❌ FAIL
- Details:
  - UI modal selection targeted Claude.
  - Live footer, message badges, and backend message metadata all remained GPT 5.4.

### Issues Found

- Model picker selection does not apply to the active session after save.
- Backend persisted / continued using GPT 5.4.
- Message generation failed with `413 failed to parse request`.

### Overall

- Overall: ❌ FAIL

## Test: Kimi K2.5 (`kimi-coding/k2.5`)

### Phase 1: UI Selection

- Status: ❌ FAIL
- Details:
  - The modal selection changed internally to `Kimi K2.5kimi-coding`.
  - After save and a 5-second wait, the footer still showed `Gpt 5.4`.
- Evidence:
  - Live UI observation during the run: footer remained `Gpt 5.4` after the Kimi save attempt.

### Phase 2: Backend Verification

- Status: ❌ FAIL
- Expected:
  - `kimi-coding/k2.5`
- Actual:
  - The observed backend tail did not show a Kimi model change for the active session.
  - The latest effective model remained GPT 5.4 in the same JSONL file.

### Phase 3: Chat Verification

- Status: ❌ FAIL
- Details:
  - The active session already contained a prior Kimi test prompt in history:

```json
{"type":"message","id":"52c7768d","parentId":"5280faa7","timestamp":"2026-03-14T19:25:49.746Z","message":{"role":"user","content":[{"type":"text","text":"This is a test for Kimi For Coding. What model are you?"}]}}
{"type":"message","id":"2a436a77","parentId":"52c7768d","timestamp":"2026-03-14T19:25:50.920Z","message":{"role":"assistant","content":[],"api":"openai-responses","provider":"github-copilot","model":"gpt-5.4","stopReason":"error","errorMessage":"413 failed to parse request"}}
```

  - This is a direct mismatch against the expected Kimi family model.

### Phase 4: Cross-Reference Verification

- Status: ❌ FAIL
- Details:
  - UI selection targeted Kimi.
  - Backend message metadata still identified GPT 5.4.
  - UI conversation badges also remained `Gpt 5.4`.

### Overall

- Overall: ❌ FAIL

## Test: GLM-5 (`glm-coding/glm-5`)

### Phase 1: UI Selection

- Status: ❌ FAIL
- Details:
  - The modal selection changed internally to `GLM-5 (Coding Plan)glm-coding`.
  - After save and waiting, the footer still showed `Gpt 5.4`.
- Evidence:
  - Live UI observation during the run: footer remained `Gpt 5.4` after the GLM save attempt.

### Phase 2: Backend Verification

- Status: ❌ FAIL
- Expected:
  - `glm-coding/glm-5`
- Actual:
  - No corresponding GLM model change was observed in the active session file after the tested save.
  - The session continued to show GPT 5.4 as the effective model.

### Phase 3: Chat Verification

- Status: ❌ FAIL
- Details:
  - The active session already contained a prior GLM prompt in history:

```json
{"type":"message","id":"8bb660bb","parentId":"2a436a77","timestamp":"2026-03-14T19:26:03.988Z","message":{"role":"user","content":[{"type":"text","text":"This is a test for GLM-5. What model are you?"}]}}
{"type":"message","id":"5f2dfe92","parentId":"8bb660bb","timestamp":"2026-03-14T19:26:05.177Z","message":{"role":"assistant","content":[],"api":"openai-responses","provider":"github-copilot","model":"gpt-5.4","stopReason":"error","errorMessage":"413 failed to parse request"}}
```

  - This is a direct mismatch against the expected GLM model.

### Phase 4: Cross-Reference Verification

- Status: ❌ FAIL
- Details:
  - UI selection targeted GLM-5.
  - Backend and message badge evidence stayed on GPT 5.4.

### Overall

- Overall: ❌ FAIL

## Additional issues found

1. The same session title `are you here?` appeared twice in the sidebar with different project labels (`/` and `/root`), which may cause operator confusion during testing.
2. The conversation history already contained previous model-targeted prompts for GPT, Claude, Kimi, and GLM, but the visible assistant badges were repeatedly `Gpt 5.4`.
3. Playwright interaction with the searchable dropdown required careful re-querying because refs became stale after filtering. This was worked around in the test by using direct locator-based `run-code`.
4. Chrome-based Playwright could not be used in this environment because of root sandbox restrictions; Firefox was used successfully instead.

## Overall assessment

Model switching reliability in the tested production session is **poor**.

- Baseline `GPT 5.4` is the only model that remained internally consistent.
- Switching from GPT to `Claude Sonnet 4.6`, `Kimi K2.5`, or `GLM-5` did not take effect in the active session.
- The strongest evidence is that the UI modal can show the requested target model before save, but the live footer, backend JSONL metadata, and assistant message metadata continue to reflect `gpt-5.4`.
- Independent of the switching defect, message execution in this session is also unhealthy because assistant responses are failing with `413 failed to parse request`.
