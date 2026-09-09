import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore, type Message } from '../../../src/store/sessionStore';

/**
 * Antigravity live parity (F3): the agy wire carries tool parameters only on
 * the DONE step, so the server emits `tool_execution_end` with an `args` field
 * (additive) and the live card must be patched with them — previously the
 * start event had no args and the end event dropped them, leaving live agy
 * tool cards bare while replay showed args.
 */

function messagesFor(sessionId: string): Message[] {
  return useSessionStore.getState().sessionData[sessionId]?.messages ?? [];
}

function msg(sessionId: string, event: Record<string, unknown>): void {
  useSessionStore.getState().handleServerMessage({
    type: 'session_event',
    sessionId,
    event,
  } as never);
}

describe('tool_execution_end carries args (agy live parity)', () => {
  const SID = 's-agy-args';

  beforeEach(() => {
    const state = useSessionStore.getState();
    state.resetSession?.(SID);
    // Fall back to clearing whatever the store exposes.
    useSessionStore.setState((s) => {
      const sessionData = { ...s.sessionData };
      delete sessionData[SID];
      return { sessionData, sessionMessages: { ...s.sessionMessages, [SID]: [] } };
    });
  });

  it('patches the tool card args when the end event carries them', () => {
    msg(SID, { type: 'tool_execution_start', toolCallId: 't1', toolName: 'write_to_file' });
    expect(messagesFor(SID)).toHaveLength(1);
    expect(messagesFor(SID)[0].toolCall?.args).toBeUndefined();

    msg(SID, {
      type: 'tool_execution_end',
      toolCallId: 't1',
      args: { TargetFile: '/tmp/x/hello.txt' },
      result: 'Wrote /tmp/x/hello.txt',
      isError: false,
    });
    const tool = messagesFor(SID)[0];
    expect(tool.toolCall?.args).toEqual({ TargetFile: '/tmp/x/hello.txt' });
    expect(tool.toolResult?.output).toBe('Wrote /tmp/x/hello.txt');
  });

  it('keeps start-event args when the end event has none (pi flow unchanged)', () => {
    msg(SID, { type: 'tool_execution_start', toolCallId: 't2', toolName: 'bash', args: { command: 'ls' } });
    msg(SID, { type: 'tool_execution_end', toolCallId: 't2', result: 'a\nb', isError: false });
    expect(messagesFor(SID)[0].toolCall?.args).toEqual({ command: 'ls' });
  });
});
