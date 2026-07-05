import { MAX_FILES_PER_MESSAGE } from '@pi-web-ui/shared';

/**
 * Build the prompt the runtime receives by prepending an "I've uploaded N
 * files" note listing the server paths of the successfully-uploaded files.
 *
 * Pure and side-effect free — extracted from `MessageInput.tsx` so the exact
 * wording contract the four runtimes already see is centralized and tested.
 *
 * - 0 paths → content returned unchanged
 * - 1 path  → "I've uploaded a file. Please read it at: <path>"
 * - N paths → "I've uploaded N files. Please read them at:\n<path1>\n<path2>…"
 *
 * When there is no user content, only the note is returned. The note always
 * goes in front of the user's text.
 */
export function buildPromptWithFiles(content: string, filePaths: string[]): string {
  if (filePaths.length === 0) {
    return content;
  }

  const list = filePaths.join('\n');
  const note =
    filePaths.length === 1
      ? `I've uploaded a file. Please read it at: ${list}`
      : `I've uploaded ${filePaths.length} files. Please read them at:\n${list}`;

  return content ? `${note}\n\n${content}` : note;
}

/**
 * Result of applying the per-message file cap to a batch of newly-added files.
 * `accepted` is the prefix of `incoming` that still fits under the cap given
 * the files already attached; `rejectedCount` is how many were dropped.
 */
export interface FileCapResult<T> {
  accepted: T[];
  rejectedCount: number;
}

/**
 * Enforce the max-files-per-message cap on a batch of incoming files.
 *
 * Given `currentCount` files already attached and `incoming` newly-added ones,
 * returns the subset of `incoming` (in original order) that fits under `max`,
 * plus how many were rejected. Pure: never mutates `incoming`. Defaults to the
 * shared {@link MAX_FILES_PER_MESSAGE} constant so the cap has one source of
 * truth.
 */
export function enforceFileCap<T>(
  incoming: T[],
  currentCount: number,
  max: number = MAX_FILES_PER_MESSAGE,
): FileCapResult<T> {
  const remaining = Math.max(0, max - currentCount);
  const accepted = incoming.slice(0, remaining);
  return {
    accepted,
    rejectedCount: incoming.length - accepted.length,
  };
}
