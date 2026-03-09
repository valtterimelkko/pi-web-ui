# Agent Instructions for Pi Web UI

> **For users**: See [README.md](./README.md) for installation and usage instructions. This document is for developers/agents working on the codebase.

## Your Role

You are an experienced debugging and quality + UI improvement agent whose job is to improve the Pi Web UI. You use a test-driven approach where each improvement needs to be verified and tested using one or all of the following:

1. `webapp-testing` skill
2. `playwright-cli` skill
3. A test suite approach

## Quick Reference

| Task | See Section |
|------|-------------|
| Debug WebSocket issues | [Debugging WebSocket](#debugging-websocket) |
| Fix auth problems | [Debugging Auth](#debugging-authentication) |
| Add new component | [Adding Components](#adding-a-new-component) |
| Add API endpoint | [Adding API Endpoints](#adding-a-new-api-endpoint) |
| Fix session sync | [Debugging Session Sync](#debugging-session-sync) |
| Performance issues | [Performance Debugging](#performance-debugging) |
| Running tests | [Testing Strategy](#testing-strategy) |

## Project Overview

Pi Web UI is a web interface for the Pi Coding Agent with:
- **React frontend** + Express backend
- **WebSocket** for real-time communication
- **JWT authentication** with security hardening
- **Pi SDK integration** for AI capabilities
- **File-based sessions** shared with CLI

### Architecture Deep Dive

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

### Starting Development

```bash
# 1. Install dependencies
npm install

# 2. Copy and configure environment
cp .env.example .env
# Edit .env with JWT_SECRET, CSRF_SECRET

# 3. Start development (both client and server)
npm run dev

# 4. Verify everything works
npm test
```

### Making Changes

1. **Write tests first** (TDD approach)
2. **Make minimal changes** to fix/improve
3. **Run relevant tests** to verify
4. **Check TypeScript** compiles (`npm run build`)
5. **Test manually** if UI changes

## Debugging Guides

### Debugging WebSocket

**Symptoms:** Connection drops, messages not received, "Thinking..." stuck

**Diagnostic Steps:**

1. Check browser DevTools → Network → WS
   - Look for connection attempts
   - Check close codes (1006 = abnormal, 1008 = policy violation)

2. Check server logs for:
   ```
   "WebSocket connection from [origin]"
   "Origin not allowed"  → Check ALLOWED_ORIGINS
   "Invalid CSRF token"  → Token not sent or expired
   "JWT verification failed" → Cookie issue
   ```

3. Verify auth flow:
   ```bash
   # Check cookie is set
curl -c cookies.txt -b cookies.txt http://localhost:3000/api/auth/me
   ```

4. Common fixes:
   - `ALLOWED_ORIGINS` must include exact URL (including port)
   - First WebSocket message must be `{ type: 'auth', csrfToken: '...' }`
   - JWT cookie must have `httpOnly` and `sameSite` settings

**Code Locations:**
- Connection: `server/src/websocket/connection.ts`
- Handlers: `server/src/websocket/handlers.ts`
- Client: `client/src/lib/websocket.ts`

### Debugging Authentication

**Symptoms:** 401 errors, redirect to login, "Unauthorized"

**Diagnostic Steps:**

1. Check JWT token validity:
   ```typescript
   // In browser console
   document.cookie  // Should contain 'jwt=...'
   ```

2. Verify token hasn't expired:
   ```bash
   # Decode JWT (second part)
   echo "TOKEN" | cut -d. -f2 | base64 -d
   # Check "exp" claim
   ```

3. Check CSRF token flow:
   - Login → response header `X-CSRF-Token`
   - Stored in Zustand authStore
   - Sent with WebSocket auth message

**Code Locations:**
- JWT: `server/src/security/auth.ts`
- CSRF: `server/src/security/csrf.ts`
- Login: `server/src/routes/auth.ts`
- Store: `client/src/store/authStore.ts`

### Debugging Session Sync

**Symptoms:** CLI sessions don't appear, stale session list

**Diagnostic Steps:**

1. Verify file watcher is running:
   ```bash
   # Check for watcher logs
   grep "SessionWatcher" server/logs
   ```

2. Check session directory:
   ```bash
   ls -la ~/.pi/agent/sessions/--path--/
   # Should show .jsonl files
   ```

3. Verify permissions:
   - Server must have read access to `~/.pi/agent/sessions/`
   - Files must be readable

4. Test manual trigger:
   ```bash
   # Create test session via CLI
   pi "test message"
   # Should trigger 'add' event in logs
   ```

**Code Locations:**
- Watcher: `server/src/pi/session-watcher.ts`
- Broadcast: `server/src/websocket/connection.ts` (broadcast method)
- Handler: `client/src/store/sessionStore.ts` (session_update case)

### Debugging Tool Execution Display

**Symptoms:** Tools don't show output, stuck "Executing..."

**Diagnostic Steps:**

1. Check tool events in WebSocket:
   - Look for `tool_execution_start`
   - Should receive `tool_execution_update` (streaming)
   - Ends with `tool_execution_end`

2. Verify tool result format:
   ```typescript
   // Expected format from Pi SDK
   {
     content: [{ type: 'text', text: '...' }],
     isError: false
   }
   ```

3. Check if tool call is in store:
   ```typescript
   // In browser console
   useSessionStore.getState().messages
   // Look for role: 'tool' messages
   ```

**Code Locations:**
- Handler: `server/src/pi/event-forwarder.ts`
- Store: `client/src/store/sessionStore.ts` (tool_execution_* cases)
- Display: `client/src/components/Tools/`

### Debugging Extension UI

**Symptoms:** Extension dialogs don't appear, timeout errors

**Diagnostic Steps:**

1. Check for extension_ui_request event:
   ```bash
   # In browser console
   useSessionStore.getState().extensionUIRequest
   ```

2. Verify response is sent:
   - Dialog should send `extension_ui_response`
   - Must include `response.id` matching request

3. Check timeout:
   - Default 30s timeout
   - Server logs: "Extension UI request timed out"

**Code Locations:**
- Handler: `server/src/pi/extension-ui-handler.ts`
- Dialog: `client/src/components/Extensions/ExtensionDialog.tsx`

## Performance Debugging

### Slow Initial Load

**Check:**
1. Bundle size: `npm run build` → check output size
2. Code splitting: Consider lazy loading for Settings, FileBrowser
3. Dependencies: Remove unused packages

### Message Streaming Lag

**Check:**
1. WebSocket latency in DevTools Network tab
2. Server CPU usage during streaming
3. Client re-renders (React DevTools Profiler)

**Optimizations:**
- Virtualize long message lists (react-window)
- Debounce rapid state updates
- Use `React.memo` for message bubbles

### High Memory Usage

**Check:**
1. SessionStore growing unbounded
2. Message history retention
3. WebSocket reconnection leaks

**Fixes:**
- Implement message pagination
- Limit stored sessions count
- Cleanup on unmount

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
4. **Add animations** (from index.css):
   - `animate-in fade-in`
   - `animate-in slide-in-from-right`
5. **Export from barrel**: `client/src/components/index.ts`
6. **Add tests**: `client/tests/unit/components/MyComponent.test.tsx`

## Adding a New API Endpoint

1. **Create route file**: `server/src/routes/my-feature.ts`
2. **Add security middleware**:
   ```typescript
   router.use(cookieAuthMiddleware);
   router.use(apiLimiter);
   ```
3. **Validate input** with Zod:
   ```typescript
   const schema = z.object({ ... });
   const data = schema.parse(req.body);
   ```
4. **Mount in app.ts**:
   ```typescript
   app.use('/api/my-feature', myFeatureRouter);
   ```
5. **Add tests**: `server/tests/unit/routes/my-feature.test.ts`
6. **Update client API**: `client/src/lib/api.ts` if needed

## Adding a WebSocket Message Type

1. **Add to shared types** (`shared/src/types.ts`):
   ```typescript
   export type ClientMessage = 
     | ...existing types
     | { type: 'my_message'; data: MyData };
   ```

2. **Update server protocol** (`server/src/websocket/protocol.ts`):
   ```typescript
   export type ClientMessage = 
     | ...existing
     | MyMessageType;
   ```

3. **Add server handler** (`server/src/websocket/handlers.ts`):
   ```typescript
   case 'my_message': {
     // Handle message
     break;
   }
   ```

4. **Update client store** (`client/src/store/sessionStore.ts`):
   ```typescript
   handleServerMessage: (message) => {
     switch (message.type) {
       case 'my_message':
         // Update state
         break;
     }
   }
   ```

## Testing Strategy

### Test-Driven Development Flow

```
1. Write failing test
2. Implement minimal fix
3. Verify test passes
4. Refactor if needed
5. Check for regressions
```

### Test Commands

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test file
npm test -- server/tests/unit/security/auth.test.ts

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

### E2E Testing

```bash
# Using with_server.py (recommended)
npm run test:e2e

# Manual E2E
1. Start server: cd server && npm run dev
2. Start client: cd client && npm run dev
3. Open http://localhost:5173
4. Login with admin/admin
5. Create session and send test message
```

## Security Considerations

**CRITICAL: Always follow these rules:**

1. **Path Validation** - ALWAYS validate paths before file access:
   ```typescript
   const validPath = validatePath(requestedPath, allowedDirs);
   if (!validPath) return res.status(403).json({ error: 'Access denied' });
   ```

2. **Authentication** - ALWAYS check auth on protected routes:
   ```typescript
   router.use(cookieAuthMiddleware);  // First middleware
   ```

3. **Input Validation** - NEVER trust client input:
   ```typescript
   const data = mySchema.parse(req.body);  // Zod validation
   ```

4. **Prompt Injection** - Check for injection attempts:
   ```typescript
   if (detectPromptInjection(input)) {
     return res.status(400).json({ error: 'Suspicious input detected' });
   }
   ```

## Known Issues & TODOs

### Current Issues

1. **Session tree navigation doesn't sync with CLI forks**
   - CLI forks create new files, but tree state isn't shared
   - Workaround: Refresh browser to see new branches
   - Fix needed: Broadcast fork events via WebSocket

2. **File browser limited to 50KB preview**
   - Hard limit in `server/src/routes/files.ts`
   - Consider pagination or streaming for large files

3. **Extension UI timeout hardcoded to 30s**
   - Located in `server/src/pi/extension-ui-handler.ts`
   - Should be configurable per-extension

4. **No mobile responsive design**
   - Sidebar takes full width on mobile
   - Needs responsive breakpoints

### Enhancement Ideas

- [ ] Add keyboard shortcuts (Cmd+K for command palette)
- [ ] Implement message search
- [ ] Add export to PDF/markdown
- [ ] Theme customization (user-defined colors)
- [ ] Multi-language support
- [ ] Collaborative sessions (multiple users)

## Code Style Guide

### TypeScript

- Use strict mode
- Prefer `interface` over `type` for object shapes
- Use `unknown` instead of `any`
- Document public APIs with JSDoc

### React

- Use functional components with hooks
- Prefer composition over inheritance
- Keep components small (< 200 lines)
- Use custom hooks for reusable logic

### Tailwind

- Use arbitrary values sparingly
- Prefer semantic colors (slate/violet/amber)
- Group related classes
- Extract repeated patterns to components

### Naming

- Components: PascalCase (`MyComponent.tsx`)
- Hooks: camelCase with `use` prefix (`useMyHook.ts`)
- Utilities: camelCase (`myUtility.ts`)
- Constants: UPPER_SNAKE_CASE (`API_BASE`)

## Resources

- [README.md](./README.md) - User documentation
- [API.md](./API.md) - WebSocket/REST protocol details
- [SECURITY.md](./SECURITY.md) - Security architecture
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Production deployment

## Getting Help

1. Check this document first
2. Review relevant code locations listed above
3. Check test files for usage examples
4. Review commit history for similar changes
5. When in doubt, add more tests!
