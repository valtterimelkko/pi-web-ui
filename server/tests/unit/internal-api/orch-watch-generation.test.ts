import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import http, { type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { InternalApiEventBroker } from '../../../src/internal-api/event-broker.js';
import { createCapabilitiesRoutes } from '../../../src/internal-api/routes/capabilities.js';
import { createSessionRoutes } from '../../../src/internal-api/routes/sessions.js';
import { WatchManager } from '../../../src/internal-api/watch/watch-manager.js';
import { WatchStore, type PersistedWatch } from '../../../src/internal-api/watch/watch-store.js';

const dirs: string[] = [];
const servers: Server[] = [];
const managers: WatchManager[] = [];
const condition = { type: 'event_type' as const, eventType: 'agent_end' };
const event = (type: string): NormalizedEvent => ({ type, timestamp: Date.now(), data: {} });
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await settle();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function makeManager(dir: string, overrides: Partial<ConstructorParameters<typeof WatchManager>[0]> = {}) {
  const manager = new WatchManager({
    broker: new InternalApiEventBroker({ replayBufferSize: 10 }),
    storeDir: dir,
    pinSession: () => true,
    unpinSession: () => true,
    ...overrides,
  });
  managers.push(manager);
  return manager;
}

describe('WatchStore generation durability boundary', () => {
  it('rolls back to the bytes actually written, not a live record mutated while save was pending', async () => {
    const dir = await tempDir('watch-parent-durable-payload-');
    const store = new WatchStore(dir); await store.init();
    const record: PersistedWatch = {
      watchId: 'watch-subject', generation: 'generation-1', sessionId: 'subject', sessionPath: 'subject', runtime: 'pi',
      status: 'active', pinned: false, targetPinned: false,
      createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
      conditions: [], wakeAttempts: [], firings: [], snapshot: { status: 'idle', eventCount: 0, toolCallCount: 0, sawAgentEnd: false },
    };
    const saving = store.save(record);
    record.snapshot.eventCount = 99; // Like handleEvent mutating the same ActiveWatch record during I/O.
    await saving;
    const ledger = path.join(dir, 'subject.json');
    const persisted = JSON.parse(await fs.readFile(ledger, 'utf8'));
    expect(persisted.snapshot.eventCount).toBe(0);
    await fs.unlink(ledger); await fs.mkdir(ledger); // Force the next atomic rename to fail, without mocking store behaviour.
    await expect(store.save({ ...record, label: 'failed-save' })).rejects.toBeDefined();
    expect(store.get('subject')?.snapshot.eventCount, 'rollback must match the disk-confirmed payload').toBe(persisted.snapshot.eventCount);
  });

  it('an older failed save cannot replace cache owned by a newer queued save of the same mutable record', async () => {
    const dir = await tempDir('watch-parent-queued-payload-');
    const store = new WatchStore(dir); await store.init();
    const record: PersistedWatch = {
      watchId: 'watch-subject', generation: 'generation-1', sessionId: 'subject', sessionPath: 'subject', runtime: 'pi',
      status: 'active', pinned: false, targetPinned: false,
      createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
      conditions: [], wakeAttempts: [], firings: [], snapshot: { status: 'idle', eventCount: 0, toolCallCount: 0, sawAgentEnd: false },
    };
    await store.save(record);
    await fs.mkdir(path.join(dir, `subject.json.${process.pid}.tmp`)); // Real writeFile failure for queued saves.
    record.snapshot.eventCount = 1;
    const first = store.save(record);
    record.snapshot.eventCount = 2;
    const second = store.save(record);
    const firstFailure = first.catch(() => store.get('subject')?.snapshot.eventCount);
    const secondFailure = second.catch(() => undefined);
    const visibleAfterOlderFailure = await firstFailure;
    await secondFailure;
    expect(visibleAfterOlderFailure, 'newer queued save still owns the visible cache at the older rejection').toBe(2);
  });

  it('does not report durable deletion success when the ledger unlink fails', async () => {
    const dir = await tempDir('watch-delete-failure-');
    const store = new WatchStore(dir);
    await store.init();
    const record: PersistedWatch = {
      watchId: 'watch-subject', generation: 'generation-1', sessionId: 'subject', sessionPath: 'subject', runtime: 'pi',
      status: 'active', pinned: true, targetPinned: false,
      createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
      conditions: [{ id: 'c0', type: 'event_type', spec: { id: 'c0', ...condition }, fired: false, fireCount: 0 }],
      wakeAttempts: [], firings: [], snapshot: { status: 'idle', eventCount: 0, toolCallCount: 0, sawAgentEnd: false },
    };
    await store.save(record);
    const ledgerPath = path.join(dir, 'subject.json');
    await fs.unlink(ledgerPath);
    await fs.mkdir(ledgerPath);

    await expect(store.delete('subject')).rejects.toMatchObject({ code: 'EISDIR' });
    expect(store.get('subject')?.generation).toBe('generation-1');
  });
});

describe('WatchManager generation CAS', () => {
  it('failed conditional replacement preserves the old durable observer and its pin claim', async () => {
    const dir = await tempDir('watch-review-replacement-failure-');
    const broker = new InternalApiEventBroker({ replayBufferSize: 10 });
    const pins = new Set<string>();
    const manager = makeManager(dir, { broker, pinSession: (_id, claim) => { pins.add(claim); return true; }, unpinSession: (_id, claim) => pins.delete(claim) });
    const first = await manager.register({ sessionId: 'subject', sessionPath: 'subject', runtime: 'pi', request: { conditions: [{ ...condition, once: false }] } });
    const blockedTemp = path.join(dir, `subject.json.${process.pid}.tmp`);
    await fs.mkdir(blockedTemp); // Real candidate writeFile failure; the old ledger still exists.
    await expect(manager.register({ sessionId: 'subject', sessionPath: 'subject', runtime: 'pi', request: { conditions: [{ ...condition, once: false }], expectedGeneration: first.generation } })).rejects.toBeDefined();
    await fs.rm(blockedTemp, { recursive: true });
    expect(manager.get('subject')?.generation, 'a rejected replacement must retain the prior generation').toBe(first.generation);
    expect(pins.has('watch:watch-subject')).toBe(true);
    broker.publish('subject', event('agent_end'));
    expect(manager.get('subject')?.firingCount).toBe(1);
    await settle();
    manager.close();
    const restarted = makeManager(dir); await restarted.init();
    expect(restarted.get('subject')?.generation).toBe(first.generation);
    expect(restarted.get('subject')?.firingCount).toBe(1);
  });

  it('old one-shot completion release cannot unpin or persist over a replacement', async () => {
    const dir = await tempDir('watch-review-completion-race-');
    const broker = new InternalApiEventBroker({ replayBufferSize: 10 });
    const pins = new Set<string>(); let releaseCompletion!: () => void; let unpins = 0;
    const manager = makeManager(dir, { broker,
      pinSession: (_id, claim) => { pins.add(claim); return true; },
      unpinSession: async (_id, claim) => { if (++unpins === 1) await new Promise<void>(resolve => { releaseCompletion = resolve; }); return pins.delete(claim); },
    });
    const first = await manager.register({ sessionId: 'subject', sessionPath: 'subject', runtime: 'pi', request: { conditions: [condition] } });
    broker.publish('subject', event('agent_end'));
    await new Promise(resolve => setImmediate(resolve));
    expect(releaseCompletion).toBeTypeOf('function');
    const replacing = manager.register({ sessionId: 'subject', sessionPath: 'subject', runtime: 'pi', request: { conditions: [{ ...condition, once: false }], expectedGeneration: first.generation } });
    await new Promise(resolve => setImmediate(resolve)); // Drain admitted JS mutations; old release stays explicitly held.
    releaseCompletion();
    const replacement = await replacing;
    await settle();
    expect(pins.has('watch:watch-subject'), 'old completion must not remove the new generation pin').toBe(true);
    expect(manager.get('subject')?.generation).toBe(replacement.generation);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'subject.json'), 'utf8')).generation).toBe(replacement.generation);
    broker.publish('subject', event('agent_end'));
    expect(manager.get('subject')?.firingCount).toBe(1);
  });

  it('retries a failed legacy migration before exposing its generation as durable', async () => {
    const dir = await tempDir('watch-parent-migration-');
    const legacy = {
      watchId: 'watch-legacy', sessionId: 'legacy', sessionPath: 'legacy', runtime: 'pi', status: 'active', pinned: false,
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
      conditions: [], wakeAttempts: [], firings: [], snapshot: { status: 'idle', eventCount: 0, toolCallCount: 0, sawAgentEnd: false },
    };
    await fs.writeFile(path.join(dir, 'legacy.json'), JSON.stringify(legacy));
    const manager = makeManager(dir);
    const save = vi.spyOn(WatchStore.prototype, 'save').mockRejectedValueOnce(new Error('temporary migration write failure'));
    try {
      await expect(manager.init()).rejects.toThrow('temporary migration write failure');
      await manager.init();
      const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'legacy.json'), 'utf8'));
      expect(onDisk.generation, 'successful init must not skip a failed migration write').toBe(manager.get('legacy')?.generation);
      expect(onDisk.status).toBe('detached');
    } finally { save.mockRestore(); }
  });

  it('keeps legacy replacement, enforces match/create-only, and leaves mismatches untouched', async () => {
    const dir = await tempDir('watch-generation-');
    const broker = new InternalApiEventBroker({ replayBufferSize: 10 });
    const pin = vi.fn(() => true);
    const unpin = vi.fn(() => true);
    const manager = makeManager(dir, { broker, pinSession: pin, unpinSession: unpin });

    const first = await manager.register({
      sessionId: 'subject', sessionPath: 'subject', runtime: 'pi',
      request: { conditions: [condition] },
    });
    expect(first.generation).toMatch(/^[0-9a-f-]{36}$/i);

    await expect(manager.register({
      sessionId: 'subject', sessionPath: 'subject', runtime: 'pi',
      request: { conditions: [condition], expectedGeneration: null },
    })).rejects.toMatchObject({ name: 'WatchGenerationMismatchError', expectedGeneration: null, currentGeneration: first.generation });
    expect(manager.get('subject')?.generation).toBe(first.generation);
    expect(unpin).not.toHaveBeenCalled();
    broker.publish('subject', event('agent_end'));
    expect(manager.get('subject')?.firingCount).toBe(1);

    const second = await manager.register({
      sessionId: 'subject', sessionPath: 'subject', runtime: 'pi',
      request: { conditions: [{ ...condition, once: false }], expectedGeneration: first.generation },
    });
    expect(second.generation).not.toBe(first.generation);
    expect(second.replaced).toBe(true);

    await expect(manager.deleteWithPrecondition('subject', first.generation)).rejects.toMatchObject({
      name: 'WatchGenerationMismatchError', currentGeneration: second.generation,
    });
    expect(manager.get('subject')?.generation).toBe(second.generation);
    broker.publish('subject', event('agent_end'));
    expect(manager.get('subject')?.firingCount).toBe(1);

    const deleted = await manager.deleteWithPrecondition('subject', second.generation);
    expect(deleted).toEqual({ deleted: true, generation: second.generation, watchId: 'watch-subject' });
    expect(manager.get('subject')).toBeUndefined();

    const createOnly = await manager.register({
      sessionId: 'subject', sessionPath: 'subject', runtime: 'pi',
      request: { conditions: [condition], expectedGeneration: null },
    });
    expect(createOnly.replaced).toBe(false);

    const legacyReplacement = await manager.register({
      sessionId: 'subject', sessionPath: 'subject', runtime: 'pi',
      request: { conditions: [condition] },
    });
    expect(legacyReplacement.replaced).toBe(true);
    expect(legacyReplacement.generation).not.toBe(createOnly.generation);
  });

  it('serializes same-session replace/replace and replace/delete races while unrelated sessions progress independently', async () => {
    const dir = await tempDir('watch-generation-race-');
    let releaseUnpin!: () => void;
    let blockUnpin = false;
    const unpin = vi.fn(async (sessionId: string) => {
      if (blockUnpin && sessionId === 'a') await new Promise<void>((resolve) => { releaseUnpin = resolve; });
      return true;
    });
    const manager = makeManager(dir, { unpinSession: unpin });
    const initial = await manager.register({ sessionId: 'a', sessionPath: 'a', runtime: 'pi', request: { conditions: [condition] } });

    const competing = await Promise.allSettled([
      manager.register({ sessionId: 'a', sessionPath: 'a', runtime: 'pi', request: { conditions: [condition], expectedGeneration: initial.generation } }),
      manager.register({ sessionId: 'a', sessionPath: 'a', runtime: 'pi', request: { conditions: [condition], expectedGeneration: initial.generation } }),
    ]);
    expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(competing.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const current = manager.get('a')!;

    blockUnpin = true;
    const replacing = manager.register({ sessionId: 'a', sessionPath: 'a', runtime: 'pi', request: { conditions: [condition], expectedGeneration: current.generation } });
    while (!releaseUnpin) await new Promise((resolve) => setImmediate(resolve));
    const deleting = manager.deleteWithPrecondition('a', current.generation);
    const unrelated = await manager.register({ sessionId: 'b', sessionPath: 'b', runtime: 'pi', request: { conditions: [condition], expectedGeneration: null } });
    expect(unrelated.sessionId).toBe('b');
    releaseUnpin();

    const replaced = await replacing;
    await expect(deleting).rejects.toMatchObject({ name: 'WatchGenerationMismatchError', currentGeneration: replaced.generation });
    expect(manager.get('a')?.generation).toBe(replaced.generation);
  });

  it('migrates a legacy disk ledger once and preserves generation, firings and detached status across restart', async () => {
    const dir = await tempDir('watch-generation-migrate-');
    const legacy = {
      watchId: 'watch-legacy', sessionId: 'legacy', sessionPath: 'legacy', runtime: 'pi', status: 'active', pinned: true, targetPinned: false,
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
      conditions: [{ id: 'c0', type: 'event_type', spec: { id: 'c0', ...condition }, fired: true, fireCount: 1 }],
      wakeAttempts: [], firings: [{ conditionId: 'c0', firedAt: 1, eventType: 'agent_end', evidence: 'event agent_end' }],
      snapshot: { status: 'idle', eventCount: 1, toolCallCount: 0, sawAgentEnd: true },
    };
    await fs.writeFile(path.join(dir, 'legacy.json'), JSON.stringify(legacy), 'utf8');

    const first = makeManager(dir);
    await first.init();
    const migrated = first.get('legacy')!;
    expect(migrated.generation).toMatch(/^[0-9a-f-]{36}$/i);
    expect(migrated.status).toBe('detached');
    expect(migrated.firings).toHaveLength(1);
    await settle();

    const second = makeManager(dir);
    await second.init();
    const restarted = second.get('legacy')!;
    expect(restarted.generation).toBe(migrated.generation);
    expect(restarted.status).toBe('detached');
    expect(restarted.firings).toEqual(migrated.firings);
  });
});

