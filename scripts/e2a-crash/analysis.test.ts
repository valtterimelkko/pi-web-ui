/**
 * TDD tests for the E2a-6c crash-recovery harness's parsing and counting
 * logic (scripts/e2a-crash/analysis.ts). Pure functions only — no I/O, no
 * server. Run: node --import tsx --test scripts/e2a-crash/analysis.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const TESTDATA = path.join(__dirname, 'testdata');

function lastLine(lines: string[]): string {
  return lines.filter((l) => l.trim().length > 0).slice(-1)[0] ?? '';
}
import {
  diffTranscriptSnapshots,
  type ChildOutcomeRow,
  summariseWatchLedger,
  diffProcessSnapshots,
  buildChildRow,
  totalsRows,
  parseTranscriptEvents,
  parseRawSessionJsonl,
  detectInFlightToolCall,
  drainRequestTimeoutMs,
  firstWorkingAfterReadiness,
  classifyWindowEnd,
  summariseDuplicatesByStepId,
  buildOperationLedgerEntry,
  type CommitRecord,
} from './analysis.ts';

// ---------------------------------------------------------------------------
// drainRequestTimeoutMs (08-parent-note): the Internal API POST /drain BLOCKS
// until its verdict (settled | timed_out after timeoutSeconds) — the client's
// request timeout must exceed the server's drain timeout by a healthy margin,
// never the other way round.
// ---------------------------------------------------------------------------

test('drain request timeout exceeds the server drain timeout with margin', () => {
  assert.equal(drainRequestTimeoutMs(45), 75_000);
  assert.equal(drainRequestTimeoutMs(600), 630_000);
  assert.ok(drainRequestTimeoutMs(45) > 45_000, 'client timeout must exceed the 45 s verdict window (run of 03:46Z failed at 30 s)');
});

// ---------------------------------------------------------------------------
// parseRawSessionJsonl (the arm's primary evidence: the child's raw session file)
// ---------------------------------------------------------------------------

const RAW_SAMPLE = [
  JSON.stringify({ type: 'session', id: 's1' }),
  JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Goal: ...' }] } }),
  JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'thinking' }, { type: 'text', text: 'plan' }, { type: 'toolCall', id: 'call_a', name: 'bash', arguments: { command: 'ls' } }] } }),
  JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: 'call_a', toolName: 'bash', content: [{ type: 'text', text: 'out' }] } }),
  JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call_b', name: 'write', arguments: {} }] } }),
  'not json at all',
].join('\n');

test('parseRawSessionJsonl extracts tool calls/results with ids and tolerates junk lines', () => {
  const events = parseRawSessionJsonl(RAW_SAMPLE.split('\n'));
  // user, assistant (text flushed before its toolCall), toolCall_a, toolResult_a, toolCall_b
  assert.equal(events.length, 5);
  assert.equal(events[0].kind, 'user');
  assert.equal(events[1].kind, 'assistant');
  assert.equal(events[2].kind, 'toolCall');
  assert.equal(events[2].toolName, 'bash');
  assert.equal(events[2].callId, 'call_a');
  assert.equal(events[3].kind, 'toolResult');
  assert.equal(events[3].callId, 'call_a');
  assert.equal(events[4].kind, 'toolCall');
  assert.equal(events[4].toolName, 'write');
  assert.equal(detectInFlightToolCall(events), true); // call_b has no result yet
});

test('parseRawSessionJsonl: empty and garbage inputs yield empty', () => {
  assert.deepEqual(parseRawSessionJsonl([]), []);
  assert.deepEqual(parseRawSessionJsonl(['{broken']), []);
});

// ---------------------------------------------------------------------------
// 09-correction item 4: SYNTHETIC fixture (the raw run-4 excerpt was removed
// from the branch). Same record shapes: a trailing in-flight toolCall (A), and
// the same with its toolResult appended (B).
// ---------------------------------------------------------------------------

const EXCERPT_A = path.join(TESTDATA, 'synthetic-session-excerpt.jsonl');
const EXCERPT_B = path.join(TESTDATA, 'synthetic-session-excerpt-with-result.jsonl');

test('synthetic excerpt: trailing in-flight toolCall is detected', () => {
  const lines = readFileSync(EXCERPT_A, 'utf8').split('\n');
  const events = parseRawSessionJsonl(lines);
  assert.ok(events.length > 0);
  const last = JSON.parse(lastLine(lines));
  const call = (last.message.content as Array<{ type: string; id?: string; name?: string }>).find((c) => c.type === 'toolCall');
  assert.ok(call, 'excerpt must end at a toolCall line');
  const tail = events[events.length - 1];
  assert.equal(tail.kind, 'toolCall');
  assert.equal(tail.callId, call.id);
  assert.equal(tail.toolName, call.name);
  assert.equal(detectInFlightToolCall(events), true);
});

test('synthetic excerpt + its toolResult: no longer in flight', () => {
  const lines = readFileSync(EXCERPT_B, 'utf8').split('\n');
  const events = parseRawSessionJsonl(lines);
  assert.equal(detectInFlightToolCall(events), false);
  assert.ok(events.some((e) => e.kind === 'toolResult' && e.callId === 'call_synthetic0001'));
});
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
    promptToWorkSeconds: null,
    workedAfterReadiness: true,
    silentStall: false,
    parentAction: null,
    duplicateByStep: summariseDuplicatesByStepId(
      [{ hash: 'h1', subject: 'feat: slugify', files: ['test/slug.test.ts'] }, { hash: 'h2', subject: 'redo', files: ['test/slug.test.ts'] }],
      [],
      ['slugify', 'initials', 'maskEmail', 'build'],
    ),
    orphans: { orphansAtKill: 1, orphanPids: [201], gonePids: [201] },
    finalOutcome: 'goal_achieved',
    receiptState: 'success',
    watch: summariseWatchLedger({ firings: [{ eventType: 'goal_end', data: {} }] }),
  });
  assert.equal(row.childId, 'c1');
  assert.equal(row.turnsLost, 1);
  assert.equal(row.parentActionNeeded, false);
  assert.equal(row.duplicateByStep.byStepId['slugify'], 1);

  const row2 = buildChildRow({
    childId: 'c2',
    arm: 'kill',
    transcriptDiff: { lostCount: 0, lostKinds: {}, retainedCount: 5, newCount: 3, newKinds: {}, lostExamples: [], lostToolCalls: [] },
    secondsToWorking: null,
    promptToWorkSeconds: null,
    workedAfterReadiness: false,
    silentStall: true,
    parentAction: 'follow-up-prompt',
    duplicateByStep: summariseDuplicatesByStepId([], [], ['slugify', 'initials', 'maskEmail', 'build']),
    orphans: { orphansAtKill: 0, orphanPids: [], gonePids: [] },
    finalOutcome: 'stuck',
    receiptState: 'RUN_TRANSPORT_LOST',
    watch: summariseWatchLedger({ firings: [] }),
  });
  assert.equal(row2.parentActionNeeded, true);
  assert.equal(row2.silentStall, true);

  const totals = totalsRows([row, row2]);
  assert.equal(totals.children, 2);
  assert.equal(totals.turnsLost, 1);
  assert.equal(totals.workedWithoutParentAction, 1);
  assert.equal(totals.neededParentAction, 1);
  assert.equal(totals.silentStalls, 1);
  assert.equal(totals.duplicateCommits, 1);
  assert.equal(totals.orphanProcesses, 1); // union of pids: rows may repeat the same anchor-wide snapshot
});

test('totalsRows: anchor-wide orphan snapshots are deduplicated by pid union, never summed', () => {
  const mk = (id: string): ChildOutcomeRow => ({
    childId: id, arm: 'kill',
    turnsLost: 0, toolResultsLost: 0, editsLost: 0, newAfterRecovery: 0, promptToWorkSeconds: null,
    secondsToWorking: null, workedAfterReadiness: false, silentStall: false,
    parentActionNeeded: false, parentAction: null,
    duplicateByStep: summariseDuplicatesByStepId([], [], ['slugify', 'initials', 'maskEmail', 'build']),
    orphans: { orphansAtKill: 2, orphanPids: [10, 11], gonePids: [] },
    finalOutcome: 'unknown', receiptState: 'none',
    watch: summariseWatchLedger({ firings: [] }),
  });
  const totals = totalsRows([mk('a'), mk('b')]);
  assert.equal(totals.orphanProcesses, 2, 'same two pids repeated in both rows -> 2, not 4');
});

// ---------------------------------------------------------------------------
// 09-correction item 1: readiness-gated "working after restart".
// Work after the interruption counts ONLY when its timestamp is after the
// restarted API was ready; the harness's own probe supplies that instant.
// ---------------------------------------------------------------------------

const T0 = 1_800_000_000_000;

function rawLine(kind: 'user' | 'assistant' | 'toolResult', ts: number, tool?: { id: string; name: string }): string {
  if (kind === 'assistant' && tool) {
    return JSON.stringify({ type: 'message', message: { role: 'assistant', timestamp: ts, content: [{ type: 'text', text: 'x' }, { type: 'toolCall', id: tool.id, name: tool.name, arguments: {} }] } });
  }
  if (kind === 'toolResult' && tool) {
    return JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: tool.id, toolName: tool.name, timestamp: ts, content: [{ type: 'text', text: 'out' }] } });
  }
  return JSON.stringify({ type: 'message', message: { role: kind, timestamp: ts, content: [{ type: 'text', text: 'x' }] } });
}

test('firstWorkingAfterReadiness: work recorded BEFORE readiness is not recovery (the drain-arm bug)', () => {
  // All events happen during the drain, before the API was ready.
  const events = parseRawSessionJsonl([
    rawLine('user', T0),
    rawLine('assistant', T0 + 20_000, { id: 'call_during', name: 'bash' }),
    rawLine('toolResult', T0 + 30_000, { id: 'call_during', name: 'bash' }),
  ]);
  const r = firstWorkingAfterReadiness(events, T0 + 60_000);
  assert.equal(r.working, false, 'work before readiness must NOT count as recovery (09 finding 1)');
  assert.equal(r.firstEventAtMs, null);
});

test('firstWorkingAfterReadiness: a tool call after readiness is recovery, with its exact time', () => {
  const events = parseRawSessionJsonl([
    rawLine('user', T0),
    rawLine('assistant', T0 + 20_000, { id: 'call_during', name: 'bash' }),
    rawLine('toolResult', T0 + 30_000, { id: 'call_during', name: 'bash' }),
    rawLine('assistant', T0 + 70_000, { id: 'call_after', name: 'bash' }),
  ]);
  const r = firstWorkingAfterReadiness(events, T0 + 60_000);
  assert.equal(r.working, true);
  assert.equal(r.firstEventAtMs, T0 + 70_000);
});

test('firstWorkingAfterReadiness: assistant text after readiness counts as a resumed turn, tool-less', () => {
  const events = parseRawSessionJsonl([
    rawLine('user', T0),
    rawLine('assistant', T0 + 90_000),
  ]);
  const r = firstWorkingAfterReadiness(events, T0 + 60_000);
  assert.equal(r.working, true);
  assert.equal(r.firstEventAtMs, T0 + 90_000, 'the assistant record itself is the child event (13 item 1)');
});

// ---------------------------------------------------------------------------
// 09-correction item 3: duplicates per normalised step id, measured from
// evidence the harness owns (commits mapped to steps by FILES TOUCHED, and a
// harness-owned append-only operation ledger) — not from child-writable
// whole-line text or commit subjects.
// ---------------------------------------------------------------------------

test('duplicates by step id: repeated execution of a step (second commit touching its files) is counted', () => {
  const commits: Array<CommitRecord & { files: string[] }> = [
    { hash: 'a1', subject: 'feat: slugify with tests', files: ['test/slug.test.ts', 'src/lib/slug.ts'] },
    { hash: 'a2', subject: 'feat: initials with tests', files: ['test/initials.test.ts', 'src/lib/initials.ts'] },
    { hash: 'a3', subject: 'redo slugify after crash', files: ['test/slug.test.ts', 'src/lib/slug.ts'] },
  ];
  const r = summariseDuplicatesByStepId(commits, [], ['slugify', 'initials', 'maskEmail', 'build']);
  assert.equal(r.byStepId['slugify'], 1, 'two slugify commits = 1 duplicated execution');
  assert.equal(r.byStepId['initials'], 0);
  assert.equal(r.byStepId['maskEmail'], 0);
  assert.equal(r.totalDuplicateCommits, 1);
});

test('duplicates by step id: build re-runs are counted from the harness-owned ledger, not the child', () => {
  const ledger = [
    buildOperationLedgerEntry('c1', T0, { buildInfoHash: 'h1' }),
    buildOperationLedgerEntry('c1', T0 + 5_000, { buildInfoHash: 'h1' }),
    buildOperationLedgerEntry('c1', T0 + 9_000, { buildInfoHash: 'h2' }),
  ];
  const r = summariseDuplicatesByStepId([], ledger, ['slugify', 'initials', 'maskEmail', 'build']);
  assert.equal(r.buildRuns, 2, 'h1 and h2 are two distinct observed builds; identical repeat is one build');
});

test('duplicates by step id: progress-log text is reported unmeasured, never as 0', () => {
  const r = summariseDuplicatesByStepId([], [], ['slugify', 'initials', 'maskEmail', 'build']);
  assert.equal(r.unmeasuredClasses.includes('progress-log-lines'), true, 'child-writable progress text is unmeasured by design');
  assert.equal(r.totalDuplicateCommits, 0);
});

// ---------------------------------------------------------------------------
// 13-final-correction item 1: the post-action metric counts the CHILD'S OWN
// work only — the first ASSISTANT message or TOOL CALL after the reference
// point. User, system and tool-result records never count, and there is no
// Date.now()/polling-time fallback: no qualifying event = not working.
// ---------------------------------------------------------------------------

test('firstChildWorkAfter: a post-reference USER record (the parent prompt echo) is not work', () => {
  const events = parseRawSessionJsonl([
    rawLine('user', T0),
    rawLine('user', T0 + 60_000), // the follow-up prompt lands as a user record
  ]);
  const r = firstWorkingAfterReadiness(events, T0 + 30_000);
  assert.equal(r.working, false, 'a user record is not the child\'s own work (13 item 1)');
  assert.equal(r.firstEventAtMs, null);
});

test('firstChildWorkAfter: assistant or tool event after the reference counts, with its own timestamp', () => {
  const events = parseRawSessionJsonl([
    rawLine('user', T0),
    rawLine('assistant', T0 + 78_650, { id: 'call_1', name: 'bash' }),
    rawLine('toolResult', T0 + 80_000, { id: 'call_1', name: 'bash' }),
  ]);
  const r = firstWorkingAfterReadiness(events, T0 + 30_000);
  assert.equal(r.working, true);
  assert.equal(r.firstEventAtMs, T0 + 78_650, 'event timestamp, never polling time');
});

test('firstChildWorkAfter: tool results alone after the reference never count', () => {
  const events = parseRawSessionJsonl([
    rawLine('user', T0),
    rawLine('assistant', T0 + 10_000, { id: 'call_pre', name: 'bash' }),
    rawLine('toolResult', T0 + 70_000, { id: 'call_pre', name: 'bash' }),
  ]);
  const r = firstWorkingAfterReadiness(events, T0 + 30_000);
  assert.equal(r.working, false, 'a late tool result belongs to pre-reference work');
  assert.equal(r.firstEventAtMs, null);
});

test('classifyWindowEnd: goal running + idle + no qualifying work = silent stall at the boundary', () => {
  assert.equal(classifyWindowEnd('running', false, false), true);
  assert.equal(classifyWindowEnd('running', true, false), false, 'busy is working, not stalled');
  assert.equal(classifyWindowEnd('running', false, true), false, 'qualifying work in the window is recovery, not stall');
  assert.equal(classifyWindowEnd('paused', false, false), false, 'a paused goal is a different outcome');
});

// ---------------------------------------------------------------------------
// 13 item 5: the harness operation ledger must be appended in the WORK phase,
// the POST-RESTART observation loop and the POST-PROMPT observation loop —
// not only before the interruption (the r2 review's 'sampled only before
// interruption' finding).
// ---------------------------------------------------------------------------

test('operation ledger is appended in all three phases of both arms', () => {
  const src = readFileSync('/root/.worktrees/orch-scaling/e2-a6c-pi-web-ui/scripts/e2a-crash/driver.ts', 'utf8');
  const count = (src.match(/appendOperationLedger\(paths, '/g) ?? []).length;
  assert.ok(count >= 3, `appendOperationLedger must be called in work + no-action + post-action loops (found ${count} arm-phase call sites)`);
  for (const arm of ['kill', 'drain-timeout']) {
    assert.ok(src.includes(`appendOperationLedger(paths, '${arm}'`), `missing ledger call for arm ${arm}`);
  }
});
