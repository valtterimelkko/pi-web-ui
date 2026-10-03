#!/usr/bin/env npx tsx
/**
 * E2a-1 — credential-scope assertion (parent condition, 01-answer.md).
 *
 * Before `start` (dry-run mode): builds a scoped agent-dir copy with the SAME
 * code path the launcher uses (buildIsolatedAgentDir + the
 * HEAP_SOAK_CREDENTIAL_PROVIDERS scope) into a throwaway directory, asserts
 * it, prints a STRUCTURE-ONLY summary (provider names, never secret values)
 * and removes the copy.
 *
 * After boot (agent-dir mode + journal check): asserts the run's actual agent
 * dir, and greps the server unit's journal for
 * `[PiService] Available providers (with auth):` — every provider on that
 * line must be inside the allowed scope.
 *
 *   npx tsx scripts/e2a-soak/assert-credential-scope.ts --allowed zai --dry-run
 *   npx tsx scripts/e2a-soak/assert-credential-scope.ts --allowed zai --agent-dir <run>/agent-dir
 *   npx tsx scripts/e2a-soak/assert-credential-scope.ts --allowed zai --journal-unit e2a-1-server-<run>
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildIsolatedAgentDir } from '../heap-soak/agent-dir.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

interface AgentDirSummary {
  authProviders: string[];
  modelsProviders: string[];
  modelsProvidersWithApiKey: string[];
  credentialFieldsOutsideProviders: string[];
}

/** True when any key named `apiKey`/`api_key` appears anywhere inside the value (same rule as credential-scope.ts). */
function carriesCredentialKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(carriesCredentialKey);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([k, v]) => k === 'apiKey' || k === 'api_key' || carriesCredentialKey(v));
  }
  return false;
}

function summariseAgentDir(agentDir: string): AgentDirSummary {
  const authPath = path.join(agentDir, 'auth.json');
  const modelsPath = path.join(agentDir, 'models.json');
  const authProviders = existsSync(authPath) ? Object.keys(JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, unknown>) : [];
  let modelsProviders: string[] = [];
  let modelsProvidersWithApiKey: string[] = [];
  let credentialFieldsOutsideProviders: string[] = [];
  if (existsSync(modelsPath)) {
    const models = JSON.parse(readFileSync(modelsPath, 'utf8')) as Record<string, unknown>;
    // Correction 02: same fail-closed rule as scopeModelsJson — a credential
    // outside `providers` must fail the assertion, never pass silently.
    credentialFieldsOutsideProviders = Object.entries(models)
      .filter(([field, value]) => field !== 'providers' && carriesCredentialKey(value))
      .map(([field]) => field);
    const providers = (typeof models.providers === 'object' && models.providers !== null)
      ? models.providers as Record<string, Record<string, unknown>>
      : {};
    modelsProviders = Object.keys(providers);
    modelsProvidersWithApiKey = Object.entries(providers).filter(([, e]) => e && ('apiKey' in e || 'api_key' in e)).map(([name]) => name);
  }
  return { authProviders, modelsProviders, modelsProvidersWithApiKey, credentialFieldsOutsideProviders };
}

function assertScoped(summary: AgentDirSummary, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const authViolations = summary.authProviders.filter((p) => !allowedSet.has(p));
  const apiKeyViolations = summary.modelsProvidersWithApiKey.filter((p) => !allowedSet.has(p));
  if (authViolations.length > 0) throw new Error(`auth.json carries credentials outside the scope: ${authViolations.join(', ')}`);
  if (apiKeyViolations.length > 0) throw new Error(`models.json carries apiKey entries outside the scope: ${apiKeyViolations.join(', ')}`);
  if (summary.credentialFieldsOutsideProviders.length > 0) throw new Error(`models.json carries credential keys in top-level field(s) outside "providers": ${summary.credentialFieldsOutsideProviders.join(', ')}`);
  const missing = allowed.filter((p) => !summary.authProviders.includes(p) && !summary.modelsProvidersWithApiKey.includes(p));
  if (missing.length > 0) throw new Error(`allowed provider(s) have NO credential in the scoped agent dir: ${missing.join(', ')}`);
}

function checkJournal(unit: string, allowed: readonly string[]): { lines: string[]; ok: boolean; violations: string[] } {
  const text = execFileSync('journalctl', ['-u', unit, '--no-pager', '-o', 'cat'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const lines = text.split('\n').filter((l) => l.includes('Available providers (with auth)'));
  const violations: string[] = [];
  for (const line of lines) {
    const list = line.split(':')[1] ?? '';
    const providers = list.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = providers.filter((p) => !allowed.includes(p));
    if (bad.length > 0) violations.push(`${line.trim().slice(0, 160)} → outside scope: ${bad.join(', ')}`);
  }
  return { lines: lines.map((l) => l.trim().slice(0, 160)), ok: lines.length > 0 && violations.length === 0, violations };
}

function main(): void {
  const allowedRaw = arg('allowed');
  if (!allowedRaw) { console.error('--allowed <provider[,provider…]> is required'); process.exit(64); }
  const allowed = allowedRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const agentDir = arg('agent-dir');
  const journalUnit = arg('journal-unit');
  const dryRun = process.argv.includes('--dry-run');

  const parts: Record<string, unknown> = { allowed };
  try {
    if (dryRun) {
      // Same code path the launcher uses; throwaway copy under this lane's analysis dir.
      const dest = path.join(process.env.HOME ?? '/root', '.pi-web-ui', 'validation', 'heap-soak', `e2a-1-analysis`, `scope-dryrun-${randomUUID().slice(0, 8)}`);
      try {
        const built = buildIsolatedAgentDir(dest, undefined, { allowedCredentialProviders: allowed });
        const summary = summariseAgentDir(dest);
        assertScoped(summary, allowed);
        parts.mode = 'dry-run';
        parts.built = { copied: built.copied, credentialScope: built.credentialScope, droppedCredentialProviders: built.droppedCredentialProviders ?? [] };
        parts.agentDir = summary;
        parts.pass = true;
      } finally {
        rmSync(dest, { recursive: true, force: true });
      }
    } else if (agentDir) {
      if (!existsSync(agentDir)) { console.error(`agent dir not found: ${agentDir}`); process.exit(64); }
      const summary = summariseAgentDir(agentDir);
      assertScoped(summary, allowed);
      parts.mode = 'agent-dir';
      parts.agentDirPath = agentDir;
      parts.agentDir = summary;
      parts.pass = true;
    } else {
      console.error('give --dry-run or --agent-dir <path>');
      process.exit(64);
    }
  } catch (error) {
    parts.pass = false;
    parts.error = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify(parts, null, 1));
    process.exit(1);
  }

  if (journalUnit) {
    const journal = checkJournal(journalUnit, allowed);
    parts.journal = { unit: journalUnit, ok: journal.ok, lines: journal.lines, violations: journal.violations };
    if (!journal.ok) parts.pass = false;
  }

  console.log(JSON.stringify(parts, null, 1));
  process.exit(parts.pass ? 0 : 1);
}

main();
