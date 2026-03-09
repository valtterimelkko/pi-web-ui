# API Documentation

## WebSocket Protocol

### Connection

Connect to `ws://localhost:3000/ws` (or `wss://` in production).

**Authentication:**
1. JWT must be in httpOnly cookie
2. First message must include CSRF token

### Client → Server Messages

```typescript
// Authenticate
{ type: 'auth', csrfToken: string }

// Send prompt
{ type: 'prompt', sessionId: string, message: string, images?: Image[] }

// Steer/abort
{ type: 'steer', message: string }
{ type: 'abort' }

// Session management
{ type: 'new_session', cwd?: string }
{ type: 'switch_session', sessionPath: string }
{ type: 'get_sessions' }

// Extension response
{ type: 'extension_ui_response', response: { id, approved?, value? } }
```

### Server → Client Messages

```typescript
// Auth result
{ type: 'authenticated' }
{ type: 'error', message: string }

// Sessions
{ type: 'sessions_list', sessions: SessionInfo[] }
{ type: 'session_update', type: 'add'|'change'|'unlink', sessionId, info? }

// Agent events
{ type: 'agent_start'|'agent_end'|'turn_start'|'turn_end' }
{ type: 'message_start', message: Message }
{ type: 'message_update', message: { id }, assistantMessageEvent }

// Tool events
{ type: 'tool_execution_start', toolCallId, toolName, args }
{ type: 'tool_execution_update', toolCallId, partialResult }
{ type: 'tool_execution_end', toolCallId, result, isError }

// Extension
{ type: 'extension_ui_request', request: ExtensionUIRequest }
```

## REST API

### Authentication

```
POST /api/auth/login
Body: { username, password }
Response: { success, csrfToken }
Sets: httpOnly cookie with JWT

POST /api/auth/logout
Response: { success }
Clears: JWT cookie

GET /api/auth/me
Response: { user: { id, username } }
```

### Sessions

```
GET /api/sessions
Query: ?cwd=path
Response: { sessions: SessionInfo[] }

GET /api/sessions/:id
Response: { session: SessionInfo }

DELETE /api/sessions/:id
Response: { success }

GET /api/sessions/:id/export
Response: HTML file download
```

### Models

```
GET /api/models
Response: { models: Model[] }
```

### Files

```
GET /api/files/browse?path=/path
Response: { path, parent, items: FileItem[] }

GET /api/files/read?path=/file&offset=1&limit=100
Response: { content, truncated?, totalSize }
```

### Extensions

```
GET /api/extensions
Response: { extensions: ExtensionInfo[] }

POST /api/extensions/:name/toggle
Body: { enabled: boolean }
Response: { success }
```

## Error Responses

All errors follow this format:

```json
{
  "error": "Error message",
  "code": "ERROR_CODE"
}
```

Common codes:
- `UNAUTHORIZED` - Not authenticated
- `FORBIDDEN` - No permission
- `NOT_FOUND` - Resource not found
- `RATE_LIMITED` - Too many requests
- `VALIDATION_ERROR` - Invalid input
