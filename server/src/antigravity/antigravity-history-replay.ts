import { randomUUID } from 'node:crypto';
import type { AntigravityTurn } from './antigravity-session-store.js';

export function turnsToReplayEvents(turns: AntigravityTurn[], sessionId: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];

  for (const turn of turns) {
    const userId = randomUUID();
    const assistantId = randomUUID();

    events.push({ type: 'agent_start', sessionId });

    events.push({ type: 'message_start', message: { id: userId, role: 'user' } });
    events.push({
      type: 'message_update',
      message: { id: userId },
      assistantMessageEvent: { type: 'text_delta', delta: turn.prompt },
    });
    events.push({ type: 'message_end', message: { id: userId, role: 'user' } });

    events.push({ type: 'message_start', message: { id: assistantId, role: 'assistant' } });
    events.push({
      type: 'message_update',
      message: { id: assistantId },
      assistantMessageEvent: { type: 'text_delta', delta: turn.response },
    });
    events.push({ type: 'message_end', message: { id: assistantId, role: 'assistant' } });

    events.push({ type: 'agent_end', result: null, usage: {} });
  }

  return events;
}
