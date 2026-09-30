/**
 * C3a (contract 1.58.0): completion-block capture on run receipts.
 *
 * A run whose assistant output ends with a ```completion block gets the
 * parsed block (`completion`) or the typed parse error (`completionError`)
 * on its receipt. The parse uses the run's FULL final assistant text — a
 * block near the start of a long final message must not be cut by the
 * 4096-character `finalText` tail.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { FinalTextTracker, FINAL_TEXT_MAX_CHARS } from '../../../src/internal-api/run-receipts/final-text.js';
import { COMPLETION_PARSE_WINDOW_CHARS } from '../../../src/internal-api/completion/completion-schema.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';
import type { RunReceipt } from '../../../src/internal-api/types.js';

const e = (type: string, data: Record<string, unknown> = {}): NormalizedEvent => ({ type, timestamp: Date.now(), data });
const delta = (text: string, id = 'm') => e('message_update', { id, assistantMessageEvent: { type: 'text_delta', delta: text } });

const BLOCK_JSON = JSON.stringify({
  schema: 'pi-completion/v1',
  status: 'done',
  commands: [{ command: 'npm test', exitCode: 0 }],
  commits: [{ sha: 'abcdef1234567', repo: '/repo' }],
});

const baseInput = {
  sessionId: 'session-1',
  runtime: 'pi' as const,
  executionInstanceId: 'pi-local-default',
  model: 'provider/model',
  message: 'run the task',
  mode: 'prompt' as const,
  verbosity: 'answers' as const,
  detach: false,
};

describe('C3a — completion capture on run receipts', () => {
  let dir: string;
  let now: number;
  let manager: RunReceiptManager;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-c3a-receipt-'));
    now = Date.parse('2026-07-15T12:00:00.000Z');
    let n = 0;
    manager = new RunReceiptManager({
      store: new RunReceiptStore(dir, { now: () => now }),
      now: () => now,
      idFactory: () => `run-${++n}`,
      metrics: undefined,
    });
    await manager.init();
  });

  afterEach(async () => {
    await manager.shutdown();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  async function runWithFinalText(finalText: string, id = 's'): Promise<RunReceipt | undefined> {
    const begun = await manager.beginRun({ ...baseInput, sessionId: id });
    if (begun.kind !== 'created') throw new Error('expected created');
    await manager.observeEvent(begun.receipt.runId, e('message_start', { message: { role: 'assistant' } }));
    // Stream the final text in chunks like a real adapter.
    for (let i = 0; i < finalText.length; i += 512) {
      await manager.observeEvent(begun.receipt.runId, delta(finalText.slice(i, i + 512), id));
    }
    await manager.observeEvent(begun.receipt.runId, e('agent_end', {}));
    await manager.finish(begun.receipt.runId);
    return manager.get(begun.receipt.runId);
  }

  it('a run whose final text carries a valid block gets completion on its receipt', async () => {
    const receipt = await runWithFinalText(`All gates green.\n\n\`\`\`completion\n${BLOCK_JSON}\n\`\`\`\nDone.`);
    expect(receipt?.completion).toBeDefined();
    expect(receipt?.completion?.status).toBe('done');
    expect(receipt?.completion?.commands).toEqual([{ command: 'npm test', exitCode: 0 }]);
    expect(receipt?.completionError).toBeUndefined();
  });

  it('a run with no block has neither completion nor completionError (additive absence)', async () => {
    const receipt = await runWithFinalText('Just a plain answer, no block.');
    expect(receipt?.completion).toBeUndefined();
    expect(receipt?.completionError).toBeUndefined();
  });

  it('a malformed block surfaces as a typed completionError, never a throw', async () => {
    const receipt = await runWithFinalText('```\u200bcompletion\n{"schema": "pi-completion/v1", oops\n```'.replace('\u200b', ''));
    expect(receipt?.completion).toBeUndefined();
    expect(receipt?.completionError?.code).toBe('MALFORMED_JSON');
  });

  it('parses the run full final assistant text, not the 4096-char finalText tail', async () => {
    // The block sits EARLY in a >4096-char final message; the finalText tail
    // truncation must not decide the parse.
    const filler = 'Narrative. '.repeat(500); // ~5500 chars of prose after the block
    const finalText = `\`\`\`completion\n${BLOCK_JSON}\n\`\`\`\n${filler}`;
    const receipt = await runWithFinalText(finalText, 'long-final');
    expect(receipt?.finalTextTruncated).toBe(true);
    expect((receipt?.finalText ?? '').length).toBe(FINAL_TEXT_MAX_CHARS);
    expect(receipt?.finalText?.startsWith('```completion')).toBe(false);
    expect(receipt?.completion?.status).toBe('done');
  });

  it('a schema-violating block surfaces as SCHEMA_VIOLATION with the field path', async () => {
    const receipt = await runWithFinalText(
      `\`\`\`completion\n${JSON.stringify({ schema: 'pi-completion/v1', status: 'done', commits: [{ sha: 'nope' }] })}\n\`\`\``,
      'schema-bad',
    );
    expect(receipt?.completionError?.code).toBe('SCHEMA_VIOLATION');
    expect(receipt?.completionError?.fieldPath).toBe('commits.0.sha');
  });

  it('records the json-tagged delimiter on the receipt when the block arrived in a json fence (correction 01)', async () => {
    const receipt = await runWithFinalText(
      `\`\`\`json\n${JSON.stringify({ schema: 'pi-completion/v1', status: 'done' })}\n\`\`\`\n`,
      'json-tagged-run',
    );
    expect(receipt?.completion?.status).toBe('done');
    expect(receipt?.completionDelimiter).toBe('json-tagged');
  });

  it('records the completion delimiter on the receipt for the protocol fence', async () => {
    const receipt = await runWithFinalText(`\`\`\`completion\n${BLOCK_JSON}\n\`\`\``, 'delimiter-run');
    expect(receipt?.completionDelimiter).toBe('completion');
  });

  it('a run cancelled before any assistant text has neither field', async () => {
    const begun = await manager.beginRun({ ...baseInput, sessionId: 'cancelled-early' });
    if (begun.kind !== 'created') throw new Error('expected created');
    const receipt = await manager.cancelRun(begun.receipt.runId);
    expect(receipt?.status).toBe('cancelled');
    expect(receipt?.completion).toBeUndefined();
    expect(receipt?.completionError).toBeUndefined();
  });

  it('fires the completion listener exactly once per run with the capture and runId source', async () => {
    const captures: Array<{ sessionId: string; runId: string; receipt: RunReceipt }> = [];
    manager.addCompletionListener((capture) => captures.push(capture));
    const receipt = await runWithFinalText(`\`\`\`completion\n${BLOCK_JSON}\n\`\`\``, 'listener-run');
    expect(captures).toHaveLength(1);
    expect(captures[0].sessionId).toBe('listener-run');
    expect(captures[0].runId).toBe(receipt?.runId);
    expect(captures[0].receipt.completion?.status).toBe('done');
    expect(captures[0].receipt.completionError).toBeUndefined();
  });

  it('does not fire the completion listener when no block was present', async () => {
    const captures: unknown[] = [];
    manager.addCompletionListener(() => captures.push(1));
    await runWithFinalText('no block here', 'listener-none');
    expect(captures).toHaveLength(0);
  });
});

describe('C3a — completion scan tracker (bounded tail)', () => {
  it('FinalTextTracker accepts a wider cap for the completion scan', () => {
    const t = new FinalTextTracker({ maxChars: COMPLETION_PARSE_WINDOW_CHARS });
    t.observe(e('message_start', { role: 'assistant' }));
    t.observe(delta('A'.repeat(COMPLETION_PARSE_WINDOW_CHARS + 100)));
    expect(t.snapshot()?.truncated).toBe(true);
    expect(t.snapshot()?.text.length).toBe(COMPLETION_PARSE_WINDOW_CHARS);
    // Default tracker unchanged.
    const plain = new FinalTextTracker();
    plain.observe(e('message_start', { role: 'assistant' }));
    plain.observe(delta('A'.repeat(FINAL_TEXT_MAX_CHARS + 10)));
    expect(plain.snapshot()?.text.length).toBe(FINAL_TEXT_MAX_CHARS);
  });
});
