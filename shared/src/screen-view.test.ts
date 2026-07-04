/**
 * Tests for the shared "screen view" projection — the single source of truth
 * for "what the user sees by default on screen" in a session. Pure, no I/O.
 *
 * These tests mirror the rule bullets in SCREEN-VIEW-OBSERVABILITY-PLAN.md §4
 * Stage 1 and are the contract the client migration (Stage 3) must conform to.
 */
import { describe, it, expect } from 'vitest';
import {
  VISIBLE_TOOL_NAMES,
  isVisibleTool,
  detectSkillContent,
  skillPlaceholder,
  toolPrimaryArg,
  estimateItemLines,
  findConsecutiveToolRuns,
  isSubagentToolName,
  isTodoToolName,
  projectDefaultViewFromEvents,
  renderScreenViewMarkdown,
  type ScreenItem,
} from '../src/screen-view.js';

// ─── Event helpers (common replay-event shapes) ────────────────────────────────

function userMsg(id: string, text: string, ts = 1000): Array<Record<string, unknown>> {
  return [
    { type: 'message_start', message: { id, role: 'user', content: text }, timestamp: ts },
    { type: 'message_end', message: { id }, timestamp: ts },
  ];
}

function asstMsg(id: string, text: string, ts = 2000): Array<Record<string, unknown>> {
  return [
    { type: 'message_start', message: { id, role: 'assistant' }, timestamp: ts },
    {
      type: 'message_update',
      message: { id },
      assistantMessageEvent: { type: 'text_delta', delta: text },
      timestamp: ts,
    },
    { type: 'message_end', message: { id }, timestamp: ts },
  ];
}

function tool(
  id: string,
  name: string,
  args: unknown,
  resultText: string,
  ts = 3000,
): Array<Record<string, unknown>> {
  return [
    { type: 'tool_execution_start', toolCallId: id, toolName: name, args, timestamp: ts },
    {
      type: 'tool_execution_end',
      toolCallId: id,
      result: { content: [{ type: 'text', text: resultText }] },
      isError: false,
      timestamp: ts,
    },
  ];
}

function thinkingAsst(id: string, thinking: string, text: string, ts = 2000): Array<Record<string, unknown>> {
  return [
    { type: 'message_start', message: { id, role: 'assistant' }, timestamp: ts },
    {
      type: 'message_update',
      message: { id },
      assistantMessageEvent: { type: 'thinking', thinking },
      timestamp: ts,
    },
    {
      type: 'message_update',
      message: { id },
      assistantMessageEvent: { type: 'text_delta', delta: text },
      timestamp: ts,
    },
    { type: 'message_end', message: { id }, timestamp: ts },
  ];
}

// ─── isVisibleTool / VISIBLE_TOOL_NAMES ────────────────────────────────────────

describe('isVisibleTool', () => {
  it('accepts Pi lowercase tool names', () => {
    expect(isVisibleTool('bash')).toBe(true);
    expect(isVisibleTool('read')).toBe(true);
    expect(isVisibleTool('subagent')).toBe(true);
    expect(isVisibleTool('web_search')).toBe(true);
  });

  it('accepts Claude PascalCase equivalents', () => {
    expect(isVisibleTool('Read')).toBe(true);
    expect(isVisibleTool('Agent')).toBe(true);
    expect(isVisibleTool('TodoWrite')).toBe(true);
    expect(isVisibleTool('WebSearch')).toBe(true);
  });

  it('accepts OpenCode _tool-suffixed names', () => {
    expect(isVisibleTool('Read_tool')).toBe(true);
    expect(isVisibleTool('Bash_tool')).toBe(true);
  });

  it('rejects arbitrary MCP / unknown tool names', () => {
    expect(isVisibleTool('mcp__custom__do_thing')).toBe(false);
    expect(isVisibleTool('some_random_tool')).toBe(false);
    expect(isVisibleTool('')).toBe(false);
  });

  it('is exact-match (case-sensitive) — the client/screen semantics', () => {
    // 'read' is visible but 'READ' is not a member
    expect(isVisibleTool('read')).toBe(true);
    expect(isVisibleTool('READ')).toBe(false);
  });

  it('VISIBLE_TOOL_NAMES is the unified superset', () => {
    expect(VISIBLE_TOOL_NAMES.has('skill')).toBe(true);
    expect(VISIBLE_TOOL_NAMES.has('Task')).toBe(true);
    expect(VISIBLE_TOOL_NAMES.size).toBeGreaterThan(20);
  });
});

