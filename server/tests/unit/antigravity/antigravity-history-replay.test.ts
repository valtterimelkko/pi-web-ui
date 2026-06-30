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

  describe('turn status-aware rendering', () => {
    function assistantDelta(events: Array<Record<string, unknown>>): string | undefined {
      // The second message_update is the assistant delta for a single-turn replay.
      const updates = events.filter((e) => e.type === 'message_update');
      const assistantUpdate = updates[updates.length - 1];
      const ame = (assistantUpdate as Record<string, unknown>)?.assistantMessageEvent as Record<string, unknown> | undefined;
      return ame?.delta as string | undefined;
    }

    it('renders a legacy turn (no status) identically to an explicit done turn', () => {
      const legacy = makeTurn({ response: 'legacy reply' }); // no status
      const done = makeTurn({ response: 'legacy reply', status: 'done' });
      const legacyEvents = turnsToReplayEvents([legacy], 'sess');
      const doneEvents = turnsToReplayEvents([done], 'sess');

      expect(legacyEvents.map((e) => e.type)).toEqual(doneEvents.map((e) => e.type));
      expect(legacyEvents).toHaveLength(8); // full done sequence
    });

    it('renders an error turn as user message + assistant body + agent_end', () => {
      const turn = makeTurn({ status: 'error', response: '', error: 'The agent timed out.' });
      const events = turnsToReplayEvents([turn], 'sess');

      expect(events.map((e) => e.type)).toEqual([
        'agent_start',
        'message_start',
        'message_update',
        'message_end',
        'message_start',
        'message_update',
        'message_end',
        'agent_end',
      ]);
      // Body comes from the error text when response is empty.
      expect(assistantDelta(events)).toBe('The agent timed out.');
    });

    it('error turn prefers a non-empty response over the error field', () => {
      const turn = makeTurn({ status: 'error', response: 'partial reply text', error: 'boom' });
      const events = turnsToReplayEvents([turn], 'sess');
      expect(assistantDelta(events)).toBe('partial reply text');
    });

    it('error turn falls back to a generic message when both response and error are empty', () => {
      const turn = makeTurn({ status: 'error', response: '', error: '' });
      const events = turnsToReplayEvents([turn], 'sess');
      expect(assistantDelta(events)).toMatch(/failed/i);
      expect((assistantDelta(events) ?? '').length).toBeGreaterThan(0);
    });

    it('renders a running turn as user message only — no assistant message, no agent_end', () => {
      const turn = makeTurn({ status: 'running', response: '' });
      const events = turnsToReplayEvents([turn], 'sess');

      // agent_start + user message_start/update/end. The streaming indicator is
      // driven by replayAntigravityHistory's isStreaming flag, not an agent_end.
      expect(events.map((e) => e.type)).toEqual([
        'agent_start',
        'message_start',
        'message_update',
        'message_end',
      ]);
      expect(events.some((e) => e.type === 'agent_end')).toBe(false);
    });

    it('still emits the user prompt for a running turn', () => {
      const turn = makeTurn({ status: 'running', prompt: 'in-flight prompt' });
      const events = turnsToReplayEvents([turn], 'sess');
      const userUpdate = events.find(
        (e) => e.type === 'message_update' &&
          ((e as Record<string, unknown>).assistantMessageEvent as Record<string, unknown>)?.delta === 'in-flight prompt',
      );
      expect(userUpdate).toBeDefined();
    });

    it('a running turn followed by a done turn renders both correctly', () => {
      // Unusual but possible after a crash: an orphaned running turn then a later done turn.
      const turns = [
        makeTurn({ turnId: 't-running', status: 'running', prompt: 'p1', response: '' }),
        makeTurn({ turnId: 't-done', status: 'done', prompt: 'p2', response: 'r2' }),
      ];
      const events = turnsToReplayEvents(turns, 'sess');
      const types = events.map((e) => e.type);
      // running = 4 events, done = 8 events
      expect(types).toEqual([
        'agent_start', 'message_start', 'message_update', 'message_end', // running turn 1
        'agent_start', 'message_start', 'message_update', 'message_end',
        'message_start', 'message_update', 'message_end', 'agent_end',   // done turn 2
      ]);
      expect(events.filter((e) => e.type === 'agent_end')).toHaveLength(1);
    });
  });
});
