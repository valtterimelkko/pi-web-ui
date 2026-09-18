import { describe, expect, it } from 'vitest';
import { CAPTURE_WORKLET_PATH, CAPTURE_WORKLET_SOURCE } from '../src/lib/voiceLive/captureWorkletSource';
import { captureWorkletPlugin } from '../voice-capture-worklet-plugin';

/**
 * The deployed-UI failure this guards (2026-09-18): capture could not start in
 * production because the only worklet URL was a `blob:`, which the production
 * policy (`script-src 'self'`, no `blob:`) refuses as a script. The build must
 * therefore EMIT the bytes as a same-origin asset, and dev must serve the very
 * same bytes — one source, two delivery paths, no policy change.
 */
describe('capture worklet delivery plugin', () => {
  it('emits the worklet asset the production server will serve', () => {
    const emitted: Array<{ type: string; fileName: string; source: unknown }> = [];
    const plugin = captureWorkletPlugin();
    (plugin.generateBundle as unknown as (...args: unknown[]) => void).call(
      { emitFile: (asset: never) => emitted.push(asset) },
      {},
      {},
    );

    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe('asset');
    // `express.static(client/dist)` serves this at CAPTURE_WORKLET_PATH.
    expect(`/${emitted[0].fileName}`).toBe(CAPTURE_WORKLET_PATH);
    expect(emitted[0].source).toBe(CAPTURE_WORKLET_SOURCE);
  });

  it('answers that path in dev with the same bytes and a script content type', () => {
    let handler: ((req: unknown, res: unknown, next: () => void) => void) | null = null;
    const plugin = captureWorkletPlugin();
    (plugin.configureServer as unknown as (server: unknown) => void).call(plugin, {
      middlewares: { use: (fn: never) => { handler = fn; } },
    });
    expect(handler).not.toBeNull();

    const headers: Record<string, string> = {};
    let body: string | null = null;
    let nextCalled = false;
    handler!(
      { url: `${CAPTURE_WORKLET_PATH}?v=1` },
      { setHeader: (name: string, value: string) => { headers[name] = value; }, end: (value: string) => { body = value; } },
      () => { nextCalled = true; },
    );

    expect(body).toBe(CAPTURE_WORKLET_SOURCE);
    expect(headers['Content-Type']).toContain('javascript');
    expect(nextCalled).toBe(false);
  });

  it('leaves every other request to the rest of the dev server', () => {
    let handler: ((req: unknown, res: unknown, next: () => void) => void) | null = null;
    const plugin = captureWorkletPlugin();
    (plugin.configureServer as unknown as (server: unknown) => void).call(plugin, {
      middlewares: { use: (fn: never) => { handler = fn; } },
    });
    let nextCalled = false;
    handler!({ url: '/assets/app.js' }, { setHeader: () => undefined, end: () => undefined }, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });
});
