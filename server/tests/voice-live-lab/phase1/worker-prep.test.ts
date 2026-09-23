/**
 * W4 worker-session preparation harness (seams C22 + C24): the busy drive for
 * the parking family and the two-real-session preparation for the attachment
 * family. Both go through REAL Internal API paths — a real prompt to the
 * journey's worker session, real session creation — never a fabricated busy
 * flag or a fabricated target.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { loadCorpus, withValidatorOverlays } from '../../../../scripts/voice-lane-lab/lib/corpus.js';
import {
  BUSY_DRIVE_PROMPT,
  BUSY_HOLD_MS,
  BUSY_MAX_PROMPTS,
  SECOND_WORKER_DISPLAY_NAMES,
  driveWorkerBusy,
  journeyRequiresBusyDrive,
  journeyRequiresSecondWorker,
  prepareTwoWorkerSessions,
  setSessionDisplayName,
  type InternalApiCall,
  type SessionListRow,
} from '../../../../scripts/voice-lane-lab/lib/worker-prep.js';

const corpusDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../../scripts/voice-lane-lab/corpus');
const corpus = loadCorpus();
const dirs: string[] = [];
afterEach(() => dirs.splice(0));

const turnsWith = (kinds: string[]): Array<{ kind: string }> => kinds.map((kind) => ({ kind }));

/** A scripted Internal API caller over an in-memory session table. */
function scriptedCall(initialRows: SessionListRow[], handler?: (apiPath: string, options?: { method?: string; body?: unknown }) => { status: number; body: string } | null): { call: InternalApiCall; rows: SessionListRow[]; posts: Array<{ apiPath: string; body: unknown }> } {
  const rows = initialRows;
  const posts: Array<{ apiPath: string; body: unknown }> = [];
  const call: InternalApiCall = async (apiPath, options = {}) => {
    if (apiPath === '/api/v1/sessions' && (options.method ?? 'GET') === 'GET') {
      return { status: 200, body: JSON.stringify({ sessions: rows }) };
    }
    if (options.method === 'POST') {
      posts.push({ apiPath, body: options.body });
      const result = handler?.(apiPath, options as { method?: string; body?: unknown }) ?? { status: 200, body: '{}' };
      return result;
    }
    return { status: 200, body: '{}' };
  };
  return { call, rows, posts };
}

describe('journey requirement detection from the merged plan', () => {
  it('requires the busy drive exactly when the plan carries an adaptive-promote turn (C22 shape)', () => {
    expect(journeyRequiresBusyDrive(turnsWith(['opening', 'adaptive-promote', 'adaptive-confirm']))).toBe(true);
    expect(journeyRequiresBusyDrive(turnsWith(['opening', 'adaptive-confirm']))).toBe(false);
  });

  it('requires a second worker exactly when the plan carries an adaptive-switch turn (C24 shape)', () => {
    expect(journeyRequiresSecondWorker(turnsWith(['opening', 'adaptive-switch']))).toBe(true);
    expect(journeyRequiresSecondWorker(turnsWith(['opening', 'adaptive-confirm']))).toBe(false);
  });
});

