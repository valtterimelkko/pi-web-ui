/**
 * C4 dispatch preflight (contract 1.53.0).
 *
 * Children dispatched by orchestration parents kept failing on workspace
 * problems (43% of measured children): a working directory that does not
 * exist or is not writable, referenced paths that were never created, tools
 * that are not installed. This module answers those questions BEFORE any
 * runtime session is created or any model token is spent, with one
 * aggregated, deterministic report:
 *
 *   - the effective cwd exists, is a directory and is writable by the server
 *     user (always checked on session create paths);
 *   - caller-declared referenced paths exist (existence only — no reads);
 *   - caller-declared tool names are executable files on the PATH the server
 *     (and therefore the runtime child it spawns) will see.
 *
 * Security posture (SECURITY.md §5): caller-supplied paths are never trusted
 * beyond existence/writability probes — no content reads, no directory
 * listings, no creation. Tool names are bare names only (no separators, so no
 * path traversal); they are resolved against PATH entries by `stat` +
 * `access(X_OK)`, the same resolution a spawned runtime child performs.
 *
 * The check is inherently point-in-time: state can change between the probe
 * and the runtime spawn (TOCTOU). Listed blind spots belong to the C4
 * evidence bundle, not to clever fixing here.
 */

import { z } from 'zod';
import { promises as fsp, constants } from 'node:fs';
import * as nodePath from 'node:path';

/** Bounds mirror the request-schema bounds in session-validation.ts. */
export const MAX_PREFLIGHT_PATHS = 32;
export const MAX_PREFLIGHT_TOOLS = 32;
const MAX_PATH_LENGTH = 4096;

/** A tool name is a bare PATH-resolvable name: no separators, no traversal. */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

const absolutePathSchema = z
  .string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .refine((p) => !p.includes('\0'), { message: 'path must not contain NUL bytes' })
  .refine((p) => p.startsWith('/'), { message: 'path must be absolute' });

/** Contract 1.53.0 `preflight` request field (create / batch-create / prompt). */
export const preflightSpecSchema = z
  .object({
    paths: z.array(absolutePathSchema).max(MAX_PREFLIGHT_PATHS).optional(),
    tools: z.array(z.string().regex(TOOL_NAME_PATTERN, 'tool must be a bare executable name (no separators)')).max(MAX_PREFLIGHT_TOOLS).optional(),
  })
  .strict();

export type PreflightSpec = z.infer<typeof preflightSpecSchema>;

export interface PreflightFailure {
  /** Which check failed. */
  kind: 'cwd' | 'path' | 'tool';
  /** The item probed (absolute path, or bare tool name). */
  item: string;
  /** Short, stable human/agent-readable reason. */
  problem: string;
}

export interface PreflightReport {
  ok: boolean;
  /** Every failure, in check order (cwd, then paths, then tools). */
  failures: PreflightFailure[];
}

/** The subset of fs/promises the probes need; injectable for tests. */
export interface PreflightFs {
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
  access(path: string, mode: number): Promise<void>;
}

const defaultFs: PreflightFs = {
  stat: (p) => fsp.stat(p) as Promise<{ isDirectory(): boolean; isFile(): boolean }>,
  access: (p, mode) => fsp.access(p, mode),
};

export interface RunDispatchPreflightOptions {
  /**
   * Effective working directory the session would run in. When provided it is
   * always checked (exists + directory + writable by the server user) — this
   * is the default-on behaviour for the create paths. Absent for the optional
   * prompt-dispatch surface, which re-checks only caller-declared items.
   */
  cwd?: string;
  /** Caller-declared referenced paths; existence is required, nothing more. */
  paths?: readonly string[];
  /** Caller-declared bare tool names resolved against `pathEnv`. */
  tools?: readonly string[];
  /** PATH to resolve tools against; defaults to the server process PATH, which runtime children inherit. */
  pathEnv?: string;
  fs?: PreflightFs;
}

/**
 * The PATH the target runtime's child will actually see. Antigravity spawns
 * `agy` with `/root/.local/bin` prepended (see the inline env builders in
 * `antigravity-service.ts` `runAgy` and `agy-stream-process.ts` `start` — the
 * expression here mirrors them exactly); Pi sessions run in-process and
 * Claude/Command Code children inherit the server environment, so they see the
 * server PATH unchanged. Correction 01 item 1: tool lookups must use THIS
 * environment, not the bare server PATH.
 */
