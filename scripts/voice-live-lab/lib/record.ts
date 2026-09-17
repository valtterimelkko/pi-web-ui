/**
 * Immutable attempt records and the offline verifier (L0, plan §21).
 *
 * One attempt = one directory:
 *
 *   runs/<run-id>/<condition>/<attempt-id>/
 *     manifest.json          frozen at finalisation, hashed
 *     FINALISED              marker written with the manifest
 *     manifest.sha256        hash of the manifest
 *     input/ provider/ application/ capture/ evaluation/
 *
 * A record is written once. A retry is a new attempt: overwriting a manifest
 * or finalising twice is refused, because "we retried until it passed" is not
 * evidence and the retained failure is usually the informative artefact.
 *
 * The verifier is deliberately NOT a grep for a self-reported "passed". It
 * re-reads the trace and re-derives the mechanical facts an outside reader
 * would need: hashes intact, sequence dense, required events present, input
 * frame accounting exact, and no hidden-truth string leaked into the log. A
 * damaged trace (missing usage, dropped frames, reordered sequence, leaked
 * golden text) must fail here — that is the L0 verification gate.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { EVENT, parseEventLog, type LabEvent } from './scheduler.js';

export const RECORD_SCHEMA_VERSION = 1;
export const LAB_VERSION = '0.1.0';

export const ATTEMPT_DIRS = ['input', 'provider', 'application', 'capture', 'evaluation'] as const;

/** Roots the lab must never write into. Run records and audio stay outside the
 *  canonical checkout; nothing here is ever committed. */
const FORBIDDEN_ROOTS = ['/root/pi-web-ui', '/etc', '/usr', '/var', '/boot', '/root/.pi-web-ui'];

export function assertSafeRunRoot(root: string): string {
  const resolved = path.resolve(root);
  if (!path.isAbsolute(resolved)) throw new Error(`Run root must be absolute: ${root}`);
  if (resolved === '/') throw new Error('Refusing to use / as the run root');
  for (const forbidden of FORBIDDEN_ROOTS) {
    if (resolved === forbidden || resolved.startsWith(`${forbidden}/`)) {
      throw new Error(
        `Refusing to use ${resolved}: it is inside protected path ${forbidden}. ` +
          'Run records belong outside the repository (benchmarks/04-voice-live-lab/runs or a temp dir).'
      );
    }
  }
  return resolved;
}

export function sha256Bytes(buffer: Buffer | Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sha256File(filePath: string): string {
  return sha256Bytes(readFileSync(filePath));
}

export interface AttemptArtifact {
  role: string;
  relativePath: string;
  bytes: number;
  sha256: string;
}

export interface AttemptInputDeclaration {
  sourceId?: string;
  declaredFrames?: number;
  declaredBytes?: number;
  frameBytes?: number;
}

export interface AttemptManifest {
  schemaVersion: number;
  labVersion: string;
  runId: string;
  condition: string;
  attemptId: string;
  createdAt: string;
  clockOriginIso?: string;
  /** Relative path to the JSONL event log; defaults to application/events.jsonl. */
  eventLog?: string;
  input?: AttemptInputDeclaration;
  /** Event kinds the trace must contain (e.g. input_frame, provider_usage). */
  requiredEventKinds?: string[];
  /** Hidden-truth strings that must NOT appear anywhere in the trace. */
  goldenStrings?: string[];
  artifacts?: AttemptArtifact[];
  outcome?: string;
  usage?: Record<string, unknown> | null;
}

export interface AttemptLayout {
  root: string;
  runId: string;
  condition: string;
  attemptId: string;
  attemptDir: string;
}

export function attemptDirFor(root: string, runId: string, condition: string, attemptId: string): string {
  return path.join(assertSafeRunRoot(root), 'runs', runId, condition, attemptId);
}

export function eventLogPath(attemptDir: string, manifest?: Pick<AttemptManifest, 'eventLog'>): string {
  return path.join(attemptDir, manifest?.eventLog ?? 'application/events.jsonl');
}

/** Create a fresh, empty attempt directory. Refuses to reuse a path. */
export function createAttempt(
  root: string,
  runId: string,
  condition: string,
  attemptId?: string
): AttemptLayout {
  const safeRoot = assertSafeRunRoot(root);
  const id = attemptId ?? nextAttemptId(safeRoot, runId, condition);
  const attemptDir = attemptDirFor(safeRoot, runId, condition, id);
  if (existsSync(attemptDir)) {
    throw new Error(`Attempt directory already exists (refusing to overwrite evidence): ${attemptDir}`);
  }
  mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
  for (const sub of ATTEMPT_DIRS) mkdirSync(path.join(attemptDir, sub), { recursive: true, mode: 0o700 });
  return { root: safeRoot, runId, condition, attemptId: id, attemptDir };
}

/** Next free attempt id for a (run, condition) pair, e.g. attempt-03. */
export function nextAttemptId(root: string, runId: string, condition: string): string {
  const dir = path.join(assertSafeRunRoot(root), 'runs', runId, condition);
  if (!existsSync(dir)) return 'attempt-01';
  const used = readdirSync(dir)
    .map((name) => /^attempt-(\d+)$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number.parseInt(match[1], 10));
  const next = used.length === 0 ? 1 : Math.max(...used) + 1;
  return `attempt-${String(next).padStart(2, '0')}`;
}

/** Hash every artefact in the attempt directory, so the manifest can be
 *  re-checked offline. Manifest-side files are excluded (they are the things
 *  being trusted); the event log is included like any other artefact. */
export function collectArtifacts(attemptDir: string, exclude: string[] = []): AttemptArtifact[] {
  const skip = new Set(['manifest.json', 'manifest.sha256', 'FINALISED', ...exclude]);
  const out: AttemptArtifact[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (dir === attemptDir && skip.has(entry)) continue;
      const full = path.join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      out.push({
        role: path.relative(attemptDir, dir) || '.',
        relativePath: path.relative(attemptDir, full),
        bytes: stat.size,
        sha256: sha256File(full),
      });
    }
  };
  walk(attemptDir);
  return out;
}

