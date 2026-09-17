/**
 * L0 record / offline-verifier tests — the L0 verification gate.
 *
 * The gate is explicit: unit tests with deliberately damaged traces must FAIL
 * the verifier, and a clean control trace must pass. Four damage classes are
 * exercised, each on a record whose hashes are internally consistent (the log
 * is damaged as if a faulty driver produced it), so the verifier must catch a
 * *content* defect and not merely a hash mismatch:
 *
 *   - missing usage record
 *   - dropped input frames
 *   - out-of-order sequence numbers
 *   - leaked golden (hidden-truth) text
 *
 * A separate case proves tampering after finalisation is caught by the hash.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EVENT, type LabEvent } from '../../../scripts/voice-live-lab/lib/scheduler.js';
import {
  RECORD_SCHEMA_VERSION,
  LAB_VERSION,
  attemptDirFor,
  collectArtifacts,
  createAttempt,
  finaliseAttempt,
  nextAttemptId,
  verifyAttempt,
  type AttemptManifest,
} from '../../../scripts/voice-live-lab/lib/record.js';

const GOLDEN = 'the amber lanterns hang above the quiet harbour';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'voice-live-record-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function baseEvents(): LabEvent[] {
  return [
    { seq: 1, tMs: 0, source: 'input', kind: EVENT.INPUT_FRAME, id: 'f1', payload: { index: 0, bytes: 640 } },
    { seq: 2, tMs: 20, source: 'input', kind: EVENT.INPUT_FRAME, id: 'f2', payload: { index: 1, bytes: 640 } },
    { seq: 3, tMs: 40, source: 'input', kind: EVENT.INPUT_FRAME, id: 'f3', payload: { index: 2, bytes: 640 } },
    { seq: 4, tMs: 200, source: 'provider', kind: EVENT.PROVIDER_CONTENT, id: 'c1', payload: { text: 'acknowledged' } },
    { seq: 5, tMs: 260, source: 'provider', kind: EVENT.PROVIDER_USAGE, id: 'u1', payload: { totalTokenCount: 42 } },
    { seq: 6, tMs: 300, source: 'player', kind: EVENT.PLAYBACK_RENDERED, id: 'r1', payload: { bytes: 1280 } },
  ];
}

function renumber(events: LabEvent[]): LabEvent[] {
  return events.map((event, index) => ({ ...event, seq: index + 1 }));
}

function createRecord(): string {
  const layout = createAttempt(root, 'run-l0', 't1/fake/E-native-duck/world', 'attempt-01');
  return layout.attemptDir;
}

function writeEvents(attemptDir: string, events: LabEvent[]): void {
  writeFileSync(
    path.join(attemptDir, 'application', 'events.jsonl'),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
  );
}

function baseManifest(): AttemptManifest {
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    labVersion: LAB_VERSION,
    runId: 'run-l0',
    condition: 't1/fake/E-native-duck/world',
    attemptId: 'attempt-01',
    createdAt: new Date().toISOString(),
    input: { sourceId: 'u0', declaredFrames: 3, declaredBytes: 1920, frameBytes: 640 },
    requiredEventKinds: [EVENT.INPUT_FRAME, EVENT.PROVIDER_USAGE],
    goldenStrings: [GOLDEN],
  };
}

describe('attempt layout', () => {
  it('creates the documented subdirectories once and refuses to reuse a path', () => {
    const layout = createAttempt(root, 'run-l0', 'cond-a', 'attempt-01');
    for (const sub of ['input', 'provider', 'application', 'capture', 'evaluation']) {
      expect(existsSync(path.join(layout.attemptDir, sub))).toBe(true);
    }
    expect(() => createAttempt(root, 'run-l0', 'cond-a', 'attempt-01')).toThrow(/already exists/);
    expect(nextAttemptId(root, 'run-l0', 'cond-a')).toBe('attempt-02');
  });

  it('refuses to write into the canonical checkout', () => {
    expect(() => createAttempt('/root/pi-web-ui', 'run-l0', 'cond-a', 'attempt-01')).toThrow(
      /protected path/
    );
  });
});

describe('offline verifier', () => {
  it('passes a clean control trace and reports its checks', () => {
    const attemptDir = createRecord();
    writeEvents(attemptDir, baseEvents());
    writeFileSync(path.join(attemptDir, 'provider', 'script.json'), JSON.stringify({ model: 'fake-live' }));
    finaliseAttempt(attemptDir, baseManifest());

    const outcome = verifyAttempt(attemptDir);
    expect(outcome.problems).toEqual([]);
    expect(outcome.ok).toBe(true);
    expect(outcome.lines.join('\n')).toMatch(/dense seq/);
  });

  it('fails when the usage record is missing', () => {
    const attemptDir = createRecord();
    const events = renumber(baseEvents().filter((event) => event.kind !== EVENT.PROVIDER_USAGE));
    writeEvents(attemptDir, events);
    finaliseAttempt(attemptDir, baseManifest());

    const outcome = verifyAttempt(attemptDir);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join('\n')).toMatch(/required event kind missing: provider_usage/);
  });

  it('fails when input frames were dropped', () => {
    const attemptDir = createRecord();
    const events = renumber(baseEvents().filter((event) => event.id !== 'f2'));
    writeEvents(attemptDir, events);
    finaliseAttempt(attemptDir, baseManifest());

    const outcome = verifyAttempt(attemptDir);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join('\n')).toMatch(/dropped frames/);
  });

  it('fails when the sequence is not dense', () => {
    const attemptDir = createRecord();
    const events = baseEvents();
    const swapped = [events[0], events[1], events[2], events[3], events[4], events[5]];
    swapped[4] = { ...swapped[4], seq: 99 };
    writeEvents(attemptDir, swapped);
    finaliseAttempt(attemptDir, baseManifest());

    const outcome = verifyAttempt(attemptDir);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join('\n')).toMatch(/not dense/);
  });

  it('fails when golden text leaks into the trace', () => {
    const attemptDir = createRecord();
    const events = baseEvents();
    events[3] = { ...events[3], payload: { text: `context included: ${GOLDEN}` } };
    writeEvents(attemptDir, events);
    finaliseAttempt(attemptDir, baseManifest());

    const outcome = verifyAttempt(attemptDir);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join('\n')).toMatch(/golden text leaked/);
  });

  it('fails when golden text leaks into a provider artefact', () => {
    const attemptDir = createRecord();
    writeEvents(attemptDir, baseEvents());
    writeFileSync(path.join(attemptDir, 'provider', 'context.json'), JSON.stringify({ hint: GOLDEN }));
    finaliseAttempt(attemptDir, baseManifest());

    const outcome = verifyAttempt(attemptDir);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join('\n')).toMatch(/golden text leaked/);
  });

  it('fails when a finalised artefact is tampered with afterwards', () => {
    const attemptDir = createRecord();
    writeEvents(attemptDir, baseEvents());
    finaliseAttempt(attemptDir, baseManifest());

    const logFile = path.join(attemptDir, 'application', 'events.jsonl');
    writeFileSync(logFile, `${readFileSync(logFile, 'utf8')}{"seq":7}\n`);

    const outcome = verifyAttempt(attemptDir);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join('\n')).toMatch(/artifact (hash|size) mismatch|not valid JSON/);
  });

  it('fails an unfinalised record when finalisation is required', () => {
    const attemptDir = createRecord();
    writeEvents(attemptDir, baseEvents());
    // No finaliseAttempt call.
    const outcome = verifyAttempt(attemptDir, { requireFinalised: true });
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join('\n')).toMatch(/not finalised|missing manifest/);
  });

  it('refuses to overwrite an immutable manifest', () => {
    const attemptDir = createRecord();
    writeEvents(attemptDir, baseEvents());
    finaliseAttempt(attemptDir, baseManifest());
    expect(() => finaliseAttempt(attemptDir, baseManifest())).toThrow(/immutable manifest/);
  });

  it('hashes every artefact it is asked to trust', () => {
    const attemptDir = createRecord();
    writeEvents(attemptDir, baseEvents());
    writeFileSync(path.join(attemptDir, 'capture', 'rendered.pcm'), Buffer.from([1, 2, 3, 4]));
    finaliseAttempt(attemptDir, baseManifest());
    const artifacts = collectArtifacts(attemptDir);
    expect(artifacts.map((artifact) => artifact.relativePath)).toContain('capture/rendered.pcm');
    for (const artifact of artifacts) expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resolves the documented attempt path helper', () => {
    expect(attemptDirFor(root, 'run-l0', 'cond-a', 'attempt-01')).toBe(
      path.join(root, 'runs', 'run-l0', 'cond-a', 'attempt-01')
    );
  });
});
