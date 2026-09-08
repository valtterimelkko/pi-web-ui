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
