/**
 * Offline verifier for built-app attempt records (native-primary plan Phase 1,
 * gate G1: "injected failures are caught for the right reason; clean controls
 * pass; cleanup fails closed").
 *
 * The verifier NEVER re-runs anything. It re-reads the immutable attempt
 * record and re-derives every mechanical fact:
 *
 *   integrity  — manifest present, finalised, self-hash intact, artifact
 *                hashes intact;
 *   evidence   — required sections exist, are parseable and non-empty
 *                (missing/empty/malformed ⇒ indeterminate, never a pass);
 *   capture    — ingress PCM digests recomputed from bytes, declared durations
 *                re-derived from sample counts, causality (monotone
 *                timestamps, chunks within the capture window), the 16 kHz
 *                egress of the production resampler digest-checked and
 *                duration-matched against the ingress;
 *   director   — the recorded step log must be EXACTLY what the deterministic
 *                director replays from the recorded observations and clock —
 *                any divergence means the record was not produced by the
 *                frozen FSM and is unusable;
 *   product    — the replayed terminal status decides pass/fail: an
 *                unauthorised release, forbidden proposal, identity reuse or
 *                unpersisted worker store is a demonstrated failure;
 *   instruments— fixture ASR validation must have passed and labels must say
 *                synthetic; golden (expected-slot) strings must not leak into
 *                provider-side artifacts; negative-control markers must not
 *                appear in E2 records.
 *
 * Verdicts: `pass` (exit 0), `fail` (exit 1, demonstrated defect), and
 * `indeterminate` (exit 2, incomplete/invalid proof). Damaged evidence is
 * never allowed to look like success.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { type LoadedCorpus } from './corpus.js';
import { EpisodeDirector, checkSlots, normaliseUtterance, type DirectorObservation } from './director.js';
import { SYNTHETIC_TTS_LABEL } from './built-app.js';

export const RECORD_SCHEMA_VERSION = 1;

export interface VerifierProblem {
  code: string;
  detail: string;
}

export interface VerifyOutcome {
  verdict: 'pass' | 'fail' | 'indeterminate';
  problems: VerifierProblem[];
  lines: string[];
}

export function exitCodeFor(outcome: VerifyOutcome): 0 | 1 | 2 {
  if (outcome.verdict === 'pass') return 0;
  if (outcome.verdict === 'fail') return 1;
  return 2;
}

interface StepRow {
  seq: number;
  atMs: number;
  observation?: Record<string, unknown>;
  action: Record<string, unknown>;
}

interface ChunkRow {
  seq: number;
  atMs: number;
  sampleRate: number;
  sampleCount: number;
  declaredDurationMs: number;
  sha256: string;
  pcmFile: string;
  source?: string;
}

import { createHash } from 'node:crypto';
const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

function readText(attemptDir: string, relative: string): string | null {
  const full = path.join(attemptDir, relative);
  return existsSync(full) ? readFileSync(full, 'utf8') : null;
}

function readJson<T>(attemptDir: string, relative: string, problems: VerifierProblem[]): T | null {
  const text = readText(attemptDir, relative);
  if (text === null) {
    problems.push({ code: 'missing-section', detail: `required record section missing: ${relative}` });
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    problems.push({ code: 'malformed-json', detail: `${relative}: ${String(error)}` });
    return null;
  }
}

function collectFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out;
}

// ── Negation-aware forbidden-response check (fix-loop pass 1, C15/C16) ─────

/**
 * A forbidden response phrase only counts when no negation cue governs it: an
 * honest "I can't confirm the suite has finished" must never be graded as a
 * completion claim. Cues are written in raw wording and normalised so they
 * match the same normalised text the slot check sees. `responseMustContain`
 * stays literal — only forbidden content is negation-guarded.
 */
const RESPONSE_NEGATION_CUES = [
  "can't",
  'cannot',
  'can not',
  "don't",
  "doesn't",
  "didn't",
  "hasn't",
  "haven't",
  "isn't",
  "aren't",
  "won't",
  "wouldn't",
  "couldn't",
  'not sure',
  'not certain',
  'no idea',
  "don't know",
  'do not know',
  "can't say",
  'cannot say',
  "can't confirm",
  'cannot confirm',
  'not yet',
  'yet to',
].map((cue) => normaliseUtterance(cue));

/** True when `needle` occurs in some clause with no negation cue before the occurrence. */
function occursUnnegated(clauses: string[], needle: string): boolean {
  for (const clause of clauses) {
    let index = clause.indexOf(needle);
    while (index !== -1) {
      const before = clause.slice(0, index);
      if (!RESPONSE_NEGATION_CUES.some((cue) => before.includes(cue))) return true;
      index = clause.indexOf(needle, index + 1);
    }
  }
  return false;
}

// ── Labelled synthetic-TTS seam (child J3) ─────────────────────────────────

interface ProposalFrame {
  proposalId: string;
  original: string;
  tidied: string;
  presentedVariant: string;
}

