/**
 * Resolve the canonical Pi Web UI session id used by diagnostics and receipts.
 *
 * Browser/WebSocket Pi prompts arrive with the runtime session path, while the
 * registry and Internal API use the stable internal id. Registry lookup is a
 * best-effort observability aid: a failed lookup must never prevent a prompt
 * from reaching the runtime, so callers receive the supplied identifier as a
 * fail-safe fallback.
 */

export interface SessionPathResolver {
  getByPath(sessionPath: string): Promise<{ id?: string } | undefined>;
}

export async function resolveCanonicalSessionId(
  sessionPath: string,
  registry: SessionPathResolver,
): Promise<string> {
  try {
    const entry = await registry.getByPath(sessionPath);
    return typeof entry?.id === 'string' && entry.id.length > 0
      ? entry.id
      : sessionPath;
  } catch {
    return sessionPath;
  }
}
