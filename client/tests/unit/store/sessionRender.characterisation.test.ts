/**
 * Characterisation (command-centre step 1a): pins the HISTORY fold
 * (history_start … session_event … history_end) over invented per-runtime
 * Pi-format streams. The same golden files are the expected output of the
 * extracted `foldEvents` in `@pi-web-ui/session-core`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useSessionStore } from '../../../src/store/sessionStore';
import { messagesToLiveMessages } from '../../../src/lib/messageAdapter';

// jsdom rewrites import.meta.url to an http URL; resolve from the file path.
const GOLDEN = resolve(__dirname, '../../../../fixtures/session-render/__golden__');
const RUNTIMES = ['pi', 'claude', 'antigravity', 'commandcode'] as const;
const FIXED_NOW = 1_700_000_000_000;

function reset(sessionId: string): void {
  useSessionStore.setState({
    sessionMessages: {}, streamingSessions: {}, currentSessionId: sessionId, currentSessionSdkType: 'pi',
    messages: [], isStreaming: false, isLoading: false, error: null, sessionData: {},
    sessionCache: new Map(), historyReplayActive: {}, isSwitchingSession: false, switchingToSessionId: null,
  });
}

describe('session-render characterisation: history fold', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(FIXED_NOW); });
  afterEach(() => { vi.useRealTimers(); });

  for (const runtime of RUNTIMES) {
    it(`folds the ${runtime} fixture stream unchanged`, async () => {
      const sessionId = `fixture-${runtime}-session`;
      reset(sessionId);
      const events = JSON.parse(readFileSync(resolve(GOLDEN, `${runtime}.pi-events.json`), 'utf8')) as Array<Record<string, unknown>>;
      const state = useSessionStore.getState();
      state.handleServerMessage({ type: 'session_switched', sessionId, sessionPath: sessionId, sdkType: 'pi', messages: [] } as never);
      state.handleServerMessage({ type: 'history_start', sessionId } as never);
      for (const event of events) state.handleServerMessage({ type: 'session_event', sessionId, event } as never);
      state.handleServerMessage({ type: 'history_end', sessionId } as never);
      const messages = useSessionStore.getState().sessionMessages[sessionId];
      const golden = { messages, live: messagesToLiveMessages(messages) };
      await expect(JSON.stringify(golden, null, 2) + '\n')
        .toMatchFileSnapshot(`../../../../fixtures/session-render/__golden__/${runtime}.messages.json`);
    });
  }
});
