/**
 * Return whether a loaded Pi runtime status represents positive quiescence.
 *
 * An absent status means the session is not materialised in the manager, so
 * there is no active runtime turn to drain. Callers that cannot establish the
 * status at all must use readPiRuntimeQuiescence(), which fails closed.
 */
export function isPiRuntimeQuiescent(status: string | undefined): boolean {
  return status !== 'busy' && status !== 'streaming';
}

/**
 * Resolve Pi runtime quiescence from a status lookup.
 *
 * A missing status is safe (the runtime is not loaded); an exception is not
 * positive evidence and therefore returns false so admission remains fenced.
 */
export function readPiRuntimeQuiescence(
  read: () => { status?: string } | undefined,
): boolean {
  try {
    const current = read();
    return !current || isPiRuntimeQuiescent(current.status);
  } catch {
    return false;
  }
}
