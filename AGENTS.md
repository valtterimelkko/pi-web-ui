# Agent Instructions for Pi Web UI

> **For users**: See [README.md](./README.md) for installation and usage instructions. This document is for developers/agents working on the codebase.

## Your Role

Improve the Pi Web UI with test-driven development. Each change needs verification via:
1. `webapp-testing` skill (local dev servers)
2. `playwright-cli` skill (external sites)
3. Test suite (`npm test`)

## Quick Reference

| Task | Section |
|------|---------|
| Debug WebSocket | [Debugging WebSocket](#debugging-websocket) |
| Fix auth issues | [Debugging Auth](#debugging-authentication) |
| Add component | [Adding Components](#adding-a-new-component) |
| Add API endpoint | [Adding API Endpoints](#adding-a-new-api-endpoint) |
| Run tests | [Testing Strategy](#testing-strategy) |

## Project Overview

Pi Web UI is a web interface for the Pi Coding Agent:
- **React frontend** + Express backend
- **WebSocket** real-time communication
- **JWT authentication** with security hardening
- **Pi SDK integration** for AI capabilities
- **File-based sessions** shared with CLI

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  CLIENT (React + Vite)                                          │
│  ├─ WebSocket Client (client/src/lib/websocket.ts)             │
│  ├─ Zustand Stores (client/src/store/)                         │
│  ├─ React Components (client/src/components/)                  │
│  └─ API Client (client/src/lib/api.ts)                         │
└───────────────────────┬─────────────────────────────────────────┘
                        │ WebSocket / HTTP
┌───────────────────────┴─────────────────────────────────────────┐
│  SERVER (Express + Node.js)                                     │
│  ├─ WebSocket Handler (server/src/websocket/)                  │
│  ├─ Pi Service Layer (server/src/pi/)                          │
│  ├─ REST API Routes (server/src/routes/)                       │
│  └─ Security Layer (server/src/security/)                      │
└───────────────────────┬─────────────────────────────────────────┘
                        │ File I/O
┌───────────────────────┴─────────────────────────────────────────┐
│  FILE SYSTEM                                                    │
│  └─ ~/.pi/agent/sessions/  (JSONL files)                       │
└─────────────────────────────────────────────────────────────────┘
```

## Development Workflow

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with JWT_SECRET, CSRF_SECRET

# 3. Start development
npm run dev

# 4. Run tests
npm test
```

### Making Changes

1. **Write tests first** (TDD)
2. **Make minimal changes**
3. **Run tests** to verify
4. **Check TypeScript** (`npm run build`)
5. **Test manually** if UI changes

## Debugging Guides

### Debugging WebSocket

**Symptoms:** Connection drops, "Thinking..." stuck

**Diagnostic Steps:**
1. Check browser DevTools → Network → WS
   - Look for connection attempts
   - Close codes: 1006 = abnormal, 1008 = policy violation

2. Check server logs:
   ```
   "Origin not allowed" → Check ALLOWED_ORIGINS
   "Invalid CSRF token" → Token not sent or expired
   "JWT verification failed" → Cookie issue
   ```

3. Verify auth:
   ```bash
   curl -c cookies.txt -b cookies.txt http://localhost:3000/api/auth/me
   ```

4. Common fixes:
   - `ALLOWED_ORIGINS` must include exact URL (including port)
   - First WebSocket message: `{ type: 'auth', csrfToken: '...' }`
   - JWT cookie needs `httpOnly` and `sameSite`

**Code Locations:**
- Connection: `server/src/websocket/connection.ts`
- Handlers: `server/src/websocket/handlers.ts`
- Client: `client/src/lib/websocket.ts`

### Debugging Authentication

**Symptoms:** 401 errors, redirect to login

**Diagnostic Steps:**
1. Check JWT token:
   ```javascript
   document.cookie  // Should contain 'jwt=...'
   ```

2. Decode JWT:
   ```bash
   echo "TOKEN" | cut -d. -f2 | base64 -d
   ```

3. Check CSRF flow:
   - Login → `X-CSRF-Token` header
   - Stored in Zustand authStore
   - Sent with WebSocket auth message

**Code Locations:**
- JWT: `server/src/security/auth.ts`
- CSRF: `server/src/security/csrf.ts`
- Login: `server/src/routes/auth.ts`
- Store: `client/src/store/authStore.ts`

### Debugging Session Sync

**Symptoms:** CLI sessions don't appear, stale list

**Diagnostic Steps:**
1. Verify file watcher:
   ```bash
   grep "SessionWatcher" server/logs
   ```

2. Check session directory:
   ```bash
   ls -la ~/.pi/agent/sessions/--path--/
   ```

3. Test manual trigger:
   ```bash
   pi "test message"
   ```

**Code Locations:**
- Watcher: `server/src/pi/session-watcher.ts`
- Handler: `client/src/store/sessionStore.ts`

### Debugging Tool Execution Display

**Symptoms:** Tools don't show output, stuck "Executing..."

**Diagnostic Steps:**
1. Check WebSocket events:
   - `tool_execution_start`
   - `tool_execution_update` (streaming)
   - `tool_execution_end`

2. Check tool result format:
   ```typescript
   { content: [{ type: 'text', text: '...' }], isError: false }
   ```

**Code Locations:**
- Handler: `server/src/pi/event-forwarder.ts`
- Store: `client/src/store/sessionStore.ts`
- Display: `client/src/components/Tools/`

### Debugging Slash Commands

**Pattern:** Slash commands (`/command`) and natural language requests for the same feature may behave differently.

**Key Insight:** The Pi SDK processes slash commands by injecting content directly into the session as **user messages** (not tool calls). This means:
1. Natural language: "Use the X skill to..." → triggers `read` tool → clean tool card display
2. Slash command: `/skill:X do...` → injects skill content as user message → raw content displayed

**When Filtering/Processing Content:**
- Check **all message roles** (user, assistant, tool) - not just assistant messages
- Check the **session file** (JSONL) to see how content is actually stored
- Check **multiple data paths**: streaming events, session loading, and session list previews

**Diagnostic Steps:**
```bash
# Check how content is stored in session file
cat ~/.pi/agent/sessions/--path--/*.jsonl | head -10

# Look for injected content patterns:
# - <skill name="..."> tags (slash command injection)
# - Raw markdown content
# - User messages that aren't actual user input
```

**Code Locations:**
- Session loading: `server/src/websocket/connection.ts` (`loadSessionMessages`)
- Session watcher: `server/src/pi/session-watcher.ts` (firstMessage extraction)
- Event filtering: `server/src/pi/multi-session-manager.ts`
- Client display: `client/src/components/Chat/VirtualizedMessageList.tsx`

## UI Message Filtering & Tool Display

**Important:** Not all messages from the Pi SDK are displayed in the chat UI. The `VirtualizedMessageList` component filters messages to maintain a clean interface:

**Filtering Logic** (`client/src/components/Chat/VirtualizedMessageList.tsx`):
- ✅ **User messages** - Shown (except slash command injected content)
- ✅ **Assistant messages** - Shown (except raw skill content)  
- ✅ **Subagent tools** - Shown with hierarchical display (CLI-style)
- ✅ **Read tools** - Shown (for skill-loading visibility)
- ❌ **Other tool messages** (edit, bash, web_search, etc.) - Hidden to reduce clutter
- ❌ **toolResult messages** - Hidden (contains raw tool output)
- ❌ **Skill injection content** - Hidden (from `/skill:name` slash commands)

**Why?** The agent's text narrative summarizes tool results, so showing every tool call creates visual clutter. However, subagent tools are an exception - they show a hierarchical view of what subagents did internally.

**Note on Slash Commands:** `/command` syntax may inject raw content as user messages. Filter these by checking for content patterns (e.g., `<skill name="...">`, `SKILL.md`) in the message content.

**To Add a New Visible Tool Type:**
1. Modify the filter in `VirtualizedMessageList.tsx`
2. Create a tool card component (see `SubagentToolCard.tsx` as example)
3. Route it in `MessageBubble.tsx`
4. Add tests for visibility

## Extensions

The Web UI shares the same extension directory as the CLI: `~/.pi/agent/extensions/`

**Pre-installed Extensions:**
- `agent-discovery` - Injects available subagents into system prompt
- `enhanced-plan-mode` - `/plan` command with wave-based analysis
- `subagent` - Subagent delegation tool
- `todo` - Todo management (`/todos` command)
- `web-tools` - Web search and fetch tools

**Extension Loading:**
Extensions are loaded by the Pi SDK's `DefaultResourceLoader` at startup. Check server logs for:
```
Loaded extensions:
  - /root/.pi/agent/extensions/agent-discovery/index.ts
  - /root/.pi/agent/extensions/enhanced-plan-mode/index.ts
```

**Extension Hooks Supported:**
- `before_agent_start` - Modify system prompt before agent runs
- `tool_call` - Validate/modify tool calls
- `after_tool_call` - Process tool results

## Adding a New Component

1. **Create directory**: `client/src/components/MyComponent/`
2. **Create files**:
   ```typescript
   // MyComponent.tsx
   export function MyComponent() { ... }
   
   // index.ts
   export { MyComponent } from './MyComponent';
   ```
3. **Style with Tailwind**:
   - Backgrounds: `bg-slate-900`, `bg-slate-800`
   - Primary accent: `text-violet-400`, `bg-violet-600`
   - Text: `text-slate-200` (primary), `text-slate-400` (secondary)
4. **Export from barrel**: `client/src/components/index.ts`
5. **Add tests**: `client/tests/unit/components/MyComponent.test.tsx`

## Adding a New API Endpoint

1. **Create route**: `server/src/routes/my-feature.ts`
2. **Add security**:
   ```typescript
   router.use(cookieAuthMiddleware);
   router.use(apiLimiter);
   ```
3. **Validate input**:
   ```typescript
   const data = z.object({ ... }).parse(req.body);
   ```
4. **Mount in app.ts**:
   ```typescript
   app.use('/api/my-feature', myFeatureRouter);
   ```
5. **Add tests**: `server/tests/unit/routes/my-feature.test.ts`

## Testing Strategy

### Commands

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test
npm test -- server/tests/unit/security/auth.test.ts

# E2E tests
npm run test:e2e

# Watch mode
npm test -- --watch
```

### Coverage Targets

| Module | Target | Current |
|--------|--------|---------|
| Security | 90% | ~90% |
| Pi Service | 85% | ~85% |
| WebSocket | 85% | ~85% |
| API Routes | 80% | ~80% |
| Frontend | 70% | ~70% |

### Current Status
- **Server**: 93/93 passing ✅
- **Client**: 62/62 passing ✅
- **E2E**: 9/9 passing ✅

## Security Considerations

**CRITICAL:** Always follow these rules:

1. **Path Validation** - Validate paths before file access:
   ```typescript
   const validPath = validatePath(requestedPath, allowedDirs);
   if (!validPath) return res.status(403).json({ error: 'Access denied' });
   ```

2. **Authentication** - Check auth on protected routes:
   ```typescript
   router.use(cookieAuthMiddleware);
   ```

3. **Input Validation** - Never trust client input:
   ```typescript
   const data = mySchema.parse(req.body);
   ```

4. **Prompt Injection** - Check for injection:
   ```typescript
   if (detectPromptInjection(input)) {
     return res.status(400).json({ error: 'Suspicious input' });
   }
   ```

## Known Issues & TODOs

### Current Issues

1. **Session tree navigation doesn't sync with CLI forks**
   - CLI forks create new files, but tree state isn't shared
   - Workaround: Refresh browser to see new branches

2. **Extension UI timeout hardcoded to 30s**
   - Located in `server/src/pi/extension-ui-handler.ts`
   - Should be configurable per-extension

3. **No mobile responsive design**
   - Sidebar takes full width on mobile
   - Needs responsive breakpoints

### Enhancement Ideas

- [ ] Keyboard shortcuts (Cmd+K for command palette)
- [ ] Message search
- [ ] Export to PDF/markdown
- [ ] Theme customization
- [ ] Collaborative sessions

## Code Style

### TypeScript
- Use strict mode
- Prefer `interface` over `type`
- Use `unknown` instead of `any`

### React
- Functional components with hooks
- Keep components small (< 200 lines)
- Custom hooks for reusable logic

### Tailwind
- Use arbitrary values sparingly
- Prefer semantic colors
- Extract repeated patterns to components

## Resources

- [README.md](./README.md) - User documentation
- [API.md](./API.md) - WebSocket/REST protocol
- [SECURITY.md](./SECURITY.md) - Security architecture
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Production deployment

## Getting Help

1. Check this document
2. Review code locations above
3. Check test files for examples
4. Review commit history
5. When in doubt, add more tests!