interface HttpFixture {
  socketPath: string;
  observers: Array<(event: NormalizedEvent) => void>;
  pin: ReturnType<typeof vi.fn>;
  unpin: ReturnType<typeof vi.fn>;
}

async function startHttpFixture(watchDir: string, socketPath: string): Promise<HttpFixture> {
  await fs.rm(socketPath, { force: true });
  const observers: Array<(event: NormalizedEvent) => void> = [];
  const pin = vi.fn(() => true);
  const unpin = vi.fn(() => true);
  const entry = { id: 'pi-1', path: 'pi-1', sdkType: 'pi', cwd: '/tmp', firstMessage: '', messageCount: 0, status: 'idle', createdAt: '', lastActivity: '' };
  const routes = createSessionRoutes({
    claudeService: {} as never,
    opencodeService: {} as never,
    antigravityService: {} as never,
    multiSessionManager: {
      addApiObserver: vi.fn((_path: string, observer: (event: NormalizedEvent) => void) => observers.push(observer)),
      removeApiObserver: vi.fn(), pinSession: pin, unpinSession: unpin,
    } as never,
    sessionRegistry: { get: vi.fn(async () => entry) } as never,
    piService: {} as never,
    internalClientId: 'generation-http-test',
    watchDir,
  });
  const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (parsed.pathname !== '/api/v1/sessions/pi-1/watch') {
        res.writeHead(404).end();
      } else if (req.method === 'POST') {
        await routes.handleRegisterWatch(req, res, 'pi-1');
      } else if (req.method === 'GET') {
        await routes.handleGetWatch(req, res, 'pi-1', parsed.searchParams);
      } else if (req.method === 'DELETE') {
        await routes.handleDeleteWatch(req, res, 'pi-1');
      } else {
        res.writeHead(405).end();
      }
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => resolve()); });
  servers.push(server);
  return { socketPath, observers, pin, unpin };
}

