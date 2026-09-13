import { describe, it, expect, beforeEach } from 'vitest';
import {
  pushDiagnosticsRecord,
  getRecentLogs,
  getDiagnosticsSummary,
  clearDiagnosticsBuffer,
} from '../../../src/internal-api/diagnostics-buffer.js';
import { createDiagnosticsRoutes } from '../../../src/internal-api/routes/diagnostics.js';
import type { ServerResponse } from 'node:http';
import type { LogRecord } from '../../../src/logging/logger.js';

/**
 * P10 D5 — the retrieval half: voice records are queryable through the
 * EXISTING diagnostics surface, plus one additive `voiceTurnId` selector so
 * one utterance's whole journey is one documented query (design: "how to
 * follow one voiceTurnId end to end"). No new endpoint, no second buffer.
 */

function rec(over: Partial<LogRecord> = {}): LogRecord {
  return {
    ts: '2026-06-23T12:00:00.000Z',
    level: 'info',
    component: 'VoiceMode',
    msg: 'voice turn',
    voiceTurnId: 'pi:worker-1:1',
    workerSessionId: 'worker-1',
    runtime: 'pi',
    ...over,
  } as LogRecord;
}

function mockRes(): ServerResponse & { statusCode: number; body: string } {
  const r = { statusCode: 0, body: '' } as unknown as ServerResponse & { statusCode: number; body: string };
  (r as Record<string, unknown>).writeHead = (code: number) => { r.statusCode = code; return r; };
  (r as Record<string, unknown>).end = (data?: string) => { r.body = typeof data === 'string' ? data : ''; return r; };
  return r;
}

beforeEach(() => clearDiagnosticsBuffer());

describe('diagnostics buffer — voiceTurnId selector', () => {
  it('follows one voiceTurnId end to end across its turn and release records', () => {
    pushDiagnosticsRecord(rec({ msg: 'voice turn', voiceTurnId: 'pi:worker-1:1' }));
    pushDiagnosticsRecord(rec({ msg: 'voice turn', voiceTurnId: 'pi:worker-1:2' }));
    pushDiagnosticsRecord(rec({ msg: 'voice release', voiceTurnId: 'pi:worker-1:2' }));

    const turn2 = getRecentLogs({ voiceTurnId: 'pi:worker-1:2' });
    expect(turn2).toHaveLength(2);
    expect(turn2.map((r) => r.msg).sort()).toEqual(['voice release', 'voice turn']);
    expect(getRecentLogs({ voiceTurnId: 'pi:worker-1:1' })).toHaveLength(1);
    expect(getRecentLogs({ voiceTurnId: 'pi:worker-1:does-not-exist' })).toHaveLength(0);
    // Composable with the existing selectors.
    expect(getRecentLogs({ voiceTurnId: 'pi:worker-1:2', component: 'VoiceMode' })).toHaveLength(2);
    expect(getDiagnosticsSummary({ voiceTurnId: 'pi:worker-1:2' }).bufferedRecords).toBe(2);
  });
});

describe('diagnostics routes — voiceTurnId query parameter', () => {
  it('GET /api/v1/diagnostics?voiceTurnId= returns exactly that turn\u2019s records', async () => {
    pushDiagnosticsRecord(rec({ msg: 'voice turn', voiceTurnId: 'pi:worker-1:7' }));
    pushDiagnosticsRecord(rec({ msg: 'voice release', voiceTurnId: 'pi:worker-1:7' }));
    pushDiagnosticsRecord(rec({ msg: 'voice turn', voiceTurnId: 'pi:worker-1:8' }));

    const routes = createDiagnosticsRoutes();
    const res = mockRes();
    await routes.handleGetDiagnostics({} as never, res, new URLSearchParams('voiceTurnId=pi%3Aworker-1%3A7'));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.recentLogs).toHaveLength(2);
    for (const record of body.recentLogs) expect(record.voiceTurnId).toBe('pi:worker-1:7');
    // The voice block of the operational snapshot rides the existing snapshot.
    expect(body.operational).toHaveProperty('voice');
  });
});