export function runtimeChildPathEnv(runtime: 'pi' | 'claude' | 'opencode' | 'antigravity' | 'commandcode', serverPath?: string): string {
  const base = serverPath ?? process.env.PATH ?? '';
  return runtime === 'antigravity' ? `/root/.local/bin:${base}` : base;
}

/**
 * Effective create cwd, shared by the single-create and batch-create preflight
 * hooks so both resolve EXACTLY the same value (correction 01 item 5): explicit
 * request cwd, else the validation default read at request time, else the
 * server cwd. Config's load-time snapshot must not be used here — a caller
 * that sets the env var after boot would otherwise see two different cwds on
 * the two create paths.
 */
export function resolveEffectiveCreateCwd(explicitCwd?: string): string {
  return explicitCwd || process.env.PI_WEB_UI_VALIDATION_DEFAULT_CWD || process.cwd();
}

/** Resolve one bare tool name against a PATH string (first match wins). */
async function toolOnPath(name: string, pathEnv: string, fs: PreflightFs): Promise<boolean> {
  for (const dir of pathEnv.split(':')) {
    if (dir === '') continue;
    const candidate = nodePath.join(dir, name);
    try {
      const st = await fs.stat(candidate);
      // Regular files only: a FIFO or socket with the exec bit set is not a
      // usable tool (correction 01 item 2).
      if (st.isFile()) {
        await fs.access(candidate, constants.X_OK);
        return true;
      }
    } catch {
      // Not here (or not usable): keep searching the remaining entries.
    }
  }
  return false;
}

/**
 * Run every requested probe and aggregate ALL failures (no short-circuit), so
 * a parent fixes its whole brief in one round trip. Deterministic, no child
 * processes, no provider calls.
 */
export async function runDispatchPreflight(options: RunDispatchPreflightOptions): Promise<PreflightReport> {
  const fs = options.fs ?? defaultFs;

  // Per-check-group indexed collection, flattened afterwards, so the report
  // order is deterministic in input order no matter which probe resolves first
  // (correction 01 item 3).
  const cwdFailures: PreflightFailure[] = [];
  if (options.cwd !== undefined) {
    const cwd = options.cwd;
    try {
      const st = await fs.stat(cwd);
      if (!st.isDirectory()) {
        cwdFailures.push({ kind: 'cwd', item: cwd, problem: 'not a directory' });
      } else {
        try {
          await fs.access(cwd, constants.W_OK);
        } catch {
          cwdFailures.push({ kind: 'cwd', item: cwd, problem: 'not writable by the server user' });
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      cwdFailures.push({ kind: 'cwd', item: cwd, problem: code === 'ENOENT' ? 'does not exist' : 'not accessible' });
    }
  }

  const pathChecks = await Promise.all(
    (options.paths ?? []).map(async (p): Promise<PreflightFailure | null> => {
      try {
        await fs.access(p, constants.F_OK);
        return null;
      } catch {
        return { kind: 'path', item: p, problem: 'does not exist' };
      }
    }),
  );

  const pathEnv = options.pathEnv ?? process.env.PATH ?? '';
  const toolChecks = await Promise.all(
    (options.tools ?? []).map(async (tool): Promise<PreflightFailure | null> => {
      if (await toolOnPath(tool, pathEnv, fs)) return null;
      return { kind: 'tool', item: tool, problem: 'not found on PATH' };
    }),
  );

  const failures = [
    ...cwdFailures,
    ...pathChecks.filter((f): f is PreflightFailure => f !== null),
    ...toolChecks.filter((f): f is PreflightFailure => f !== null),
  ];

  return { ok: failures.length === 0, failures };
}

/** One-line message listing every failure (for the wire error body). */
export function formatPreflightProblem(report: PreflightReport): string {
  if (report.failures.length === 0) return 'Dispatch preflight failed';
  const parts = report.failures.map((f) => {
    switch (f.kind) {
      case 'cwd':
        return `working directory '${f.item}' ${f.problem}`;
      case 'path':
        return `path '${f.item}' ${f.problem}`;
      case 'tool':
        return `tool '${f.item}' ${f.problem}`;
    }
  });
  return `Dispatch preflight failed: ${parts.join('; ')}`;
}
