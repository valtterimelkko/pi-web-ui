/**
 * Return whether a loaded Pi runtime status represents positive quiescence.
 *
 * An absent status means the session is not materialised in the manager, so
 * there is no active runtime turn to drain. Callers that cannot establish the
 * status at all must use readPiRuntimeQuiescence(), which fails closed.
 *
 * Correction 01 (Luna r1): status-only quiescence is NOT cessation truth —
 * the pinned stale-streaming watchdog can reset the manager status to idle
 * while the SDK session is still streaming (multi-session-manager resets to
 * idle without disposing). Release decisions must use isPiSessionQuiescent,
 * which shares the piLiveness busy truth.
 */
export function isPiRuntimeQuiescent(status: string | undefined): boolean {
  return status !== 'busy' && status !== 'streaming';
}

/**
 * The one Pi busy truth shared by `piLiveness` (routes), `listBusySessions`
 * and the Internal API quiescence wiring: manager status (busy/streaming),
 * the SDK's own streaming truth (extension/browser turns the manager never
 * saw), and compaction are all busy; everything else is quiescent.
 *
 * Correction 01 (Luna r1 finding 1): `{ status: 'idle', sdkStreaming: true }`
 * is NOT quiescent — an admission slot must not be released while work is
 * still streaming, whatever the manager's reset status claims.
 */
export interface PiSessionStatusInfo {
  status?: string;
  sdkStreaming?: boolean;
  compacting?: boolean;
}

export function isPiSessionQuiescent(info: PiSessionStatusInfo | undefined): boolean {
  if (!info) return true; // not materialised: no active runtime turn
  const busy = info.status === 'busy'
    || info.status === 'streaming'
    || info.sdkStreaming === true
    || info.compacting === true;
  return !busy;
}

/**
 * Resolve Pi runtime quiescence from a status lookup.
 *
 * A missing status is safe (the runtime is not loaded); an exception is not
 * positive evidence and therefore returns false so admission remains fenced.
 */
export function readPiRuntimeQuiescence(
  read: () => PiSessionStatusInfo | undefined,
): boolean {
  try {
    return isPiSessionQuiescent(read());
  } catch {
    return false;
  }
}
