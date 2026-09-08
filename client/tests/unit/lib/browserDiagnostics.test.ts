import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearBrowserDiagnostics,
  createBrowserDiagnosticBundle,
  getBrowserBuildIdentity,
  parseBrowserBuildIdentity,
  recordBrowserDiagnostic,
  recordProtocolDrift,
  type BrowserDiagnosticInput,
} from '../../../src/lib/browserDiagnostics.js';

describe('browser diagnostics', () => {
  beforeEach(() => clearBrowserDiagnostics());

  it('keeps a bounded privacy-safe event ring without payload content', () => {
    for (let index = 0; index < 250; index += 1) {
      recordBrowserDiagnostic({
        kind: 'message', messageType: `type-${index}`, sessionId: 'session-1', runtime: 'pi',
      } as unknown as BrowserDiagnosticInput);
    }
    recordProtocolDrift('unknown', 'future_message');
    const bundle = createBrowserDiagnosticBundle();
    expect(bundle.events).toHaveLength(200);
    expect(bundle.protocolDrift.unknown).toBe(1);
    expect(JSON.stringify(bundle)).not.toContain('prompt');
    expect(JSON.stringify(bundle)).not.toContain('session-1');
    expect(bundle).toHaveProperty('buildVersion');
    expect(bundle.buildVersion).toBe(bundle.buildIdentity.buildId);
    expect(getBrowserBuildIdentity()).toMatchObject({
      identityStatus: 'unknown',
      buildId: 'unknown',
    });
  });

  it('projects strict identity metadata without forwarding synthetic fields', () => {
    const payload = {
      manifestSchemaVersion: 1,
      identityStatus: 'known',
      buildMode: 'compiled',
      buildId: 'build-0123456789abcdef0123456789abcdef',
      buildFingerprint: `sha256:${'0123456789abcdef'.repeat(4)}`,
      revision: 'revision-a',
      sourceFingerprint: `sha256:${'1234567890abcdef'.repeat(4)}`,
      configFingerprint: `sha256:${'abcdef0123456789'.repeat(4)}`,
      lockfileFingerprint: `sha256:${'fedcba9876543210'.repeat(4)}`,
      componentVersions: { app: '1.0.0' },
      inputCounts: { source: 1, config: 1, lockfile: 1 },
      unexpected: 'must not escape',
    };

    const identity = parseBrowserBuildIdentity(JSON.stringify(payload));

    expect(identity).toMatchObject({ buildId: payload.buildId, identityStatus: 'known' });
    expect(identity).not.toHaveProperty('unexpected');
  });

  it('rejects malformed or oversized embedded identities', () => {
    expect(parseBrowserBuildIdentity('{"buildId":"known-but-incomplete"}').identityStatus).toBe('unknown');
    expect(parseBrowserBuildIdentity('x'.repeat(100_000)).identityStatus).toBe('unknown');
  });

  it('scrubs sensitive close reasons and counts malformed protocol messages', () => {
    recordBrowserDiagnostic({
      kind: 'connection', state: 'disconnected', closeCode: 1011,
      closeReason: 'accessToken=secret-value refresh_token=other-secret https://x.test/?api_key=query-secret failed',
    });
    recordProtocolDrift('malformed');
    const bundle = createBrowserDiagnosticBundle();
    expect(bundle.events.find((event) => event.closeCode === 1011)?.closeReason).toContain('[REDACTED]');
    expect(JSON.stringify(bundle)).not.toContain('secret-value');
    expect(JSON.stringify(bundle)).not.toContain('other-secret');
    expect(JSON.stringify(bundle)).not.toContain('query-secret');
    expect(bundle.protocolDrift.malformed).toBe(1);
    recordProtocolDrift('unknown', 'user supplied text with spaces and token=do-not-keep');
    expect(JSON.stringify(createBrowserDiagnosticBundle())).not.toContain('do-not-keep');
  });
});

describe('diagnostics export byte bound', () => {
  it('bounds the exported bundle to 128 KiB with an explicit truncation marker', () => {
    clearBrowserDiagnostics();
    for (let index = 0; index < 200; index++) {
      recordBrowserDiagnostic({
        kind: 'error',
        errorName: 'Error',
        closeReason: 'x'.repeat(160),
        operation: `op-${index}`,
      });
    }
    // Default bound holds trivially for legal input (per-field caps keep
    // 200 events ≈ 100 KiB); exercise the trim path with an injected tiny
    // bound so oldest-event dropping + marker are deterministic.
    const bundle = createBrowserDiagnosticBundle(8 * 1024);
    expect(JSON.stringify(bundle).length).toBeLessThanOrEqual(8 * 1024);
    expect(bundle.truncation?.applied).toBe(true);
    expect(bundle.truncation?.droppedEvents).toBeGreaterThan(0);
    // The default call stays within the plan's 128 KiB export bound.
    expect(JSON.stringify(createBrowserDiagnosticBundle()).length).toBeLessThanOrEqual(128 * 1024);
    // Retained events are the newest; oldest were dropped first.
    expect(bundle.events.at(-1)?.operation).toBe('op-199');
  });

  it('does not mark truncation for a small bundle', () => {
    clearBrowserDiagnostics();
    recordBrowserDiagnostic({ kind: 'open' });
    const bundle = createBrowserDiagnosticBundle();
    expect(bundle.truncation).toBeUndefined();
    expect(bundle.events.length).toBe(1);
  });
});
