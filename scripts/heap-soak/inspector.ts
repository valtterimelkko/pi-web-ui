/**
 * Minimal Chrome DevTools Protocol client over the Node inspector, used to:
 *  - force a full GC (HeapProfiler.collectGarbage) before every heap reading,
 *    since heapUsed otherwise includes uncollected garbage;
 *  - read process.memoryUsage() via Runtime.evaluate in the main context;
 *  - take a heap snapshot, streamed in chunks to a file;
 *  - measure a CDP round-trip as an event-loop-lag PROXY (explicitly labelled
 *    as such everywhere it's surfaced — it is NOT a real event-loop-lag probe
 *    inside the target process).
 *
 * Uses the `ws` package already in node_modules (no new dependency).
 */
import { createWriteStream } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';

const execFile = promisify(execFileCb);

/**
 * Confirms the inspector port is bound to 127.0.0.1 only (never 0.0.0.0 / *),
 * by inspecting the live listening-socket table rather than trusting the flag
 * we passed. Throws if the port is not found listening at all, or if it is
 * listening on a non-loopback address.
 */
export async function assertInspectorLoopbackOnly(port: number): Promise<string> {
  const { stdout } = await execFile('ss', ['-H', '-ltn']);
  const line = stdout.split('\n').find((l) => l.includes(`:${port} `) || l.trimEnd().endsWith(`:${port}`));
  if (!line) throw new Error(`No listening socket found for inspector port ${port}`);
  const localAddress = line.trim().split(/\s+/)[3] ?? '';
  if (!localAddress.startsWith('127.0.0.1:') && localAddress !== `127.0.0.1:${port}`) {
    throw new Error(`Inspector port ${port} is not loopback-only (observed local address: ${localAddress})`);
  }
  return localAddress;
}

export interface InspectorTarget {
  webSocketDebuggerUrl: string;
  title: string;
  type: string;
}

/** GET http://127.0.0.1:<port>/json/list — loopback only, matches the --inspect=127.0.0.1:<port> binding. */
export function listInspectorTargets(port: number): Promise<InspectorTarget[]> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/json/list', method: 'GET' }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk.toString(); });
      res.on('end', () => {
        try { resolve(JSON.parse(raw) as InspectorTarget[]); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('inspector /json/list timed out')));
    req.end();
  });
}

export class InspectorClient {
  private ws: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly chunkListeners = new Set<(params: { chunk: string }) => void>();

  private constructor(private readonly url: string) {}

  static async connect(port: number, timeoutMs = 10_000): Promise<InspectorClient> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const targets = await listInspectorTargets(port);
        const target = targets.find((t) => t.type === 'node' || t.webSocketDebuggerUrl);
        if (!target) throw new Error('no inspector target with a webSocketDebuggerUrl yet');
        const client = new InspectorClient(target.webSocketDebuggerUrl);
        await client.open();
        return client;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error(`Failed to connect to inspector on 127.0.0.1:${port}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
      this.ws.on('message', (data) => this.handleMessage(data.toString()));
    });
  }

  private handleMessage(raw: string): void {
    const msg = JSON.parse(raw) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown };
    if (msg.method === 'HeapProfiler.addHeapSnapshotChunk') {
      const params = msg.params as { chunk: string };
      for (const listener of this.chunkListeners) listener(params);
      return;
    }
    if (msg.id === undefined) return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error.message));
    else pending.resolve(msg.result);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const ws = this.ws;
    if (!ws) throw new Error('InspectorClient is not connected');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as T); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async enable(): Promise<void> {
    await this.send('Runtime.enable');
    await this.send('HeapProfiler.enable');
  }

  /** Forces a full synchronous GC via the inspector protocol. */
  async collectGarbage(): Promise<void> {
    await this.send('HeapProfiler.collectGarbage');
  }

  /** Reads process.memoryUsage() from the target's main execution context. */
  async readMemoryUsage(): Promise<NodeJS.MemoryUsage> {
    const result = await this.send<{ result: { value: string } }>('Runtime.evaluate', {
      expression: 'JSON.stringify(process.memoryUsage())',
      includeCommandLineAPI: false,
      returnByValue: true,
    });
    return JSON.parse(result.result.value) as NodeJS.MemoryUsage;
  }

  /**
   * CDP round-trip time in ms for a trivial no-op evaluate. This is a PROXY
   * for event-loop lag (queueing delay for our own message plus the target's
   * processing time), not a measurement of lag inside the target's own event
   * loop — labelled `eventLoopLagMsProxy` everywhere it is recorded.
   */
  async measureRoundTripMs(): Promise<number> {
    const start = Date.now();
    await this.send('Runtime.evaluate', { expression: '1', includeCommandLineAPI: false, returnByValue: true });
    return Date.now() - start;
  }

  /** Streams a heap snapshot to `destPath`, returning the number of chunk events received. */
  async takeHeapSnapshot(destPath: string): Promise<{ chunkCount: number; bytesWritten: number }> {
    const stream = createWriteStream(destPath);
    let chunkCount = 0;
    let bytesWritten = 0;
    const listener = (params: { chunk: string }) => {
      chunkCount += 1;
      bytesWritten += Buffer.byteLength(params.chunk);
      stream.write(params.chunk);
    };
    this.chunkListeners.add(listener);
    try {
      await this.send('HeapProfiler.takeHeapSnapshot', {}, 5 * 60_000);
    } finally {
      this.chunkListeners.delete(listener);
      await new Promise<void>((resolve, reject) => stream.end((err?: Error | null) => (err ? reject(err) : resolve())));
    }
    return { chunkCount, bytesWritten };
  }

  close(): void {
    this.ws?.close();
  }
}