// ─── detectSkillContent / skillPlaceholder ──────────────────────────────────────

describe('detectSkillContent', () => {
  it('detects the XML skill form and extracts the name', () => {
    const text = '<skill name="lecture-website" location="/x/SKILL.md">\n# Lecture Website Builder\n...</skill>';
    expect(detectSkillContent(text)).toEqual({ isSkill: true, skillName: 'lecture-website' });
  });

  it('detects the HTML-escaped XML skill form (name only extractable from raw form)', () => {
    // The escaped form is recognised as skill content; the name regex matches
    // the raw `<skill name="…">` only (mirrors the client exactly), so the
    // name is undefined here.
    const text = '&lt;skill name="foo"&gt;body&lt;/skill&gt;';
    expect(detectSkillContent(text)).toEqual({ isSkill: true, skillName: undefined });
  });

  it('detects the "# Skill:" markdown header form (no name)', () => {
    expect(detectSkillContent('# Skill: Something\nbody')).toEqual({ isSkill: true });
  });

  it('detects the Skill Purpose + Workflow markdown structure', () => {
    expect(detectSkillContent('blah\n### Skill Purpose\nx\n### Workflow\ny')).toEqual({ isSkill: true });
  });

  it('detects the Lecture Website Builder header form', () => {
    expect(detectSkillContent('# Lecture Website Builder\n...')).toEqual({ isSkill: true });
  });

  it('does NOT flag text that merely mentions SKILL.md in a path', () => {
    const text = 'I edited the file: /root/.skills/skill-name/SKILL.md';
    expect(detectSkillContent(text)).toEqual({ isSkill: false });
  });

  it('does NOT flag ordinary text', () => {
    expect(detectSkillContent('Here is your refactored function.')).toEqual({ isSkill: false });
  });
});

describe('skillPlaceholder', () => {
  it('includes the name when provided', () => {
    expect(skillPlaceholder('lecture-website')).toBe('📚 **Skill loaded: lecture-website**');
  });
  it('omits the name when not provided', () => {
    expect(skillPlaceholder()).toBe('📚 **Skill loaded**');
    expect(skillPlaceholder(undefined)).toBe('📚 **Skill loaded**');
  });
});

// ─── toolPrimaryArg ─────────────────────────────────────────────────────────────

describe('toolPrimaryArg', () => {
  it('reads command for bash', () => {
    expect(toolPrimaryArg('bash', { command: 'ls -la' })).toBe('ls -la');
  });
  it('reads path for read', () => {
    expect(toolPrimaryArg('read', { path: '/a/b.txt' })).toBe('/a/b.txt');
  });
  it('respects the priority order (path before pattern)', () => {
    expect(toolPrimaryArg('x', { pattern: 'p', path: '/f' })).toBe('/f');
  });
  it('truncates long values to 50 chars + ellipsis', () => {
    const long = '/very/long/path/that/exceeds/fifty/characters/and/should/be/truncated';
    const out = toolPrimaryArg('read', { path: long });
    expect(out?.endsWith('…')).toBe(true);
    expect((out ?? '').length).toBe(51); // 50 + ellipsis
  });
  it('falls back to first string param', () => {
    expect(toolPrimaryArg('x', { foo: 'bar' })).toBe('bar');
  });
  it('returns undefined when no usable arg', () => {
    expect(toolPrimaryArg('bash', {})).toBeUndefined();
    expect(toolPrimaryArg('bash', undefined)).toBeUndefined();
    expect(toolPrimaryArg('bash', { n: 5 })).toBeUndefined();
  });
});

