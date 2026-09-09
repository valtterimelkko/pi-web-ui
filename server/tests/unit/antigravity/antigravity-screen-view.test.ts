import { describe, it, expect } from 'vitest';
import { turnsToReplayEvents } from '../../../src/antigravity/antigravity-history-replay.js';
import {
  projectDefaultViewFromEvents,
  renderScreenViewMarkdown,
  type ScreenItem,
} from '@pi-web-ui/shared';
import { storedTurnsFromAbRun, CAPTURED_USAGE_TURN1 } from './fixtures.js';

/**
 * Integration regression for the operator-facing "see what I see" surface:
 * the Internal API `transcript?view=screen` projection must show antigravity
 * tool cards exactly like the pi screen view does. Live-validated defect
 * (2026-09-09): every agy tool card was dropped because the shared
 * VISIBLE_TOOL_NAMES allowlist had no agy members.
 */

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('required value missing');
  return value;
}

const SID = 'agy-screen-test';

describe('antigravity stored turns → screen view', () => {
  const events = turnsToReplayEvents(storedTurnsFromAbRun(), SID);
  const collapsed = projectDefaultViewFromEvents(events);
  const expanded = projectDefaultViewFromEvents(events, { expand: { tools: true, thinking: false } });

  it('emits tool_execution pairs for the stored agy tool calls', () => {
    const starts = events.filter((e) => e.type === 'tool_execution_start');
    const ends = events.filter((e) => e.type === 'tool_execution_end');
    expect(starts).toHaveLength(4);
    expect(ends).toHaveLength(4);
    expect(starts.map((e) => e.toolName)).toEqual([
      'write_to_file', 'write_to_file', 'run_command', 'run_command',
    ]);
  });

  it('projects tool cards (collapsed and expanded) instead of dropping them', () => {
    // Expanded: four individual agy tool cards.
    expect(expanded.items.filter((i) => i.kind === 'tool')).toHaveLength(4);
    // Default collapsed view: the 4 consecutive tools collapse into ONE
    // tool_group item (TOOL_GROUP_MIN_RUN = 3) — exactly how pi tool runs render.
    const groups = collapsed.items.filter((i) => i.kind === 'tool_group');
    expect(groups).toHaveLength(1);
    expect(groups[0].groupSize).toBe(4);
  });

  it('shows primary args on the agy cards', () => {
    const tools = expanded.items.filter((i) => i.kind === 'tool');
    expect(must(tools[0].toolPrimaryArg)).toBe('/tmp/agpi-compare/calc.py');
    expect(must(tools[2].toolPrimaryArg)).toBe('python3 -m unittest -v test_calc');
  });

  it('carries the expanded command output for run_command', () => {
    const tools = expanded.items.filter((i) => i.kind === 'tool');
    expect(must(tools[2].expandedText)).toContain('test_add_negative ... ok');
  });

  it('keeps the surrounding conversation items', () => {
    const kinds = expanded.items.map((i) => i.kind);
    expect(kinds).toEqual(['user', 'tool', 'tool', 'tool', 'tool', 'assistant', 'user', 'assistant']);
  });

  it('markdown contains the agy tool headers', () => {
    const md = renderScreenViewMarkdown(expanded);
    expect(md).toContain('write_to_file: /tmp/agpi-compare/calc.py');
    expect(md).toContain('run_command: python3 -m unittest -v test_calc');
  });

  it('usage from the stored turns is available to context surfacing (real captured numbers)', () => {
    // Anchors the context-honesty work: real request size is input + cacheRead.
    expect(CAPTURED_USAGE_TURN1.input + CAPTURED_USAGE_TURN1.cacheRead).toBe(148_489);
    expect(CAPTURED_USAGE_TURN1.total).toBe(44_704); // input+output only — the old, wrong signal
  });
});
