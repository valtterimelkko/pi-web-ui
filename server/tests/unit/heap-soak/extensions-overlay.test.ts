import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyExtensionsOverlays } from '../../../src/live-validation/heap-soak/extensions-overlay.js';

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeExtension(dir: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'index.ts'), content);
}

describe('applyExtensionsOverlays (B0 defect 6)', () => {
  it('overlays a single extension directory into <agentDir>/extensions/<name>', () => {
    const agentDir = tempDir('agent-dir-');
    const fix = tempDir('fix-');
    writeExtension(path.join(fix, 'subagent'), 'export const fixed = true;\n');

    const result = applyExtensionsOverlays(agentDir, [path.join(fix, 'subagent')]);

    expect(result.applied.map((a) => a.name)).toEqual(['subagent']);
    const copied = readFileSync(path.join(agentDir, 'extensions', 'subagent', 'index.ts'), 'utf8');
    expect(copied).toContain('fixed = true');
  });

  it('accepts a directory OF extension directories and overlays each child', () => {
    const agentDir = tempDir('agent-dir-');
    const fix = tempDir('fix-');
    writeExtension(path.join(fix, 'subagent'), 'subagent-fix\n');
    writeExtension(path.join(fix, 'memory'), 'memory-fix\n');

    applyExtensionsOverlays(agentDir, [fix]);

    expect(readFileSync(path.join(agentDir, 'extensions', 'subagent', 'index.ts'), 'utf8')).toContain('subagent-fix');
    expect(readFileSync(path.join(agentDir, 'extensions', 'memory', 'index.ts'), 'utf8')).toContain('memory-fix');
  });

  it('overwrites an already-copied extension, so the fix wins over the production copy', () => {
    const agentDir = tempDir('agent-dir-');
    writeExtension(path.join(agentDir, 'extensions', 'subagent'), 'production-version\n');
    const fix = tempDir('fix-');
    writeExtension(path.join(fix, 'subagent'), 'overlaid-version\n');

    applyExtensionsOverlays(agentDir, [path.join(fix, 'subagent')]);

    expect(readFileSync(path.join(agentDir, 'extensions', 'subagent', 'index.ts'), 'utf8')).toContain('overlaid-version');
  });

  it('fails fast on a path that is not a directory', () => {
    const agentDir = tempDir('agent-dir-');
    expect(() => applyExtensionsOverlays(agentDir, ['/no/such/overlay/dir'])).toThrow(/not a directory/);
  });

  it('fails fast on a directory containing no extension dirs', () => {
    const agentDir = tempDir('agent-dir-');
    const empty = tempDir('empty-');
    expect(() => applyExtensionsOverlays(agentDir, [empty])).toThrow(/no extension/i);
  });
});