// ─── estimateItemLines ──────────────────────────────────────────────────────────

describe('estimateItemLines', () => {
  const base = { collapsedByDefault: false, estimatedLines: 0 };
  it('is monotonic non-decreasing with content length', () => {
    const small: ScreenItem = { ...base, kind: 'assistant', text: 'hi' };
    const med: ScreenItem = { ...base, kind: 'assistant', text: 'x'.repeat(90) };
    const big: ScreenItem = { ...base, kind: 'assistant', text: 'x'.repeat(500) };
    expect(estimateItemLines(big)).toBeGreaterThanOrEqual(estimateItemLines(med));
    expect(estimateItemLines(med)).toBeGreaterThanOrEqual(estimateItemLines(small));
  });
  it('returns 0 for empty text', () => {
    expect(estimateItemLines({ ...base, kind: 'assistant', text: '' })).toBe(0);
  });
  it('counts a tool_group as 1 rendered line', () => {
    expect(
      estimateItemLines({ ...base, kind: 'tool_group', text: '(3 tools)', groupSize: 3 }),
    ).toBe(1);
  });
  it('counts explicit newlines', () => {
    const one = estimateItemLines({ ...base, kind: 'assistant', text: 'a' });
    const three = estimateItemLines({ ...base, kind: 'assistant', text: 'a\nb\nc' });
    expect(three).toBeGreaterThan(one);
  });
});

// ─── special-card name helpers ──────────────────────────────────────────────────

describe('special-card name detection', () => {
  it('recognises subagent family names (case-insensitive)', () => {
    expect(isSubagentToolName('subagent')).toBe(true);
    expect(isSubagentToolName('Agent')).toBe(true);
    expect(isSubagentToolName('Task')).toBe(true);
    expect(isSubagentToolName('bash')).toBe(false);
  });
  it('recognises todo family names (case-insensitive)', () => {
    expect(isTodoToolName('todo')).toBe(true);
    expect(isTodoToolName('TodoWrite')).toBe(true);
    expect(isTodoToolName('TodoRead')).toBe(true);
    expect(isTodoToolName('bash')).toBe(false);
  });
});

// ─── findConsecutiveToolRuns (shared grouping rule) ────────────────────────────

describe('findConsecutiveToolRuns', () => {
  it('returns a run of 3+ consecutive tools', () => {
    // roles: u, t, t, t, a  → one run [1..3]
    const roles = ['user', 'tool', 'tool', 'tool', 'assistant'];
    const runs = findConsecutiveToolRuns(roles.length, (i) => roles[i] === 'tool');
    expect(runs).toEqual([{ start: 1, size: 3 }]);
  });
  it('does NOT return a run shorter than the minimum', () => {
    const roles = ['user', 'tool', 'tool', 'assistant'];
    expect(findConsecutiveToolRuns(roles.length, (i) => roles[i] === 'tool')).toEqual([]);
  });
  it('returns multiple runs', () => {
    const roles = ['tool', 'tool', 'tool', 'assistant', 'tool', 'tool', 'tool', 'tool'];
    const runs = findConsecutiveToolRuns(roles.length, (i) => roles[i] === 'tool');
    expect(runs).toEqual([{ start: 0, size: 3 }, { start: 4, size: 4 }]);
  });
  it('respects an explicit minRun', () => {
    const roles = ['tool', 'tool'];
    expect(findConsecutiveToolRuns(roles.length, (i) => roles[i] === 'tool', 2)).toEqual([{ start: 0, size: 2 }]);
  });
});