describe('the busy drive (C22 prerequisite)', () => {
  it('prompts the journey\'s NEW worker session through the Internal API and waits until it reports busy AND holds', async () => {
    const before = [{ sessionId: 'older-1', busy: false }];
    const { call, rows, posts } = scriptedCall([...before, { sessionId: 'journey-worker', busy: false }], (apiPath) => {
      if (apiPath === '/api/v1/sessions/journey-worker/prompt') {
        // The real prompt execution flips the session's live status.
        const row = rows.find((candidate) => candidate.sessionId === 'journey-worker');
        if (row) row.busy = true;
        return { status: 202, body: '{"accepted":true}' };
      }
      return { status: 404, body: '{}' };
    });
    const record = await driveWorkerBusy(call, before.map((row) => String(row.sessionId)), { holdWatchMs: 2_200 });
    expect(record).toMatchObject({ workerSessionId: 'journey-worker', promptsSent: 1, busyObserved: true });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.apiPath).toBe('/api/v1/sessions/journey-worker/prompt');
    // The busy state is genuine work: the prompt makes the runtime execute a
    // real command; it is detached so the journey never waits on the sleep.
    expect(posts[0]!.body).toMatchObject({ message: BUSY_DRIVE_PROMPT, detach: true });
    expect(BUSY_DRIVE_PROMPT).toContain('sleep 75');
    expect(BUSY_DRIVE_PROMPT).toContain('shell tool');
    expect(BUSY_HOLD_MS).toBeGreaterThanOrEqual(60_000);
    expect(BUSY_MAX_PROMPTS).toBeGreaterThanOrEqual(4);
  });

  it('re-prompts when the busy state collapses — a model that answers without running the command ends its turn in ~1 s (the attempt-02 failure)', async () => {
    const before = [{ sessionId: 'older-1' }];
    let busyObservations = 0;
    const { call, rows, posts } = scriptedCall([...before, { sessionId: 'w', busy: false }], () => {
      // First prompt: the runtime flips busy, then ends the turn immediately
      // (agent_end → idle). The second prompt holds.
      const row = rows.find((candidate) => candidate.sessionId === 'w');
      if (posts.length === 2 && row) row.busy = true;
      else if (row) row.busy = true;
      return { status: 202, body: '{"accepted":true}' };
    });
    // Collapse the first busy state right after phase 1 first observes it.
    const wrapped: InternalApiCall = async (apiPath, options) => {
      const result = await call(apiPath, options);
      if (apiPath === '/api/v1/sessions' && (options?.method ?? 'GET') === 'GET') {
        const row = rows.find((candidate) => candidate.sessionId === 'w');
        if (row?.busy) {
          busyObservations += 1;
          if (busyObservations === 1) row.busy = false;
        }
      }
      return result;
    };
    const record = await driveWorkerBusy(wrapped, before.map((row) => String(row.sessionId)), { holdWatchMs: 2_200 });
    expect(record.promptsSent).toBe(2);
    expect(posts.filter((post) => post.apiPath.endsWith('/prompt'))).toHaveLength(2);
  });

  it('refuses when the busy state keeps collapsing and the prompt budget is exhausted', async () => {
    const before = [{ sessionId: 'older-1' }];
    let calls = 0;
    const { call, rows } = scriptedCall([...before, { sessionId: 'w', busy: false }], () => {
      calls += 1;
      const row = rows.find((candidate) => candidate.sessionId === 'w');
      if (row) row.busy = true;
      return { status: 202, body: '{}' };
    });
    // busy flips to idle right after each busy poll observes it.
    const originalCall = call;
    const flaky: InternalApiCall = async (apiPath, options) => {
      const result = await originalCall(apiPath, options);
      if (apiPath === '/api/v1/sessions' && (options?.method ?? 'GET') === 'GET') {
        const row = rows.find((candidate) => candidate.sessionId === 'w');
        if (row && row.busy) {
          // hold collapses immediately after being observed once per prompt
          if (calls > 0) row.busy = false;
        }
      }
      return result;
    };
    await expect(driveWorkerBusy(flaky, before.map((row) => String(row.sessionId)), { holdWatchMs: 2_000, maxPrompts: 2 })).rejects.toThrow(/prompt budget/);
  });

  it('refuses to prompt when the session diff is not exactly one new session', async () => {
    const before = [{ sessionId: 'older-1' }, { sessionId: 'older-2' }];
    const { call } = scriptedCall(before);
    await expect(driveWorkerBusy(call, before.map((row) => String(row.sessionId)), { pollTimeoutMs: 1_500 })).rejects.toThrow(/exactly one new worker session/);
  });

  it('refuses the journey when the prompt fails — a non-busy worker would silently prove nothing', async () => {
    const before = [{ sessionId: 'older-1' }];
    const { call } = scriptedCall([...before, { sessionId: 'w', busy: false }], () => ({ status: 500, body: '{}' }));
    await expect(driveWorkerBusy(call, before.map((row) => String(row.sessionId)), { pollTimeoutMs: 1_500 })).rejects.toThrow(/prompt.*failed|not busy/);
  });

  it('refuses the journey when the session never reports busy within the bounded window', async () => {
    const before = [{ sessionId: 'older-1' }];
    const { call } = scriptedCall([...before, { sessionId: 'w', busy: false }]);
    await expect(driveWorkerBusy(call, before.map((row) => String(row.sessionId)), { pollTimeoutMs: 1_500 })).rejects.toThrow(/never reported busy/);
  });
});

