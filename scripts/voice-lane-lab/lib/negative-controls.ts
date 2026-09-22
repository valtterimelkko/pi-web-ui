/**
 * Labelled E0 negative controls (native-primary plan §4.2(3), Phase 1 item 7).
 *
 * Bypass hooks exist for deterministic rig checks: feeding a transcript
 * without ASR, injecting model text without speech, fabricating a candidate
 * without a product. They are LEGITIMATE only as labelled E0 evidence. The
 * rules enforced here:
 *
 *   1. every hook refuses to run when the lab context is a measured E2/E2R
 *      path — the bypass is structurally unreachable there;
 *   2. everything a hook produces carries an explicit `negativeControl`
 *      marker and is stamped `E0`;
 *   3. the offline verifier rejects any E2 attempt record whose content shows
 *      one of these markers (proven in verifier.test.ts).
 */
import type { DirectorObservation } from './director.js';

export const NEGATIVE_CONTROL_NAMES = [
  'transcript-injection',
  'direct-model-text',
  'fabricated-candidate',
] as const;
export type NegativeControlName = (typeof NEGATIVE_CONTROL_NAMES)[number];

export type EvidenceLevel = 'E0' | 'E1' | 'E2' | 'E2R' | 'E3';

export interface LabContext {
  evidenceLevel: EvidenceLevel;
}

export class BypassRefusedError extends Error {
  constructor(name: NegativeControlName, level: EvidenceLevel) {
    super(
      `negative control "${name}" refused: evidence level ${level} is a measured path — ` +
        'bypass hooks are E0-only (plan §4.2(3))'
    );
    this.name = 'BypassRefusedError';
  }
}

/** Guard: bypass hooks may never execute on a measured E2/E2R path. */
export function assertBypassAllowed(context: LabContext, name: NegativeControlName): void {
  if (context.evidenceLevel === 'E2' || context.evidenceLevel === 'E2R') {
    throw new BypassRefusedError(name, context.evidenceLevel);
  }
}

type Marked<T> = T & { negativeControl: NegativeControlName; evidenceLevel: 'E0' };

function marked<T extends object>(context: LabContext, name: NegativeControlName, value: T): Marked<T> {
  void context; // the context was already checked by assertBypassAllowed
  return { ...value, negativeControl: name, evidenceLevel: 'E0' };
}

/**
 * E0: a recognised transcript without any ASR or audio. Returns a response
 * observation as if the model had spoken, stamped as the control it is.
 */
export function injectTranscript(
  context: LabContext,
  text: string,
  atMs: number
): Marked<DirectorObservation> {
  assertBypassAllowed(context, 'transcript-injection');
  return marked(context, 'transcript-injection', {
    kind: 'response',
    text,
    atMs,
  } satisfies DirectorObservation);
}

/**
 * E0: direct model text input, bypassing speech, audio and the provider.
 */
export function injectModelText(
  context: LabContext,
  text: string,
  atMs: number
): Marked<DirectorObservation> {
  assertBypassAllowed(context, 'direct-model-text');
  return marked(context, 'direct-model-text', {
    kind: 'response',
    text,
    atMs,
  } satisfies DirectorObservation);
}

/**
 * E0: a fabricated relay candidate, bypassing the product's proposal path.
 */
export function fabricateCandidate(
  context: LabContext,
  payloadText: string,
  identity: string,
  atMs: number
): Marked<DirectorObservation> {
  assertBypassAllowed(context, 'fabricated-candidate');
  return marked(context, 'fabricated-candidate', {
    kind: 'candidate',
    payloadText,
    identity,
    atMs,
  } satisfies DirectorObservation);
}
