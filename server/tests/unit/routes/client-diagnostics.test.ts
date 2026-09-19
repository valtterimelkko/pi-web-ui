import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';

vi.mock('../../../src/middleware/auth.js', () => ({
  cookieAuthMiddleware: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

import clientDiagnosticsRoutes from '../../../src/routes/client-diagnostics.js';
import request from 'supertest';
import { setLogTap } from '../../../src/logging/logger.js';
import {
  pushDiagnosticsRecord,
  clearDiagnosticsBuffer,
  getRecentLogs,
  getRecentErrors,
} from '../../../src/internal-api/diagnostics-buffer.js';

/**
 * P13 Phase 2 — client-side voice error ingest.
 *
 * A client crash (uncaught error, unhandled rejection, playback failure on
 * the speech surface) is today invisible to every server-side query: the
 * browser diagnostic ring is manual-only (Copy/Download), and reloading the
 * page destroys it. This route is the minimal additive ingest the P13 brief
 * authorises: it validates a bounded, scrubbed report and re-emits it as an
 * ORDINARY central-logger record from the `ClientVoice` component — no second
 * buffer, no new store — so it is retrievable through the SAME documented
 * diagnostics query as every other record:
 *
 *   GET /api/v1/diagnostics?component=ClientVoice
 */
describe('POST /api/client-diagnostics (P13 client error ingest)', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    clearDiagnosticsBuffer();
    setLogTap(pushDiagnosticsRecord); // the same wiring internal-api/server.ts does
    app = express();
    app.use(express.json());
    app.use('/api/client-diagnostics', clientDiagnosticsRoutes);
  });

  afterEach(() => {
    setLogTap(null);
    clearDiagnosticsBuffer();
  });

  const validReport = {
    operation: 'unhandled_rejection',
    message: 'Cannot read properties of undefined (reading gain)',
    errorName: 'TypeError',
    stack: 'TypeError: Cannot read properties of undefined\n    at TtsChunkPlayer.setVolume (useReadAloud.ts:1:1)',
    runtime: 'pi',
    workerSessionId: '01a09cbd-8ab4-7309-88ef-61a02e734abe',
    recentEvents: [
      { at: '2026-09-13T21:00:00.000Z', kind: 'speech', operation: 'floor_held' },
      { at: '2026-09-13T21:00:01.000Z', kind: 'speech', operation: 'playback_failed', speechTier: 3, errorName: 'DecodeError' },
    ],
  };

  it('accepts a bounded report and lands ONE queryable ClientVoice error record in the ring', async () => {
    const res = await request(app).post('/api/client-diagnostics').send(validReport);
    expect(res.status).toBe(204);

    const records = getRecentLogs({ component: 'ClientVoice' });
    expect(records).toHaveLength(1);
    const rec = records[0];
    expect(rec.level).toBe('error');
    expect(rec.msg).toContain('client error report');
    // Correlation: joins the server-side voice story by worker session.
    expect(rec.workerSessionId).toBe(validReport.workerSessionId);
    expect(rec.runtime).toBe('pi');
    expect(rec.operation).toBe('unhandled_rejection');
    // Conventional error shape (error.name/message/stack), bounded.
    expect(rec.error).toMatchObject({ name: 'TypeError' });
    // The barge-in context rides along, bounded to the allowlisted projection.
    const events = rec.recentEvents as Array<Record<string, unknown>>;
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ kind: 'speech', operation: 'playback_failed', speechTier: 3 });
  });

  it('is retrievable through the DOCUMENTED query path (component filter + recentErrors)', async () => {
    await request(app).post('/api/client-diagnostics').send(validReport);
    const errors = getRecentErrors({ component: 'ClientVoice' });
    expect(errors).toHaveLength(1);
    expect(errors[0].msg).toContain('client error report');
  });

  it('scrubs credential-shaped content through the ring scrubber (verified, not assumed)', async () => {
    await request(app).post('/api/client-diagnostics').send({
      ...validReport,
      message: 'failed after token=super-secret-value and Bearer abc.def.ghi in page',
    });
    const records = getRecentLogs({ component: 'ClientVoice' });
    expect(records).toHaveLength(1);
    const json = JSON.stringify(records[0]);
    expect(json).not.toContain('super-secret-value');
    expect(json).not.toContain('abc.def.ghi');
  });

  it('rejects an invalid body with 400 (no record emitted)', async () => {
    const res = await request(app).post('/api/client-diagnostics').send({ message: 'x' });
    expect(res.status).toBe(400);
    expect(getRecentLogs({ component: 'ClientVoice' })).toHaveLength(0);
  });

  it('rejects oversized fields with 400 rather than truncating silently', async () => {
    const res = await request(app)
      .post('/api/client-diagnostics')
      .send({ ...validReport, message: 'x'.repeat(400) });
    expect(res.status).toBe(400);
    expect(getRecentLogs({ component: 'ClientVoice' })).toHaveLength(0);
  });

  it('rejects too many recentEvents (ring hygiene: the client cannot flood one record)', async () => {
    const flood = Array.from({ length: 13 }, () => ({
      at: '2026-09-13T21:00:00.000Z',
      kind: 'speech',
      operation: 'submit',
    }));
    const res = await request(app).post('/api/client-diagnostics').send({ ...validReport, recentEvents: flood });
    expect(res.status).toBe(400);
  });

  it('tolerates a missing optional context (global-handler reports carry no session)', async () => {
    const res = await request(app).post('/api/client-diagnostics').send({
      operation: 'uncaught_error',
      message: 'boom',
      errorName: 'Error',
    });
    expect(res.status).toBe(204);
    const records = getRecentLogs({ component: 'ClientVoice' });
    expect(records).toHaveLength(1);
    expect(records[0].workerSessionId).toBeUndefined();
    // recentEvents absent must not be invented.
    expect(records[0].recentEvents).toBeUndefined();
  });
});

