import { describe, it, expect } from 'vitest';
import { turnsToReplayEvents } from '../../../src/antigravity/antigravity-history-replay.js';
import type { AntigravityTurn } from '../../../src/antigravity/antigravity-session-store.js';

function makeTurn(overrides: Partial<AntigravityTurn> = {}): AntigravityTurn {
  return {
    turnId: 'turn-1',
    prompt: 'Hello',
    response: 'Hi there!',
    model: 'Gemini 3.5 Flash (Medium)',
    conversationId: 'conv-abc',
    timestamp: 1000,
    ...overrides,
  };
}

describe('turnsToReplayEvents', () => {
  it('returns empty array for empty turns', () => {
    expect(turnsToReplayEvents([], 'session-1')).toEqual([]);
  });

  it('emits correct event sequence for a single turn', () => {
    const turn = makeTurn();
    const events = turnsToReplayEvents([turn], 'session-1');

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'agent_start',
      'message_start',
      'message_update',
      'message_end',
      'message_start',
      'message_update',
      'message_end',
      'agent_end',
    ]);
  });

  it('includes user prompt text in first message_update', () => {
    const turn = makeTurn({ prompt: 'User asked this' });
    const events = turnsToReplayEvents([turn], 'sess');
    const userUpdate = events.find(
      (e) => e.type === 'message_update' &&
        (e as Record<string, unknown>).assistantMessageEvent &&
        ((e as Record<string, unknown>).assistantMessageEvent as Record<string, unknown>)?.delta === 'User asked this',
    );
    expect(userUpdate).toBeDefined();
  });

  it('includes assistant response text in second message_update', () => {
    const turn = makeTurn({ response: 'Assistant replied here' });
    const events = turnsToReplayEvents([turn], 'sess');
    const assistantUpdate = events.find(
      (e) => e.type === 'message_update' &&
        (e as Record<string, unknown>).assistantMessageEvent &&
        ((e as Record<string, unknown>).assistantMessageEvent as Record<string, unknown>)?.delta === 'Assistant replied here',
    );
    expect(assistantUpdate).toBeDefined();
  });

  it('emits 8 events per turn (agent_start, 3x user, 3x assistant, agent_end)', () => {
    const turns = [makeTurn(), makeTurn({ turnId: 'turn-2' }), makeTurn({ turnId: 'turn-3' })];
    const events = turnsToReplayEvents(turns, 'sess');
    expect(events).toHaveLength(24); // 8 per turn × 3 turns
  });

  it('uses text_delta format for assistantMessageEvent', () => {
    const turn = makeTurn({ response: 'Test reply' });
    const events = turnsToReplayEvents([turn], 'sess');
    const updates = events.filter((e) => e.type === 'message_update') as Array<Record<string, unknown>>;
    for (const update of updates) {
      const event = update.assistantMessageEvent as Record<string, unknown>;
      expect(event.type).toBe('text_delta');
      expect(typeof event.delta).toBe('string');
    }
  });

  it('emits agent_start for each turn', () => {
    const turns = [makeTurn(), makeTurn({ turnId: 'turn-2' })];
    const events = turnsToReplayEvents(turns, 'sess');
    const agentStarts = events.filter((e) => e.type === 'agent_start');
    expect(agentStarts).toHaveLength(2);
  });
});
