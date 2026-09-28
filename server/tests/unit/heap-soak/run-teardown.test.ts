import { describe, expect, it } from 'vitest';
import { completionNoticeBody, decideRunTeardown, parseKeepServerFlag, renderTeardownMarkdown } from '../../../src/live-validation/heap-soak/run-teardown.js';

describe('decideRunTeardown (B0.1 defect 3)', () => {
  it('stops the disposable server after a completed run by default', () => {
    expect(decideRunTeardown({ keepServer: false, terminalState: 'complete' })).toMatchObject({ stopServer: true });
  });

  it('keeps the server up only when explicitly asked', () => {
    const decision = decideRunTeardown({ keepServer: true, terminalState: 'complete' });
    expect(decision.stopServer).toBe(false);
    expect(decision.reason).toMatch(/kept up/i);
  });

  it('never tries to stop a server that already died', () => {
    const decision = decideRunTeardown({ keepServer: false, terminalState: 'server_died' });
    expect(decision.stopServer).toBe(false);
    expect(decision.reason).toMatch(/already/i);
  });
});

describe('parseKeepServerFlag', () => {
  it('is off unless the flag is explicitly truthy', () => {
    expect(parseKeepServerFlag(undefined)).toBe(false);
    expect(parseKeepServerFlag('')).toBe(false);
    expect(parseKeepServerFlag('0')).toBe(false);
    expect(parseKeepServerFlag('false')).toBe(false);
    expect(parseKeepServerFlag('1')).toBe(true);
    expect(parseKeepServerFlag('true')).toBe(true);
  });
});

describe('completionNoticeBody', () => {
  const base = { verdict: 'stable', trailingSlopeMBPerHour: 0.31, peakHeapMB: 242, serverUnit: 'pi-web-ui-soak-server-run-1' };

  it('carries the verdict numbers and does not claim the server is up when it was stopped', () => {
    const body = completionNoticeBody({ ...base, keepServer: false });
    expect(body).toContain('verdict=stable');
    expect(body).toContain('peakHeap=242MB');
    expect(body).not.toMatch(/LEFT RUNNING/);
  });

  it('says explicitly that the server is still running when kept up', () => {
    const body = completionNoticeBody({ ...base, keepServer: true });
    expect(body).toMatch(/LEFT RUNNING/);
    expect(body).toContain(base.serverUnit);
  });

  it('surfaces a teardown anomaly in the completion notice (correction 03 item 8)', () => {
    const body = completionNoticeBody({ ...base, keepServer: false, teardownAnomaly: 'server unit still present after 3 stop attempts' });
    expect(body).toMatch(/TEARDOWN ANOMALY/);
    expect(body).toContain('still present after 3 stop attempts');
  });
});

describe('renderTeardownMarkdown (correction 03 item 8)', () => {
  it('states a verified teardown', () => {
    const text = renderTeardownMarkdown({ serverUnit: 'pi-web-ui-soak-server-run-1', stoppedAt: '2026-09-28T21:39:44.136Z', verifiedGone: true, attempts: 1 }).join('\n');
    expect(text).toMatch(/## Teardown/);
    expect(text).toMatch(/[Vv]erified gone: true/);
    expect(text).not.toMatch(/TEARDOWN ANOMALY/);
  });

  it('renders a prominent anomaly when the unit was not verified gone', () => {
    const text = renderTeardownMarkdown({
      serverUnit: 'pi-web-ui-soak-server-run-1',
      verifiedGone: false,
      attempts: 3,
      anomaly: 'server unit pi-web-ui-soak-server-run-1 is STILL PRESENT after 3 stop attempts',
    }).join('\n');
    expect(text).toMatch(/TEARDOWN ANOMALY/);
    expect(text).toMatch(/STILL PRESENT/);
  });
});