/**
 * P13 gap fill — the OTHER half of "why didn't I hear it?".
 *
 * Playback faults (a corrupt chunk, a sequence gap, a backlog overflow) and the
 * lane-end playback summary used to live only in the browser surface's memory:
 * nothing about the shape of the audio left the page, which is why the
 * stranding defect needed a purpose-built lab to diagnose. This route now also
 * accepts a bounded `playback_health` record and re-emits it as an ordinary
 * ClientVoice record, so "did the lane play everything it accepted?" is
 * answerable from server evidence alone.
 */
describe('POST /api/client-diagnostics (playback health — the P13 gap fill)', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    clearDiagnosticsBuffer();
    setLogTap(pushDiagnosticsRecord);
    app = express();
    app.use(express.json());
    app.use('/api/client-diagnostics', clientDiagnosticsRoutes);
  });

  afterEach(() => {
    setLogTap(null);
    clearDiagnosticsBuffer();
  });

  const validHealth = {
    kind: 'playback_health',
    reason: 'playback_overflow',
    detail: 'playback backlog exceeded its bound; the oldest unplayed chunk was dropped',
    runtime: 'pi',
    workerSessionId: '01a09cbd-8ab4-7309-88ef-61a02e734abe',
    stats: {
      chunksScheduled: 99,
      chunksDropped: 3,
      pendingChunks: 0,
      pendingMs: 0,
      queuedMs: 120,
      ducked: false,
    },
    recentEvents: [{ at: '2026-09-18T17:00:00.000Z', kind: 'speech', operation: 'playback_health', state: 'playback_overflow' }],
  };

  it('lands ONE queryable ClientVoice warn record carrying the reason and the bounded stats', async () => {
    const res = await request(app).post('/api/client-diagnostics').send(validHealth);
    expect(res.status).toBe(204);

    const records = getRecentLogs({ component: 'ClientVoice' });
    expect(records).toHaveLength(1);
    const rec = records[0];
    expect(rec.level).toBe('warn');
    expect(rec.msg).toContain('client playback health');
    expect(rec.operation).toBe('playback_health');
    expect(rec.reason).toBe('playback_overflow');
    expect(rec.stats).toMatchObject({ chunksScheduled: 99, chunksDropped: 3 });
    expect(rec.workerSessionId).toBe(validHealth.workerSessionId);
    expect(rec.runtime).toBe('pi');
    // A health record is not an error: no conventional error object is invented.
    expect(rec.error).toBeUndefined();
  });

  it('records a lane-end summary so stranding is answerable without arithmetic on the client', async () => {
    const res = await request(app)
      .post('/api/client-diagnostics')
      .send({ ...validHealth, reason: 'lane_end', stats: { ...validHealth.stats, chunksScheduled: 48, pendingChunks: 51, pendingMs: 4500 } });
    expect(res.status).toBe(204);
    const rec = getRecentLogs({ component: 'ClientVoice' })[0];
    expect(rec.level).toBe('warn');
    expect(rec.reason).toBe('lane_end');
    expect(rec.stats).toMatchObject({ pendingChunks: 51, pendingMs: 4500 });
  });

  it('is retrievable through the DOCUMENTED query path (component filter)', async () => {
    await request(app).post('/api/client-diagnostics').send(validHealth);
    const records = getRecentLogs({ component: 'ClientVoice' });
    expect(records).toHaveLength(1);
    expect(records[0].msg).toContain('client playback health');
  });

  it('scrubs credential-shaped detail through the ring scrubber (verified, not assumed)', async () => {
    await request(app)
      .post('/api/client-diagnostics')
      .send({ ...validHealth, detail: 'dropped after token=super-secret-value in the page' });
    const json = JSON.stringify(getRecentLogs({ component: 'ClientVoice' })[0]);
    expect(json).not.toContain('super-secret-value');
  });

  it('rejects a playback_health body without stats (the numbers are the point)', async () => {
    const { stats: _stats, ...withoutStats } = validHealth;
    const res = await request(app).post('/api/client-diagnostics').send(withoutStats);
    expect(res.status).toBe(400);
    expect(getRecentLogs({ component: 'ClientVoice' })).toHaveLength(0);
  });

  it('rejects a playback_health body with an unknown reason', async () => {
    const res = await request(app)
      .post('/api/client-diagnostics')
      .send({ ...validHealth, reason: 'made_up_reason' });
    expect(res.status).toBe(400);
    expect(getRecentLogs({ component: 'ClientVoice' })).toHaveLength(0);
  });

  it('rejects unbounded stats rather than storing whatever the client sends', async () => {
    const res = await request(app)
      .post('/api/client-diagnostics')
      .send({ ...validHealth, stats: { ...validHealth.stats, chunksScheduled: 1e12 } });
    expect(res.status).toBe(400);
  });

  it('rejects unknown extra fields on a health report (strict shape, no smuggling)', async () => {
    const res = await request(app)
      .post('/api/client-diagnostics')
      .send({ ...validHealth, transcript: 'the operator said something private' });
    expect(res.status).toBe(400);
    expect(getRecentLogs({ component: 'ClientVoice' })).toHaveLength(0);
  });
});
