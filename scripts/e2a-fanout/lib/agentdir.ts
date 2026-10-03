/**
 * Isolated agent dir for the disposable server: the real extension set as
 * byte-identical copies (the loader refuses symlinks) + settings.json, and a
 * FILTERED auth.json carrying only the approved `zai` credential. models.json
 * is never copied (it holds apiKey entries — the 2026-10-03 amendment).
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PRODUCTION_AGENT_DIR = '/root/.pi/agent';
const APPROVED_AUTH_PROVIDERS = ['zai'] as const;

export interface AgentDirResult {
  agentDir: string;
  copiedExtensions: string[];
  providersInAuth: string[];
  sha256ManifestPath: string;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function buildIsolatedAgentDir(destDir: string, sourceDir = PRODUCTION_AGENT_DIR): AgentDirResult {
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const copiedExtensions: string[] = [];
  const providersInAuth: string[] = [];

  // 1. extensions/ — byte-identical copy (dereferenced; the loader refuses symlinks).
  const extSrc = join(sourceDir, 'extensions');
  if (existsSync(extSrc)) {
    cpSync(extSrc, join(destDir, 'extensions'), { recursive: true, dereference: true });
    copiedExtensions.push(...readdirSync(extSrc).sort());
  }

  // 2. settings.json — byte-identical copy.
  if (existsSync(join(sourceDir, 'settings.json'))) {
    cpSync(join(sourceDir, 'settings.json'), join(destDir, 'settings.json'), { dereference: true });
  }

  // 3. auth.json — FILTERED to the approved providers only. Never copied whole.
  const authSrc = join(sourceDir, 'auth.json');
  if (existsSync(authSrc)) {
    const full = JSON.parse(readFileSync(authSrc, 'utf8')) as Record<string, unknown>;
    const filtered: Record<string, unknown> = {};
    for (const p of APPROVED_AUTH_PROVIDERS) {
      if (full[p] !== undefined) {
        filtered[p] = full[p];
        providersInAuth.push(p);
      }
    }
    writeFileSync(join(destDir, 'auth.json'), `${JSON.stringify(filtered, null, 2)}\n`, { mode: 0o600 });
  }

  // models.json is deliberately NOT copied: it holds apiKey entries.

  // 4. sha256 manifest over everything copied, for the byte-identical claim.
  const manifest: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) manifest.push(`${sha256File(p)}  ${p.slice(destDir.length + 1)}`);
    }
  };
  walk(destDir);
  const manifestPath = join(destDir, '..', 'agent-dir-sha256.txt');
  writeFileSync(manifestPath, `${manifest.sort().join('\n')}\n`);

  return { agentDir: destDir, copiedExtensions, providersInAuth, sha256ManifestPath: manifestPath };
}

/** Guard: refuse to build on top of the real agent dir (path equality, not the basename). */
export function assertNotProductionAgentDir(destDir: string): void {
  const resolved = destDir.replace(/\/+$/, '');
  if (resolved === PRODUCTION_AGENT_DIR) {
    throw new Error(`refusing to build the isolated agent dir on top of the production agent dir: ${destDir}`);
  }
  if (existsSync(destDir) && existsSync(PRODUCTION_AGENT_DIR)) {
    if (statSync(destDir).ino === statSync(PRODUCTION_AGENT_DIR).ino) {
      throw new Error(`refusing: ${destDir} is the same inode as the production agent dir`);
    }
  }
}

/** Credential-hygiene sweep: these files must NOT exist under the run root at hand-back. */
export function credentialFindCommand(runRoot: string): string {
  return `find ${runRoot} -name auth.json -o -name models.json`;
}