describe('projectDefaultViewFromEvents — visible filter', () => {
  it('keeps user + assistant + visible tools; drops unknown MCP tools', () => {
    const events = [
      ...userMsg('u1', 'hello'),
      ...asstMsg('a1', 'hi'),
      ...tool('t1', 'bash', { command: 'ls' }, 'total 0'),
      ...tool('t2', 'mcp__custom__do_thing', {}, 'x'),
    ];
    const view = projectDefaultViewFromEvents(events);
    expect(view.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool']);
    expect(view.items[2].toolName).toBe('bash');
    expect(view.itemCount).toBe(3);
  });
});

describe('projectDefaultViewFromEvents — skill transform', () => {
  it('collapses skill content to a placeholder', () => {
    const events = asstMsg(
      'a1',
      '<skill name="lecture-website" location="/x/SKILL.md">\n# Lecture Website Builder\nTransform an idea...</skill>',
    );
    const view = projectDefaultViewFromEvents(events);
    expect(view.items[0].kind).toBe('assistant');
    expect(view.items[0].text).toBe('📚 **Skill loaded: lecture-website**');
  });

  it('leaves ordinary SKILL.md-path text unchanged', () => {
    const events = asstMsg('a1', 'I edited the file: /root/.skills/foo/SKILL.md');
    const view = projectDefaultViewFromEvents(events);
    expect(view.items[0].text).toBe('I edited the file: /root/.skills/foo/SKILL.md');
  });
});

describe('projectDefaultViewFromEvents — thinking', () => {
  it('emits a collapsed thinking item with a summary, before the assistant text', () => {
    const events = thinkingAsst('a1', 'I need to find files. Then read them.', 'Done.');
    const view = projectDefaultViewFromEvents(events);
    expect(view.items.map((i) => i.kind)).toEqual(['thinking', 'assistant']);
    const t = view.items[0];
    expect(t.collapsedByDefault).toBe(true);
    expect(t.text).toBe('I need to find files'); // first sentence, < 60 chars
    expect(t.expandedText).toBeUndefined(); // hidden by default
    expect(view.items[1].text).toBe('Done.');
  });

  it('exposes full thinking text only under expand.thinking', () => {
    const events = thinkingAsst('a1', 'I need to find files. Then read them.', 'Done.');
    const view = projectDefaultViewFromEvents(events, { expand: { thinking: true } });
    expect(view.items[0].expandedText).toBe('I need to find files. Then read them.');
    expect(view.expanded.thinking).toBe(true);
  });

  it('summarises long unbroken thinking to ~60 chars', () => {
    const long = 'word '.repeat(40); // no sentence terminator
    const events = thinkingAsst('a1', long, 'ok');
    const view = projectDefaultViewFromEvents(events);
    expect(view.items[0].text.length).toBeLessThanOrEqual(61);
    expect(view.items[0].text.endsWith('…')).toBe(true);
  });
});

describe('projectDefaultViewFromEvents — tool cards', () => {
  it('is collapsed by default: text is the header only, no output', () => {
    const events = tool('t1', 'bash', { command: 'ls' }, 'line1\nline2\nline3');
    const view = projectDefaultViewFromEvents(events);
    const ti = view.items[0];
    expect(ti.kind).toBe('tool');
    expect(ti.collapsedByDefault).toBe(true);
    expect(ti.text).toBe('bash: ls');
    expect(ti.toolPrimaryArg).toBe('ls');
    expect(ti.expandedText).toBeUndefined();
  });

  it('exposes truncated output only under expand.tools', () => {
    const events = tool('t1', 'bash', { command: 'ls' }, 'line1\nline2\nline3');
    const view = projectDefaultViewFromEvents(events, { expand: { tools: true } });
    expect(view.items[0].expandedText).toBe('line1\nline2\nline3');
    expect(view.expanded.tools).toBe(true);
  });

  it('truncates expanded tool output beyond the max length', () => {
    const huge = 'x'.repeat(500);
    const events = tool('t1', 'bash', { command: 'ls' }, huge);
    const view = projectDefaultViewFromEvents(events, { expand: { tools: true } });
    const exp = view.items[0].expandedText ?? '';
    expect(exp.endsWith('...')).toBe(true);
    expect(exp.length).toBeLessThan(huge.length);
  });
});

describe('projectDefaultViewFromEvents — tool grouping', () => {
  const threeTools = [
    ...userMsg('u1', 'go'),
    ...tool('t1', 'bash', { command: 'a' }, 'r'),
    ...tool('t2', 'read', { path: '/a' }, 'r'),
    ...tool('t3', 'read', { path: '/b' }, 'r'),
    ...asstMsg('a1', 'done'),
  ];

  it('collapses exactly 3 consecutive tools into one tool_group', () => {
    const view = projectDefaultViewFromEvents(threeTools);
    expect(view.items.map((i) => i.kind)).toEqual(['user', 'tool_group', 'assistant']);
    const g = view.items[1];
    expect(g.kind).toBe('tool_group');
    expect(g.groupSize).toBe(3);
    expect(g.collapsedByDefault).toBe(true);
    expect(g.text).toContain('3');
  });

  it('does NOT group only 2 consecutive tools', () => {
    const events = [
      ...userMsg('u1', 'go'),
      ...tool('t1', 'bash', { command: 'a' }, 'r'),
      ...tool('t2', 'read', { path: '/a' }, 'r'),
      ...asstMsg('a1', 'done'),
    ];
    const view = projectDefaultViewFromEvents(events);
    expect(view.items.map((i) => i.kind)).toEqual(['user', 'tool', 'tool', 'assistant']);
  });

  it('expand.tools un-groups (emits individual tool items)', () => {
    const view = projectDefaultViewFromEvents(threeTools, { expand: { tools: true } });
    expect(view.items.map((i) => i.kind)).toEqual(['user', 'tool', 'tool', 'tool', 'assistant']);
  });
});

describe('projectDefaultViewFromEvents — special-card serialization', () => {
  it('serializes a subagent tool as a one-line mode + task-count summary', () => {
    const events = tool(
      't1',
      'subagent',
      { mode: 'parallel', tasks: [{ agent: 'coder', task: 'x' }, { agent: 'coder', task: 'y' }] },
      JSON.stringify({ mode: 'parallel', tasks: [{}, {}] }),
    );
    const view = projectDefaultViewFromEvents(events);
    expect(view.items[0].kind).toBe('tool');
    expect(view.items[0].text).toContain('parallel');
    expect(view.items[0].text).toContain('2');
    expect(view.items[0].collapsedByDefault).toBe(true);
  });

  it('enriches a subagent tool with model + one-line summary when resultSummary is present', () => {
    const summary = {
      mode: 'single',
      kind: 'subagent' as const,
      agents: [
        {
          agent: 'codescout',
          model: 'github-copilot/gpt-5.4-mini',
          turns: 13,
          toolCalls: 46,
          toolBreakdown: [{ name: 'read', count: 26 }],
          inputTokens: 100770,
          outputTokens: 15350,
        },
      ],
      totals: { agentCount: 1, toolCalls: 46, turns: 13, inputTokens: 100770, outputTokens: 15350 },
    };
    const events = [
      { type: 'tool_execution_start', toolCallId: 't1', toolName: 'subagent', args: { agent: 'codescout' }, timestamp: 1000 },
      { type: 'tool_execution_end', toolCallId: 't1', toolName: 'subagent', result: { content: [{ type: 'text', text: 'ans' }] }, resultSummary: summary, isError: false, timestamp: 1000 },
    ];
    const view = projectDefaultViewFromEvents(events);
    const text = view.items[0].text;
    expect(text).toContain('codescout');
    expect(text).toContain('github-copilot/gpt-5.4-mini');
    expect(text).toContain('46 tools · 13 turns · 116k tok');
  });

  it('computes the summary from raw result.details when resultSummary is absent', () => {
    const details = {
      mode: 'single',
      results: [
        {
          agent: 'codescout',
          messages: [
            {
              role: 'assistant',
              provider: 'github-copilot',
              model: 'gpt-5.4-mini',
              usage: { input: 1000, output: 100, cost: { total: 0.01 } },
              content: [{ type: 'toolCall', name: 'read' }],
            },
          ],
        },
      ],
    };
    const events = [
      { type: 'tool_execution_start', toolCallId: 't1', toolName: 'subagent', args: {}, timestamp: 1000 },
      { type: 'tool_execution_end', toolCallId: 't1', toolName: 'subagent', result: { content: [{ type: 'text', text: 'ans' }], details }, isError: false, timestamp: 1000 },
    ];
    const view = projectDefaultViewFromEvents(events);
    const text = view.items[0].text;
    expect(text).toContain('github-copilot/gpt-5.4-mini');
    expect(text).toContain('1 tool · 1 turn · 1k tok');
  });

  it('serializes a todo tool as a short checklist (☑ done / ☐ pending)', () => {
    const events = tool(
      't1',
      'TodoWrite',
      { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] },
      'ok',
    );
    const view = projectDefaultViewFromEvents(events);
    expect(view.items[0].kind).toBe('tool');
    const text = view.items[0].text;
    expect(text).toContain('☑ a'); // completed → checked
    expect(text).toContain('☐ b'); // pending → unchecked
  });
});

