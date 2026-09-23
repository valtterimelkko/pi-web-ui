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
      const response = normaliseUtterance(responses[0].text ?? '');
      for (const required of episode.expectedSlots.responseMustContain) {
        if (!response.includes(normaliseUtterance(required))) {
          problems.push({ code: 'slot-violation', detail: `response missing required content: "${required}"` });
        }
      }
      for (const forbidden of episode.expectedSlots.responseMustNotContain) {
        if (forbidden.split('|').every((alt) => response.includes(normaliseUtterance(alt)))) {
          problems.push({ code: 'slot-violation', detail: `response contains forbidden content: "${forbidden}"` });
        }
      }
      if (problems.length > 0) return { verdict: 'fail', problems, lines };
      lines.push('response grounding verified against the episode slots');
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
