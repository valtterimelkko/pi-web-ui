import { describe, expect, it } from 'vitest';
import { isWebSocketOriginAllowed } from '../../../src/websocket/origin-check.js';

describe('WebSocket origin check', () => {
  const allowlist = ['http://localhost:5173', 'https://tmux.letsautomate.work'];

  it('accepts exact allowlisted origins in every environment', () => {
    expect(isWebSocketOriginAllowed('https://tmux.letsautomate.work', allowlist, 'production')).toBe(true);
    expect(isWebSocketOriginAllowed('http://localhost:5173', allowlist, 'test')).toBe(true);
  });

  it('rejects missing origins always', () => {
    expect(isWebSocketOriginAllowed(undefined, allowlist, 'development')).toBe(false);
    expect(isWebSocketOriginAllowed(undefined, allowlist, 'production')).toBe(false);
  });

  it('allows any localhost port in non-production so disposable servers on random ports work', () => {
    expect(isWebSocketOriginAllowed('http://localhost:38785', allowlist, 'test')).toBe(true);
    expect(isWebSocketOriginAllowed('http://localhost:38785', allowlist, 'development')).toBe(true);
  });

  it('keeps production exact-match: no localhost wildcard, no unknown origins', () => {
    expect(isWebSocketOriginAllowed('http://localhost:38785', allowlist, 'production')).toBe(false);
    expect(isWebSocketOriginAllowed('https://evil.example', allowlist, 'production')).toBe(false);
    expect(isWebSocketOriginAllowed('http://127.0.0.1:38785', allowlist, 'production')).toBe(false);
  });

  it('does not relax non-production beyond http localhost with a port', () => {
    expect(isWebSocketOriginAllowed('https://localhost:38785', allowlist, 'test')).toBe(false);
    expect(isWebSocketOriginAllowed('http://localhost.evil.com', allowlist, 'test')).toBe(false);
    expect(isWebSocketOriginAllowed('http://localhost:38785/path', allowlist, 'test')).toBe(false);
  });
});
