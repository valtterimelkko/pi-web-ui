/**
 * Tool-call argument validation, per tool — the boundary that decides what can
 * ride a tool call into the kernel.
 *
 * There are two declared tools, and each carries exactly one bounded string:
 *
 *   - `read_worker_history` takes `query`, which can only SELECT which existing
 *     history is read back. The retrieved text is data and the response
 *     authorises nothing.
 *   - `relay_to_worker` takes `text`, the words the model wants placed in front
 *     of the operator for approval. It creates a candidate proposal ONLY; it
 *     cannot release, confirm or deliver, and the operator's own confirmation
 *     bound to the presented proposal is still the only release predicate
 *     (N1, N2, N8).
 *
 * 2026-09-22 (owner directive): `relay_to_worker` replaced the two parameterless
 * gate tools (`mark_addressed_to_talker`, `offer_ask_worker`). The native talker
 * now decides conversation versus relay itself; the host's remaining job is to
 * show anything relayed to the operator for approval.
 *
 * Anything unexpected is a violation the bridge surfaces, never something it
 * quietly forwards.
 */
import type { VoiceBridgeToolName } from '@pi-web-ui/shared';

/** Longest query the retrieval tool may carry (a search phrase, not a payload). */
export const MAX_HISTORY_QUERY_CHARS = 300;

/**
 * Longest relay the `relay_to_worker` tool may carry. A relay is one spoken
 * instruction, not an essay; the bound keeps a runaway model from parking an
 * unbounded blob in the proposal store. It is generous enough for a dictation
 * of a few paragraphs.
 */
export const MAX_RELAY_TEXT_CHARS = 4_000;

export type ToolArgumentValidation =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; reason: string };

/** Read one bounded, trimmed single-string argument; refuse everything else. */
function readSingleStringArgument(
  raw: unknown,
  key: string,
  maxChars: number,
  { allowEmpty = false }: { allowEmpty?: boolean } = {}
): ToolArgumentValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'a malformed argument object' };
  }
  const record = raw as Record<string, unknown>;
  const unexpected = Object.keys(record).filter((name) => name !== key);
  if (unexpected.length > 0) {
    return { ok: false, reason: `unexpected arguments (${unexpected.join(', ')})` };
  }
  const rawValue = record[key];
  if (typeof rawValue !== 'string') {
    return { ok: false, reason: `a non-string ${key}` };
  }
  const value = rawValue.trim();
  if (value.length === 0 && !allowEmpty) {
    return { ok: false, reason: `an empty ${key}` };
  }
  if (value.length > maxChars) {
    return { ok: false, reason: `an oversized ${key} (${value.length} characters)` };
  }
  return { ok: true, args: { [key]: value } };
}

export function validateToolArguments(name: VoiceBridgeToolName, raw: unknown): ToolArgumentValidation {
  if (name === 'read_worker_history') {
    // An empty query means "the earliest messages", so it is allowed here.
    return readSingleStringArgument(raw, 'query', MAX_HISTORY_QUERY_CHARS, { allowEmpty: true });
  }
  if (name === 'relay_to_worker') {
    return readSingleStringArgument(raw, 'text', MAX_RELAY_TEXT_CHARS);
  }
  // Unreachable for a declared tool name; a new tool without a rule here is a
  // violation rather than a silent pass.
  return { ok: false, reason: 'an unknown tool' };
}
