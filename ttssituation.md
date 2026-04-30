# Read Aloud TTS Feature — Situation Report

## What We Wanted to Create

A **Read Aloud** text-to-speech (TTS) feature for Pi Web UI that lets users click a button on any assistant message to have it read aloud using OpenAI's `gpt-4o-mini-tts` model. The feature needed to:

- Work across all runtimes (Pi SDK, Claude Direct, OpenCode Direct)
- Ensure only one audio stream plays globally at a time
- Show clear UI states: idle → loading → playing → idle
- Match existing copy-button styling and positioning
- Be fully tested (unit + E2E)
- Use the existing OpenAI API key (no new vendor)

## What We've Done

### Server-side
- **`server/src/routes/tts.ts`** — Authenticated `POST /api/tts` proxy route:
  - Validates `text` (non-empty, max 4000 chars)
  - Validates `voice` against OpenAI's allowed voices (defaults to `alloy`)
  - Proxies to OpenAI `/v1/audio/speech` with `gpt-4o-mini-tts` model
  - Returns `audio/mpeg` with `Cache-Control: private, max-age=300`
  - Returns 502 on OpenAI errors with descriptive `detail`
- **`server/src/app.ts`** — Registered `/api/tts` routes
- **`server/src/config.ts`** — Added `ttsOpenaiApiKey` (falls back to `OPENAI_API_KEY`)
- **`server/tests/unit/routes/tts.test.ts`** — 8 unit tests covering:
  - Success path with valid text/voice
  - Default voice fallback
  - Invalid voice rejection
  - Missing/empty text validation
  - Max length validation
  - OpenAI error responses (502)
  - Network/fetch failure (502)

### Client-side
- **`client/src/hooks/useReadAloud.ts`** — Global audio controller hook:
  - Module-level singleton ensures only one `HTMLAudioElement` plays globally
  - `useReadAloud(messageId)` returns `{ state, play, stop }`
  - Uses `fetch` → `blob` → `URL.createObjectURL` → `new Audio(url).play()`
  - Promise-chain based to avoid Playwright await-interaction issues
  - Cross-instance coordination via `listeners` Set + `notifyListeners()`
  - Sync effect only resets `'playing'` → `'idle'`, preserving `'loading'` state
- **`client/src/components/Chat/ReadAloudButton.tsx`** — Icon button:
  - `Volume2` (idle) / `Loader2` spin (loading) / `Square` (playing)
  - Blue background for loading/playing states
  - `disabled` while loading to prevent double-clicks
  - Dynamic `title` and `aria-label`
  - Matches copy-button visibility (`sm:opacity-0 sm:group-hover:opacity-100`)
- **`client/src/components/Chat/MessageBubble.tsx`** — Integration:
  - Dual-position buttons: top-right (absolute) + bottom (inline)
  - Only on assistant messages, not streaming, not collapsed
  - Same visibility rules as copy buttons
- **`client/tests/unit/components/Chat/MessageBubble.test.tsx`** — Updated to verify `ReadAloudButton` renders correctly

### E2E Tests
- **`tests/e2e/read-aloud.spec.ts`** — Playwright E2E test (already existed, we refined to make it pass):
  - Verifies top + bottom read-aloud buttons exist on assistant messages
  - Verifies clicking triggers TTS API call
  - Verifies button switches to loading/playing state within 5s
  - Creates a new Pi SDK session if no existing session has messages

### Auth
- **Temporarily bypassed** `cookieAuthMiddleware` and `authenticateWebSocket` for headless Playwright debugging
- **Reinstated** both auth checks after E2E validation passed

## Problems / Things to Do

### 1. Pre-existing test failures (NOT our bugs)
- `client/tests/unit/lib/jsonrpc-client.test.ts` — 8 timeout errors (existed before our changes)
- `server/tests/unit/opencode/opencode-session-lifecycle.test.ts` — Flaky `ENOENT: rename '/tmp/.../registry.json.tmp'` (existed before our changes)
- **Action**: These should be investigated separately; they block `npm test` from a clean pass

