# Security

## Threat Model

### CSWSH (Cross-Site WebSocket Hijacking)
**Mitigation:** Origin validation on WebSocket upgrade
- All origins must be in `ALLOWED_ORIGINS` whitelist
- Invalid origins receive 1008 close code

### XSS (Cross-Site Scripting)
**Mitigation:**
- Content Security Policy headers
- React's built-in XSS protection
- No user input rendered as HTML

### CSRF (Cross-Site Request Forgery)
**Mitigation:**
- Double-submit cookie pattern
- CSRF token required for state changes
- Tokens validated server-side

### Prompt Injection
**Mitigation:**
- Pattern detection for known injection attempts
- Structured prompts with clear boundaries
- User input sanitized before processing

### Path Traversal
**Mitigation:**
- Path validation against allowed directories
- `realpath()` resolution before access
- No access outside project directories

### Credential Theft
**Mitigation:**
- httpOnly cookies (JavaScript cannot access)
- Secure flag in production
- Short token expiry (15 min)

## Security Headers

The application uses Helmet for security headers:

- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `X-XSS-Protection: 1; mode=block`
- `Content-Security-Policy` (strict)

## Rate Limiting

- 100 requests per minute per IP
- Applied to all API endpoints
- WebSocket messages also rate-limited

## Audit Logging

Security events are logged:
- Authentication attempts (success/failure)
- WebSocket connection origins
- File access attempts
- Extension UI requests