describe('the two-real-session preparation (C24 prerequisite)', () => {
  it('creates two real sessions through POST /api/v1/sessions and verifies both in the list', async () => {
    const rows: SessionListRow[] = [];
    const { call, posts } = scriptedCall(rows, (apiPath, options) => {
      if (apiPath === '/api/v1/sessions') {
        const body = options?.body as { runtime?: string; cwd?: string };
        expect(body.runtime).toBe('pi');
        rows.push({ sessionId: `created-${rows.length + 1}`, sessionPath: `/tmp/created-${rows.length + 1}`, busy: false, model: 'Kimi for Coding' });
        return { status: 201, body: JSON.stringify({ sessionId: `created-${rows.length}` }) };
      }
      return { status: 404, body: '{}' };
    });
    const prepared = await prepareTwoWorkerSessions(call);
    expect(posts.filter((post) => post.apiPath === '/api/v1/sessions')).toHaveLength(2);
    expect(prepared.map((session) => session.displayName)).toEqual(SECOND_WORKER_DISPLAY_NAMES);
    expect(prepared.every((session) => session.sessionId && session.sessionPath)).toBe(true);
  });

  it('refuses honestly when session creation fails', async () => {
    const { call } = scriptedCall([], () => ({ status: 503, body: '{}' }));
    await expect(prepareTwoWorkerSessions(call)).rejects.toThrow(/creating "Voice Lab Worker A".*failed/);
  });

  it('sets the picker label through the app\'s own display-name preference route', async () => {
    const { call, posts } = scriptedCall([], () => ({ status: 200, body: '{"ok":true}' }));
    const ok = await setSessionDisplayName(call, '/tmp/some-session', 'Voice Lab Worker A');
    expect(ok).toBe(true);
    expect(posts[0]!.apiPath).toBe('/api/preferences/display-name');
    expect(posts[0]!.body).toMatchObject({ sessionPath: '/tmp/some-session', name: 'Voice Lab Worker A' });
  });
});

describe('holdout voice fixtures (real-run prerequisite for both families)', () => {
  // The C22-t1 'auth'/'oath' homophone: Supertonic M1 (voice-a) deterministically
  // synthesises audio the ASR gate can only hear as 'oath' (18 samples produced
  // byte-identical output). The C22 journey therefore drives on voice-b, whose
  // slower profile resolves the word; voice-a intentionally carries every other
  // overlay fixture. The absence is documented, never silent.
  const C22_T1_VOICE_A_SKIP = 't1';

  it('the frozen manifests carry ASR-validated fixtures for the C22 overlay turns', () => {
    const merged = withValidatorOverlays(corpus, corpusDir);
    const overlay = JSON.parse(readFileSync(path.join(corpusDir, 'holdout', 'C22.validator.json'), 'utf8')) as {
      inputTurns: Array<{ id: string; text: string }>
    };
    for (const profile of ['voice-a', 'voice-b']) {
      const manifest = JSON.parse(readFileSync(path.join(corpusDir, 'voices', `${profile}.manifest.json`), 'utf8')) as {
        fixtures: Array<{ id: string; text: string; asr: { ok: boolean } | null }>;
      };
      for (const turn of overlay.inputTurns) {
        if (profile === 'voice-a' && turn.id === C22_T1_VOICE_A_SKIP) {
          expect(
            manifest.fixtures.find((candidate) => candidate.id === `C22-${turn.id}`),
            'voice-a C22-t1 must stay absent until the auth/oath homophone is re-judged (documented skip)'
          ).toBeUndefined();
          continue;
        }
        const fixture = manifest.fixtures.find((candidate) => candidate.id === `C22-${turn.id}`);
        expect(fixture, `${profile} has no C22-${turn.id} fixture`).toBeDefined();
        expect(fixture!.text).toBe(turn.text);
        expect(fixture!.asr?.ok).toBe(true);
        expect(merged.episodes.find((episode) => episode.id === 'C22')?.inputTurns.find((candidate) => candidate.id === turn.id)?.text).toBe(turn.text);
      }
    }
  });

  it('the frozen manifests carry ASR-validated fixtures for the C24 overlay turns', () => {
    const overlay = JSON.parse(readFileSync(path.join(corpusDir, 'holdout', 'C24.validator.json'), 'utf8')) as {
      inputTurns: Array<{ id: string; text: string }>;
    };
    for (const profile of ['voice-a', 'voice-b']) {
      const manifest = JSON.parse(readFileSync(path.join(corpusDir, 'voices', `${profile}.manifest.json`), 'utf8')) as {
        fixtures: Array<{ id: string; text: string; asr: { ok: boolean } | null }>;
      };
      for (const turn of overlay.inputTurns) {
        const fixture = manifest.fixtures.find((candidate) => candidate.id === `C24-${turn.id}`);
        expect(fixture, `${profile} has no C24-${turn.id} fixture`).toBeDefined();
        expect(fixture!.text).toBe(turn.text);
        expect(fixture!.asr?.ok).toBe(true);
      }
    }
  });
});
