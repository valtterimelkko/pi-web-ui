/**
 * Tool-call argument validation, per tool — the boundary that decides what can
 * ride a tool call into the kernel.
 *
 * The two gate tools (`mark_addressed_to_talker`, `offer_ask_worker`) are
 * PARAMETERLESS and stay that way: a call can never carry an arbitrary payload,
 * and the contract's `hasNoToolArguments` remains the check. `read_worker_history`
 * is the single exception, granted by intent §19.3 (read-only retrieval), and its
 * exception is deliberately the narrowest thing that works:
 *
 *   - exactly one argument, `query`, a string;
 *   - trimmed and length-bounded, so it cannot be used as a bulk channel;
 *   - it can only SELECT which existing history is read back. It cannot send,
 *     hold, confirm or release anything, and the retrieved text is data
 *     (N2/N7 untouched).
 *
 * Anything unexpected is a violation the bridge surfaces, never something it
 * quietly forwards.
 */
import { hasNoToolArguments } from '@pi-web-ui/shared';
import type { VoiceBridgeToolName } from '@pi-web-ui/shared';

/** Longest query the retrieval tool may carry (a search phrase, not a payload). */
export const MAX_HISTORY_QUERY_CHARS = 300;

export type ToolArgumentValidation =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; reason: string };

export function validateToolArguments(name: VoiceBridgeToolName, raw: unknown): ToolArgumentValidation {
  if (name === 'read_worker_history') {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, reason: 'a malformed argument object' };
    }
    const record = raw as Record<string, unknown>;
    const unexpected = Object.keys(record).filter((key) => key !== 'query');
    if (unexpected.length > 0) {
      return { ok: false, reason: `unexpected arguments (${unexpected.join(', ')})` };
    }
    const rawQuery = record.query;
    if (typeof rawQuery !== 'string') {
      return { ok: false, reason: 'a non-string query' };
    }
    const query = rawQuery.trim();
    if (query.length > MAX_HISTORY_QUERY_CHARS) {
      return { ok: false, reason: `an oversized query (${query.length} characters)` };
    }
    return { ok: true, args: { query } };
  }

  // Gate tools: parameterless, exactly as before.
  if (!hasNoToolArguments(raw)) {
    return { ok: false, reason: 'arguments; the function is parameterless' };
  }
  return { ok: true, args: {} };
}
