/**
 * Wave K (contract 1.59.0) — K3 continue-note builder (pure).
 *
 * The note tells a goal child what stopped it, that its worktree is intact,
 * which tool call was in flight when the stop hit (name + short argument
 * summary, read from the transcript), and the K3 rule: check the call's
 * effects before repeating it — nothing re-executes automatically. It also
 * carries the K2 honesty rule: a second transient stop will not auto-continue.
 *
 * The note is single-line and double-quote-free so it can ride inside the
 * server's composed `/goal resume "<note>"` command argument.
 */

export interface InFlightToolCall {
  name: string;
  argsSummary: string;
}

interface RawToolCallItem {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
}

const ARGS_SUMMARY_MAX = 120;
export const CONTINUE_NOTE_MAX = 700;

/**
 * Find the cut-off in-flight tool call in a raw Pi session JSONL: the LAST
 * `toolCall` content item whose call id never received a `toolResult`. Same
 * transcript shapes as scripts/e2a-crash/analysis.ts parseRawSessionJsonl
 * (message entries, role assistant/toolResult), reduced to what the note
 * needs. Junk lines are skipped; nothing here throws.
 */
export function findInFlightToolCall(lines: string[]): InFlightToolCall | null {
  const calls: Array<{ id: string | undefined; name: string; argsSummary: string }> = [];
  const answered = new Set<string>();
  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (typeof message !== 'object' || message === null) continue;
    const m = message as Record<string, unknown>;
    const role = typeof m.role === 'string' ? m.role : '';
    if (role === 'toolResult') {
      if (typeof m.toolCallId === 'string') answered.add(m.toolCallId);
      continue;
    }
    if (role !== 'assistant') continue;
    const content = Array.isArray(m.content) ? (m.content as unknown[]) : [];
    for (const item of content) {
      if (typeof item !== 'object' || item === null) continue;
      const tc = item as RawToolCallItem;
      if (tc.type !== 'toolCall') continue;
      const name = typeof tc.name === 'string' ? tc.name : 'unknown';
      const id = typeof tc.id === 'string' ? tc.id : undefined;
      calls.push({ id, name, argsSummary: summariseArguments(tc.arguments) });
    }
  }
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    if (call.id === undefined || !answered.has(call.id)) {
      return { name: call.name, argsSummary: call.argsSummary };
    }
  }
  return null;
}

function summariseArguments(args: unknown): string {
  if (args === undefined || args === null) return '';
  let text: string;
  if (typeof args === 'string') {
    text = args;
  } else {
    try {
      text = JSON.stringify(args) ?? '';
    } catch {
      text = '[unserialisable arguments]';
    }
  }
  const flattened = text.replace(/\s+/g, ' ').trim();
  if (flattened.length <= ARGS_SUMMARY_MAX) return flattened;
  return `${flattened.slice(0, ARGS_SUMMARY_MAX)}…`;
}

function sanitize(text: string): string {
  return text.replace(/["\r\n]+/g, ' ').trim();
}

export interface ContinueNoteInput {
  causeLabel: string;
  inFlightToolCall?: InFlightToolCall | null;
}

export function buildContinueNote(input: ContinueNoteInput): string {
  const cause = sanitize(input.causeLabel) || 'your run was interrupted';
  const parts: string[] = [
    `[auto-continue] ${cause}. Your worktree and any commits are intact.`,
  ];
  if (input.inFlightToolCall) {
    const name = sanitize(input.inFlightToolCall.name) || 'unknown';
    const args = sanitize(input.inFlightToolCall.argsSummary);
    const argsPart = args ? ` (${args})` : '';
    parts.push(
      `The tool call ${name}${argsPart} was in flight when the stop hit and may not have completed: check its effects before repeating it; nothing was re-executed for you.`,
    );
  }
  parts.push(
    'Continue working toward the goal from where you left off; this is the only automatic continue — if you stop again for the same kind of interruption, report honestly and pause.',
  );
  const note = sanitize(parts.join(' '));
  return note.length <= CONTINUE_NOTE_MAX ? note : `${note.slice(0, CONTINUE_NOTE_MAX - 1).trimEnd()}…`;
}
