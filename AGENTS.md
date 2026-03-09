# Agent Instructions

## Project Overview

Pi Web UI is a web interface for the Pi Coding Agent with:
- React frontend + Express backend
- WebSocket for real-time communication
- JWT authentication with security hardening
- Pi SDK integration for AI capabilities

## Architecture

```
pi-web-ui/
├── server/           # Express + WebSocket + Pi SDK
├── client/           # React + Vite + Tailwind
└── shared/           # Common types
```

## Key Patterns

### Adding a New Component

1. Create in `client/src/components/ComponentName/`
2. Export from `client/src/components/ComponentName/index.ts`
3. Use Tailwind with slate/violet/amber colors
4. Add to parent component

### Adding a New API Endpoint

1. Create route in `server/src/routes/`
2. Add to `server/src/app.ts`
3. Use `cookieAuthMiddleware` for protection
4. Add tests in `server/tests/`

### Security Considerations

- ALWAYS validate paths before file access
- ALWAYS check authentication on protected routes
- NEVER trust client input (validate with Zod)
- ALWAYS use parameterized queries (if adding DB)

## Common Tasks

### Adding a Tool Display Type

1. Add component in `client/src/components/Tools/`
2. Update `ToolOutput.tsx` to handle new type
3. Add tests

### Adding a WebSocket Message Type

1. Add to `shared/src/types.ts`
2. Update `server/src/websocket/protocol.ts`
3. Add handler in `server/src/websocket/handlers.ts`
4. Update `client/src/store/sessionStore.ts`

## Testing

```bash
# Run all tests
npm test

# With coverage
npm run test:coverage

# E2E tests
npm run test:e2e
```

## Known Issues

- Session tree navigation doesn't sync with CLI forks yet
- File browser limited to 50KB preview
- Extension UI timeout is hardcoded to 30s