describe('projectDefaultViewFromEvents — aggregates', () => {
  it('estimatedTotalLines equals the sum of visible item estimates', () => {
    const events = [
      ...userMsg('u1', 'hello'),
      ...asstMsg('a1', 'x'.repeat(200)),
    ];
    const view = projectDefaultViewFromEvents(events);
    const sum = view.items.reduce((s, i) => s + estimateItemLines(i), 0);
    expect(view.estimatedTotalLines).toBe(sum);
  });

  it('estimatedTotalLines grows with assistant content', () => {
    const short = projectDefaultViewFromEvents(asstMsg('a1', 'short'));
    const long = projectDefaultViewFromEvents(asstMsg('a1', 'x'.repeat(400)));
    expect(long.estimatedTotalLines).toBeGreaterThan(short.estimatedTotalLines);
  });

  it('echoes the applied expansions', () => {
    const events = userMsg('u1', 'hi');
    expect(projectDefaultViewFromEvents(events).expanded).toEqual({ tools: false, thinking: false });
    expect(
      projectDefaultViewFromEvents(events, { expand: { tools: true, thinking: true } }).expanded,
    ).toEqual({ tools: true, thinking: true });
  });

  it('returns an empty view for no events', () => {
    const view = projectDefaultViewFromEvents([]);
    expect(view.items).toEqual([]);
    expect(view.itemCount).toBe(0);
    expect(view.estimatedTotalLines).toBe(0);
  });
});

