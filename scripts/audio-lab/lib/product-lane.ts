/**
 * The deterministic product-player lane.
 *
 * Drives the real product read-aloud stack (mounted by the lab bundle, see
 * `browser/lab-main.tsx`) inside the real Chrome from the capsule, and serves
 * `/api/tts` from the cached fixture corpus.
 *
 * Two properties matter:
 *
 *  1. The audio the page receives is recorded here, per request, as the SOURCE
 *     of truth for the oracle. The oracle never assumes what the player asked
 *     for; it compares the captured OS output against the bytes the player
 *     actually received, in the order the intent's chunk list defines.
 *  2. Every request and every arbiter state change is stamped with the browser's
 *     `performance.now()`, so the report can correlate intent with the
 *     independently captured audio instead of asserting that an event happened.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startStaticServer, type StaticServer } from './static-server.js';
import type { FixtureManifest } from './fixtures.js';

export interface TtsRequestRecord {
  index: number;
  text: string;
  voice: string | null;
  bytes: number;
  sha256: string;
  /** Browser-side time the request was intercepted. */
  atPerformanceMs: number;
  /** Bytes the lab served (fixture) or the real endpoint returned. */
  servedFromFixture: boolean;
  status: number;
}

export interface ProductLaneOptions {
  /** Directory holding the built lab bundle. */
  bundleDir: string;
  /** Relative path of the lab page inside the bundle. */
  htmlRelative?: string;
  fixtures: FixtureManifest;
  /** When set, requests are forwarded to a REAL server instead of fixtures. */
  realServerBase?: string;
  /** Cookie header for the real server (cookie-authenticated lane). Applied
   *  explicitly so auth is guaranteed to be exercised server-side rather than
   *  depending on the interception context's cookie jar. */
  authCookieHeader?: string;
  /** When true, served 200 bodies are dumped per request (real-transport
   *  source-of-truth) under attemptDir/source/. */
  dumpServedBodies?: boolean;
  attemptDir: string;
  /** Extra browser flags (e.g. fake microphone for the capture scenarios). */
  chromeArgs?: string[];
}

export interface FaultInjection {
  kind: 'failure' | 'delay';
  text: string;
  /** Milliseconds, for `delay`. */
  ms?: number;
  /** How many requests of this text are still affected. */
  remaining: number;
}

/** Injection activations, in time order, for the report. */
export interface InjectionActivation {
  kind: 'failure' | 'delay';
  text: string;
  ms?: number;
  atPerformanceMs: number;
}

export class ProductLane {
  private server: StaticServer | null = null;
  readonly requests: TtsRequestRecord[] = [];
  readonly injectionLog: InjectionActivation[] = [];
  private readonly injections: FaultInjection[] = [];
  private pageRef: unknown = null;

  constructor(private readonly options: ProductLaneOptions) {}

  /** Make the next `times` requests for `text` fail with a 502. The product
   *  retries a failed chunk ONCE, so one failure exercises the retry path and
   *  two failures exercise terminal failure. */
  failNextRequestFor(text: string, times = 1): void {
    this.injections.push({ kind: 'failure', text, remaining: times });
  }

  /** Make the next request for `text` take `ms` extra before responding. */
  delayNextRequestFor(text: string, ms: number, times = 1): void {
    this.injections.push({ kind: 'delay', text, ms, remaining: times });
  }

  get origin(): string {
    if (!this.server) throw new Error('Lane is not started');
    return this.server.origin;
  }

  get pageUrl(): string {
    const relative = this.options.htmlRelative ?? 'scripts/audio-lab/browser/lab.html';
    return `${this.origin}/${relative}`;
  }

  /** Start the lab's static server and attach request interception. */
  async start(page: unknown): Promise<void> {
    const bundle = this.options.bundleDir;
    if (!existsSync(bundle)) throw new Error(`Lab bundle missing: ${bundle} (build it first)`);
    this.server = await startStaticServer(bundle);
    this.pageRef = page;
    await this.installRouting();
  }

