import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

describe('M1: Claude channel event-log gating', () => {
  async function source(): Promise<string> {
    return readFile(path.resolve(process.cwd(), '../pi-claude-channel/server.ts'), 'utf8');
  }

  it('keeps post-tool-use activity logs behind the debug gate', async () => {
    const sourceText = await source();
    const block = sourceText.match(/case "post-tool-use":[\s\S]*?case "stop":/)?.[0];
    expect(block).toBeDefined();
    expect(block).toContain('dbg(`');
    expect(block).not.toContain('console.error(`[hook] post-tool-use');
  });

  it('keeps per-turn prompt-received activity behind the debug gate', async () => {
    const sourceText = await source();
    expect(sourceText).toContain('dbg(`[ws] prompt received:');
    expect(sourceText).not.toContain('console.error(`[ws] prompt received:');
  });
});