/** Freeze the attempt: write the manifest once, then its hash and FINALISED. */
export function finaliseAttempt(attemptDir: string, manifest: AttemptManifest): string {
  const manifestPath = path.join(attemptDir, 'manifest.json');
  if (existsSync(manifestPath)) {
    throw new Error(`Refusing to overwrite an immutable manifest: ${manifestPath}`);
  }
  const frozen: AttemptManifest = {
    ...manifest,
    schemaVersion: manifest.schemaVersion ?? RECORD_SCHEMA_VERSION,
    labVersion: manifest.labVersion ?? LAB_VERSION,
    artifacts: manifest.artifacts ?? collectArtifacts(attemptDir),
  };
  writeFileSync(manifestPath, `${JSON.stringify(frozen, null, 2)}\n`, { mode: 0o600 });
  const hash = sha256File(manifestPath);
  writeFileSync(path.join(attemptDir, 'manifest.sha256'), `${hash}\n`, { mode: 0o600 });
  writeFileSync(path.join(attemptDir, 'FINALISED'), `${new Date().toISOString()}\n`, { mode: 0o600 });
  return manifestPath;
}

export interface VerifyOutcome {
  ok: boolean;
  lines: string[];
  problems: string[];
}

/** Concatenate the text of every file under a directory (bounded by caller use). */
function readDirectoryText(dir: string): string {
  if (!existsSync(dir)) return '';
  let text = '';
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) text += readDirectoryText(full);
    else if (stat.size < 4 * 1024 * 1024) text += readFileSync(full, 'utf8');
  }
  return text;
}

/**
 * Offline verification. Re-derives every mechanical fact from the record
 * itself; no re-run, no browser, no network.
 */
