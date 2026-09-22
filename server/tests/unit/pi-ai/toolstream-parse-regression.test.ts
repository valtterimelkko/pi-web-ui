/**
 * Regression tests for the 2026-09-12 event-loop stall, Defect B (the trigger):
 * quadratic per-delta re-parsing of streamed tool-call arguments in
 * `@earendil-works/pi-ai`'s openai-completions adapter.
 *
 * The defect: every `tool_calls` function-arguments delta executed
 *   block.partialArgs = (block.partialArgs ?? "") + delta;   // O(n) copy
 *   block.arguments = parseStreamingJson(block.partialArgs); // O(n) parse
 * `parseStreamingJson` on an incomplete string runs two throwing `JSON.parse`
 * attempts, a full `repairJson` walk and `partialParse` — linear per call,
 * quadratic over the stream, all synchronous on the event loop. Measured on
 * this host: 0.4 ms/call at 5 KB accumulating to ~14 ms/call at 460 KB; one
 * runaway 131k-token generation integrated to ~124 s of pure main-thread CPU.
 *
 * The fix is a guarded local patch (scripts/patch-pi-ai-toolstream.mjs, wired
 * as the repo postinstall): parse on a ~250 ms throttle instead of per delta,
 * keep the authoritative final parse in finishBlock, and abort the request
 * with a clear error once accumulated arguments exceed 64 KB.
 *
 * These tests pin three things:
 *   1. the patch is actually applied to every physical pi-ai copy under
 *      node_modules (loud failure on `npm ci` / version bump without re-patch);
 *   2. a large tool-args stream performs O(1) parses per ~250 ms window, not
 *      one per delta — asserted on parse COUNT, never on timing;
 *   3. runaway accumulation is cut off by the 64 KB cap with a clear error
 *      instead of streaming to the provider token ceiling.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const piAiCopies = [
  // Root copy (what server/src resolves).
  resolve(repoRoot, 'node_modules', '@earendil-works', 'pi-ai'),
  // Nested copy inside pi-coding-agent (what the in-process hosted pi sessions
  // resolve — nearest node_modules wins; this is the path that stalled).
  resolve(repoRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'node_modules', '@earendil-works', 'pi-ai'),
];

const patchState = vi.hoisted(() => ({ parseCalls: 0 }));

vi.mock('@earendil-works/pi-ai/utils/json-parse', async () => {
  const actual = await vi.importActual('@earendil-works/pi-ai/utils/json-parse') as {
    parseStreamingJson: (input: string) => unknown;
  };
  return {
    parseStreamingJson: (...args: Parameters<typeof actual.parseStreamingJson>) => {
      patchState.parseCalls += 1;
      return actual.parseStreamingJson(...args);
    },
  };
});

// Static import: vi.mock is hoisted above imports, so the adapter's json-parse
// import is intercepted when this resolves. Both specifiers resolve through the
// package exports map to the same dist files the adapter imports relatively.
import { stream } from '@earendil-works/pi-ai/api/openai-completions';

type StreamFn = typeof import('@earendil-works/pi-ai/api/openai-completions').stream;
const streamSimple: StreamFn = stream as unknown as StreamFn;

type ChatChunk = Record<string, unknown>;

function toolArgsChunk(id: string, args: string, finish: string | null = null): ChatChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'test-model',
    choices: [{
      index: 0,
      delta: finish === null
        ? { tool_calls: [{ index: 0, id, function: { name: 'bash', arguments: args } }] }
        : {},
      finish_reason: finish,
    }],
  };
}

/** Build an SSE Response whose body streams the given chat chunks. */
function sseResponse(chunks: ChatChunk[]): Response {
  const encoder = new TextEncoder();
  const lines = [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'];
  const body = new ReadableStream<Uint8Array>({
    async start(controller): Promise<void> {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

interface CollectedEvents {
  events: { type: string; [key: string]: unknown }[];
  done: { message?: { content?: Array<Record<string, unknown>> } } | undefined;
  error: { reason?: string; error?: { errorMessage?: string; stopReason?: string } } | undefined;
}

async function runToolArgsStream(deltaCount: number, deltaChars: number): Promise<CollectedEvents> {
  const chunks: ChatChunk[] = [];
  const piece = 'y'.repeat(deltaChars);
  for (let index = 0; index < deltaCount; index++) {
    chunks.push(toolArgsChunk('call-1', index === 0 ? `{"code":"${piece}` : piece));
  }
  chunks.push(toolArgsChunk('call-1', '"}', 'stop'));
  const fetch = vi.fn(async (): Promise<Response> => sseResponse(chunks));
  const model = { id: 'test-model', provider: 'test-provider', name: 'Test Model', baseUrl: 'http://127.0.0.1:9/v1', input: ['text'] };
  const context = { messages: [], tools: [] };
  const eventStream = streamSimple(model as never, context as never, { apiKey: 'test-key', fetch, maxRetries: 0 } as never);
  const collected: CollectedEvents = { events: [], done: undefined, error: undefined };
  for await (const event of eventStream) {
    collected.events.push(event);
    if (event.type === 'done') collected.done = event as CollectedEvents['done'];
    if (event.type === 'error') collected.error = event as CollectedEvents['error'];
  }
  return collected;
}

describe('pi-ai toolstream patch guard', () => {
  it('is applied to every physical pi-ai copy under node_modules', () => {
    for (const copy of piAiCopies) {
      const source = readFileSync(resolve(copy, 'dist', 'api', 'openai-completions.js'), 'utf8');
      expect(
        source.includes('PARTIAL_ARGS_PARSE_INTERVAL_MS') && source.includes('MAX_STREAMING_TOOL_ARGS_CHARS'),
        `pi-ai copy at ${copy} is missing the toolstream throttle/cap patch. ` +
        'The dependency was likely reinstalled or updated. Re-apply it: `node scripts/patch-pi-ai-toolstream.mjs` ' +
        '(runs automatically on postinstall), then re-run this suite.',
      ).toBe(true);
    }
  });

  it('pins the patched pi-ai version so silent upgrades cannot ship unpatched', () => {
    for (const copy of piAiCopies) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pkg = JSON.parse(readFileSync(resolve(copy, 'package.json'), 'utf8')) as { version: string };
      expect(pkg.version, `${copy} version drifted`).toBe('0.87.0');
    }
  });
});

describe('pi-ai streamed tool-args parsing (stall trigger regression)', () => {
  it('does not re-parse accumulated arguments on every delta (parse count, not timing)', async () => {
    // 200 deltas × 300 chars = 60 KB of accumulated arguments in one tool call
    // (deliberately under the 64 KB cap so the stream can complete normally).
    patchState.parseCalls = 0;
    const collected = await runToolArgsStream(200, 300);

    // The stream completed normally and the deferred final parse is correct.
    expect(collected.error).toBeUndefined();
    expect(collected.done).toBeDefined();
    const toolCall = collected.done?.message?.content?.find((block) => block.type === 'toolCall') as
      | { arguments?: Record<string, unknown> } | undefined;
    expect(toolCall?.arguments).toEqual({ code: 'y'.repeat(200 * 300) });
    expect(collected.events.some((event) => event.type === 'toolcall_end')).toBe(true);

    // Unpatched: one parse per delta + the final finishBlock parse ≈ 201.
    // Patched: first delta + finishBlock ≈ 2 (throttle window 250 ms). The bound
    // is generous for slow CI crossing a few throttle windows, but two orders
    // of magnitude below the unpatched count.
    expect(patchState.parseCalls).toBeLessThanOrEqual(12);
  }, 30_000);

  it('aborts a runaway tool-args stream at the accumulation cap with a clear error', async () => {
    // 130 deltas × 600 chars = 78 KB > 64 KB cap: must fail early with a clear
    // error instead of streaming on to the provider token ceiling.
    patchState.parseCalls = 0;
    const collected = await runToolArgsStream(130, 600);

    expect(collected.done).toBeUndefined();
    expect(collected.error).toBeDefined();
    expect(collected.error?.error?.stopReason).toBe('error');
    expect(collected.error?.error?.errorMessage).toMatch(/more than 65536 characters/i);
    expect(collected.error?.error?.errorMessage).toMatch(/bash/);
  }, 30_000);
});
