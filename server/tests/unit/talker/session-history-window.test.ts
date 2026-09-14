/**
 * P23 — the history window must be able to answer "what has been done in this
 * session".
 *
 * The live defect (operator-reported, root cause proven from the real worker
 * session 2026-09-14T12-46-43-058Z_01a09ff4-9b72-73f4-a687-94f99224ad49.jsonl
 * under /root/.pi/agent/sessions/--root-si--/): the operator asked the talker
 * to summarise the session's production queue -- "a clear numbered list of
 * one, two, three" -- and the talker could not.
 *
 * The real session, after the provider's user/assistant filter, is 14
 * conversation entries with this role:length profile (oldest first):
 *
 *   u:75  a:88  a:148  a:183  a:114  a:3472  u:1559  a:192  a:91  a:161
 *   a:134  a:37  a:124  a:90
 *
 * The 3,472-character assistant answer (normalised 3,457 chars) is the
 * session's substance: its numbered items sit at normalised offsets
 * 448 ("1."), 1377 ("2.") and 2099 ("3."). Under the P20 window — newest 12
 * entries, each clipped to 400 chars — the answer was either crowded out by
 * the end-of-session capture bookkeeping (10 of the 12 window slots) or, when
 * it did appear, clipped to a 400-char preamble that contains NONE of the
 * numbered items. The talker could not answer by any route. The defect was
 * the window, not the talker's honesty.
 *
 * FIX under test here: budget-based selection weighted toward the worker's
 * own messages — a much larger per-message allowance for assistant entries
 * (`assistantChars`), no flat count pre-window (the char budget is the
 * selector; a small entry-count cap only guards the line count), and a
 * disclosure that stays truthful in every case: exact counts of what is shown
 * and what is not, plus an explicit note when shown messages are shortened.
 *
 * FAITHFUL REPLICA, stated explicitly: the real session file is private
 * operator material outside this repository (and subject to session hygiene
 * archiving), so these tests construct an equivalent message list — identical
 * entry count, roles, per-entry lengths, and in-message item offsets — with
 * all wording replaced. The structural claim (offsets 448/1377/2099 inside a
 * 3,457-char normalised answer) is taken from the real file.
 */
import { describe, it, expect } from 'vitest';

import { renderStateView, SESSION_HISTORY_LIMITS, clip } from '../../../src/talker/state-view.js';
import type { HarnessView, WorkerHistoryEntry, WorkerStateSnapshot } from '../../../src/talker/types.js';

const emptyHarness: HarnessView = { draft: null, lastReleased: null };

/** Pad `text` with a deterministic filler so its length is exactly `n` chars. */
function padTo(text: string, n: number): string {
  if (text.length > n) throw new Error(`fixture bug: "${text.slice(0, 40)}" already longer than ${n}`);
  const filler = ' routine detail of the working session.';
  let out = text;
  while (out.length < n) out += filler;
  return out.slice(0, n);
}

/**
 * Structural replica of the real session's message 16: 3,457 chars once
 * whitespace-normalised (the renderer's view), with the numbered items at
 * normalised offsets 448 / 1377 / 2099 — exactly where the production-queue
 * items sit in the real answer.
 */
function buildQueueAnswer(): string {
  const item1 = '## 1. GATE-ITEM-ONE — the decision gate only the operator can call, blocking the first builds';
  const item2 = '## 2. GATE-ITEM-TWO — the build queue itself, first fortnight first';
  const item3 = '## 3. GATE-ITEM-THREE — the per-week details that attach to the build work';
  const head = padTo(
    'Here is the full picture of what is left, cross-checked against the repository and the notes. ' +
      '## Bottom line **Nothing has been built yet** — the production queue has not started, and the term begins late September, so this is the critical path.',
    448
  );
  const seg1 = padTo(head + item1, 1377);
  const seg2 = padTo(seg1 + item2, 2099);
  const seg3 = padTo(seg2 + item3, 3457);
  return seg3;
}

/** The real session's 14-entry profile, faithfully replicated. */
function buildRealSessionReplica(): WorkerHistoryEntry[] {
  const answer = buildQueueAnswer();
  return [
    { role: 'user', text: padTo('All right, let us go over the remaining to-dos for the term.', 75) },
    { role: 'assistant', text: padTo('I will start with the mandated recall, then pull the current state.', 88) },
    { role: 'assistant', text: padTo('Recall is warm. Now the actual repository state, notes and outline.', 148) },
    { role: 'assistant', text: padTo('No material directories exist yet — so no drafts have been started.', 183) },
    { role: 'assistant', text: padTo('The picture is nearly complete. Let me read the per-week details.', 114) },
    { role: 'assistant', text: answer },
    {
      role: 'user',
      text: padTo(
        'Automated session-end memory capture delivery. Record the durable outcomes, decisions and evidence from this session before it closes.',
        1559
      ),
    },
    { role: 'assistant', text: padTo('The capture skill mandates checking the CLI contract before submitting.', 192) },
    { role: 'assistant', text: padTo('The flags are valid. Now drafting the two candidates.', 91) },
    { role: 'assistant', text: padTo('Canonical id confirmed. Now drafting the capture notes.', 161) },
    { role: 'assistant', text: padTo('Both need tightening. Recounting.', 134) },
    { role: 'assistant', text: padTo('Recounted.', 37) },
    { role: 'assistant', text: padTo('Both prefixes pass. Submitting the captures.', 124) },
    { role: 'assistant', text: padTo('Capture succeeded, one candidate pending. Done.', 90) },
  ];
}