export function verifyAttempt(
  attemptDir: string,
  options: { requireFinalised?: boolean } = {}
): VerifyOutcome {
  const lines: string[] = [];
  const problems: string[] = [];
  const requireFinalised = options.requireFinalised ?? true;

  const manifestPath = path.join(attemptDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { ok: false, lines, problems: [`missing manifest: ${manifestPath}`] };
  }

  if (requireFinalised) {
    if (!existsSync(path.join(attemptDir, 'FINALISED'))) {
      problems.push('attempt is not finalised (no FINALISED marker)');
    }
    const hashFile = path.join(attemptDir, 'manifest.sha256');
    if (!existsSync(hashFile)) {
      problems.push('manifest.sha256 is missing');
    } else {
      const recorded = readFileSync(hashFile, 'utf8').trim();
      const actual = sha256File(manifestPath);
      if (recorded !== actual) {
        problems.push(`manifest hash mismatch: recorded ${recorded}, actual ${actual}`);
      } else {
        lines.push(`manifest sha256 OK (${actual.slice(0, 16)}...)`);
      }
    }
  }

  let manifest: AttemptManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as AttemptManifest;
  } catch (error) {
    return { ok: false, lines, problems: [...problems, `manifest is not valid JSON: ${String(error)}`] };
  }

  if (manifest.schemaVersion !== RECORD_SCHEMA_VERSION) {
    problems.push(
      `manifest schema version ${manifest.schemaVersion} != expected ${RECORD_SCHEMA_VERSION}`
    );
  }

  for (const artifact of manifest.artifacts ?? []) {
    const full = path.join(attemptDir, artifact.relativePath);
    if (!existsSync(full)) {
      problems.push(`artifact missing: ${artifact.relativePath}`);
      continue;
    }
    const actual = sha256File(full);
    if (actual !== artifact.sha256) {
      problems.push(`artifact hash mismatch for ${artifact.relativePath}`);
    }
    const size = statSync(full).size;
    if (size !== artifact.bytes) {
      problems.push(`artifact size mismatch for ${artifact.relativePath}: ${size} != ${artifact.bytes}`);
    }
  }

  const logFile = eventLogPath(attemptDir, manifest);
  if (!existsSync(logFile)) {
    problems.push(`missing event log: ${path.relative(attemptDir, logFile)}`);
    return { ok: problems.length === 0, lines, problems };
  }
  const logText = readFileSync(logFile, 'utf8');
  const parsed = parseEventLog(logText);
  problems.push(...parsed.problems);
  const events: LabEvent[] = parsed.events;

  if (events.length === 0) {
    problems.push('event log contains no events');
  } else {
    let seqDense = true;
    for (let index = 0; index < events.length; index += 1) {
      if (events[index].seq !== index + 1) {
        problems.push(
          `event sequence is not dense: expected seq ${index + 1} at position ${index}, got ${events[index].seq}`
        );
        seqDense = false;
        break;
      }
      if (index > 0 && events[index].tMs < events[index - 1].tMs) {
        problems.push(`event times are not monotonic at seq ${events[index].seq}`);
        seqDense = false;
        break;
      }
    }
    if (seqDense) lines.push(`${events.length} events, dense seq, monotonic times`);
  }

  const kinds = new Set(events.map((event) => event.kind));
  for (const required of manifest.requiredEventKinds ?? []) {
    if (!kinds.has(required)) problems.push(`required event kind missing: ${required}`);
  }

  const input = manifest.input;
  if (input) {
    const frameEvents = events.filter((event) => event.kind === EVENT.INPUT_FRAME);
    if (input.declaredFrames !== undefined && frameEvents.length !== input.declaredFrames) {
      problems.push(
        `dropped frames: log has ${frameEvents.length} input_frame events, source declared ${input.declaredFrames}`
      );
    }
    if (input.declaredBytes !== undefined) {
      const bytes = frameEvents.reduce((sum, event) => {
        const value = event.payload.bytes;
        return sum + (typeof value === 'number' ? value : 0);
      }, 0);
      if (bytes !== input.declaredBytes) {
        problems.push(`dropped frames: logged ${bytes} input bytes, source declared ${input.declaredBytes}`);
      }
    }
    if (input.frameBytes !== undefined) {
      for (const event of frameEvents) {
        if (event.payload.bytes !== input.frameBytes) {
          problems.push(
            `frame ${event.seq} has ${String(event.payload.bytes)} bytes, expected ${input.frameBytes}`
          );
          break;
        }
      }
    }
  }

  // Golden (hidden-truth) strings must never reach the trace or provider side.
  const golden = (manifest.goldenStrings ?? []).filter((value) => value.trim() !== '');
  if (golden.length > 0) {
    const leakSurface = `${logText}\n${readDirectoryText(path.join(attemptDir, 'provider'))}`;
    for (const secret of golden) {
      if (leakSurface.includes(secret)) {
        problems.push(`golden text leaked into the trace: "${secret.slice(0, 48)}"`);
      }
    }
  }

  if (problems.length === 0) lines.push('all mechanical checks passed');
  return { ok: problems.length === 0, lines, problems };
}
