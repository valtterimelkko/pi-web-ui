import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Client-neutrality and credential-containment suite (Track B; contract D7,
 * §6.1 invariant 1).
 *
 * D7: the service must carry no browser lifecycle concept — no tab, page,
 * visibility or audio-DOM assumption may reach the kernel's contract. The
 * contract module itself is checked by Track E; this suite checks every file the
 * bridge owns.
 *
 * Credential containment is proven here by inspection of the sources and the
 * client tree: the provider key is read in exactly one place, and no client file
 * or built client asset references it or the Google key prefix.
 */

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const voiceSrcDir = join(repoRoot, 'server/src/voice');
const clientDir = join(repoRoot, 'client');

function walk(dir: string, predicate: (path: string) => boolean, out: string[] = [], depth = 0): string[] {
  if (depth > 12 || !existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, predicate, out, depth + 1);
    else if (predicate(path)) out.push(path);
  }
  return out;
}

function voiceSources(): Array<{ path: string; source: string }> {
  return walk(voiceSrcDir, (path) => path.endsWith('.ts')).map((path) => ({ path, source: readFileSync(path, 'utf8') }));
}

describe('D7 client neutrality', () => {
  const banned: Array<{ name: string; pattern: RegExp }> = [
    { name: 'window', pattern: /\bwindow\b/ },
    { name: 'document', pattern: /\bdocument\b/ },
    { name: 'navigator', pattern: /\bnavigator\b/ },
    { name: 'localStorage', pattern: /\blocalStorage\b/ },
    { name: 'sessionStorage', pattern: /\bsessionStorage\b/ },
    { name: 'AudioContext', pattern: /\bAudioContext\b/ },
    { name: 'AudioWorklet', pattern: /\bAudioWorklet\b/ },
    { name: 'requestAnimationFrame', pattern: /\brequestAnimationFrame\b/ },
    { name: 'visibilitychange', pattern: /visibilitychange/ },
    { name: 'data-tab attribute', pattern: /data-[\w-]*tab/ },
    { name: 'browser event loop language', pattern: /\bDOMContentLoaded\b/ },
  ];

  it('contains no browser lifecycle global in any voice service source', () => {
    for (const { path, source } of voiceSources()) {
      for (const rule of banned) {
        expect(source, `${path} must not reference ${rule.name}`).not.toMatch(rule.pattern);
      }
    }
  });

  it('has no worker-delivery dependency or authority verb: the kernel owns releases', () => {
    for (const { path, source } of voiceSources()) {
      expect(source, path).not.toMatch(/from '\.\.\/talker/);
      expect(source, path).not.toMatch(/from '\.\.\/websocket/);
      expect(source, path).not.toMatch(/\bdeliverInstruction\b|\breleaseProposal\b|\bdispatchToWorker\b/);
    }
  });

  it('never writes to the process console from the voice service', () => {
    for (const { path, source } of voiceSources()) {
      expect(source, path).not.toMatch(/\bconsole\.(log|info|warn|error|debug)\b/);
    }
  });

  it('keeps the service vocabulary free of browser concepts in exported identifiers', () => {
    for (const { path, source } of voiceSources()) {
      const identifiers = source.match(/export\s+(?:interface|type|class|const|function)\s+([A-Za-z0-9_]+)/g) ?? [];
      for (const identifier of identifiers) {
        expect(identifier.toLowerCase(), `${path}: ${identifier}`).not.toMatch(/tab|page|visibility|dom|worklet/);
      }
    }
  });
});

describe('provider credential containment', () => {
  it('reads the provider key only in the bridge (default provider) and the probe (presence check), never logging it', () => {
    const readers = voiceSources().filter(({ source }) => source.includes('process.env.GEMINI_API_KEY'));
    expect(readers.map((reader) => reader.path.split('/').pop()).sort()).toEqual([
      'gemini-live-bridge.ts',
      'voice-handshake-probe.ts',
    ]);
    for (const { source } of readers) {
      expect(source).not.toMatch(/console\./);
      // The probe may report only the key LENGTH; it must never interpolate the value.
      expect(source).not.toMatch(/log\([^)]*apiKey\)/);
    }
  });

  it('never places the provider key name or key material in the client tree', () => {
    const clientFiles = walk(clientDir, (path) => /\.(ts|tsx|js|jsx|mjs|cjs|html|json)$/.test(path));
    for (const path of clientFiles) {
      const source = readFileSync(path, 'utf8');
      expect(source, `${path} must not reference the server key`).not.toMatch(/GEMINI_API_KEY/);
      expect(source, `${path} must not contain Google key material`).not.toMatch(/AIza[0-9A-Za-z_-]{35}/);
    }
  });

  it('never places key material in any built client asset when a build output exists', () => {
    const distDir = join(clientDir, 'dist');
    if (!existsSync(distDir)) return;
    const assets = walk(distDir, () => true);
    for (const path of assets) {
      const source = readFileSync(path, 'utf8');
      expect(source, `${path} must not contain the server key name`).not.toMatch(/GEMINI_API_KEY/);
      expect(source, `${path} must not contain Google key material`).not.toMatch(/AIza[0-9A-Za-z_-]{35}/);
    }
  });

  it('never sends the key name across the wire in any emitted event or server message type', () => {
    const contractSource = readFileSync(join(repoRoot, 'shared/src/types/voice-messages.ts'), 'utf8');
    expect(contractSource).not.toMatch(/GEMINI_API_KEY/);
    expect(contractSource).not.toMatch(/apiKey/);
  });
});
