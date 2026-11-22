import { describe, it, expect, vi, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';

/**
 * Parent-visible provider-error classification (lane C).
 *
 * When an agy turn fails, the service finalises it as an error turn. Two things
 * must reach the caller additively:
 *
 *   1. `agent_end` data carries `errorClass` (`quota` | `transient` | `other`),
 *      plus `resetAt` when the provider text states one — so a parent reading
 *      events can tell "stop" from "wait and retry".
 *   2. The completion error is an `AgyProviderTurnError` for quota/transient, so
 *      the run receipt's `errorCode` is `PROVIDER_QUOTA_EXHAUSTED` /
 *      `PROVIDER_TRANSIENT` instead of the generic `RUNTIME_ERROR`.
 *
 * Existing fields and values are unchanged for any error: `error` still carries
 * the verbatim provider text and `result`/`usage` keep their shapes. The
 * persisted turn keeps the raw text, which is what the goal sweeper classifies.
 */

const ctrl = vi.hoisted(() => {
  const sessionDir = `/tmp/agy-error-class-store-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const state = { sessionDir, registryPath: `${sessionDir}/registry.json`, scripted: '' };
  process.env.ANTIGRAVITY_SESSION_DIR = sessionDir;
  return state;
});

import { AgyProviderTurnError, AntigravityService } from '../../../src/antigravity/antigravity-service.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';

/** Non-null access that throws instead of using lint-banned `!`. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('required value missing');
  return value;
}

const QUOTA = 'RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).';
const QUOTA_WITH_RESET = `${QUOTA} retry after 2026-11-22T09:30:00Z`;
const TRANSIENT_500 = 'INTERNAL (code 500): Internal error encountered.';
const TRANSIENT_503 =
  'Our servers are experiencing high traffic right now, please try again in a minute. (UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server)';
const OTHER = 'stall';

const INIT =
  '{"event":"init","conversation_id":"c-err-1","init":{"cwd":"/w","tools":["run_command"],"permission_mode":"always-proceed","model":"gemini-3.8-flash-high"}}';

function errorResult(errorText: string): string {
  return JSON.stringify({
    event: 'result',
    result: {
      conversation_id: 'c-err-1',
      status: 'ERROR',
      response: '',
      duration_seconds: 1,
      num_turns: 1,
      error: errorText,
      usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
    },
  });
}

function fakeSpawnChild() {
  const child = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = new EventEmitter() as EventEmitter & { write: (s: string) => boolean; destroyed: boolean };
  stdin.destroyed = false;
  stdin.write = () => {
    if (stdout.listenerCount('data') > 0) stdout.emit('data', Buffer.from(ctrl.scripted));
    return true;
  };
  (child as unknown as { stdout: EventEmitter }).stdout = stdout;
  (child as unknown as { stderr: EventEmitter }).stderr = stderr;
  (child as unknown as { stdin: typeof stdin }).stdin = stdin;
  (child as unknown as { kill: () => void }).kill = vi.fn();
  return child;
}

async function runFailedTurn(errorText: string): Promise<{
  events: NormalizedEvent[];
  completionError: Error | undefined;
  turn: Awaited<ReturnType<AntigravityService['getLastCompletedTurn']>>;
}> {
  ctrl.scripted = `${INIT}\n${errorResult(errorText)}\n`;
  const child = fakeSpawnChild();
  const service = new AntigravityService({
    registryPath: ctrl.registryPath,
    streamSpawnFn: (() => child) as unknown as typeof import('node:child_process').spawn,
  });
  const { sessionId } = await service.createSession('/tmp/error-class-test', 'gemini-3.8-flash-high');
  const events: NormalizedEvent[] = [];
  let completionError: Error | undefined;
  await new Promise<void>((resolve) => {
    void service.sendPrompt(sessionId, 'do the failing turn', (e) => events.push(e), (err) => {
      completionError = err;
      resolve();
    });
  });
  return { events, completionError, turn: await service.getLastCompletedTurn(sessionId) };
}

function agentEnd(events: NormalizedEvent[]): Record<string, unknown> {
  const found = events.find((e) => e.type === 'agent_end');
  return must(found).data as Record<string, unknown>;
}

describe('antigravity failed turn — parent-visible error class', () => {
  it('marks a RESOURCE_EXHAUSTED turn as quota on agent_end, with the verbatim error preserved', async () => {
    const { events } = await runFailedTurn(QUOTA);
    const data = agentEnd(events);
    expect(data.errorClass).toBe('quota');
    expect(data.error).toBe(QUOTA);
    expect(data.result).toBe(null);
    expect(data.resetAt).toBeUndefined();
  });

  it('carries the reset instant on agent_end when the provider states one', async () => {
    const { events } = await runFailedTurn(QUOTA_WITH_RESET);
    expect(agentEnd(events).errorClass).toBe('quota');
    expect(agentEnd(events).resetAt).toBe('2026-11-22T09:30:00.000Z');
  });

  it.each([TRANSIENT_500, TRANSIENT_503])('marks %j as transient', async (text) => {
    const { events } = await runFailedTurn(text);
    expect(agentEnd(events).errorClass).toBe('transient');
    expect(agentEnd(events).error).toBe(text);
  });

  it('keeps unclassified errors as other, with today\'s fields and values unchanged', async () => {
    const { events } = await runFailedTurn(OTHER);
    const data = agentEnd(events);
    expect(data.errorClass).toBe('other');
    expect(data.result).toBe(null);
    expect(data.usage).toEqual({});
    expect(data.error).toBe(OTHER);
  });

  it('persists the raw provider text on the failed turn, which is what the goal sweeper classifies', async () => {
    const { turn } = await runFailedTurn(QUOTA);
    expect(turn).toMatchObject({ status: 'error', error: QUOTA });
  });

  it('hands quota/transient failures to the caller as AgyProviderTurnError so the receipt can name them', async () => {
    const quota = await runFailedTurn(QUOTA);
    expect(quota.completionError).toBeInstanceOf(AgyProviderTurnError);
    expect((quota.completionError as AgyProviderTurnError).errorClass).toBe('quota');

    const transient = await runFailedTurn(TRANSIENT_503);
    expect(transient.completionError).toBeInstanceOf(AgyProviderTurnError);
    expect((transient.completionError as AgyProviderTurnError).errorClass).toBe('transient');
  });

  it('leaves an unclassified failure as a plain Error (the pre-existing receipt behaviour)', async () => {
    const { completionError } = await runFailedTurn(OTHER);
    expect(completionError).toBeInstanceOf(Error);
    expect(completionError).not.toBeInstanceOf(AgyProviderTurnError);
  });
});

afterAll(() => {
  try {
    rmSync(ctrl.sessionDir, { recursive: true, force: true });
  } catch { /* tmp cleanup best-effort */ }
});
