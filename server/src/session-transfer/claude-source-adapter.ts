import type { ClaudeMessageEntry } from '../claude/claude-session-store.js';
import { historyToReplayEvents } from '../claude/claude-history-replay.js';
import { replayEventsToVisibleItems, buildVisibleTranscript } from './visible-transcript.js';
import type { VisibleTranscript, VisibleTranscriptSource, TransferScope } from './types.js';

export interface SourceAdapterResult {
  transcript: VisibleTranscript;
  error?: string;
}

export async function extractClaudeTranscript(
  loadHistory: (sessionId: string) => Promise<ClaudeMessageEntry[]>,
  sessionId: string,
  source: VisibleTranscriptSource,
  scope: TransferScope,
): Promise<SourceAdapterResult> {
  let history: ClaudeMessageEntry[];
  try {
    history = await loadHistory(sessionId);
  } catch {
    return { transcript: emptyTranscript(source, scope), error: 'Failed to load Claude history' };
  }

  if (history.length === 0) {
    return { transcript: emptyTranscript(source, scope), error: 'Nothing visible to transfer' };
  }

  const replayEvents = historyToReplayEvents(history);
  const items = replayEventsToVisibleItems(replayEvents);

  if (items.length === 0) {
    return { transcript: emptyTranscript(source, scope), error: 'Nothing visible to transfer' };
  }

  return { transcript: buildVisibleTranscript(items, source, scope) };
}

function emptyTranscript(source: VisibleTranscriptSource, scope: TransferScope): VisibleTranscript {
  return { source, scope, itemCount: 0, truncated: false, items: [] };
}
