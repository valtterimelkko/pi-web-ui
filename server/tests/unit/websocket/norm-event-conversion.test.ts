import { describe, expect, it } from 'vitest';
import { normEventToPiFormat } from '../../../src/websocket/connection.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';

/**
 * The wire converter for normalized replay/live events. The Command Code
 * path relies on it for every event; user bubbles were invisible on replay
 * because message_start content was dropped.
 */
describe('normEventToPiFormat', () => {
  it('passes user message content through on message_start', () => {
    const event: NormalizedEvent = {
      type: 'message_start',
      sessionId: 'commandcode-x',
      timestamp: 1,
      data: { id: 'commandcode-user-abc', role: 'user', content: 'how many skills do you have?' },
    };
    const wire = normEventToPiFormat(event) as { message: { id?: string; role?: string; content?: string } };
    expect(wire.message.id).toBe('commandcode-user-abc');
    expect(wire.message.role).toBe('user');
    expect(wire.message.content).toBe('how many skills do you have?');
  });

  it('does not invent content for assistant message_start events', () => {
    const event: NormalizedEvent = {
      type: 'message_start',
      sessionId: 'commandcode-x',
      timestamp: 1,
      data: { id: 'commandcode-message-1', role: 'assistant' },
    };
    const wire = normEventToPiFormat(event) as { message: { id?: string; role?: string; content?: unknown } };
    expect(wire.message.content).toBeUndefined();
  });
});
