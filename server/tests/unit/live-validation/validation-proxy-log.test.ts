import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createValidationLogWriter,
  sanitizeValidationCapture,
  sanitizeValidationExtract,
  sanitizeValidationRequestPath,
} from '../../../src/live-validation/validation-proxy-log.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe('validation proxy logging safety', () => {
  it('creates an owner-only log and recursively redacts/bounds unsafe body capture', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'proxy-log-'));
    dirs.push(dir);
    const logPath = path.join(dir, 'capture.jsonl');
    const writer = createValidationLogWriter(logPath);
    const capture = sanitizeValidationCapture({
      accessToken: 'secret-token',
      nested: { authorization: 'Bearer abcdef', safe: 'x'.repeat(20_000) },
      messages: [{ content: 'private prompt' }],
      prompt: 'another private prompt',
      input: 'private input',
    }, 1024);
    expect(writer.append({ ts: 1, body: capture })).toBe(true);
    writer.close();

    expect((await stat(logPath)).mode & 0o777).toBe(0o600);
    const raw = await readFile(logPath, 'utf8');
    expect(raw).not.toContain('secret-token');
    expect(raw).not.toContain('private prompt');
    expect(raw).not.toContain('private input');
    expect(raw.length).toBeLessThan(2_000);
  });

  it('removes query strings and content-shaped explicit extraction paths', () => {
    expect(sanitizeValidationRequestPath('/v1/messages?api_key=private&model=x')).toBe('/v1/messages');
    expect(sanitizeValidationExtract('request.prompt', 'private prompt')).toBe('[content omitted]');
    expect(sanitizeValidationExtract('input', 'private input')).toBe('[content omitted]');
    expect(JSON.stringify(sanitizeValidationCapture('Bearer private-token sk-privatekey123'))).not.toContain('private-token');
  });

  it('fails early for an unwritable path and reports later append failures', async () => {
    expect(() => createValidationLogWriter('/definitely/missing-parent/capture.jsonl')).toThrow();
    const dir = await mkdtemp(path.join(tmpdir(), 'proxy-log-'));
    dirs.push(dir);
    const report = vi.fn();
    const writer = createValidationLogWriter(path.join(dir, 'capture.jsonl'), { reportError: report });
    writer.close();
    expect(writer.append({ ts: 2 })).toBe(false);
    expect(report).toHaveBeenCalled();
  });
});