// ─── renderScreenViewMarkdown ───────────────────────────────────────────────────

describe('renderScreenViewMarkdown', () => {
  it('is stable (deterministic) for a fixed input', () => {
    const events = [
      ...userMsg('u1', 'hello'),
      ...tool('t1', 'bash', { command: 'ls' }, 'total 0'),
      ...asstMsg('a1', 'done'),
    ];
    const a = renderScreenViewMarkdown(projectDefaultViewFromEvents(events));
    const b = renderScreenViewMarkdown(projectDefaultViewFromEvents(events));
    expect(a).toBe(b);
  });

  it('renders a header, the tool header line, and item count', () => {
    const events = [
      ...userMsg('u1', 'hello world'),
      ...tool('t1', 'bash', { command: 'ls' }, 'total 0'),
      ...asstMsg('a1', 'done'),
    ];
    const md = renderScreenViewMarkdown(projectDefaultViewFromEvents(events));
    expect(md).toContain('# Screen view');
    expect(md).toContain('bash: ls');
    expect(md).toContain('hello world');
    expect(md).toContain('Items: 3');
  });

  it('includes expanded content only when expanded', () => {
    const events = tool('t1', 'bash', { command: 'ls' }, 'secret-output');
    const collapsed = renderScreenViewMarkdown(projectDefaultViewFromEvents(events));
    const expanded = renderScreenViewMarkdown(
      projectDefaultViewFromEvents(events, { expand: { tools: true } }),
    );
    expect(collapsed).not.toContain('secret-output');
    expect(expanded).toContain('secret-output');
  });
});
