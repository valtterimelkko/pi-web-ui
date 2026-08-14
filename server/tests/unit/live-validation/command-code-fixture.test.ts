import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { COMMAND_CODE_FULL_MODEL_CATALOGUE } from '../../../src/command-code/command-code-model-catalog.js';
import { createCommandCodeValidationFixture } from '../../../src/live-validation/command-code-fixture.js';

describe('Command Code validation fixture', () => {
  it('advertises the complete canonical model catalogue with one launcher shebang', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'command-code-fixture-catalogue-test-'));
    try {
      const executable = await createCommandCodeValidationFixture(dir);
      const source = await readFile(executable, 'utf8');
      expect(source.match(/^#!.*$/gm)).toHaveLength(1);
      const child = spawn(executable, ['--no-auto-update', '--list-models'], { cwd: dir, env: { ...process.env, HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      const exitCode = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      expect(exitCode).toBe(0);
      const ids = stdout.split(/\r?\n/).filter(Boolean).map((line) => line.trim().split(/\s{2,}/)[0]);
      expect(ids).toEqual([...COMMAND_CODE_FULL_MODEL_CATALOGUE]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not invent an effective effort for the non-adjustable Muse route', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'command-code-fixture-muse-test-'));
    try {
      const executable = await createCommandCodeValidationFixture(dir);
      const child = spawn(executable, ['-p', '--output-format', 'json', '--model', 'meta/muse-spark-1.2-contributor'], {
        cwd: dir,
        env: { ...process.env, HOME: dir },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stdin.end('Reply with the exact text MUSE-LIVE-OK and nothing else.');
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      expect(exitCode).toBe(0);
      const result = stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).find((entry) => entry.type === 'result');
      expect(result).toBeDefined();
      expect(result.finalText).toBe('MUSE-LIVE-OK');
      expect(result).not.toHaveProperty('effort');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

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
