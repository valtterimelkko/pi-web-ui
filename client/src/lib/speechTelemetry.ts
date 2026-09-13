/**
 * speechTelemetry — P10 D4: the client-side half of Voice Mode observability.
 *
 * The speech arbiter's decisions ("why didn't I hear it?") land in the
 * EXISTING browser diagnostic ring (browserDiagnostics.ts) and are recovered
 * through the existing manual bundle (Copy/Download diagnostics) — no new
 * wire message, no server route. Privacy rules of the bundle hold: only an
 * operation label, the playback tier, a short bounded reason, and an error
 * NAME are recorded. Never utterance text, never intent ids, never session
 * ids. This helper never throws into the arbiter.
 */

import { recordBrowserDiagnostic } from './browserDiagnostics.js';

export type SpeechTelemetryOperation =
  | 'submit'
  | 'drop'
  | 'floor_held'
  | 'floor_released'
  | 'playback_failed'
  | 'paused'
  | 'resumed'
  | 'stopped';

const OPERATIONS: ReadonlySet<string> = new Set<SpeechTelemetryOperation>([
  'submit',
  'drop',
  'floor_held',
  'floor_released',
  'playback_failed',
  'paused',
  'resumed',
  'stopped',
]);

export interface SpeechTelemetryDetail {
  /** Playback tier (2 receipt ack, 3 answer, 4 chatter); omitted when not applicable. */
  tier?: number;
  /** Short machine-ish reason (e.g. 'busy', 'invalid'); bounded like bundle states. */
  reason?: string;
  /** Error name only (never a message body) for playback failures. */
  errorName?: string;
}

export function recordSpeechEvent(operation: SpeechTelemetryOperation, detail: SpeechTelemetryDetail = {}): void {
  try {
    if (!OPERATIONS.has(operation)) return;
    const tier = detail.tier;
    recordBrowserDiagnostic({
      kind: 'speech',
      operation,
      ...(tier === 2 || tier === 3 || tier === 4 ? { speechTier: tier } : {}),
      ...(typeof detail.reason === 'string' && detail.reason.trim() ? { state: detail.reason.trim().slice(0, 80) } : {}),
      ...(typeof detail.errorName === 'string' && detail.errorName.trim()
        ? { errorName: detail.errorName.trim().slice(0, 80) }
        : {}),
    });
  } catch {
    // Telemetry must never alter arbiter behaviour.
  }
}