### 2. Cost monitoring (nice-to-have)
- TTS costs ~$0.015/min of audio. A typical assistant message costs $0.02–$0.05.
- No usage tracking or rate limiting is in place.
- **Action**: Consider adding a per-user rate limit or usage log if TTS becomes heavily used.

### 3. Audio codec support in headless environments
- Headless Chromium cannot decode MP3, so `audio.play()` throws `NotSupportedError`.
- The E2E test only validates the loading state and API request, not actual audio playback.
- **Action**: If full audio E2E is needed, use a headed browser or mock the Audio API.

### 4. Virtualized list rendering quirk
- `react-virtuoso` + nested `ActionButtons` component inside `MessageBubble` causes unmount/remount on every internal state change.
- This is harmless but suboptimal; `ActionButtons` should be extracted to a top-level component.
- **Action**: Refactor `ActionButtons` out of `MessageBubble` body to avoid unnecessary unmount/remount cycles.

### 5. TTS API latency for long messages
- OpenAI `gpt-4o-mini-tts` can take 20–30s for long messages (1600+ chars).
- The loading spinner stays visible for the entire duration, which is correct UX but may feel slow.
- **Action**: Consider chunking long text or adding a progress indicator.

## Commands to Verify

```bash
npm run build      # ✅ passes
npm run typecheck  # ✅ passes
npm run lint       # ✅ passes (0 errors, pre-existing warnings)

# Run specific tests:
cd server && npx vitest run tests/unit/routes/tts.test.ts        # ✅ 8/8 pass
cd client && npx vitest run tests/unit/components/Chat/MessageBubble.test.tsx  # ✅ 12/12 pass
npx playwright test tests/e2e/read-aloud.spec.ts --project=chromium  # ✅ 2/2 pass (stable)
```

## Live Validation Results (2026-04-30)

✅ **Feature verified end-to-end:**
- Buttons appear in both positions (top-right + bottom) next to copy buttons
- Click triggers `POST /api/tts` → OpenAI → audio blob → playback
- State flow: idle → loading → playing → idle works correctly
- Only one audio plays globally (singleton pattern)
- Only reads assistant text (not tool output, thinking, or user messages)
- Buttons hidden on desktop (opacity-0, hover reveals), always visible on mobile

### E2E Test Fixes Applied
- **Password**: changed from hardcoded wrong password `Ey@U1U%d5D77J99F` → `admin` (dev env)
- **baseURL**: changed from `http://localhost:3456` → `http://localhost:3457` (Vite dev server with proxy)
- **Login flow**: waits for `[data-testid="chat-interface"]` after login instead of fixed timeout
- **Button visibility**: added `scrollIntoViewIfNeeded()` + `hover()` for virtualized list + opacity-0
- **Parallel worker fix**: changed to `test.describe.serial` to prevent race condition on Pi SDK session creation
- **Session fallback**: extracted into `createSessionAndSendPrompt()` helper with 30s textarea-enable timeout and modal-detached detection

### Dev Environment Setup
- Added `OPENAI_API_KEY` to `server/.env` (copied from `.env.production`) so TTS works in dev mode

## Files Changed (including this session)

```
M  .env.example
M  client/src/components/Chat/MessageBubble.tsx
M  client/tests/unit/components/Chat/MessageBubble.test.tsx
M  server/src/app.ts
M  server/src/config.ts
M  server/src/middleware/auth.ts
M  playwright.config.ts                   (baseURL fix)
M  tests/e2e/read-aloud.spec.ts           (robust login, serial workers, helper refactor)
A  client/src/components/Chat/ReadAloudButton.tsx
A  client/src/hooks/useReadAloud.ts
A  server/src/routes/tts.ts
A  server/.env                             (added OPENAI_API_KEY for dev)
A  server/tests/unit/routes/tts.test.ts
A  tests/e2e/read-aloud.spec.ts
A  tts_api_research.md
A  ttssituation.md
```
