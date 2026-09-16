/*
 * INJECTION MARKING (2026-09-16) — the store carries the structural marker.
 *
 * The emitter now delivers the routine Agent OS capture prompt as a custom
 * message (role 'custom', customType 'agent-os-capture') that arrives live as a
 * `message_start` and replays inside history windows. The client store must
 * carry role AND customType through every Message-building path so the talker's
 * turn scan can key on the structural mark. Nothing else about these messages
 * changes: they were already filtered out of every rendered projection by role,
 * and stay filtered.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore } from '../../../src/store/sessionStore';

const CUSTOM_MSG = {
  id: 'cap-1',
  role: 'custom',
  customType: 'agent-os-capture',
  content: 'Agent OS session-end memory capture (automated delivery).',
};

describe('sessionStore — custom injection messages carry their structural marker', () => {
  beforeEach(() => {
    useSessionStore.setState({ messages: [], sessionMessages: {}, currentSessionId: 's1' });
  });

  it('single-session live message_start keeps role custom and customType', () => {
    useSessionStore.getState().handleServerMessage({
      type: 'message_start',
      message: { ...CUSTOM_MSG },
    } as never);
    const [m] = useSessionStore.getState().messages;
    expect(m.role).toBe('custom');
    expect((m as { customType?: string }).customType).toBe('agent-os-capture');
    expect((m.content as string)).toBe(CUSTOM_MSG.content);
  });

  it('multi-session session_event message_start keeps role custom and customType', () => {
    useSessionStore.getState().handleServerMessage({
      type: 'session_event',
      sessionId: 's1',
      event: { type: 'message_start', message: { ...CUSTOM_MSG } },
    } as never);
    const [m] = useSessionStore.getState().messages;
    expect(m.role).toBe('custom');
    expect((m as { customType?: string }).customType).toBe('agent-os-capture');
  });

  it('history replay (folded window) keeps role custom and customType', () => {
    const state = useSessionStore.getState();
    state.handleServerMessage({ type: 'session_switched', sessionId: 's2', sdkType: 'pi', messages: [] } as never);
    state.handleServerMessage({ type: 'history_start', sessionId: 's2' } as never);
    state.handleServerMessage({ type: 'session_event', sessionId: 's2', event: { type: 'message_start', message: { id: 'u1', role: 'user', content: 'work prompt' } } } as never);
    state.handleServerMessage({ type: 'session_event', sessionId: 's2', event: { type: 'message_start', message: { ...CUSTOM_MSG } } } as never);
    state.handleServerMessage({ type: 'history_end', sessionId: 's2' } as never);

    const messages = useSessionStore.getState().sessionMessages['s2'];
    expect(messages).toHaveLength(2);
    const custom = messages[1] as { role: string; customType?: string };
    expect(custom.role).toBe('custom');
    expect(custom.customType).toBe('agent-os-capture');
  });

  it('a plain user message gains no customType — the marker is additive only', () => {
    useSessionStore.getState().handleServerMessage({
      type: 'message_start',
      message: { id: 'u9', role: 'user', content: 'my own words' },
    } as never);
    const [m] = useSessionStore.getState().messages;
    expect(m.role).toBe('user');
    expect((m as { customType?: string }).customType).toBeUndefined();
  });
});
