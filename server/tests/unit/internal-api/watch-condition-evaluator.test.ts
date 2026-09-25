import { describe, it, expect } from 'vitest';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { ConditionEngine, resolveConditions } from '../../../src/internal-api/watch/condition-evaluator.js';
import type { WatchConditionSpec } from '../../../src/internal-api/types.js';

function ev(type: string, data: Record<string, unknown> = {}): NormalizedEvent {
  return { type, timestamp: Date.now(), data };
}

function engine(specs: WatchConditionSpec[]): ConditionEngine {
  return new ConditionEngine(resolveConditions(specs));
}

describe('ConditionEngine — generic, function-agnostic matching', () => {
  it('matches an event_type condition', () => {
    const e = engine([{ type: 'event_type', eventType: 'session_compaction' }]);
    expect(e.ingest(ev('agent_start'))).toHaveLength(0);
    const matches = e.ingest(ev('session_compaction', { removedCount: 3 }));
    expect(matches).toHaveLength(1);
    expect(matches[0].conditionId).toBe('c0');
    expect(matches[0].eventType).toBe('session_compaction');
  });

  it('honours dataMatch shallow equality on event_type', () => {
    const e = engine([{ type: 'event_type', eventType: 'permission_request', dataMatch: { toolName: 'Bash' } }]);
    expect(e.ingest(ev('permission_request', { toolName: 'Read' }))).toHaveLength(0);
    expect(e.ingest(ev('permission_request', { toolName: 'Bash' }))).toHaveLength(1);
  });

  it('matches a tool condition on start by default', () => {
    const e = engine([{ type: 'tool', toolName: 'Bash' }]);
    expect(e.ingest(ev('tool_execution_end', { toolName: 'Bash' }))).toHaveLength(0);
    expect(e.ingest(ev('tool_execution_start', { toolName: 'Read' }))).toHaveLength(0);
    const m = e.ingest(ev('tool_execution_start', { toolName: 'Bash', args: { command: 'echo hi' } }));
    expect(m).toHaveLength(1);
    expect(m[0].evidence).toContain('Bash');
  });

  it('supports tool phase=end and argIncludes', () => {
    const e = engine([{ type: 'tool', toolName: 'Bash', phase: 'end', argIncludes: 'PASS' }]);
    expect(e.ingest(ev('tool_execution_end', { toolName: 'Bash', result: 'tests FAIL' }))).toHaveLength(0);
    expect(e.ingest(ev('tool_execution_end', { toolName: 'Bash', result: 'tests PASS' }))).toHaveLength(1);
  });

  it('matches text spanning multiple streamed deltas', () => {
    const e = engine([{ type: 'text', contains: 'BANANA' }]);
    expect(e.ingest(ev('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'BAN' } }))).toHaveLength(0);
    const m = e.ingest(ev('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'ANA' } }));
    expect(m).toHaveLength(1);
  });

  it('matches text via regex pattern', () => {
    const e = engine([{ type: 'text', pattern: 'goal\\s*=\\s*(\\w+)', patternFlags: 'i' }]);
    const m = e.ingest(ev('message_update', { text: 'Current GOAL = shipit now' }));
    expect(m).toHaveLength(1);
    expect(m[0].evidence.toLowerCase()).toContain('goal');
  });

  it('resets the assistant buffer at turn boundaries', () => {
    const e = engine([{ type: 'text', contains: 'DONE' }]);
    e.ingest(ev('message_update', { text: 'DO' }));
    // New turn — the earlier partial must not combine with the next turn.
    expect(e.ingest(ev('agent_start'))).toHaveLength(0);
    expect(e.ingest(ev('message_update', { text: 'NE' }))).toHaveLength(0);
  });

  it('ignores user-role message text (prompt echoes never feed the assistant buffer)', () => {
    const e = engine([{ type: 'text', contains: 'QUESTION-FOR-PARENT' }]);
    // Claude / Command Code / agy shape: role on data.role.
    expect(e.ingest(ev('message_start', { role: 'user', text: 'If blocked, write QUESTION-FOR-PARENT' }))).toHaveLength(0);
    // Antigravity / OpenCode replay echo the user text as a text_delta after a user message_start.
    expect(e.ingest(ev('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'QUESTION-FOR-PARENT' } }))).toHaveLength(0);
    expect(e.ingest(ev('message_end', { role: 'user' }))).toHaveLength(0);
    // Pi shape: role on data.message.role.
    expect(e.ingest(ev('message_start', { message: { role: 'user' }, text: 'QUESTION-FOR-PARENT' }))).toHaveLength(0);
    // The assistant saying it is what fires.
    expect(e.ingest(ev('message_start', { role: 'assistant' }))).toHaveLength(0);
    expect(e.ingest(ev('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'QUESTION-FOR-PARENT: which db?' } }))).toHaveLength(1);
  });

  it('fires once per new occurrence, not on every later event of the turn', () => {
    const e = engine([{ type: 'text', contains: 'SENTINEL', once: false }]);
    expect(e.ingest(ev('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'SENTI' } }))).toHaveLength(0);
    expect(e.ingest(ev('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'NEL here' } }))).toHaveLength(1);
    // Later non-text events and text without a new occurrence must not re-fire.
    expect(e.ingest(ev('tool_execution_start', { toolName: 'Bash', args: {} }))).toHaveLength(0);
    expect(e.ingest(ev('tool_execution_end', { toolName: 'Bash', result: 'ok' }))).toHaveLength(0);
    expect(e.ingest(ev('claude_sdk_raw', { raw: {} }))).toHaveLength(0);
    expect(e.ingest(ev('message_update', { assistantMessageEvent: { type: 'text_delta', delta: ' and more text' } }))).toHaveLength(0);
    // A genuinely new occurrence fires again.
    expect(e.ingest(ev('message_update', { assistantMessageEvent: { type: 'text_delta', delta: ' SENTINEL again' } }))).toHaveLength(1);
  });

  it('regex text conditions fire only on matches that include new text', () => {
    const e = engine([{ type: 'text', pattern: 'DONE-\\d+', once: false }]);
    expect(e.ingest(ev('message_update', { text: 'DONE-1' }))).toHaveLength(1);
    expect(e.ingest(ev('agent_end'))).toHaveLength(0);
    expect(e.ingest(ev('message_update', { text: ' still working' }))).toHaveLength(0);
    const m = e.ingest(ev('message_update', { text: ' DONE-2' }));
    expect(m).toHaveLength(1);
    expect(m[0].evidence).toBe('DONE-2');
  });

  it('throws on an invalid regex at resolve time', () => {
    expect(() => resolveConditions([{ type: 'text', pattern: '(' }])).toThrow();
  });

  it('assigns stable auto ids and preserves caller ids', () => {
    const resolved = resolveConditions([
      { type: 'event_type', eventType: 'agent_end' },
      { id: 'mine', type: 'tool', toolName: 'Bash' },
    ]);
    expect(resolved[0].id).toBe('c0');
    expect(resolved[1].id).toBe('mine');
  });
});
