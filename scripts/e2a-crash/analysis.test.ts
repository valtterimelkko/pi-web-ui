/**
 * TDD tests for the E2a-6c crash-recovery harness's parsing and counting
 * logic (scripts/e2a-crash/analysis.ts). Pure functions only — no I/O, no
 * server. Run: node --import tsx --test scripts/e2a-crash/analysis.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diffTranscriptSnapshots,
  summariseDuplicates,
  summariseWatchLedger,
  diffProcessSnapshots,
  buildChildRow,
  totalsRows,
  parseTranscriptEvents,
  detectInFlightToolCall,
  type CommitRecord,
} from './analysis.ts';

// ---------------------------------------------------------------------------
// parseTranscriptEvents
// ---------------------------------------------------------------------------

test('parseTranscriptEvents extracts ordered comparable records from a transcript payload', () => {
  const payload = {
    events: [
      { type: 'message', message: { role: 'user' }, id: 'm1' },
      { type: 'message', message: { role: 'assistant' }, id: 'm2' },
      { type: 'toolCall', toolName: 'bash', id: 't1' },
      { type: 'toolResult', toolName: 'bash', id: 't1' },
      { type: 'message', message: { role: 'assistant' }, id: 'm3' },
    ],
  };
  const events = parseTranscriptEvents(payload);
  assert.equal(events.length, 5);
  assert.equal(events[2].kind, 'toolCall');
  assert.equal(events[2].toolName, 'bash');
  assert.ok(events.every((e) => e.label.length > 0));
});

test('parseTranscriptEvents tolerates missing/odd payloads', () => {
  assert.deepEqual(parseTranscriptEvents(undefined), []);
  assert.deepEqual(parseTranscriptEvents({}), []);
  assert.deepEqual(parseTranscriptEvents({ events: 'nope' }), []);
  assert.deepEqual(parseTranscriptEvents({ events: [null, 3, { type: 'message' }] }).length, 1);
});

// ---------------------------------------------------------------------------
// detectInFlightToolCall
// ---------------------------------------------------------------------------

test('detectInFlightToolCall: true when the tail is an unmatched tool call', () => {
  const events = parseTranscriptEvents({
    events: [
      { type: 'message', id: 'm1' },
      { type: 'toolCall', toolName: 'bash', id: 't9' },
    ],
  });
  assert.equal(detectInFlightToolCall(events), true);
});

test('detectInFlightToolCall: false when the call has its result or the tail is a message', () => {
  const matched = parseTranscriptEvents({
    events: [
      { type: 'toolCall', toolName: 'bash', id: 't1' },
      { type: 'toolResult', toolName: 'bash', id: 't1' },
    ],
  });
  assert.equal(detectInFlightToolCall(matched), false);

  const plain = parseTranscriptEvents({ events: [{ type: 'message', id: 'm1' }] });
  assert.equal(detectInFlightToolCall(plain), false);

  assert.equal(detectInFlightToolCall([]), false);
});

// ---------------------------------------------------------------------------
// diffTranscriptSnapshots (turns of work lost)
// ---------------------------------------------------------------------------

test('identical snapshots lose nothing', () => {
  const mk = () => parseTranscriptEvents({
    events: [
      { type: 'message', id: 'a' },
      { type: 'toolCall', id: 'b' },
      { type: 'toolResult', id: 'b' },
    ],
  });
  const diff = diffTranscriptSnapshots(mk(), mk());
  assert.equal(diff.lostCount, 0);
  assert.equal(diff.newCount, 0);
  assert.equal(diff.retainedCount, 3);
});

test('a crash that truncates the tail counts the tail as lost, per kind', () => {
  const before = parseTranscriptEvents({
    events: [
      { type: 'message', id: 'a' },
      { type: 'toolCall', id: 'b', toolName: 'bash' },
      { type: 'toolResult', id: 'b' },
      { type: 'message', id: 'c' },
      { type: 'toolCall', id: 'd', toolName: 'edit' },
    ],
  });
  // Server died mid toolCall d: recovery rewrote the transcript without c and d.
  const after = parseTranscriptEvents({
    events: [
      { type: 'message', id: 'a' },
      { type: 'toolCall', id: 'b', toolName: 'bash' },
      { type: 'toolResult', id: 'b' },
    ],
  });
  const diff = diffTranscriptSnapshots(before, after);
  assert.equal(diff.lostCount, 2);
  assert.equal(diff.lostKinds['message'], 1);
  assert.equal(diff.lostKinds['toolCall'], 1);
  assert.equal(diff.newCount, 0);
  assert.ok(diff.lostExamples.length >= 1);
});

test('events lost then re-done count as lost AND new (divergence point semantics)', () => {
  const before = parseTranscriptEvents({
    events: [{ type: 'message', id: 'a' }, { type: 'toolCall', id: 'x' }],
  });
  const after = parseTranscriptEvents({
    events: [{ type: 'message', id: 'a' }, { type: 'toolCall', id: 'y' }, { type: 'toolResult', id: 'y' }],
  });
  const diff = diffTranscriptSnapshots(before, after);
  assert.equal(diff.lostCount, 1);
  assert.equal(diff.newCount, 2);
  assert.equal(diff.retainedCount, 1);
});

// ---------------------------------------------------------------------------
// summariseDuplicates (side effects done twice)
// ---------------------------------------------------------------------------

test('duplicate progress lines and commit subjects are counted with examples', () => {
  const commits: CommitRecord[] = [
    { hash: 'h1', subject: 'feat: slugify' },
    { hash: 'h2', subject: 'feat: slugify' },
    { hash: 'h3', subject: 'test: slugify' },
  ];
  const report = summariseDuplicates({
    progressLines: ['step: tests', 'step: tests', 'step: build'],
    commits,
    buildRuns: [{ label: 'build@t1' }, { label: 'build@t2' }],
  });
  assert.equal(report.duplicateProgressLines, 1); // 'step: tests' appears twice → 1 duplicated line text
  assert.deepEqual(report.duplicateProgressExamples, ['step: tests']);
  assert.equal(report.duplicateCommitSubjects, 1);
  assert.deepEqual(report.duplicateCommitExamples, ['feat: slugify']);
  assert.equal(report.buildRunCount, 2);
  assert.equal(report.totalDuplicateEvents, 2); // 1 dup progress + 1 dup commit
});

test('all-unique side effects report zero duplicates', () => {
  const report = summariseDuplicates({
    progressLines: ['a', 'b', 'c'],
    commits: [{ hash: 'h1', subject: 'one' }],
    buildRuns: [{ label: 'build@t1' }],
  });
  assert.equal(report.duplicateProgressLines, 0);
  assert.equal(report.duplicateCommitSubjects, 0);
  assert.equal(report.totalDuplicateEvents, 0);
});

// ---------------------------------------------------------------------------
// summariseWatchLedger (what the parent's watch saw)
// ---------------------------------------------------------------------------

test('watch ledger summary flags goal_end and interruptedByRestart', () => {
  const ledger = {
    watchId: 'w1',
    sessionId: 's1',
    firings: [
      { conditionId: 'c0', eventType: 'goal_end', at: 't1', data: { interruptedByRestart: true } },
      { conditionId: 'c1', eventType: 'agent_end', at: 't2' },
    ],
  };
  const s = summariseWatchLedger(ledger);
  assert.equal(s.sawGoalEnd, true);
  assert.equal(s.sawInterruptedByRestart, true);
  assert.equal(s.firingCount, 2);
  assert.ok(s.firingKinds.includes('agent_end'));
});

test('watch ledger summary is honest when the watch saw nothing', () => {
  const s = summariseWatchLedger({ watchId: 'w2', sessionId: 's2', firings: [] });
  assert.equal(s.sawGoalEnd, false);
  assert.equal(s.sawInterruptedByRestart, false);
  assert.equal(s.firingCount, 0);
  assert.deepEqual(s.firingKinds, []);
  assert.equal(summariseWatchLedger(undefined).firingCount, 0);
});

// ---------------------------------------------------------------------------
// diffProcessSnapshots (orphaned tool processes)
// ---------------------------------------------------------------------------

test('process snapshot diff finds children-owned processes that outlived the server', () => {
  const before = [
    { pid: 100, cmd: 'node server', owner: 'server' },
    { pid: 201, cmd: 'npm test', owner: 'child-c1' },
  ];
  const after = [
    { pid: 100, cmd: 'node server', owner: 'server' },
    { pid: 201, cmd: 'npm test', owner: 'child-c1' },
  ];
  const diff = diffProcessSnapshots(before, after, new Set([100]));
  assert.deepEqual(diff.orphanPids, [201]);
  assert.equal(diff.orphansAtKill, 1);
});

test('orphan fate is classified against a later snapshot', () => {
  const before = [{ pid: 201, cmd: 'npm test', owner: 'child-c1' }];
  const after = [{ pid: 201, cmd: 'npm test', owner: 'child-c1' }];
  const later: Array<{ pid: number; cmd: string; owner: string }> = [];
  const first = diffProcessSnapshots(before, after, new Set());
  const fate = diffProcessSnapshots(first.orphanPids.map((pid) => ({ pid, cmd: 'npm test', owner: 'child-c1' })), later, new Set());
  assert.deepEqual(fate.orphanPids, []);
  assert.equal(fate.orphansAtKill, 0);
  // pids from the first snapshot that are gone in the later snapshot:
  assert.equal(fate.gonePids.length, 1);
});

// ---------------------------------------------------------------------------
// buildChildRow + totalsRows
// ---------------------------------------------------------------------------

test('buildChildRow derives the per-child record and totalsRows reconciles', () => {
  const row = buildChildRow({
    childId: 'c1',
    arm: 'kill',
    transcriptDiff: diffTranscriptSnapshots(
      parseTranscriptEvents({ events: [{ type: 'message', id: 'a' }, { type: 'toolCall', id: 'b' }] }),
      parseTranscriptEvents({ events: [{ type: 'message', id: 'a' }] }),
    ),
    secondsToWorking: 120,
    parentAction: null,
    duplicates: summariseDuplicates({ progressLines: ['x', 'x'], commits: [], buildRuns: [] }),
    orphans: { orphansAtKill: 1, orphanPids: [201], gonePids: [201] },
    finalOutcome: 'goal_achieved',
    receiptState: 'success',
    watch: summariseWatchLedger({ firings: [{ eventType: 'goal_end', data: {} }] }),
  });
  assert.equal(row.childId, 'c1');
  assert.equal(row.turnsLost, 1);
  assert.equal(row.parentActionNeeded, false);
  assert.equal(row.duplicateSideEffects.totalDuplicateEvents, 1);

  const row2 = buildChildRow({
    childId: 'c2',
    arm: 'kill',
    transcriptDiff: { lostCount: 0, lostKinds: {}, retainedCount: 5, newCount: 3, newKinds: {}, lostExamples: [], lostToolCalls: [] },
    secondsToWorking: null,
    parentAction: 'follow-up-prompt',
    duplicates: summariseDuplicates({ progressLines: [], commits: [], buildRuns: [] }),
    orphans: { orphansAtKill: 0, orphanPids: [], gonePids: [] },
    finalOutcome: 'stuck',
    receiptState: 'RUN_TRANSPORT_LOST',
    watch: summariseWatchLedger({ firings: [] }),
  });
  assert.equal(row2.parentActionNeeded, true);

  const totals = totalsRows([row, row2]);
  assert.equal(totals.children, 2);
  assert.equal(totals.turnsLost, 1);
  assert.equal(totals.workedWithoutParentAction, 1);
  assert.equal(totals.neededParentAction, 1);
  assert.equal(totals.duplicateSideEffectEvents, 1);
  assert.equal(totals.orphanProcesses, 1);
});