/** The proposal_created frames the runner recorded from the live wire. */
function readProposalFrames(attemptDir: string): ProposalFrame[] {
  const framesPath = path.join(attemptDir, 'capture', 'wire-frames.json');
  if (!existsSync(framesPath)) return [];
  try {
    const rows = JSON.parse(readFileSync(framesPath, 'utf8')) as Array<{ type?: unknown; frame?: unknown }>;
    const out: ProposalFrame[] = [];
    for (const row of rows) {
      if (row?.type !== 'proposal_created') continue;
      const frame = row.frame as { proposal?: unknown } | undefined;
      const proposal = (frame?.proposal ?? null) as Record<string, unknown> | null;
      if (!proposal) continue;
      const proposalId = String(proposal.proposalId ?? '');
      if (!proposalId) continue;
      const original = String(proposal.original ?? '');
      out.push({
        proposalId,
        original,
        tidied: String(proposal.tidied ?? original),
        presentedVariant: String(proposal.presentedVariant ?? 'tidied'),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** The bytes the client reads back for one proposal: the presented variant, verbatim. */
function readBackBytes(proposal: ProposalFrame): string {
  return proposal.presentedVariant === 'original' ? proposal.original : proposal.tidied;
}

export interface TtsSeamResult {
  problems: VerifierProblem[];
  lines: string[];
  /** True when the declared seam's evidence is missing/malformed: never a pass — incomplete. */
  incomplete: boolean;
}

/**
 * The synthetic-TTS seam's integrity (child J3):
 *   - shim artefacts in the record force a manifest declaration (no silent use);
 *   - a declared seam must be described by an honest manifest tts block, must
 *     record what the shim spoke (capture/tts-spoken.json), and must keep the
 *     record at evidence level E2 (a shim read-back is NEVER a rendered-audio
 *     E2R/E3 pass);
 *   - every text the shim spoke must equal the live proposal's retained bytes
 *     (exact comparison after the product's own normalisation) — a shim that
 *     fabricated a read-back of different words is a demonstrated failure;
 *   - every completed read-back presentation must join to a shim-spoken text
 *     (attribution), and a claimed completion with zero shim speech is fraud.
 */
function collectTtsSeamProblems(attemptDir: string, manifest: Record<string, unknown>, steps: StepRow[]): TtsSeamResult {
  const problems: VerifierProblem[] = [];
  const lines: string[] = [];
  const spokenRel = path.join('capture', 'tts-spoken.json');

  const captureMode = typeof manifest.captureMode === 'string' ? manifest.captureMode : '';
  const declared = captureMode.includes(SYNTHETIC_TTS_LABEL);
  const spokenPath = path.join(attemptDir, spokenRel);
  const spokenExists = existsSync(spokenPath);
  const ttsBlock = (manifest.tts ?? null) as Record<string, unknown> | null;

  if (!declared && !spokenExists && !ttsBlock) {
    lines.push('synthetic-tts seam: not declared, no shim artefacts (default journey)');
    return { problems, lines, incomplete: false };
  }
  if (!declared) {
    problems.push({
      code: 'tts-shim-undeclared',
      detail: `the ${SYNTHETIC_TTS_LABEL} shim left evidence in the record (${spokenExists ? spokenRel : 'manifest tts block'}) but manifest.captureMode does not declare it — silent shim use`,
    });
    return { problems, lines, incomplete: false };
  }

  // Declared: the seam must be honestly described and fully evidenced.
  lines.push(`synthetic-tts seam declared (${captureMode})`);
  if (manifest.evidenceLevel !== 'E2') {
    problems.push({
      code: 'tts-shim-rendered-audio-claim',
      detail: `a ${SYNTHETIC_TTS_LABEL} record claims evidence level ${String(manifest.evidenceLevel)} — a shim read-back is never a rendered-audio (E2R/E3) pass`,
    });
  }
  if (!ttsBlock) {
    problems.push({ code: 'tts-shim-evidence-missing', detail: 'captureMode declares the shim but the manifest has no tts block describing it' });
    return { problems, lines, incomplete: true };
  }
  if (ttsBlock.mode !== 'synthetic' || ttsBlock.label !== SYNTHETIC_TTS_LABEL) {
    problems.push({
      code: 'tts-shim-undeclared',
      detail: `manifest tts block does not describe the sanctioned shim (mode ${String(ttsBlock.mode)}, label ${String(ttsBlock.label)})`,
    });
  }
  if (ttsBlock.renderedAudioClaimed === true) {
    problems.push({ code: 'tts-shim-rendered-audio-claim', detail: 'the manifest claims rendered audio for a shim read-back' });
  }
  if (!spokenExists) {
    problems.push({ code: 'tts-shim-evidence-missing', detail: `captureMode declares the shim but ${spokenRel} is absent — the spoken texts were not recorded` });
    return { problems, lines, incomplete: true };
  }
  let spokenLog: { label?: unknown; shimVerified?: unknown; spoken?: unknown };
  try {
    spokenLog = JSON.parse(readFileSync(spokenPath, 'utf8')) as typeof spokenLog;
  } catch (error) {
    problems.push({ code: 'tts-shim-log-malformed', detail: `${spokenRel}: ${String(error)}` });
    return { problems, lines, incomplete: true };
  }
  if (spokenLog.label !== SYNTHETIC_TTS_LABEL) {
    problems.push({ code: 'tts-shim-undeclared', detail: `${spokenRel} carries label ${String(spokenLog.label)} — not the sanctioned shim log` });
  }
  if (spokenLog.shimVerified !== true) {
    problems.push({ code: 'tts-shim-evidence-missing', detail: `${spokenRel} records shimVerified=false — the shim's installation was not verified in-page` });
  }
  if (!Array.isArray(spokenLog.spoken)) {
    problems.push({ code: 'tts-shim-log-malformed', detail: `${spokenRel}: spoken is not an array` });
    return { problems, lines, incomplete: true };
  }
  const spoken = spokenLog.spoken as Array<{ seq?: unknown; text?: unknown }>;
  lines.push(`${spoken.length} shim-spoken texts recorded`);
  const completedPresentation = steps.some(
    (step) => (step.observation as { kind?: unknown; complete?: unknown } | undefined)?.kind === 'presentation' &&
      (step.observation as { complete?: unknown } | undefined)?.complete === true
  );
  if (spoken.length === 0) {
    if (completedPresentation) {
      problems.push({
        code: 'tts-shim-readback-unattributed',
        detail: 'the record claims a completed read-back presentation but the shim spoke nothing — the read-back is not attributable to the shim',
      });
      return { problems, lines, incomplete: false };
    }
    if (readProposalFrames(attemptDir).length > 0) {
      // A proposal existed on the wire but the record shows neither shim speech
      // nor a completed read-back: the seam is unproven either way (the
      // fraud/incomplete class the seam exists to catch).
      lines.push('shim spoke nothing although a proposal exists and no read-back completed — seam unproven');
      return { problems, lines, incomplete: true };
    }
    // Zero speech with no proposal and no completed presentation is the
    // EXPECTED, complete shape for a proposalless (conversation-only) episode:
    // the declared seam simply had nothing to read back (fix-loop pass 4,
    // C16/C21). The journey verdict still grades the episode on its own terms.
    lines.push('shim spoke nothing: no proposal and no completed read-back — nothing for the seam to carry');
    return { problems, lines, incomplete: false };
  }

  // Byte integrity: every spoken text must be some proposal's read-back bytes.
  const proposals = readProposalFrames(attemptDir);
  if (proposals.length === 0) {
    problems.push({
      code: 'tts-shim-evidence-missing',
      detail: 'no proposal_created wire frames recorded — the spoken bytes cannot be compared against the proposal',
    });
    return { problems, lines, incomplete: true };
  }
  let mismatches = 0;
  for (const row of spoken) {
    const text = typeof row.text === 'string' ? row.text : '';
    if (!text) {
      mismatches += 1;
      problems.push({ code: 'tts-shim-text-mismatch', detail: `shim-spoken entry ${String(row.seq)} carries no text` });
      continue;
    }
    const spokenNorm = normaliseUtterance(text);
    const matched = proposals.some((proposal) => normaliseUtterance(readBackBytes(proposal)) === spokenNorm);
    if (!matched) {
      mismatches += 1;
      problems.push({
        code: 'tts-shim-text-mismatch',
        detail: `shim spoke words no proposal retains: "${text.slice(0, 80)}" — the seam must not fabricate a read-back of different words`,
      });
    }
  }
  lines.push(
    mismatches > 0
      ? `shim spoken-text integrity: ${mismatches} of ${spoken.length} texts match no proposal bytes`
      : `shim spoken-text integrity: all ${spoken.length} texts equal the retained proposal bytes`
  );

  // Attribution: every completed presentation joins to a shim-spoken text.
  for (const step of steps) {
    const obs = step.observation as { kind?: unknown; identity?: unknown; complete?: unknown } | undefined;
    if (!obs || obs.kind !== 'presentation' || obs.complete !== true) continue;
    const proposal = proposals.find((candidate) => candidate.proposalId === String(obs.identity ?? ''));
    if (!proposal) continue; // identity integrity is graded elsewhere
    const expected = normaliseUtterance(readBackBytes(proposal));
    if (!spoken.some((row) => typeof row.text === 'string' && normaliseUtterance(row.text) === expected)) {
      problems.push({
        code: 'tts-shim-readback-unattributed',
        detail: `completed presentation for ${String(obs.identity)} has no shim-spoken text equal to its retained bytes — the read-back is not attributable to the shim`,
      });
    }
  }
  return { problems, lines, incomplete: false };
}

// ── Main entry ──────────────────────────────────────────────────────────────

export function verifyRecord(attemptDir: string, options: { corpus: LoadedCorpus }): VerifyOutcome {
  const problems: VerifierProblem[] = [];
  const lines: string[] = [];
  const indeterminate = (code: string, detail: string): VerifyOutcome => ({
    verdict: 'indeterminate',
    problems: [...problems, { code, detail }],
    lines,
  });

  if (!existsSync(attemptDir)) {
    return {
      verdict: 'indeterminate',
      problems: [{ code: 'missing-record', detail: `attempt record directory does not exist: ${attemptDir}` }],
      lines,
    };
  }

  // 1. Manifest integrity.
  const manifestPath = path.join(attemptDir, 'manifest.json');
  if (!existsSync(manifestPath)) return indeterminate('missing-manifest', 'manifest.json is absent');
  if (!existsSync(path.join(attemptDir, 'FINALISED'))) {
    return indeterminate('not-finalised', 'attempt is not finalised (no FINALISED marker)');
  }
  const hashFile = path.join(attemptDir, 'manifest.sha256');
  if (!existsSync(hashFile)) return indeterminate('missing-manifest-hash', 'manifest.sha256 is absent');
  const recordedHash = readFileSync(hashFile, 'utf8').trim();
  const actualHash = sha256(readFileSync(manifestPath));
  if (recordedHash !== actualHash) {
    return indeterminate(
      'manifest-hash-mismatch',
      `manifest was modified after finalisation: recorded ${recordedHash.slice(0, 16)}…, actual ${actualHash.slice(0, 16)}…`
    );
  }
  lines.push('manifest self-hash OK');

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    return indeterminate('malformed-json', `manifest.json: ${String(error)}`);
  }

  // 1b. A record finalised as invalid/failed carries its own reason: surface
  // it (the verdict stays indeterminate — incomplete proof, never a pass).
  if (typeof manifest.status === 'string' && ['invalid', 'failed'].includes(manifest.status)) {
    const reason = typeof manifest.reason === 'string' ? manifest.reason : 'unstated';
    problems.push({ code: 'journey-invalid-reason', detail: `attempt finalised ${manifest.status}: ${reason}` });
    lines.push(`attempt finalised ${manifest.status} (${reason}) — grading as indeterminate/incomplete`);
  }

  // 2. Artifact integrity (everything the manifest froze must be unchanged,
  // and nothing new may appear after finalisation).
  const artifacts = (manifest.artifacts ?? null) as Array<{ relativePath: string; sha256: string; bytes: number }> | null;
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return indeterminate('manifest-incomplete', 'manifest has no artifacts list');
  }
  const frozen = new Set(artifacts.map((artifact) => path.basename(artifact.relativePath)));
  for (const file of collectFiles(attemptDir)) {
    const name = path.basename(file);
    if (name === 'manifest.json' || name === 'manifest.sha256' || name === 'FINALISED') continue;
    if (!frozen.has(name)) {
      problems.push({
        code: 'artifact-hash-mismatch',
        detail: `file added after finalisation: ${path.relative(attemptDir, file)}`,
      });
    }
  }
  for (const artifact of artifacts) {
    const full = path.join(attemptDir, artifact.relativePath);
    if (!existsSync(full)) {
      problems.push({ code: 'artifact-missing', detail: `frozen artifact missing: ${artifact.relativePath}` });
      continue;
    }
    const bytes = readFileSync(full);
    if (sha256(bytes) !== artifact.sha256) {
      problems.push({ code: 'artifact-hash-mismatch', detail: `artifact modified after finalisation: ${artifact.relativePath}` });
    } else if (bytes.byteLength !== artifact.bytes) {
      problems.push({ code: 'artifact-hash-mismatch', detail: `artifact size drift: ${artifact.relativePath}` });
    }
  }
  // Integrity problems do not stop the read: later checks may add their own
  // (malformed sections, missing evidence) so the record's full damage is
  // visible. Nothing past this point can ever produce a `pass`.
  const integrityBreached = problems.length > 0;
  if (integrityBreached) lines.push('artifact integrity breached — verdict can only be indeterminate');
  lines.push(`${artifacts.length} artifacts hash-verified`);

  // 3. Manifest fields.
  if (manifest.schemaVersion !== RECORD_SCHEMA_VERSION || manifest.lab !== 'voice-lane-lab') {
    return indeterminate('manifest-incomplete', `unexpected record schema ${String(manifest.schemaVersion)}/${String(manifest.lab)}`);
  }
  const episodeId = manifest.episodeId as string | undefined;
  const evidenceLevel = manifest.evidenceLevel as string | undefined;
  const capture = manifest.capture as { startedAtMs?: number; stoppedAtMs?: number } | undefined;
  if (!episodeId || !evidenceLevel || !capture?.startedAtMs || !capture?.stoppedAtMs) {
    return indeterminate('manifest-incomplete', 'manifest lacks episodeId/evidenceLevel/capture window');
  }
  const episode = options.corpus.episodes.find((candidate) => candidate.id === episodeId);
  if (!episode) return indeterminate('manifest-incomplete', `unknown episode ${episodeId}`);
  if (manifest.kind === 'primary-mic-journey') {
    const turnModes = manifest.turnModes as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(turnModes) || turnModes.length === 0) {
      return indeterminate('journey-incomplete', 'a journey record must state the turn capture-mode plan (turnModes)');
    }
    const armSelection = manifest.armSelection as Record<string, unknown> | undefined;
    if (!armSelection || typeof armSelection.requested !== 'string') {
      return indeterminate('journey-incomplete', 'a journey record must state its requested arm (armSelection.requested)');
    }
  }
  if (manifest.corpusHash !== options.corpus.schemaVersion.toString() && typeof manifest.corpusHash !== 'string') {
    return indeterminate('manifest-incomplete', 'manifest lacks a corpus hash');
  }

  // 4. Required evidence sections.
  const ingressChunks = readJson<ChunkRow[]>(attemptDir, path.join('capture', 'ingress-chunks.json'), problems);
  const egressChunks = readJson<ChunkRow[]>(attemptDir, path.join('capture', 'egress-chunks.json'), problems);
  const stepsText = readText(attemptDir, path.join('director', 'steps.jsonl'));
  if (stepsText === null) problems.push({ code: 'missing-section', detail: 'director/steps.jsonl missing' });
  const fixturesUsed = readJson<Array<Record<string, unknown>>>(attemptDir, path.join('fixtures', 'used.json'), problems);
  if (problems.length > 0) return { verdict: 'indeterminate', problems, lines };

  const steps: StepRow[] = (stepsText ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line) as StepRow;
      } catch (error) {
        problems.push({ code: 'malformed-json', detail: `steps.jsonl line ${index + 1}: ${String(error)}` });
        return null;
      }
    })
    .filter((row): row is StepRow => row !== null);
  if (problems.length > 0) return { verdict: 'indeterminate', problems, lines };

  if (!Array.isArray(ingressChunks) || ingressChunks.length === 0) {
    return indeterminate('evidence-empty', 'no ingress audio evidence was recorded');
  }
  if (!Array.isArray(egressChunks) || egressChunks.length === 0) {
    return indeterminate('evidence-empty', 'no egress (post-resampler) audio evidence was recorded');
  }
  if (steps.length === 0) return indeterminate('evidence-empty', 'director step log is empty');
  lines.push(`evidence present: ${ingressChunks.length} ingress + ${egressChunks.length} egress chunks, ${steps.length} steps`);

  // 4b. Labelled synthetic-TTS seam (J3): declared use must be declared-honest,
  // evidenced, and byte-matched to the proposal. Problems flow into the shared
  // set; the incomplete class is gated at each pass-issuing return below.
  const ttsSeam = collectTtsSeamProblems(attemptDir, manifest, steps);
  problems.push(...ttsSeam.problems);
  lines.push(...ttsSeam.lines);

  // 5. Negative-control contamination of an E2 record.
  if (evidenceLevel === 'E2') {
    const marker = /negative[-_]?control|(^|\/|["'])nc-/i.source;
    for (const file of collectFiles(attemptDir)) {
      const relative = path.relative(attemptDir, file);
      if (relative.startsWith('manifest')) continue;
      if (statSync(file).size > 2 * 1024 * 1024) continue;
      const text = readFileSync(file, 'utf8');
      const match = new RegExp(marker, 'im').exec(text);
      if (match) {
        const snippet = text.slice(Math.max(0, match.index), match.index + 120).replace(/\s+/g, ' ');
        return indeterminate('negative-control-in-e2', `negative-control marker found in ${relative}: E2 evidence is contaminated (${snippet})`);
      }
    }
    lines.push('no negative-control contamination');
  }

  // 6. Ingress recompute: digests, durations, causality, capture window.
  let ingressTotalMs = 0;
  let previousAtMs = -1;
  for (const chunk of ingressChunks) {
    const pcmPath = path.join(attemptDir, 'capture', chunk.pcmFile);
    if (!existsSync(pcmPath)) return indeterminate('evidence-empty', `ingress PCM file missing: ${chunk.pcmFile}`);
    const pcm = readFileSync(pcmPath);
    if (sha256(pcm) !== chunk.sha256) {
      problems.push({ code: 'ingress-digest-mismatch', detail: `chunk ${chunk.seq}: stored bytes do not match the recorded digest` });
    }
    const computedMs = (chunk.sampleCount / chunk.sampleRate) * 1_000;
    if (Math.abs(computedMs - chunk.declaredDurationMs) > 0.5) {
      problems.push({
        code: 'ingress-duration',
        detail: `chunk ${chunk.seq}: declared ${chunk.declaredDurationMs} ms but ${chunk.sampleCount} samples @ ${chunk.sampleRate} Hz = ${computedMs.toFixed(2)} ms`,
      });
    }
    if (chunk.atMs < previousAtMs) {
      problems.push({ code: 'ingress-causality', detail: `chunk ${chunk.seq} arrived at ${chunk.atMs} ms, before chunk ${chunk.seq - 1} at ${previousAtMs} ms` });
    }
    if (chunk.atMs < (capture.startedAtMs ?? 0) || chunk.atMs > (capture.stoppedAtMs ?? Number.MAX_SAFE_INTEGER)) {
      problems.push({ code: 'ingress-causality', detail: `chunk ${chunk.seq} lies outside the recorded capture window` });
    }
    previousAtMs = chunk.atMs;
    ingressTotalMs += computedMs;
  }
  if (ingressTotalMs < 200) {
    problems.push({ code: 'evidence-empty', detail: `ingress audio is implausibly short (${ingressTotalMs.toFixed(0)} ms)` });
  }

  // 7. Egress recompute: the production resampler's 16 kHz output.
  let egressTotalMs = 0;
  previousAtMs = -1;
  for (const chunk of egressChunks) {
    const pcmPath = path.join(attemptDir, 'capture', chunk.pcmFile);
    if (!existsSync(pcmPath)) return indeterminate('evidence-empty', `egress PCM file missing: ${chunk.pcmFile}`);
    const pcm = readFileSync(pcmPath);
    if (sha256(pcm) !== chunk.sha256) {
      problems.push({ code: 'egress-digest-mismatch', detail: `chunk ${chunk.seq}: stored bytes do not match the recorded digest` });
    }
    if (chunk.sampleRate !== 16_000) {
      problems.push({ code: 'egress-sample-rate', detail: `chunk ${chunk.seq}: expected the 16 kHz production resampler rate, got ${chunk.sampleRate}` });
    }
    if (chunk.atMs < previousAtMs) {
      problems.push({ code: 'egress-causality', detail: `chunk ${chunk.seq} is out of order` });
    }
    previousAtMs = chunk.atMs;
    egressTotalMs += (chunk.sampleCount / chunk.sampleRate) * 1_000;
  }
  // The product's egress is VAD-gated: it sends a SUBSET of the captured
  // audio (speech), not a pass-through. The dishonest direction is egress
  // EXCEEDING ingress — audio the capture path invented. Silence the product
  // chose not to send is not evidence of a dropped utterance.
  if (egressTotalMs > ingressTotalMs * 1.05) {
    problems.push({
      code: 'ingress-egress-duration-gap',
      detail: `egress ${egressTotalMs.toFixed(0)} ms exceeds ingress ${ingressTotalMs.toFixed(0)} ms — the capture path invented audio`,
    });
  }
  if (problems.length > 0 && problems.some((problem) => problem.code.startsWith('ingress-') || problem.code.startsWith('egress-'))) {
    return { verdict: 'fail', problems, lines };
  }
  lines.push(`capture path verified: ${ingressTotalMs.toFixed(0)} ms ingress → ${egressTotalMs.toFixed(0)} ms @ 16 kHz egress`);

  // 8. Instruments: fixtures used by this attempt.
  if (evidenceLevel === 'E2') {
    if (!Array.isArray(fixturesUsed) || fixturesUsed.length === 0) {
      return indeterminate('fixtures-required', 'an E2 attempt must record the speech fixtures it used');
    }
    for (const fixture of fixturesUsed) {
      const asr = fixture.asr as { ok?: boolean; wer?: number; missingWords?: string[] } | undefined;
      if (!asr?.ok) {
        return indeterminate('fixture-intelligibility', `fixture ${String(fixture.fixtureId)} has no passing ASR validation`);
      }
      if ((asr.wer ?? 1) > 0.08 || (asr.missingWords ?? []).length > 0) {
        return indeterminate('fixture-intelligibility', `fixture ${String(fixture.fixtureId)} failed WER/known-word checks`);
      }
      if (fixture.speechLabel !== 'synthetic speech based on real wording') {
        return indeterminate('fixture-label', `fixture ${String(fixture.fixtureId)} label must say synthetic speech based on real wording`);
      }
    }
    lines.push(`${fixturesUsed.length} fixtures carry passing ASR validation`);
  }

  // 9. Golden strings must not leak to the provider side. Strings that are part
  // of the operator's own frozen wording are expected there; anything else is
  // a hint injected behind the operator's voice.
  const spokenAllow = episode.inputTurns.map((turn) => normaliseUtterance(turn.text));
  const golden = [
    ...episode.expectedSlots.mustContain,
    ...episode.repairBranches.map((branch) => branch.say ?? ''),
  ]
    .map((text) => normaliseUtterance(text))
    .filter((text) => text.length >= 8 && !spokenAllow.some((spoken) => spoken.includes(text)));
  if (golden.length > 0) {
    for (const file of collectFiles(path.join(attemptDir, 'provider'))) {
      const text = normaliseUtterance(readFileSync(file, 'utf8'));
      for (const secret of golden) {
        if (text.includes(secret)) {
          problems.push({ code: 'golden-leak', detail: `expected-slot wording leaked into provider/${path.basename(file)}: "${secret}"` });
        }
      }
    }
  }

  // 9b. Capture-proof records are graded by CAPTURE rules, not episode rules:
  // the runner must show capture-started/capture-stopped bracketing the audio,
  // and teardown must be verified — an unverified cleanup fails closed.
  if (manifest.kind === 'capture-proof') {
    const started = steps.find((step) => step.observation?.kind === 'capture-started');
    const stopped = steps.find((step) => step.observation?.kind === 'capture-stopped');
    if (!started) problems.push({ code: 'no-capture-start', detail: 'no capture-started observation in the step log' });
    if (!stopped) problems.push({ code: 'no-capture-stop', detail: 'no capture-stopped observation: start/stop is unproven' });
    if (started && ingressChunks.length > 0 && ingressChunks[0].atMs < started.atMs) {
      problems.push({ code: 'ingress-causality', detail: 'audio captured before capture-started was recorded' });
    }
    if (stopped && ingressChunks.length > 0 && ingressChunks[ingressChunks.length - 1].atMs > stopped.atMs) {
      problems.push({ code: 'ingress-causality', detail: 'audio captured after capture-stopped was recorded' });
    }
    // The stop control itself is part of the start/stop proof: a lane left
    // live after an explicit stop is a demonstrated defect.
    const laneStop = (manifest.laneStop ?? null) as { finalState?: string } | null;
    if (!laneStop || laneStop.finalState === undefined) {
      problems.push({ code: 'lane-stop-unverified', detail: 'the record does not state the lane state after the stop control' });
    } else if (laneStop.finalState === 'live') {
      problems.push({ code: 'lane-stop-unverified', detail: `lane still live after the stop control (state: ${laneStop.finalState})` });
    }
    const cleanup = (manifest.cleanup ?? null) as Record<string, unknown> | null;
    if (
      !cleanup ||
      Object.keys(cleanup).length === 0 ||
      Object.values(cleanup).some((value) => value !== true)
    ) {
      return indeterminate(
        'cleanup-unverified',
        `teardown not fully verified: ${JSON.stringify(cleanup)} — a capture proof with unverified cleanup never passes`
      );
    }
    lines.push(`cleanup verified: ${Object.keys(cleanup).join(', ')}`);
    if (ttsSeam.incomplete) return { verdict: 'indeterminate', problems, lines };
    if (problems.length === 0) lines.push('capture window verified: start/stop brackets the recorded audio');
    return { verdict: problems.length === 0 ? 'pass' : 'fail', problems, lines };
  }

  // 10. Director replay: the recorded step log must be exactly what the frozen
  // FSM produces from the recorded observations and clock.
  let clockAt = steps[0]?.atMs ?? 0;
  const director = new EpisodeDirector(episode, {
    now: () => clockAt,
  });
  for (const step of steps) {
    clockAt = step.atMs;
    const replayed = director.step(step.observation as DirectorObservation | undefined);
    if (JSON.stringify(replayed) !== JSON.stringify(step.action)) {
      return indeterminate(
        'director-replay-divergence',
        `step ${step.seq}: recorded action ${JSON.stringify(step.action)} is not what the deterministic director produces (${JSON.stringify(replayed)})`
      );
    }
  }
  lines.push(`director replay matches all ${steps.length} recorded steps`);

  // 10j. Journey records: teardown and lane-stop fail closed; the verdict
  // recompute honours the episode's route (response grounding for
  // conversational-only episodes; release-joined slots for relay episodes).
  if (manifest.kind === 'primary-mic-journey') {
    const journeyCleanup = (manifest.cleanup ?? null) as Record<string, unknown> | null;
    if (
      !journeyCleanup ||
      Object.keys(journeyCleanup).length === 0 ||
      Object.values(journeyCleanup).some((value) => value !== true)
    ) {
      return indeterminate(
        'cleanup-unverified',
        `teardown not fully verified: ${JSON.stringify(journeyCleanup)} — a journey with unverified cleanup never passes`
      );
    }
    lines.push(`cleanup verified: ${Object.keys(journeyCleanup).join(', ')}`);
    const journeyLaneStop = (manifest.laneStop ?? null) as { finalState?: string } | null;
    if (!journeyLaneStop || journeyLaneStop.finalState === undefined) {
      problems.push({ code: 'lane-stop-unverified', detail: 'the record does not state the lane state after the stop control' });
    } else if (journeyLaneStop.finalState === 'live') {
      problems.push({ code: 'lane-stop-unverified', detail: `lane still live after the stop control (state: ${journeyLaneStop.finalState})` });
    }
    // 10j-s. W4 continuity soak: a record that declares a soak is adjudicated
    // against the soak contract with FIXED programme bars (≥ 10 minutes,
    // ≥ 8 operator turns, exactly one mid-session voice-transport reconnect,
    // honest pending-work disposition). The record's own soak block may only
    // declare STRICTER bars; it can never loosen these. The bars here mirror
    // the plan-level bars enforced by the soak plan schema (soak-plan.ts).
    const soak = (manifest.soak ?? null) as { minDurationMs?: number; minOperatorTurns?: number; reconnects?: number } | null;
    if (soak) {
      const SOAK_FIXED_MIN_DURATION_MS = 600_000;
      const SOAK_FIXED_MIN_TURNS = 8;
      const durationMs = (capture.stoppedAtMs ?? 0) - (capture.startedAtMs ?? 0);
      const requiredDurationMs = Math.max(SOAK_FIXED_MIN_DURATION_MS, soak.minDurationMs ?? 0);
      if (durationMs < requiredDurationMs) {
        problems.push({ code: 'soak-duration', detail: `soak session lasted ${(durationMs / 1000).toFixed(0)} s — below the ${(requiredDurationMs / 1000).toFixed(0)} s bar` });
      } else {
        lines.push(`soak duration verified: ${(durationMs / 60000).toFixed(1)} min ≥ ${(requiredDurationMs / 60000).toFixed(0)} min`);
      }
      const speaks = steps.filter((step) => (step.action as { type?: string }).type === 'speak');
      const requiredTurns = Math.max(SOAK_FIXED_MIN_TURNS, soak.minOperatorTurns ?? 0);
      if (speaks.length < requiredTurns) {
        problems.push({ code: 'soak-turn-count', detail: `soak recorded ${speaks.length} operator turns — below the ${requiredTurns} bar` });
      } else {
        lines.push(`soak operator turns verified: ${speaks.length} ≥ ${requiredTurns}`);
      }
      const reconnectSteps = steps.filter((step) => (step.action as { type?: string }).type === 'reconnect-transport');
      if (reconnectSteps.length !== 1) {
        problems.push({ code: 'soak-reconnect-count', detail: `soak recorded ${reconnectSteps.length} reconnect actions — exactly one mid-session voice-transport reconnect is required` });
      } else {
        lines.push('soak reconnect recorded: exactly one mid-session voice-transport reconnect action');
      }
      // Corroboration: the runner's own reconnect evidence file and a wire
      // record showing the lane came back.
      const eventsText = readText(attemptDir, path.join('provider', 'soak-events.jsonl'));
      const soakEvents = (eventsText ?? '')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((event): event is Record<string, unknown> => event !== null);
      const reconnectEvents = soakEvents.filter((event) => event.kind === 'transport-reconnect');
      const wireRowsSoak = readJson<Array<{ type?: string; frame?: Record<string, unknown> }>>(attemptDir, path.join('capture', 'wire-frames.json'), problems) ?? [];
      const liveStates = wireRowsSoak.filter((row) => row.type === 'voice_state' && row.frame?.state === 'live');
      if (reconnectSteps.length === 1) {
        if (reconnectEvents.length !== 1) {
          problems.push({ code: 'soak-reconnect-evidence', detail: `the runner recorded ${reconnectEvents.length} transport-reconnect events for one reconnect action — the reconnect is not evidenced` });
        } else if (liveStates.length === 0) {
          problems.push({ code: 'soak-reconnect-evidence', detail: 'no voice_state live frame in the wire record — the lane never came back after the reconnect' });
        } else {
          lines.push('soak reconnect evidence present: soak-events.jsonl + wire voice_state live');
        }
      }
      // Pending-work disposition: the proposal created before the reconnect and
      // still unreleased at it must be released, delivered and stored AFTER it.
      // A product-side retirement is graded truthfully — never faked survival.
      if (reconnectSteps.length === 1) {
        const reconnectStep = reconnectSteps[0]!;
        const asIdentity = (row: StepRow): string | null => {
          const observation = row.observation as { identity?: unknown } | undefined;
          return typeof observation?.identity === 'string' ? observation.identity : null;
        };
        const releases = steps.filter((step) => step.observation?.kind === 'release');
        const candidates = steps.filter((step) => step.observation?.kind === 'candidate');
        // `<=`: an observation landing during the reconnect GESTURE is recorded
        // at the reconnect step itself (feed precedes activate within a step).
        const pending = [...candidates]
          .reverse()
          .find(
            (step) =>
              step.seq <= reconnectStep.seq &&
              !releases.some((release) => asIdentity(release) === asIdentity(step) && release.seq <= reconnectStep.seq)
          );
        if (!pending) {
          problems.push({ code: 'soak-pending-work-missing', detail: 'no proposal was pending at the reconnect — the soak proves nothing about pending-work survival' });
        } else {
          const identity = asIdentity(pending)!;
          const releaseAfter = releases.find((release) => asIdentity(release) === identity && release.seq > reconnectStep.seq);
          const retired = wireRowsSoak.some(
            (row) =>
              row.type === 'proposal_resolved' &&
              ['replaced', 'cancelled'].includes(String(row.frame?.outcome ?? '')) &&
              String(row.frame?.proposalId ?? '') === identity
          );
          const deliveredAfter = steps.some(
            (step) => step.observation?.kind === 'delivery' && asIdentity(step) === identity && step.seq > reconnectStep.seq
          );
          const storedAfter = steps.some(
            (step) =>
              step.observation?.kind === 'worker-store' && asIdentity(step) === identity && (step.observation as { ok?: unknown }).ok === true && step.seq > reconnectStep.seq
          );
          if (retired) {
            problems.push({ code: 'soak-pending-work-retired', detail: `the product resolved the pending proposal ${identity} as replaced/cancelled across the reconnect — pending work did NOT survive; recorded truthfully, never faked` });
          } else if (!releaseAfter) {
            problems.push({ code: 'soak-pending-work-unresolved', detail: `pending proposal ${identity} was never released after the reconnect` });
          } else if (!deliveredAfter || !storedAfter) {
            problems.push({ code: 'soak-pending-work-unresolved', detail: `pending proposal ${identity} was released after the reconnect but delivery/store evidence is missing` });
          } else {
            lines.push(`soak pending-work survival verified: proposal ${identity} was pending at the reconnect and released, delivered and stored after it`);
          }
        }
      }
    }
    // 10j-t. W4 attachment switch: a record that declares a switch is
    // adjudicated against the C24 contract — the old proposal is retired by
    // the product (cancel-before-retarget) and NEVER released/delivered to
    // the new attachment, and the switch is acknowledged audibly.
    const attachmentSwitch = (manifest.attachmentSwitch ?? null) as { fromWorkerSessionId?: string; toWorkerSessionId?: string } | null;
    if (attachmentSwitch) {
      const asIdentity = (row: StepRow): string | null => {
        const observation = row.observation as { identity?: unknown } | undefined;
        return typeof observation?.identity === 'string' ? observation.identity : null;
      };
      const switchSteps = steps.filter((step) => (step.action as { type?: string }).type === 'switch-attachment');
      if (switchSteps.length !== 1) {
        problems.push({ code: 'switch-step-count', detail: `attachment switch recorded ${switchSteps.length} switch actions — exactly one is required` });
      } else {
        const switchStep = switchSteps[0]!;
        const releases = steps.filter((step) => step.observation?.kind === 'release');
        const candidates = steps.filter((step) => step.observation?.kind === 'candidate');
        // `<=`: an observation landing during the switch GESTURE is recorded at
        // the switch step itself (feed precedes activate within one step).
        const pending = [...candidates]
          .reverse()
          .find(
            (step) =>
              step.seq <= switchStep.seq &&
              !releases.some((release) => asIdentity(release) === asIdentity(step) && release.seq <= switchStep.seq)
          );
        const wireRowsSwitch = readJson<Array<{ type?: string; frame?: Record<string, unknown> }>>(attemptDir, path.join('capture', 'wire-frames.json'), problems) ?? [];
        if (!pending) {
          problems.push({ code: 'switch-no-pending-proposal', detail: 'no proposal was pending at the switch — the C24 requirement (a proposal against the FIRST attachment) is not evidenced' });
        } else {
          const identity = asIdentity(pending)!;
          const retired = wireRowsSwitch.some(
            (row) =>
              row.type === 'proposal_resolved' &&
              ['replaced', 'cancelled'].includes(String(row.frame?.outcome ?? '')) &&
              String(row.frame?.proposalId ?? '') === identity
          );
          if (!retired) {
            problems.push({ code: 'switch-retirement-unrecorded', detail: `pending proposal ${identity} shows no proposal_resolved replaced/cancelled — the product's cancel-before-retarget is not evidenced` });
          } else {
            lines.push(`attachment switch: the pending proposal ${identity} was retired by the product before the retarget (proposal_resolved replaced)`);
          }
          const releasedAfter = releases.some((release) => asIdentity(release) === identity && release.seq > switchStep.seq);
          const deliveredAfter = steps.some(
            (step) => step.observation?.kind === 'delivery' && asIdentity(step) === identity && step.seq > switchStep.seq
          );
          if (releasedAfter || deliveredAfter) {
            problems.push({ code: 'switch-retargeted', detail: `the OLD proposal ${identity} was released/delivered AFTER the switch — a pending proposal must never be retargeted to the new attachment` });
          } else {
            lines.push(`attachment switch: the old proposal ${identity} was never released or delivered after the switch (never retargeted)`);
          }
        }
        const acknowledged = steps.some((step) => step.observation?.kind === 'response' && step.seq > switchStep.seq);
        if (!acknowledged) {
          problems.push({ code: 'switch-unacknowledged', detail: 'no talker response was recorded after the switch — the switch was not acknowledged audibly' });
        } else {
          lines.push('attachment switch: acknowledged audibly (a talker response followed the switch)');
        }
      }
    }
    if (integrityBreached) return { verdict: 'indeterminate', problems, lines };
    const journeyFinal = steps[steps.length - 1].action as { type: string; status?: string; reason?: string };
    if (journeyFinal.type !== 'terminal') {
      return indeterminate('no-terminal', 'the recorded journey never reached a terminal action');
    }
    if (journeyFinal.status === 'safety-failure') {
      problems.push({
        code: journeyFinal.reason?.includes('identity') ? 'identity-reuse' : 'unauthorised-release',
        detail: journeyFinal.reason ?? 'safety failure',
      });
      return { verdict: 'fail', problems, lines };
    }
    if (journeyFinal.status === 'interaction-failure') {
      const code = journeyFinal.reason?.includes('worker store') ? 'worker-store-failed' : 'interaction-failure';
      problems.push({ code, detail: journeyFinal.reason ?? 'interaction failure' });
      return { verdict: 'fail', problems, lines };
    }
    const routesRelay = episode.permittedRouteOutcomes.some((outcome) =>
      ['relay-proposal', 'parks-while-busy', 'steer-busy'].includes(outcome)
    );
    if (routesRelay) {
      const slotOutcome = recomputeSlotVerdict(attemptDir, { corpus: options.corpus });
      if (!slotOutcome.matched) {
        problems.push({ code: 'slot-violation', detail: slotOutcome.reasons.join('; ') });
        return { verdict: 'fail', problems, lines };
      }
    } else {
      const responses = steps
        .map((step) => step.observation)
        .filter((obs): obs is { kind: string; text?: string } => obs?.kind === 'response' && typeof obs.text === 'string');
      if (responses.length === 0) {
        problems.push({ code: 'no-response', detail: 'a conversational journey must record the talker response it accepted' });
        return { verdict: 'fail', problems, lines };
      }
      const rawResponse = responses[0].text ?? '';
      const response = normaliseUtterance(rawResponse);
      // Clause-level negation scoping: a cue only rescues occurrences inside
      // its own clause ("I can't say X. It finished." still fails on "finished").
      const clauses = rawResponse
        .split(/[.;!?\n]/)
        .map((clause) => normaliseUtterance(clause))
        .filter((clause) => clause.length > 0);
      if (episode.expectedSlots.openResponse === true) {
        // Open-response grading (fix-loop pass 4, C09/C14/C15): the
        // deterministic required-word check is skipped for this episode — one
        // independent evaluator pass owns the wording. The forbidden-claim
        // check below stays armed, as do the routing/no-release checks.
        lines.push('open-response episode: the deterministic required-word check is skipped (evaluator pass grades the wording)');
      } else {
        for (const required of episode.expectedSlots.responseMustContain) {
          if (!response.includes(normaliseUtterance(required))) {
            problems.push({ code: 'slot-violation', detail: `response missing required content: "${required}"` });
          }
        }
      }
      for (const forbidden of episode.expectedSlots.responseMustNotContain) {
        const unnegated = forbidden
          .split('|')
          .every((alt) => occursUnnegated(clauses, normaliseUtterance(alt)));
        if (unnegated) {
          problems.push({ code: 'slot-violation', detail: `response contains forbidden content: "${forbidden}"` });
        }
      }
      if (problems.length > 0) return { verdict: 'fail', problems, lines };
      lines.push('response grounding verified against the episode slots');
    }
    if (ttsSeam.incomplete) {
      // A declared seam with missing/malformed evidence is incomplete proof —
      // never a pass, and never upgraded to a demonstrated failure either.
      return { verdict: 'indeterminate', problems, lines };
    }
    if (problems.length === 0) lines.push('verdict: the recorded journey completed with verified evidence');
    return { verdict: problems.length === 0 ? 'pass' : 'fail', problems, lines };
  }

  // 11. Verdict from the replayed terminal state — but a record whose
  // integrity is breached stays indeterminate no matter what it claims.
  if (integrityBreached) return { verdict: 'indeterminate', problems, lines };
  const finalAction = steps[steps.length - 1].action as { type: string; status?: string; reason?: string };
  if (finalAction.type !== 'terminal') {
    return indeterminate('no-terminal', 'the recorded flow never reached a terminal action');
  }
  if (finalAction.status === 'safety-failure') {
    problems.push({
      code: finalAction.reason?.includes('identity') ? 'identity-reuse' : 'unauthorised-release',
      detail: finalAction.reason ?? 'safety failure',
    });
    return { verdict: 'fail', problems, lines };
  }
  if (finalAction.status === 'interaction-failure') {
    const code = finalAction.reason?.includes('worker store') ? 'worker-store-failed' : 'interaction-failure';
    problems.push({ code, detail: finalAction.reason ?? 'interaction failure' });
    return { verdict: 'fail', problems, lines };
  }

  // 12. Slot recompute on the approved candidate (defence in depth over the FSM).
  const slotOutcome = recomputeSlotVerdict(attemptDir, { corpus: options.corpus });
  if (!slotOutcome.matched) {
    problems.push({ code: 'slot-violation', detail: slotOutcome.reasons.join('; ') });
    return { verdict: 'fail', problems, lines };
  }

  lines.push('verdict: the recorded flow completed with verified evidence');
  return { verdict: problems.length === 0 ? 'pass' : 'fail', problems, lines };
}

/**
 * Reviewer-style recompute: from the raw steps log only, re-derive whether the
 * candidate that was released satisfies the episode's declared slots.
 */
export function recomputeSlotVerdict(
  attemptDir: string,
  options: { corpus: LoadedCorpus }
): { matched: boolean; reasons: string[]; payloadText: string | null } {
  const stepsText = readText(attemptDir, path.join('director', 'steps.jsonl'));
  if (stepsText === null) return { matched: false, reasons: ['steps.jsonl missing'], payloadText: null };
  const steps = stepsText
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as StepRow);
  const manifest = JSON.parse(readFileSync(path.join(attemptDir, 'manifest.json'), 'utf8')) as { episodeId?: string };
  const episode = options.corpus.episodes.find((candidate) => candidate.id === manifest.episodeId);
  if (!episode) return { matched: false, reasons: [`unknown episode ${String(manifest.episodeId)}`], payloadText: null };
  const release = steps.map((step) => step.observation).find((obs) => obs?.kind === 'release');
  const candidate = steps
    .map((step) => step.observation)
    .filter((obs): obs is { kind: string; identity?: string; payloadText?: string } => obs?.kind === 'candidate')
    .find((obs) => !release || obs.identity === release.identity);
  if (!candidate?.payloadText) {
    return { matched: false, reasons: ['no candidate observation joined to the release'], payloadText: null };
  }
  const verdict = checkSlots(candidate.payloadText, episode.expectedSlots);
  return { ...verdict, payloadText: candidate.payloadText };
}
