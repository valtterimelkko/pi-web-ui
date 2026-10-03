/**
 * Wave K (contract 1.59.0) — K3 continue-note builder tests.
 *
 * The note names what stopped the run, that the worktree is intact, and —
 * read from the transcript — the tool call that was in flight (K3: check its
 * effects before repeating it; nothing re-executes automatically). The note is
 * single-line and double-quote-free so it can ride inside a `/goal resume …`
 * command argument.
 */
import { describe, it, expect } from 'vitest';
import { findInFlightToolCall, buildContinueNote } from '../../../../src/internal-api/goal/continue-note.js';

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

const TOOL_CALL_COMMIT = line({
  type: 'message',
  message: {
    role: 'assistant',
    timestamp: 100,
    content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'git commit -m "feat: half done"' } }],
  },
});

describe('findInFlightToolCall', () => {
  it('returns the trailing unmatched tool call with its name and argument summary', () => {
    const call = findInFlightToolCall([TOOL_CALL_COMMIT]);
    expect(call).not.toBeNull();
    expect(call?.name).toBe('bash');
    expect(call?.argsSummary).toContain('git commit');
  });

  it('returns null when the last call has a matching result', () => {
    const result = line({ type: 'message', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', timestamp: 110, content: [{ type: 'text', text: 'ok' }] } });
    expect(findInFlightToolCall([TOOL_CALL_COMMIT, result])).toBeNull();
  });

  it('returns the LAST unmatched call when an earlier one was answered', () => {
    const result1 = line({ type: 'message', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', timestamp: 110, content: [] } });
    const call2 = line({
      type: 'message',
      message: {
        role: 'assistant',
        timestamp: 120,
        content: [{ type: 'toolCall', id: 'call-2', name: 'write', arguments: { path: '/w/file.txt', content: 'x'.repeat(400) } }],
      },
    });
    const call = findInFlightToolCall([TOOL_CALL_COMMIT, result1, call2]);
    expect(call?.name).toBe('write');
    expect(call?.argsSummary).toContain('/w/file.txt');
  });

  it('truncates long argument summaries', () => {
    const call = findInFlightToolCall([TOOL_CALL_COMMIT, line({ type: 'message', message: { role: 'toolResult', toolCallId: 'call-1', content: [] } }), line({
      type: 'message',
      message: {
        role: 'assistant',
        timestamp: 120,
        content: [{ type: 'toolCall', id: 'call-2', name: 'write', arguments: { content: 'y'.repeat(500) } }],
      },
    })]);
    expect(call?.argsSummary.length).toBeLessThanOrEqual(121);
    expect(call?.argsSummary.endsWith('…')).toBe(true);
  });

  it('returns null for an empty or junk transcript', () => {
    expect(findInFlightToolCall([])).toBeNull();
    expect(findInFlightToolCall(['not json', line({ type: 'session', id: 'x' })])).toBeNull();
  });

  it('tolerates a tool call without arguments', () => {
    const call = findInFlightToolCall([line({ type: 'message', message: { role: 'assistant', timestamp: 5, content: [{ type: 'toolCall', id: 'c', name: 'read' }] } })]);
    expect(call?.name).toBe('read');
    expect(call?.argsSummary).toBe('');
  });
});

describe('buildContinueNote', () => {
  const base = {
    causeLabel: 'a server restart cut your run off',
    inFlightToolCall: { name: 'bash', argsSummary: 'git commit -m "feat: half done"' },
  };

  it('names the cause, the intact worktree, the cut-off tool call and the check-first rule', () => {
    const note = buildContinueNote(base);
    expect(note).toContain('a server restart cut your run off');
    expect(note).toContain('intact');
    expect(note).toContain('bash');
    expect(note).toContain('git commit');
    expect(note.toLowerCase()).toContain('before');
  });

  it('is a single line with no double quotes and bounded length', () => {
    const note = buildContinueNote({ ...base, inFlightToolCall: { name: 'write', argsSummary: 'a"b'.repeat(200) } });
    expect(note).not.toContain('\n');
    expect(note).not.toContain('"');
    expect(note.length).toBeLessThanOrEqual(700);
  });

  it('works without an in-flight tool call', () => {
    const note = buildContinueNote({ causeLabel: 'a provider outage stopped your run' });
    expect(note).toContain('a provider outage stopped your run');
    expect(note).toContain('intact');
    expect(note).not.toContain('was in flight');
  });
});
