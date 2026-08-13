import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createCommandCodeValidationFixture } from '../../../src/live-validation/command-code-fixture.js';

describe('Command Code validation fixture', () => {
  it('returns the browser-path sentinel when the browser scenario asks for it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'command-code-fixture-test-'));
    try {
      const executable = await createCommandCodeValidationFixture(dir);
      const child = spawn(executable, ['-p', '--output-format', 'json', '--model', 'qwen/qwen3.8-max', '--effort', 'medium'], {
        cwd: dir,
        env: { ...process.env, HOME: dir },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stdin.end('Reply with the exact text COMMAND-CODE-BROWSER-LIVE-OK and nothing else.');
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('COMMAND-CODE-BROWSER-LIVE-OK');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