async function request(socketPath: string, method: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      socketPath, path: '/api/v1/sessions/pi-1/watch', method,
      headers: payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.end(payload); else req.end();
  });
}

describe('actual HTTP watch generation contract', () => {
  it('stores the same normalised wake target identity that the HTTP route validated', async () => {
    const root = await tempDir('watch-review-target-'); const socket = path.join(root, 'api.sock');
    await startHttpFixture(path.join(root, 'watches'), socket);
    const result = await request(socket, 'POST', { conditions: [condition], onFire: { type: 'prompt', targetSessionId: ' parent-session ', message: 'wake the validated parent' } });
    expect(result.status).toBe(201);
    expect(result.body.onFire.targetSessionId).toBe('parent-session');
    expect((await request(socket, 'GET')).body.onFire.targetSessionId).toBe('parent-session');
  });

  it.each(['{', 'null'])('rejects a non-object or malformed chunked DELETE body without deleting the watch: %s', async (rawBody) => {
    const root = await tempDir('watch-parent-chunked-');
    const socket = path.join(root, 'api.sock');
    await startHttpFixture(path.join(root, 'watches'), socket);
    const created = await request(socket, 'POST', { conditions: [condition], expectedGeneration: null });
    expect(created.status).toBe(201);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ socketPath: socket, path: '/api/v1/sessions/pi-1/watch', method: 'DELETE', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, res => {
        res.resume(); res.once('end', () => resolve(res.statusCode ?? 0));
      });
      req.once('error', reject); req.end(rawBody);
    });
    expect(status, 'invalid payload must never downgrade to unconditional legacy DELETE').toBe(400);
    expect((await request(socket, 'GET')).body.generation).toBe(created.body.generation);
  });

  it('validates and enforces register/delete preconditions, then preserves generation and firings over disk restart', async () => {
    const root = await tempDir('watch-generation-http-');
    const watchDir = path.join(root, 'watches');
    const socket1 = path.join(root, 'one.sock');
    const firstFixture = await startHttpFixture(watchDir, socket1);

    const created = await request(socket1, 'POST', { conditions: [{ ...condition, once: false }], expectedGeneration: null });
    expect(created.status).toBe(201);
    const generation1 = created.body.generation;
    expect(generation1).toMatch(/^[0-9a-f-]{36}$/i);

    for (const observer of firstFixture.observers) observer(event('agent_end'));
    await settle();

    const pinCalls = firstFixture.pin.mock.calls.length;
    const unpinCalls = firstFixture.unpin.mock.calls.length;
    const conflict = await request(socket1, 'POST', { conditions: [condition], expectedGeneration: null });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: 'WATCH_GENERATION_MISMATCH', expectedGeneration: null, currentGeneration: generation1 });
    expect(firstFixture.pin).toHaveBeenCalledTimes(pinCalls);
    expect(firstFixture.unpin).toHaveBeenCalledTimes(unpinCalls);
    const preserved = await request(socket1, 'GET');
    expect(preserved.body).toMatchObject({ generation: generation1, firingCount: 1, status: 'active' });

    const badRegister = await request(socket1, 'POST', { conditions: [condition], expectedGeneration: 42 });
    expect(badRegister.status).toBe(400);
    const badDelete = await request(socket1, 'DELETE', { expectedGeneration: null });
    expect(badDelete.status).toBe(400);

    const replaced = await request(socket1, 'POST', { conditions: [{ ...condition, once: false }], expectedGeneration: generation1 });
    expect(replaced.status).toBe(201);
    expect(replaced.body.generation).not.toBe(generation1);
    const generation2 = replaced.body.generation;

    const staleDelete = await request(socket1, 'DELETE', { expectedGeneration: generation1 });
    expect(staleDelete.status).toBe(409);
    expect(staleDelete.body.currentGeneration).toBe(generation2);
    expect((await request(socket1, 'GET')).body.generation).toBe(generation2);

    // Record a firing on generation 2, then restart only the HTTP/route fixture
    // against the same disk-backed watch directory.
    for (const observer of firstFixture.observers) observer(event('agent_end'));
    await settle();
    const firstServer = servers.shift()!;
    firstServer.closeAllConnections();
    await new Promise<void>((resolve) => firstServer.close(() => resolve()));

    const socket2 = path.join(root, 'two.sock');
    await startHttpFixture(watchDir, socket2);
    const restarted = await request(socket2, 'GET');
    expect(restarted.status).toBe(200);
    expect(restarted.body.generation).toBe(generation2);
    expect(restarted.body.status).toBe('detached');
    expect(restarted.body.firingCount).toBe(1);

    const deleted = await request(socket2, 'DELETE', { expectedGeneration: generation2 });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ success: true, watchId: 'watch-pi-1', generation: generation2 });
  });

  it('advertises the exact additive watch precondition fields', async () => {
    const routes = createCapabilitiesRoutes({
      claudeService: { isAvailable: async () => true, getBackendMode: async () => 'sdk', getProfiles: () => [] } as never,
      opencodeService: { isAvailable: async () => true, isEnabled: () => true } as never,
      antigravityService: { isAvailable: async () => true } as never,
      blockedPiProviders: [],
    });
    let status = 0;
    let text = '';
    const res = {
      writeHead(code: number) { status = code; return this; },
      end(body: string) { text = body; return this; },
    } as never;
    await routes.handleGetCapabilities({} as never, res);
    expect(status).toBe(200);
    expect(JSON.parse(text).features.watchGenerationPreconditions).toEqual({
      generationField: 'generation',
      registerField: 'expectedGeneration',
      deleteBodyField: 'expectedGeneration',
    });
  });
});
