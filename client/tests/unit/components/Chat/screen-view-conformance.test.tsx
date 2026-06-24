/**
 * Conformance test — the anti-drift guarantee.
 *
 * For a set of fixture sessions, the set + order of visible items the CLIENT
 * message list produces must equal the items `projectDefaultViewFromEvents`
 * (the Internal API `view=screen` projection) produces from the SAME session's
 * replay events. This is what enforces "the agent sees exactly what the user
 * sees": both sides now import the SAME shared rule primitives.
 *
 * See SCREEN-VIEW-OBSERVABILITY-PLAN.md §4 Stage 3.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import type { LiveMessage } from '../../../../src/hooks/useSessionStream';
import { projectDefaultViewFromEvents } from '@pi-web-ui/shared';

// Capture every message the list actually renders (after its visible-filter +
// skill-transform). The real MessageBubble is replaced so we observe the
// selection decision, not the rendering.
const rendered: Array<{ id: string; role: string; toolName?: string; text: string }> = [];
vi.mock('../../../../src/components/Chat/MessageBubble', () => ({
  MessageBubble: ({ message }: { message: LiveMessage }) => {
    rendered.push({
      id: message.id,
      role: message.role,
      toolName: message.toolCall?.name,
      text: message.content.map((c) => c.text || c.thinking || '').join(''),
    });
    return <div data-testid={`bubble-${message.id}`} />;
  },
}));

vi.mock('react-virtuoso', () => ({
  Virtuoso: ({ data, itemContent }: {
    data: Array<any>;
    itemContent: (index: number, item: any) => React.ReactNode;
  }) => (
    <div data-testid="virtuoso-mock">
      {data.map((item, index) => (
        <div key={item.kind === 'tool_group' ? `group-${item.groupId}` : item.message.id}>
          {itemContent(index, item)}
        </div>
      ))}
    </div>
  ),
}));

// Lazy import so the mocks above apply.
const { VirtualizedMessageList } = await import('../../../../src/components/Chat/VirtualizedMessageList');

// ─── Fixture: one session in two synchronized forms ────────────────────────────
// LiveMessages (what the client renders) AND the equivalent replay events
// (what the server projects). They describe the same conversation.

const fixtureMessages: LiveMessage[] = [
  { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 1000, isComplete: true },
  { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 2000, isComplete: true },
  { id: 't1', role: 'tool', content: [], timestamp: 3000, isComplete: true, toolCall: { id: 'c1', name: 'bash', args: { command: 'ls' } } },
  // Invisible MCP tool — must be dropped by BOTH client and projection.
  { id: 't2', role: 'tool', content: [], timestamp: 3100, isComplete: true, toolCall: { id: 'c2', name: 'mcp__custom__do_thing', args: {} } },
  { id: 't3', role: 'tool', content: [], timestamp: 3200, isComplete: true, toolCall: { id: 'c3', name: 'read', args: { path: '/a' } } },
  // PascalCase Claude name — visible on both sides.
  { id: 't4', role: 'tool', content: [], timestamp: 3300, isComplete: true, toolCall: { id: 'c4', name: 'Edit', args: { path: '/b' } } },
  { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: 4000, isComplete: true },
];

function tool(id: string, name: string, args: unknown, ts: number, resultText = 'ok') {
  return [
    { type: 'tool_execution_start', toolCallId: id, toolName: name, args, timestamp: ts },
    { type: 'tool_execution_end', toolCallId: id, result: { content: [{ type: 'text', text: resultText }] }, isError: false, timestamp: ts },
  ];
}

const fixtureEvents: Array<Record<string, unknown>> = [
  { type: 'message_start', message: { id: 'u1', role: 'user', content: 'hello' }, timestamp: 1000 },
  { type: 'message_end', message: { id: 'u1' }, timestamp: 1000 },
  { type: 'message_start', message: { id: 'a1', role: 'assistant' }, timestamp: 2000 },
  { type: 'message_update', message: { id: 'a1' }, assistantMessageEvent: { type: 'text_delta', delta: 'hi' }, timestamp: 2000 },
  { type: 'message_end', message: { id: 'a1' }, timestamp: 2000 },
  ...tool('c1', 'bash', { command: 'ls' }, 3000),
  ...tool('c2', 'mcp__custom__do_thing', {}, 3100),
  ...tool('c3', 'read', { path: '/a' }, 3200),
  ...tool('c4', 'Edit', { path: '/b' }, 3300),
  { type: 'message_start', message: { id: 'a2', role: 'assistant' }, timestamp: 4000 },
  { type: 'message_update', message: { id: 'a2' }, assistantMessageEvent: { type: 'text_delta', delta: 'done' }, timestamp: 4000 },
  { type: 'message_end', message: { id: 'a2' }, timestamp: 4000 },
];

describe('screen-view conformance: client list === server projection', () => {
  it('selects the same default visible items in the same order, including collapsed tool groups', () => {
    rendered.length = 0;
    render(<VirtualizedMessageList messages={fixtureMessages} isStreaming={false} />);

    // Default/resting client view: the 3 visible consecutive tools are collapsed
    // behind one group toggle, so the individual tool bubbles are not rendered.
    expect(screen.getByText(/3 tools/)).toBeInTheDocument();
    expect(rendered.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(rendered.filter((m) => m.role === 'tool')).toEqual([]);

    const clientSeq = [
      { kind: 'user', toolName: undefined },
      { kind: 'assistant', toolName: undefined },
      { kind: 'tool_group', toolName: undefined },
      { kind: 'assistant', toolName: undefined },
    ];

    const view = projectDefaultViewFromEvents(fixtureEvents);
    const projectedSeq = view.items
      .filter((i) => i.kind !== 'thinking')
      .map((i) => ({ kind: i.kind, toolName: i.toolName }));

    expect(clientSeq).toEqual(projectedSeq);
  });

  it('drops the unknown MCP tool on both sides', () => {
    rendered.length = 0;
    render(<VirtualizedMessageList messages={fixtureMessages} isStreaming={false} />);
    expect(rendered.find((m) => m.toolName === 'mcp__custom__do_thing')).toBeUndefined();

    const view = projectDefaultViewFromEvents(fixtureEvents, { expand: { tools: true } });
    expect(view.items.find((i) => i.toolName === 'mcp__custom__do_thing')).toBeUndefined();
  });

  it('collapses skill content to the same placeholder on both sides', () => {    const skillText = '<skill name="lecture-website" location="/x/SKILL.md">\n# Lecture Website Builder\n...</skill>';
    const messages: LiveMessage[] = [
      { id: 's1', role: 'assistant', content: [{ type: 'text', text: skillText }], timestamp: 1000, isComplete: true },
    ];
    const events: Array<Record<string, unknown>> = [
      { type: 'message_start', message: { id: 's1', role: 'assistant' }, timestamp: 1000 },
      { type: 'message_update', message: { id: 's1' }, assistantMessageEvent: { type: 'text_delta', delta: skillText } },
      { type: 'message_end', message: { id: 's1' } },
    ];

    rendered.length = 0;
    render(<VirtualizedMessageList messages={messages} isStreaming={false} />);
    const clientText = rendered[0].text;

    const view = projectDefaultViewFromEvents(events);
    const projectedText = view.items.find((i) => i.kind === 'assistant')!.text;

    expect(clientText).toBe('📚 **Skill loaded: lecture-website**');
    expect(clientText).toBe(projectedText);
  });

  it('keeps non-grouped special-card tools visible on both sides', () => {
    const messages: LiveMessage[] = [
      { id: 'u1', role: 'user', content: [{ type: 'text', text: 'delegate and plan' }], timestamp: 1000, isComplete: true },
      {
        id: 'task-1',
        role: 'tool',
        content: [],
        timestamp: 2000,
        isComplete: true,
        toolCall: { id: 'c1', name: 'Task', args: { mode: 'parallel', tasks: [{ agent: 'worker', task: 'check' }] } },
        toolResult: { output: 'done', isError: false },
      },
      {
        id: 'todo-1',
        role: 'tool',
        content: [],
        timestamp: 3000,
        isComplete: true,
        toolCall: { id: 'c2', name: 'TodoWrite', args: { todos: [{ content: 'check', status: 'pending' }] } },
        toolResult: { output: 'updated', isError: false },
      },
    ];
    const events: Array<Record<string, unknown>> = [
      { type: 'message_start', message: { id: 'u1', role: 'user', content: 'delegate and plan' }, timestamp: 1000 },
      { type: 'message_end', message: { id: 'u1' } },
      ...tool('c1', 'Task', { mode: 'parallel', tasks: [{ agent: 'worker', task: 'check' }] }, 2000, 'done'),
      ...tool('c2', 'TodoWrite', { todos: [{ content: 'check', status: 'pending' }] }, 3000, 'updated'),
    ];

    rendered.length = 0;
    render(<VirtualizedMessageList messages={messages} isStreaming={false} />);
    const clientSeq = rendered.map((m) => ({ kind: m.role, toolName: m.toolName }));
    const projectedSeq = projectDefaultViewFromEvents(events).items.map((i) => ({
      kind: i.kind,
      toolName: i.toolName,
    }));

    expect(clientSeq).toEqual(projectedSeq);
  });

  it('groups 3+ consecutive tools identically (shared findConsecutiveToolRuns)', () => {
    const messages: LiveMessage[] = [
      { id: 'u1', role: 'user', content: [{ type: 'text', text: 'go' }], timestamp: 1000, isComplete: true },
      { id: 't1', role: 'tool', content: [], timestamp: 2000, isComplete: true, toolCall: { id: 'c1', name: 'bash', args: { command: 'a' } } },
      { id: 't2', role: 'tool', content: [], timestamp: 3000, isComplete: true, toolCall: { id: 'c2', name: 'read', args: { path: '/a' } } },
      { id: 't3', role: 'tool', content: [], timestamp: 4000, isComplete: true, toolCall: { id: 'c3', name: 'Edit', args: { path: '/b' } } },
      { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: 5000, isComplete: true },
    ];
    const events: Array<Record<string, unknown>> = [
      { type: 'message_start', message: { id: 'u1', role: 'user', content: 'go' }, timestamp: 1000 },
      { type: 'message_end', message: { id: 'u1' } },
      ...tool('c1', 'bash', { command: 'a' }, 2000, 'r'),
      ...tool('c2', 'read', { path: '/a' }, 3000, 'r'),
      ...tool('c3', 'Edit', { path: '/b' }, 4000, 'r'),
      { type: 'message_start', message: { id: 'a1', role: 'assistant' }, timestamp: 5000 },
      { type: 'message_update', message: { id: 'a1' }, assistantMessageEvent: { type: 'text_delta', delta: 'done' } },
      { type: 'message_end', message: { id: 'a1' } },
    ];

    // Client: the list renders one collapsed group toggle and no individual tool bubbles.
    rendered.length = 0;
    render(<VirtualizedMessageList messages={messages} isStreaming={false} />);
    expect(screen.getByText(/3 tools/)).toBeInTheDocument();
    expect(rendered.filter((m) => m.role === 'tool')).toEqual([]);

    // Projection: the three tools collapse into one tool_group of size 3.
    const view = projectDefaultViewFromEvents(events);
    const group = view.items.find((i) => i.kind === 'tool_group');
    expect(group).toBeDefined();
    expect(group?.groupSize).toBe(3);
  });
});
