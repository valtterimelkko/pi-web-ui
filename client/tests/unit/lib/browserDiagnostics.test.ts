import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearBrowserDiagnostics,
  createBrowserDiagnosticBundle,
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
