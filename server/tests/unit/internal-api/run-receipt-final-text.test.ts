/**
 * Contract 1.47.0 — C2: bounded `finalText` (last assistant text of the run)
 * on run receipts, tail-truncated to 4096 chars with `finalTextTruncated`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { FinalTextTracker, FINAL_TEXT_MAX_CHARS } from '../../../src/internal-api/run-receipts/final-text.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';

const e = (type: string, data: Record<string, unknown> = {}): NormalizedEvent => ({ type, timestamp: Date.now(), data });
const delta = (text: string, id = 'm') => e('message_update', { id, assistantMessageEvent: { type: 'text_delta', delta: text } });

describe('FinalTextTracker', () => {
  it('is undefined until assistant text is observed', () => {
    const t = new FinalTextTracker();
    expect(t.snapshot()).toBeUndefined();
    t.observe(e('agent_start'));
    t.observe(e('tool_execution_start', { toolName: 'Bash' }));
    expect(t.snapshot()).toBeUndefined();
  });

  it('accumulates text deltas of the current assistant message', () => {
    const t = new FinalTextTracker();
    t.observe(e('message_start', { id: 'a1', role: 'assistant' }));
    t.observe(delta('Hello, '));
    t.observe(delta('world.'));
    t.observe(e('message_end', { id: 'a1' }));
    expect(t.snapshot()).toEqual({ text: 'Hello, world.', truncated: false });
  });

  it('keeps only the LAST assistant message (Pi message.role shape) and ignores user text', () => {
    const t = new FinalTextTracker();
    t.observe(e('message_start', { message: { role: 'user' } }));
    t.observe(delta('user prompt echoed as a delta (Antigravity shape)'));
    t.observe(e('message_end', { message: { role: 'user', content: [{ type: 'text', text: 'prompt' }] } }));
    t.observe(e('message_start', { message: { role: 'assistant' } }));
    t.observe(delta('first answer'));
    t.observe(e('message_end', {}));
    t.observe(e('message_start', { message: { role: 'assistant' } }));
    t.observe(delta('final answer'));
    expect(t.snapshot()).toEqual({ text: 'final answer', truncated: false });
  });

  it('prefers the authoritative full assistant message on message_end when present', () => {
    const t = new FinalTextTracker();
    t.observe(e('message_start', { message: { role: 'assistant' } }));
    t.observe(delta('partial'));
    t.observe(e('message_end', { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'full ' }, { type: 'text', text: 'text' }] } }));
    expect(t.snapshot()).toEqual({ text: 'full text', truncated: false });
  });

  it('treats an assistantMessageEvent.content array as a snapshot of the current message', () => {
    const t = new FinalTextTracker();
    t.observe(e('message_start', { role: 'assistant' }));
    t.observe(e('message_update', { assistantMessageEvent: { content: [{ type: 'text', text: 'snap one' }] } }));
    t.observe(e('message_update', { assistantMessageEvent: { content: [{ type: 'text', text: 'snap one two' }] } }));
    expect(t.snapshot()!.text).toBe('snap one two');
  });

  it('ignores thinking deltas and starts a new segment after a tool call, falling back to the previous text', () => {
    const t = new FinalTextTracker();
    t.observe(e('message_start', { role: 'assistant' }));
    t.observe(e('message_update', { assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } }));
    t.observe(delta('Let me check.'));
    t.observe(e('tool_execution_start', { toolName: 'Bash' }));
    t.observe(e('tool_execution_end', { toolName: 'Bash' }));
    expect(t.snapshot()!.text).toBe('Let me check.');
    t.observe(delta('Done: 42.'));
    expect(t.snapshot()!.text).toBe('Done: 42.');
  });

  it('tail-truncates to FINAL_TEXT_MAX_CHARS and flags truncation', () => {
    expect(FINAL_TEXT_MAX_CHARS).toBe(4096);
    const t = new FinalTextTracker();
    t.observe(e('message_start', { role: 'assistant' }));
    t.observe(delta('A'.repeat(3000)));
    t.observe(delta('B'.repeat(3000)));
    const snap = t.snapshot()!;
    expect(snap.truncated).toBe(true);
    expect(snap.text).toHaveLength(4096);
    expect(snap.text.endsWith('B'.repeat(3000))).toBe(true);
    expect(snap.text.startsWith('A')).toBe(true);
  });
});

describe('RunReceiptManager — finalText on receipts', () => {
  let dir: string;
  let manager: RunReceiptManager;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-receipt-final-text-'));
    manager = new RunReceiptManager({ store: new RunReceiptStore(dir) });
  });

  afterEach(async () => {
    await manager.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function begin(runtime: 'pi' | 'claude' = 'claude'): Promise<string> {
    const began = await manager.beginRun({
      sessionId: 's1', runtime, executionInstanceId: 'exec', message: 'hi', mode: 'prompt', verbosity: 'normal', detach: true,
    });
    return began.receipt.runId;
  }

  it('records finalText at agent_end and keeps it on the terminal receipt (and on disk)', async () => {
    const runId = await begin();
    await manager.markStarted(runId);
    await manager.observeEvent(runId, e('message_start', { role: 'assistant' }));
    await manager.observeEvent(runId, delta('The answer is 42.'));
    await manager.observeEvent(runId, e('agent_end'));
    expect(manager.get(runId)).toMatchObject({ finalText: 'The answer is 42.', finalTextTruncated: false });
    const terminal = await manager.finish(runId, { status: 'completed' });
    expect(terminal).toMatchObject({ finalText: 'The answer is 42.', finalTextTruncated: false });

    const reloaded = new RunReceiptManager({ store: new RunReceiptStore(dir) });
    await reloaded.init();
    expect(reloaded.get(runId)).toMatchObject({ finalText: 'The answer is 42.', finalTextTruncated: false });
    await reloaded.shutdown();
  });

  it('records finalText when the run finishes without an agent_end event', async () => {
    const runId = await begin();
    await manager.markStarted(runId);
    await manager.observeEvent(runId, e('message_start', { role: 'assistant' }));
    await manager.observeEvent(runId, delta('partial reply before failure'));
    const terminal = await manager.finish(runId, { status: 'failed', errorCode: 'RUNTIME_ERROR' });
    expect(terminal?.finalText).toBe('partial reply before failure');
  });

  it('omits finalText (absent, not empty) when no assistant text was observed', async () => {
    const runId = await begin();
    await manager.markStarted(runId);
    await manager.observeEvent(runId, e('tool_execution_start', { toolName: 'Bash' }));
    await manager.observeEvent(runId, e('agent_end'));
    const terminal = await manager.finish(runId, { status: 'completed' });
    expect(terminal).not.toHaveProperty('finalText');
    expect(terminal).not.toHaveProperty('finalTextTruncated');
  });

  it('persists a truncated tail for long replies', async () => {
    const runId = await begin('pi');
    await manager.markStarted(runId);
    await manager.observeEvent(runId, e('message_start', { message: { role: 'assistant' } }));
    await manager.observeEvent(runId, delta('x'.repeat(5000) + 'END'));
    await manager.observeEvent(runId, e('agent_end'));
    const terminal = await manager.finish(runId, { status: 'completed' });
    expect(terminal?.finalTextTruncated).toBe(true);
    expect(terminal?.finalText).toHaveLength(4096);
    expect(terminal?.finalText?.endsWith('END')).toBe(true);
  });
});

describe('RunReceiptStore — finalText validation', () => {
  it('rejects an oversized or mistyped finalText', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-receipt-final-text-store-'));
    const store = new RunReceiptStore(dir);
    await store.init();
    const base = {
      runId: 'r1', sessionId: 's', runtime: 'claude' as const, executionInstanceId: 'x', status: 'accepted' as const,
      acceptedAt: new Date().toISOString(),
    };
    await expect(store.create({ ...base, finalText: 'y'.repeat(4097), finalTextTruncated: true })).rejects.toThrow(/finalText/);
    await expect(store.create({ ...base, runId: 'r2', finalText: 'ok', finalTextTruncated: 'no' as never })).rejects.toThrow(/finalText/);
    await store.create({ ...base, runId: 'r3', finalText: 'ok', finalTextTruncated: false });
    expect(store.get('r3')?.finalText).toBe('ok');
    await fs.rm(dir, { recursive: true, force: true });
  });
});
