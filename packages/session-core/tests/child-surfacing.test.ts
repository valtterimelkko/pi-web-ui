import { describe, it, expect } from 'vitest';
import {
  describeWatchCondition,
  childCardOneLine,
  watchCardOneLine,
} from '../src/child-surfacing.js';
import type { ChildCardProjection } from '../src/child-surfacing.js';

describe('describeWatchCondition', () => {
  it('describes an event_type condition', () => {
    expect(describeWatchCondition({ type: 'event_type', eventType: 'agent_end' })).toBe(
      'event agent_end',
    );
  });

  it('describes a tool condition with phase and argIncludes', () => {
    expect(
      describeWatchCondition({
        type: 'tool',
        toolName: 'bash',
        phase: 'end',
        argIncludes: 'npm test',
      }),
    ).toBe("tool bash@end argIncludes 'npm test'");
  });

  it('describes a text condition with source and contains', () => {
    expect(
      describeWatchCondition({ type: 'text', source: 'assistant', contains: 'ALL DONE' }),
    ).toBe("text assistant contains 'ALL DONE'");
  });

  it('describes a text condition with a pattern', () => {
    expect(describeWatchCondition({ type: 'text', pattern: 'build (ok|failed)' })).toBe(
      "text matches /build (ok|failed)/",
    );
  });

  it('never throws on junk input', () => {
    expect(describeWatchCondition(undefined)).toBe('unknown condition');
    expect(describeWatchCondition({} as never)).toBe('unknown condition');
    expect(describeWatchCondition({ type: 'weird' } as never)).toBe('unknown condition');
  });
});

describe('childCardOneLine', () => {
  it('renders a running internal-api child with runtime and model', () => {
    const card: ChildCardProjection = {
      id: '01a068b0-a551',
      kind: 'internal_api_child',
      status: 'running',
      label: 'msb13-fxa',
      runtime: 'pi',
      model: 'commandcode/meta/muse-spark-1.3-contributor',
    };
    expect(childCardOneLine(card)).toBe(
      'msb13-fxa · pi · commandcode/meta/muse-spark-1.3-contributor · running',
    );
  });

  it('uses the selector when it differs from the resolved model', () => {
    const card: ChildCardProjection = {
      id: 'x',
      kind: 'internal_api_child',
      status: 'completed',
      label: 'child',
      runtime: 'claude',
      model: 'sonnet',
      modelSelector: 'profile:glm',
    };
    expect(childCardOneLine(card)).toBe('child · claude · profile:glm → sonnet · completed');
  });

  it('renders a failed background subagent with agent name and error', () => {
    const card: ChildCardProjection = {
      id: 'bg_1',
      kind: 'background_subagent',
      status: 'failed',
      label: 'web-researcher',
      model: 'openai-codex/gpt-5.6-luna',
      error: 'boom',
    };
    expect(childCardOneLine(card)).toBe('web-researcher · openai-codex/gpt-5.6-luna · failed — boom');
  });

  it('degrades gracefully with only an id and status', () => {
    expect(childCardOneLine({ id: 'bg_2', kind: 'background_subagent', status: 'dispatched' })).toBe(
      'bg_2 · dispatched',
    );
  });
});

describe('watchCardOneLine', () => {
  it('renders an armed watch with target and first condition', () => {
    expect(
      watchCardOneLine({
        watchId: 'watch-01a068b0',
        targetSessionId: '01a068b0-a551',
        status: 'active',
        label: 'msb13-fxa-agent_end',
        conditions: [{ type: 'event_type', description: 'event agent_end' }],
      }),
    ).toBe('⏳ msb13-fxa-agent_end: event agent_end on 01a068b0-a551 (active)');
  });

  it('renders a fired watch with delivery kind', () => {
    expect(
      watchCardOneLine({
        watchId: 'watch-x',
        targetSessionId: 't',
        status: 'fired',
        conditions: [{ type: 'event_type', description: 'event agent_end' }],
        deliveryKind: 'steer',
      }),
    ).toBe('🔔 watch-x: event agent_end on t (fired → steer)');
  });
});
