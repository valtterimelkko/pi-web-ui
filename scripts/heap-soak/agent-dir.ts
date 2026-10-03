/**
 * Build an isolated Pi agent config directory for the soak's disposable
 * server: copy ONLY auth.json / models.json / settings.json / extensions/
 * from the real ~/.pi/agent — never sessions/, session-memory/, goal-engine/,
 * bg-tasks/, memory/, etc. The copy is then the harness's own to mutate (e.g.
 * Lane C would have been added here, never to the production file — see
 * scripts/heap-soak/README.md for why Lane C ended up disabled instead).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { cpSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { assertAllowedProviderPresent, scopeAuthJson, scopeModelsJson } from '../../server/src/live-validation/heap-soak/credential-scope.js';

export const PRODUCTION_AGENT_DIR = path.join(homedir(), '.pi', 'agent');

/** Config-only allowlist. Anything else in ~/.pi/agent (sessions, memory, goal-engine, …) is never read. */
export const AGENT_CONFIG_ENTRIES = ['auth.json', 'models.json', 'settings.json', 'extensions'] as const;

export interface AgentDirBuildResult {
  agentDir: string;
  copied: string[];
  skippedMissing: string[];
  /** E2a-1 parent condition: providers the scoped copy keeps credentials for (undefined = unscoped full copy). */
  credentialScope?: string[];
  /** Provider entries dropped from models.json because they carried an apiKey outside the scope. */
  droppedCredentialProviders?: string[];
}

/** Copies the allowlisted entries from the real agent dir into `destDir`, creating it first. Read-only on the source.
 *
 * E2a-1 parent condition: when `allowedCredentialProviders` is given, the copy is reduced to those providers'
 * credentials (auth.json entries and models.json apiKey entries), and the build REFUSES unless every allowed
 * provider still has a credential — the scoped run depends on it.
 */
export function buildIsolatedAgentDir(destDir: string, sourceDir: string = PRODUCTION_AGENT_DIR, options: { allowedCredentialProviders?: readonly string[] } = {}): AgentDirBuildResult {
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const copied: string[] = [];
  const skippedMissing: string[] = [];
  for (const entry of AGENT_CONFIG_ENTRIES) {
    const source = path.join(sourceDir, entry);
    const dest = path.join(destDir, entry);
    if (!existsSync(source)) {
      skippedMissing.push(entry);
      continue;
    }
    cpSync(source, dest, { recursive: true, dereference: true });
    copied.push(entry);
  }
  const allowed = options.allowedCredentialProviders;
  if (allowed !== undefined) {
    const authPath = path.join(destDir, 'auth.json');
    const modelsPath = path.join(destDir, 'models.json');
    const auth = existsSync(authPath) ? (JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, unknown>) : {};
    const models = existsSync(modelsPath) ? (JSON.parse(readFileSync(modelsPath, 'utf8')) as Record<string, unknown>) : {};
    const scopedAuth = scopeAuthJson(auth, allowed);
    const scopedModels = scopeModelsJson(models, allowed);
    assertAllowedProviderPresent(scopedAuth, allowed, scopedModels.scoped);
    writeFileSync(authPath, `${JSON.stringify(scopedAuth, null, 1)}\n`, { mode: 0o600 });
    if (existsSync(modelsPath)) writeFileSync(modelsPath, `${JSON.stringify(scopedModels.scoped, null, 1)}\n`, { mode: 0o600 });
    return { agentDir: destDir, copied, skippedMissing, credentialScope: [...allowed], droppedCredentialProviders: scopedModels.droppedCredentialProviders };
  }
  return { agentDir: destDir, copied, skippedMissing };
}

/** List of files actually present under an agent dir, for isolation logging/inspection. */
export function listAgentDirEntries(agentDir: string): string[] {
  if (!existsSync(agentDir)) return [];
  return readdirSync(agentDir).sort();
}

/** Guard: refuse to build into a destination that would alias the real agent dir. */
export function assertNotProductionAgentDir(destDir: string, sourceDir: string = PRODUCTION_AGENT_DIR): void {
  const resolvedDest = path.resolve(destDir);
  const resolvedSource = path.resolve(sourceDir);
  if (resolvedDest === resolvedSource || (existsSync(resolvedDest) && statSync(resolvedDest).ino === (existsSync(resolvedSource) ? statSync(resolvedSource).ino : -1))) {
    throw new Error(`Refusing to build the isolated agent dir on top of the production agent dir: ${destDir}`);
  }
}
