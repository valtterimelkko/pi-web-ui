import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * Contract 1.64.0 (census bug 18) — the Antigravity conversation id must
 * reach the registry as `nativeSessionId` the moment agy reports it (init
 * event), and MUST SURVIVE turn finalisation. Live validation (disposable
 * server, 2026-10-17 first lane session) found the second half broken: the
 * init write landed, but the end-of-turn registry upsert spread the
 * turn-start snapshot entry over the fresh record and its present-undefined
 * `nativeSessionId` key wiped the init-written value — the recorded
 * conversation id survived only because finalisation set it explicitly.
 *
 * The harness drives a real AntigravityService through sendPrompt with a
 * scripted fake agy child (same wire the stub binary speaks), in two acts so
 * the mid-turn write and its survival can be asserted separately.
 */

const ctrl = vi.hoisted(() => ({
  sessionDir: `/tmp/agy-native-store-${process.pid}-${Math.random().toString(36).slice(2)}`,
  stdout: null as import('node:events').EventEmitter | null,
  child: null as { stdout: import('node:events').EventEmitter } | null,
}));
process.env.ANTIGRAVITY_SESSION_DIR = ctrl.sessionDir;

import { AntigravityService } from '../../../src/antigravity/antigravity-service.js';
import { getSessionRegistry } from '../../../src/session-registry.js';

/** Non-null access that throws instead of using lint-banned `!`. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('required value missing');
  return value;
}

const CONV = 'c-native-1';

const INIT =
  '{"event":"init","conversation_id":"c-native-1","init":{"cwd":"/w","tools":["run_command"],"permission_mode":"always-proceed","model":"gemini-3.6-flash-low"}}';

function delta(text: string, index: number, state: 'ACTIVE' | 'DONE' = 'ACTIVE'): string {
  return JSON.stringify({
    event: 'step_update',
    step_update: { conversation_id: CONV, step_index: index, state, step_type: 'agent_response', text_delta: text },
  });
}

function resultLine(): string {
  return JSON.stringify({
    event: 'result',
    result: {
      conversation_id: CONV,
      status: 'SUCCESS',
      response: ' scripted turn done\n',
      duration_seconds: 1,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 15 },
    },
  });
}

function emitScript(lines: string[]): void {
  (must(ctrl.stdout) as EventEmitter).emit('data', Buffer.from(lines.join('\n') + '\n'));
}

/** Stub spawn: emits the scripted first act on construction (turn goes busy
 *  WITHOUT a terminal result); later acts are pushed to ctrl.stdout. */
vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  const stdout = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { write: (s: string) => boolean }; kill: () => void };
  child.stdout = stdout;
  (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
  (child as unknown as { stdin: { write: (s: string) => boolean } }).stdin = {
    write: () => {
      // First turn impulse carries the init + first delta (turn goes busy
      // WITHOUT a terminal result); later acts are pushed to ctrl.stdout.
      stdout.emit('data', Buffer.from(`${INIT}\n${delta('working', 1)}\n`));
      return true;
    },
  };
  (child as unknown as { kill: () => void }).kill = vi.fn();
  ctrl.stdout = stdout;
  ctrl.child = child;
  return { spawn: vi.fn(() => child) };
});

describe('antigravity nativeSessionId persistence (contract 1.64.0)', () => {
  let tmp: string;
  let service: AntigravityService;
  let sessionId: string;
  let turnDone: Promise<void>;

  async function start(): Promise<void> {
    tmp = mkdtempSync(join(tmpdir(), 'agy-native-'));
    service = new AntigravityService({ registryPath: tmp + '/registry.json' });
    ({ sessionId } = await service.createSession('/tmp/native-test', 'gemini-3.6-flash-low'));
    turnDone = new Promise<void>((resolve, reject) => {
      void service.sendPrompt(sessionId, 'run the scripted turn', () => {}, (err) => err ? reject(err) : resolve());
    });
  }

  it('init write lands mid-turn AND survives end-of-turn finalisation (live regression)', async () => {
    try {
      await start();
      // Act 1 was emitted synchronously on the first turn impulse. The
      // stream opens — init reports the conversation id while the turn is
      // still running (no result yet).
      const registry = getSessionRegistry(tmp + '/registry.json');
      // Poll briefly: the init write is async.
      let midTurnNative: string | undefined;
      for (let i = 0; i < 40 && !midTurnNative; i++) {
        midTurnNative = must((await registry.get(sessionId))).nativeSessionId;
        if (!midTurnNative) await new Promise((r) => setTimeout(r, 25));
      }
      expect(midTurnNative).toBe(CONV);

      // Act 2: the turn finalises (result arrives). The init write must
      // survive the finalisation upsert.
      emitScript([delta(' scripted turn done', 2, 'DONE'), resultLine()]);
      await turnDone;
      const final = must(await registry.get(sessionId));
      expect(final.antigravityConversationId).toBe(CONV);
      expect(final.nativeSessionId).toBe(CONV);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(ctrl.sessionDir, { recursive: true, force: true });
    }
  });
});
