import os from 'node:os';
import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import type { Runtime } from './internal-api-types.js';

export interface ValidationTarget {
  socketPath: string;
  tokenPath: string;
  runtime: Runtime;
}

export function containsAssistantMarker(value: unknown, marker: string): boolean {
  if (!marker || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const items = (value as Record<string, unknown>).items;
  if (!Array.isArray(items)) return false;
  return items.some((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return record.kind === 'assistant' && typeof record.text === 'string' && record.text.includes(marker);
  });
}

export function chooseValidationModel(runtime: Runtime, models: Array<{ id?: unknown }>): string | undefined {
  // The current Pi catalogue exposes display ids that are not always valid
  // create-time provider/model selectors. Its documented default is safer and
  // gives the receipt the effective model identity. Other runtimes advertise
  // selectors that their create routes accept directly.
  if (runtime === 'pi') return undefined;
  const first = models.find((model) => typeof model.id === 'string' && model.id.length > 0);
  return typeof first?.id === 'string' ? first.id : undefined;
}

function canonicalIfPresent(value: string): string {
  try {
    return existsSync(value) ? realpathSync.native(value) : path.resolve(value);
  } catch {
    return path.resolve(value);
  }
}

function productionPaths(homeDir: string): { socketPath: string; tokenPath: string } {
  return {
    socketPath: canonicalIfPresent(path.join(homeDir, '.pi-web-ui', 'internal-api.sock')),
    tokenPath: canonicalIfPresent(path.join(homeDir, '.pi-web-ui', 'internal-api-token')),
  };
}

export function assertDisposableTarget(socketPath: string, tokenPath: string, homeDir = os.homedir()): void {
  if (!path.isAbsolute(socketPath) || !path.isAbsolute(tokenPath)) {
    throw new Error('MCP validation requires absolute socket and token paths');
  }
  if (path.resolve(socketPath) === path.resolve(tokenPath)) {
    throw new Error('MCP validation socket and token paths must be different');
  }
  const production = productionPaths(homeDir);
  const socketCandidates = new Set([path.resolve(socketPath), canonicalIfPresent(socketPath)]);
  const tokenCandidates = new Set([path.resolve(tokenPath), canonicalIfPresent(tokenPath)]);
  if (socketCandidates.has(production.socketPath) || tokenCandidates.has(production.tokenPath)) {
    throw new Error('MCP validation refuses the production socket/token paths; no production override exists');
  }

  const temporaryRoot = path.resolve(os.tmpdir());
  const resolvedSocketPath = path.resolve(socketPath);
  const resolvedTokenPath = path.resolve(tokenPath);
  const isWithinTemporaryRoot = (candidate: string): boolean => {
    const relative = path.relative(temporaryRoot, candidate);
    return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
  };
  if (!isWithinTemporaryRoot(resolvedSocketPath) || !isWithinTemporaryRoot(resolvedTokenPath)) {
    throw new Error('MCP validation requires socket and token paths inside the operating system temporary root');
  }
  if (path.dirname(resolvedSocketPath) !== path.dirname(resolvedTokenPath)) {
    throw new Error('MCP validation socket and token paths must share one disposable directory');
  }
}

export function parseValidationArgs(argv: string[], homeDir = os.homedir()): ValidationTarget {
  let socketPath: string | undefined;
  let tokenPath: string | undefined;
  let runtime: Runtime = 'pi';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--allow-production') {
      throw new Error('--allow-production is not supported by MCP validators');
    }
    if (arg === '--socket' || arg === '--token-path' || arg === '--runtime') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === '--socket') socketPath = value;
      else if (arg === '--token-path') tokenPath = value;
      else {
        if (!['pi', 'claude', 'opencode', 'antigravity'].includes(value)) throw new Error(`Unsupported validation runtime: ${value}`);
        runtime = value as Runtime;
      }
      continue;
    }
    throw new Error(`Unknown MCP validation argument: ${arg}`);
  }
  if (!socketPath || !tokenPath) throw new Error('MCP validation requires explicit --socket and --token-path paths');
  assertDisposableTarget(socketPath, tokenPath, homeDir);
  return { socketPath: path.resolve(socketPath), tokenPath: path.resolve(tokenPath), runtime };
}

export async function withValidationCleanup<T>(cleanup: () => Promise<void>, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } finally {
    await cleanup();
  }
}

function replaceAll(value: string, secret: string): string {
  if (!secret) return value;
  return value.split(secret).join('[REDACTED]');
}

export function redactValidationReport(report: string, secrets: string[] = [], sensitiveBodies: string[] = []): string {
  return [...secrets, ...sensitiveBodies].reduce(replaceAll, report);
}
