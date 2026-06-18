import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { InternalApiEventBroker } from '../../../src/internal-api/event-broker.js';
import { WatchManager } from '../../../src/internal-api/watch/watch-manager.js';

function ev(type: string, data: Record<string, unknown> = {}): NormalizedEvent {
  return { type, timestamp: Date.now(), data };
}

const flush = () => new Promise((r) => setTimeout(r, 30));

describe('WatchManager — standing observation + durable ledger', () => {
  let dir: string;
  let broker: InternalApiEventBroker;
  let pin: ReturnType<typeof vi.fn>;
  let manager: WatchManager;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-watch-mgr-'));
    broker = new InternalApiEventBroker({ replayBufferSize: 10 });
    pin = vi.fn(() => true);
    manager = new WatchManager({ broker, storeDir: dir, pinSession: pin });
  });

  afterEach(async () => {
    manager.close();
    await flush(); // let any in-flight ledger write settle before removing the dir
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('records firings for events that arrive with no client connected', async () => {
    const watch = await manager.register({
      sessionId: 's1', sessionPath: 's1', runtime: 'pi',
      request: { conditions: [{ type: 'event_type', eventType: 'agent_end' }, { type: 'tool', toolName: 'Bash' }] },
    });
    expect(watch.pinned).toBe(true);
    expect(pin).toHaveBeenCalledWith('s1');

    // Nobody is subscribed via /events — the standing watch is the only observer.
    broker.publish('s1', ev('tool_execution_start', { toolName: 'Bash' }));
    broker.publish('s1', ev('agent_end'));

    const after = manager.get('s1')!;
    expect(after.allFired).toBe(true);
    expect(after.firingCount).toBe(2);
    expect(after.snapshot.toolCallCount).toBe(1);
    expect(after.snapshot.sawAgentEnd).toBe(true);
  });

  it('applies once-semantics (default) — a condition fires only once', async () => {
    await manager.register({
      sessionId: 's2', sessionPath: 's2', runtime: 'pi',
      request: { conditions: [{ type: 'event_type', eventType: 'agent_end' }] },
    });
    broker.publish('s2', ev('agent_end'));
    broker.publish('s2', ev('agent_end'));
    const w = manager.get('s2')!;
    expect(w.firingCount).toBe(1);
    expect(w.conditions[0].fireCount).toBe(1);
  });

  it('records every match when once=false', async () => {
    await manager.register({
      sessionId: 's3', sessionPath: 's3', runtime: 'pi',
      request: { conditions: [{ type: 'tool', toolName: 'Bash', once: false }] },
    });
    broker.publish('s3', ev('tool_execution_start', { toolName: 'Bash' }));
    broker.publish('s3', ev('tool_execution_start', { toolName: 'Bash' }));
    expect(manager.get('s3')!.firingCount).toBe(2);
  });

  it('subscribes under both id and path so Pi (path-keyed) events are seen', async () => {
    await manager.register({
      sessionId: 'id1', sessionPath: 'path1', runtime: 'pi',
      request: { conditions: [{ type: 'event_type', eventType: 'agent_end' }] },
    });
    // Pi publishes under the session *path*.
    broker.publish('path1', ev('agent_end'));
    expect(manager.get('id1')!.allFired).toBe(true);
  });

  it('persists the ledger so it survives a fresh manager (server restart)', async () => {
    await manager.register({
      sessionId: 's4', sessionPath: 's4', runtime: 'pi',
      request: { conditions: [{ type: 'event_type', eventType: 'agent_end' }] },
    });
    broker.publish('s4', ev('agent_end'));
    await flush(); // allow the immediate firing write to hit disk

    // Fresh broker + manager = a real restart. Past firings must still be read.
    const manager2 = new WatchManager({ broker: new InternalApiEventBroker(), storeDir: dir, pinSession: pin });
    await manager2.init();
    const reloaded = manager2.get('s4')!;
    expect(reloaded.status).toBe('detached');
    expect(reloaded.allFired).toBe(true);
    expect(reloaded.firingCount).toBe(1);
  });

  it('deletes a watch and stops recording', async () => {
    await manager.register({
      sessionId: 's5', sessionPath: 's5', runtime: 'pi',
      request: { conditions: [{ type: 'event_type', eventType: 'agent_end' }] },
    });
    expect(await manager.delete('s5')).toBe(true);
    broker.publish('s5', ev('agent_end')); // no subscriber now
    expect(manager.get('s5')).toBeUndefined();
    expect(await manager.delete('s5')).toBe(false);
  });

  it('rejects an empty condition list and an invalid regex', async () => {
    await expect(manager.register({
      sessionId: 's6', sessionPath: 's6', runtime: 'pi', request: { conditions: [] },
    })).rejects.toThrow();
    await expect(manager.register({
      sessionId: 's6', sessionPath: 's6', runtime: 'pi',
      request: { conditions: [{ type: 'text', pattern: '(' }] },
    })).rejects.toThrow();
  });
});
