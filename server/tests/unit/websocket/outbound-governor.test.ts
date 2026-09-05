import { describe, expect, it, vi } from 'vitest';
import { OutboundGovernor } from '../../../src/websocket/outbound-governor.js';

const OPEN = 1;

interface MutableFakeWs {
  readyState: number;
  bufferedAmount: number;
  sent: string[];
  closed: number | null;
  terminated: boolean;
}

function fakeWs(bufferedAmount = 0): MutableFakeWs {
  return {
    readyState: OPEN,
    bufferedAmount,
    sent: [],
    closed: null,
    terminated: false,
    // minimal governed-socket surface
    send(data: string) { this.sent.push(data); },
    close(code?: number) { this.closed = code ?? null; this.readyState = 3; },
    terminate() { this.terminated = true; this.readyState = 3; },
  } as unknown as MutableFakeWs & { send(d: string): void; close(c?: number, r?: string): void; terminate(): void };
}

function governor(overrides: Partial<ConstructorParameters<typeof OutboundGovernor>[0]> = {}) {
  return new OutboundGovernor({
    softCapBytes: 1000,
    hardCapBytes: 4000,
    pendingMaxBytes: 2000,
    lowWaterBytes: 100,
    ...overrides,
  });
}

describe('OutboundGovernor (WS-path memory robustness F2)', () => {
  it('sends directly when the socket is healthy', () => {
    const g = governor();
    const ws = fakeWs(0);
    expect(g.send(ws as any, '{"a":1}', { coalescable: true, clientId: 'c1' })).toBe('sent');
    expect(g.send(ws as any, '{"a":2}', { coalescable: false, clientId: 'c1' })).toBe('sent');
    expect(ws.sent).toEqual(['{"a":1}', '{"a":2}']);
  });

  it('queues coalescable updates while the socket is backpressured and keeps order on flush', () => {
    const g = governor();
    const ws = fakeWs(1500); // over softCap (1000), under hardCap (4000)

    expect(g.send(ws as any, 'u1', { coalescable: true, clientId: 'c1' })).toBe('queued');
    expect(g.send(ws as any, 'u2', { coalescable: true, clientId: 'c1' })).toBe('queued');
    expect(ws.sent).toEqual([]);

    // Non-coalescable (terminal/control) still flows immediately — after the queued older frames.
    expect(g.send(ws as any, 'END', { coalescable: false, clientId: 'c1' })).toBe('sent');
    expect(ws.sent).toEqual(['u1', 'u2', 'END']);
  });

  it('flushes a pending queue when the socket drains below low water', () => {
    const g = governor();
    const ws = fakeWs(1500);
    g.send(ws as any, 'u1', { coalescable: true, clientId: 'c1' });
    g.send(ws as any, 'u2', { coalescable: true, clientId: 'c1' });
    expect(ws.sent).toEqual([]);

    ws.bufferedAmount = 10; // drained
    g.flushPending(ws as any);
    expect(ws.sent).toEqual(['u1', 'u2']);
  });

  it('closes a stuck socket with 1013 when bufferedAmount exceeds the hard cap', () => {
    const onSlowClientClosed = vi.fn();
    const g = governor({ onSlowClientClosed });
    const ws = fakeWs(5000);

    expect(g.send(ws as any, 'END', { coalescable: false, clientId: 'slow' })).toBe('closed');
    expect(ws.closed).toBe(1013);
    expect(onSlowClientClosed).toHaveBeenCalledWith('slow', expect.stringContaining('hard'));
  });

  it('closes when the pending queue itself exceeds its byte cap (memory bound)', () => {
    const onSlowClientClosed = vi.fn();
    const g = governor({ onSlowClientClosed });
    const ws = fakeWs(1500);

    // pendingMaxBytes 2000; three 900-byte frames exceed it on the third.
    expect(g.send(ws as any, 'x'.repeat(900), { coalescable: true, clientId: 'c1' })).toBe('queued');
    expect(g.send(ws as any, 'y'.repeat(900), { coalescable: true, clientId: 'c1' })).toBe('queued');
    expect(g.send(ws as any, 'z'.repeat(900), { coalescable: true, clientId: 'c1' })).toBe('closed');
    expect(ws.closed).toBe(1013);
    expect(onSlowClientClosed).toHaveBeenCalledWith('c1', expect.stringContaining('pending'));
  });

  it('never queues non-coalescable messages (control/terminal always attempt delivery)', () => {
    const g = governor();
    const ws = fakeWs(1500);
    expect(g.send(ws as any, 'CTRL', { coalescable: false, clientId: 'c1' })).toBe('sent');
    expect(ws.sent).toEqual(['CTRL']);
  });

  it('ignores sends for non-open or already-closed sockets', () => {
    const g = governor();
    const ws = fakeWs(0);
    ws.readyState = 3;
    expect(g.send(ws as any, 'x', { coalescable: false, clientId: 'c1' })).toBe('closed');
    expect(ws.sent).toEqual([]);
  });
});