function blockOf(view: string): string {
  return view.slice(view.indexOf('--- WORKER SESSION HISTORY ---'), view.indexOf('--- END STATE ---'));
}

describe('P23 the queue case: the window reaches the worker’s own numbered answer', () => {
  it('the real session’s shape: the three numbered items of the long answer are visible to the talker', () => {
    const entries = buildRealSessionReplica();
    const view = renderStateView({ recentHistory: entries, historyTotal: entries.length }, emptyHarness);
    const block = blockOf(view);

    // THE defect: none of these survive the old 400-char clip (item one sits
    // at normalised offset 448 of a 3,457-char message).
    expect(block).toContain('1. GATE-ITEM-ONE');
    expect(block).toContain('2. GATE-ITEM-TWO');
    expect(block).toContain('3. GATE-ITEM-THREE');
  });

  it('the real session’s shape: the whole conversation fits — disclosure says complete, bookkeeping and all', () => {
    const entries = buildRealSessionReplica();
    const view = renderStateView({ recentHistory: entries, historyTotal: entries.length }, emptyHarness);
    expect(view).toContain(`All ${entries.length} messages of the session so far are shown.`);
    expect(view).not.toContain('not included');
    // …and the end-of-session bookkeeping did not crowd the substance out:
    // both the earliest prompt and the queue answer are in the same block.
    const block = blockOf(view);
    expect(block).toContain('remaining to-dos for the term');
    expect(block).toContain('production queue has not started');
  });

  it('the buried-answer variant: even with the whole count cap spent on newer bookkeeping, the answer is still reached', () => {
    // The parent's reported framing: a long enough bookkeeping tail pushes the
    // answer past a flat newest-12 window entirely. The budget scheme must
    // still reach it — short bookkeeping entries are cheap, the answer's
    // depth is reserved by its role allowance.
    const answer = buildQueueAnswer();
    const bookkeeping = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: padTo(`Automated capture step ${i + 1} of the session-end bookkeeping.`, 380),
    }));
    const entries: WorkerHistoryEntry[] = [
      { role: 'user', text: 'go over the remaining to-dos' },
      { role: 'assistant', text: answer },
      ...bookkeeping,
    ];
    const view = renderStateView({ recentHistory: entries, historyTotal: entries.length }, emptyHarness);
    const block = blockOf(view);
    expect(block).toContain('1. GATE-ITEM-ONE');
    expect(block).toContain('3. GATE-ITEM-THREE');
  });
});

describe('P23 the weighting: role-aware allowances, budget as the selector', () => {
  it('the operator’s own messages keep the short clip; the worker’s own words get the deep allowance', () => {
    const long = 'x'.repeat(1000);
    const view = renderStateView(
      {
        recentHistory: [
          { role: 'user', text: long },
          { role: 'assistant', text: long },
        ],
        historyTotal: 2,
      },
      emptyHarness
    );
    const userLine = view.split('\n').find(l => l.startsWith('operator: ')) as string;
    const workerLine = view.split('\n').find(l => l.startsWith('worker: ')) as string;
    expect(userLine.length).toBeLessThanOrEqual('operator: '.length + SESSION_HISTORY_LIMITS.entryChars + 2);
    expect(userLine.endsWith('…')).toBe(true);
    // The worker's same-length words appear whole: 1000 chars sits inside the
    // assistant allowance, so no ellipsis and no loss.
    expect(workerLine).toContain(long);
    expect(workerLine.endsWith('…')).toBe(false);
  });

  it('an assistant answer up to the allowance is shown whole — no ellipsis, no loss', () => {
    const text = 'y'.repeat(SESSION_HISTORY_LIMITS.assistantChars);
    const view = renderStateView({ recentHistory: [{ role: 'assistant', text }], historyTotal: 1 }, emptyHarness);
    const line = view.split('\n').find(l => l.startsWith('worker: ')) as string;
    expect(line.endsWith('…')).toBe(false);
    expect(line).toContain(text);
  });

  it('the newest message is always shown, even when alone it exceeds the whole budget', () => {
    const text = 'z'.repeat(50000);
    const view = renderStateView({ recentHistory: [{ role: 'assistant', text }], historyTotal: 1 }, emptyHarness);
    expect(blockOf(view)).toContain('worker: zzzz');
  });

  it('budget, not flat count, selects: the oldest entries are dropped first and the disclosure accounts for them', () => {
    // User-side entries clip to entryChars; enough of them must overflow the
    // total budget so the walk stops before reaching the oldest.
    const filler = 'w'.repeat(SESSION_HISTORY_LIMITS.entryChars);
    const entries = Array.from({ length: 45 }, (_, i) => ({
      role: 'user' as const,
      text: `msg ${i} ${filler}`,
    }));
    const view = renderStateView({ recentHistory: entries, historyTotal: entries.length }, emptyHarness);
    const shown = view.match(/^operator: /gm)?.length ?? 0;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(entries.length);
    expect(view).toContain(`Showing the most recent ${shown} of ${entries.length} messages`);
    expect(view).toContain(`${entries.length - shown} earlier are not included`);
    expect(view).toContain(`msg ${entries.length - 1} `);
    expect(view).not.toContain('msg 0 w');
  });
});

