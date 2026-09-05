import { describe, expect, it, vi } from 'vitest';

/**
 * WS-path memory robustness (2026-09-05 plan, F4): MultiSessionManager's
 * unload/dispose removed the manager entry and the event handler but left
 * strong references in PiService.sessions / clientSessionMap /
 * clientWebUIContexts. Probe evidence: after 30 distinct unloads the manager
 * held 0 residents while PiService still held 30 session refs, 30 client
 * mappings and 30 UI-context refs — so every count-based bound (maxSessions)
 * understates true residency. This locks in the canonical release path.
 */
describe('PiService session reference release', () => {
  it('releaseSessionRefsFrom clears every owning map for the exact handler/session identity', async () => {
    const { releaseSessionRefsFrom } = await import('../../../src/pi/pi-service.js');
    const maps = {
      sessions: new Map([['s1', { id: 's1' }], ['s2', { id: 's2' }]]),
      clientSessionMap: new Map([['multi-/a.jsonl', 's1'], ['multi-/b.jsonl', 's2'], ['other-owner', 's1']]),
      eventHandlers: new Map([['multi-/a.jsonl', () => {}], ['multi-/b.jsonl', () => {}]]),
      clientWebUIContexts: new Map([['multi-/a.jsonl', { clientId: 'x' }], ['multi-/b.jsonl', { clientId: 'y' }]]),
    };

    releaseSessionRefsFrom(maps, 'multi-/a.jsonl', 's1');

    // The exact owner's references are all cleared…
    expect(maps.clientSessionMap.has('multi-/a.jsonl')).toBe(false);
    expect(maps.eventHandlers.has('multi-/a.jsonl')).toBe(false);
    expect(maps.clientWebUIContexts.has('multi-/a.jsonl')).toBe(false);
    // …but the session entry survives while an unrelated owner still maps it…
    expect(maps.sessions.has('s1')).toBe(true);
    expect(maps.clientSessionMap.get('other-owner')).toBe('s1');
    // …the sibling is untouched…
    expect(maps.sessions.has('s2')).toBe(true);
    // …and releasing after the last owner leaves clears the session too.
    maps.clientSessionMap.delete('other-owner');
    releaseSessionRefsFrom(maps, 'multi-/a.jsonl', 's1');
    expect(maps.sessions.has('s1')).toBe(false);
  });

  it('PiService.releaseSessionRefs delegates to the pure release and is idempotent', async () => {
    const { PiService } = await import('../../../src/pi/pi-service.js');
    const service = new PiService();
    const anyService = service as unknown as {
      sessions: Map<string, unknown>;
      clientSessionMap: Map<string, string>;
      eventHandlers: Map<string, unknown>;
      clientWebUIContexts: Map<string, unknown>;
    };
    anyService.sessions.set('sid-1', { dispose: vi.fn() });
    anyService.clientSessionMap.set('multi-/x.jsonl', 'sid-1');
    anyService.eventHandlers.set('multi-/x.jsonl', () => {});
    anyService.clientWebUIContexts.set('multi-/x.jsonl', { clientId: 'multi-/x.jsonl' });

    service.releaseSessionRefs('multi-/x.jsonl', 'sid-1');
    expect(anyService.sessions.size).toBe(0);
    expect(anyService.clientSessionMap.size).toBe(0);
    expect(anyService.eventHandlers.size).toBe(0);
    expect(anyService.clientWebUIContexts.size).toBe(0);

    // Idempotent: a second release is a no-op.
    expect(() => service.releaseSessionRefs('multi-/x.jsonl', 'sid-1')).not.toThrow();
  });
});
