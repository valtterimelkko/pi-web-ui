import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionInfoModal } from '../../../../src/components/StatusBar/SessionInfoModal';

/**
 * F4 regression: antigravity sessions fell into the "Pi SDK" else-branch of
 * the Session Type section. They must render as Antigravity (agy CLI), with
 * the real stored usage and the native agy conversation id.
 */

let sessionState: Record<string, unknown> = {};

vi.mock('../../../../src/store', () => ({
  useSessionStore: (sel: (s: Record<string, unknown>) => unknown) => sel(sessionState),
}));

vi.mock('../../../../src/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ getSessionInfo: vi.fn() }),
}));

const AGY_SESSION_INFO = {
  sessionId: 'agy-ui-test',
  nativeSessionId: 'agy-conv-uuid-1234',
  cwd: '/tmp/agy-ui',
  sessionFile: '/root/.pi-web-ui/antigravity-sessions/agy-ui-test.jsonl',
  userMessages: 2,
  assistantMessages: 2,
  toolCalls: 4,
  toolResults: 4,
  totalMessages: 4,
  tokens: { input: 108718, output: 4977, cacheRead: 220240, cacheWrite: 0, total: 113695 },
  model: 'gemini-3.6-flash-medium',
  contextWindow: 1048576,
  contextUsed: 148489,
  contextPercent: 14,
};

describe('SessionInfoModal — antigravity sessions', () => {
  beforeEach(() => {
    sessionState = {
      sessionInfo: AGY_SESSION_INFO,
      currentSessionId: 'agy-ui-test',
      currentSessionSdkType: 'antigravity',
      sessionData: {},
    };
  });

  it('renders the Antigravity session type, not Pi SDK', () => {
    render(<SessionInfoModal isOpen onClose={() => {}} />);
    expect(screen.getByText('Antigravity')).toBeTruthy();
    expect(screen.queryByText('Pi SDK')).toBeNull();
  });

  it('shows the native agy conversation id and real token numbers', () => {
    render(<SessionInfoModal isOpen onClose={() => {}} />);
    expect(screen.getByText('agy-conv-uuid-1234')).toBeTruthy();
    // Real stored usage — not the historical hardcoded zeros.
    expect(screen.getByText('108,718')).toBeTruthy();
    expect(screen.getByText('2,259'.replace('2,259', '4,977'))).toBeTruthy();
  });

  it('shows the context window from the real request size', () => {
    render(<SessionInfoModal isOpen onClose={() => {}} />);
    // Rendered as "148,489 / 1,048,576 tokens" in one element.
    expect(screen.getByText(/148,489 \/ 1,048,576 tokens/)).toBeTruthy();
  });
});