describe('P23 boundedness and truthful disclosure', () => {
  it('a pathological session cannot flood the prompt: the block stays inside the char budget and the line cap', () => {
    const long = 'z'.repeat(5000);
    const bloated: WorkerStateSnapshot = {
      recentHistory: Array.from({ length: 400 }, (_, i) =>
        i % 2 === 0 ? { role: 'user' as const, text: `OLDEST-MARKER-${i} ${long}` } : { role: 'assistant' as const, text: long }
      ),
      historyTotal: 400,
    };
    const view = renderStateView(bloated, emptyHarness);
    const entryLines = view.match(/^(operator|worker): .*$/gm) ?? [];
    const entryChars = entryLines.reduce((n, l) => n + l.length, 0);
    expect(entryChars).toBeLessThanOrEqual(SESSION_HISTORY_LIMITS.totalChars + 512);
    expect(entryLines.length).toBeLessThanOrEqual(SESSION_HISTORY_LIMITS.entries);
    expect(view.length).toBeLessThan(SESSION_HISTORY_LIMITS.totalChars + 2000);
    expect(view).not.toContain('OLDEST-MARKER-0');
  });

  it('the truncated case discloses exact counts; the complete case says so and never says "not included"', () => {
    const entries = Array.from({ length: SESSION_HISTORY_LIMITS.entries + 5 }, (_, i) => ({
      role: 'user' as const,
      text: `turn ${i}: the early investigation continued`,
    }));
    const view = renderStateView({ recentHistory: entries, historyTotal: entries.length }, emptyHarness);
    expect(view).toContain(
      `Showing the most recent ${SESSION_HISTORY_LIMITS.entries} of ${entries.length} messages; 5 earlier are not included.`
    );

    const small = renderStateView(
      {
        recentHistory: [
          { role: 'user', text: 'fix the bug' },
          { role: 'assistant', text: 'Fixed.' },
        ],
        historyTotal: 2,
      },
      emptyHarness
    );
    expect(small).toContain('All 2 messages of the session so far are shown.');
    expect(small).not.toContain('not included');
  });

  it('the disclosure says when shown messages are shortened — and stays silent when none are', () => {
    const clipped = renderStateView(
      {
        recentHistory: [
          { role: 'user', text: 'q'.repeat(2000) },
          { role: 'assistant', text: 'a'.repeat(SESSION_HISTORY_LIMITS.assistantChars + 100) },
        ],
        historyTotal: 2,
      },
      emptyHarness
    );
    expect(clipped).toContain('Some shown messages are shortened to fit (they end with …).');

    const whole = renderStateView(
      {
        recentHistory: [
          { role: 'user', text: 'fix the bug' },
          { role: 'assistant', text: 'Fixed.' },
        ],
        historyTotal: 2,
      },
      emptyHarness
    );
    expect(whole).not.toContain('shortened to fit');
  });

  it('historyTotal larger than the provided tail is still disclosed exactly', () => {
    const entries = buildRealSessionReplica();
    const view = renderStateView({ recentHistory: entries, historyTotal: 300 }, emptyHarness);
    expect(view).toContain(`Showing the most recent ${entries.length} of 300 messages`);
    expect(view).toContain(`${300 - entries.length} earlier are not included`);
  });

  it('stays deterministic, and clip() itself is unchanged in shape', () => {
    const snapshot: WorkerStateSnapshot = {
      activity: 'worker status: idle',
      recentHistory: buildRealSessionReplica(),
      historyTotal: 14,
    };
    const view = renderStateView(snapshot, emptyHarness);
    expect(view).toBe(renderStateView(snapshot, emptyHarness));
    expect(clip('short', 10)).toBe('short');
    expect(clip('a '.repeat(50), 10)).toBe('a a a a a…');
  });
});