  private async installRouting(): Promise<void> {
    const page = this.pageRef as {
      route: (
        pattern: string,
        handler: (route: {
          request: () => { postDataJSON: () => unknown; url: () => string };
          fulfill: (options: Record<string, unknown>) => Promise<void>;
          fetch: () => Promise<{
            status: () => number;
            body: () => Promise<Buffer>;
            headers: () => Record<string, string>;
          }>;
        }) => Promise<void>
      ) => Promise<void>;
      evaluate: <T>(fn: () => T) => Promise<T>;
    };
    const byText = new Map(this.options.fixtures.chunks.map((chunk) => [chunk.text, chunk]));
    let index = 0;
    await page.route('**/api/tts', async (route) => {
      const request = route.request();
      const body = request.postDataJSON() as { text?: string; voice?: string } | null;
      const text = body?.text ?? '';
      const voice = body?.voice ?? null;
      const atPerformanceMs = await page.evaluate(() => Math.round(performance.now() * 1000) / 1000);

      // Fault injection is applied BEFORE serving, and logged, so a scenario
      // can prove it really injected the fault it claims to have tested. An
      // unlogged "slow TTS" scenario is indistinguishable from one that did
      // nothing.
      const injection = this.injections.find(
        (entry) => entry.remaining > 0 && (entry.text === text || entry.text === '*')
      );
      if (injection) {
        injection.remaining -= 1;
        if (injection.kind === 'failure') {
          this.injectionLog.push({ kind: 'failure', text, atPerformanceMs });
          this.requests.push({
            index: index++,
            text,
            voice,
            bytes: 0,
            sha256: '',
            atPerformanceMs,
            servedFromFixture: !this.options.realServerBase,
            status: 502,
          });
          await route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"injected failure"}' });
          return;
        }
        this.injectionLog.push({ kind: 'delay', text, ms: injection.ms, atPerformanceMs });
        await new Promise((resolve) => setTimeout(resolve, injection.ms ?? 1000));
      }

      if (this.options.realServerBase) {
        // Real transport: forward to the disposable server and record what came
        // back. This keeps the production path exercised rather than concealed.
        const target = `${this.options.realServerBase.replace(/\/$/, '')}/api/tts`;
        const forwarded = await route.fetch({
          url: target,
          ...(this.options.authCookieHeader
          ? { headers: { cookie: this.options.authCookieHeader, 'content-type': 'application/json' } }
          : {}),
        });
        const bytes = Buffer.from(await forwarded.body());
        if (this.options.dumpServedBodies && forwarded.status() === 200) {
          const servedDir = path.join(this.options.attemptDir, 'source');
          mkdirSync(servedDir, { recursive: true, mode: 0o700 });
          writeFileSync(path.join(servedDir, `req-${String(index).padStart(2, '0')}.mp3`), bytes, { mode: 0o600 });
        }
        const entry: TtsRequestRecord = {
          index: index++,
          text,
          voice,
          bytes: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          atPerformanceMs,
          servedFromFixture: false,
          status: forwarded.status(),
        };
        this.requests.push(entry);
        await route.fulfill({
          status: forwarded.status(),
          headers: { ...forwarded.headers(), 'content-type': 'audio/mpeg' },
          body: bytes,
        });
        return;
      }

      const fixture = byText.get(text);
      if (!fixture) {
        // A missing fixture is a lab bug, not a product defect: answering with
        // silence would silently turn it into a "missing speech" finding.
        this.requests.push({
          index: index++,
          text,
          voice,
          bytes: 0,
          sha256: '',
          atPerformanceMs,
          servedFromFixture: true,
          status: 404,
        });
        await route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"no fixture"}' });
        return;
      }
      const bytes = readFileSync(fixture.mp3Path);
      this.requests.push({
        index: index++,
        text,
        voice,
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        atPerformanceMs,
        servedFromFixture: true,
        status: 200,
      });
      await route.fulfill({ status: 200, contentType: 'audio/mpeg', body: bytes });
    });
  }

  /** Write the request log next to the recording as evidence. */
  writeRequestLog(): string {
    const file = path.join(this.options.attemptDir, 'events', 'tts-requests.json');
    writeFileSync(file, `${JSON.stringify(this.requests, null, 2)}\n`);
    return file;
  }

  async stop(): Promise<void> {
    if (this.server) {
      await this.server.close();
      this.server = null;
    }
  }
}
