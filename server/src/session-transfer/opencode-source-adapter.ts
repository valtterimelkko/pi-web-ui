import { replayEventsToVisibleItems, buildVisibleTranscript } from './visible-transcript.js';
import type { VisibleTranscript, VisibleTranscriptSource, TransferScope } from './types.js';

export interface SourceAdapterResult {
  transcript: VisibleTranscript;
  error?: string;
}

export interface OpenCodeReplayLoader {
  getReplayEvents(sessionId: string): Promise<Array<Record<string, unknown>>>;
}

export async function extractOpenCodeTranscript(
  replayLoader: OpenCodeReplayLoader,
  sessionId: string,
  source: VisibleTranscriptSource,
  scope: TransferScope,
): Promise<SourceAdapterResult> {
  let replayEvents: Array<Record<string, unknown>>;
  try {
    replayEvents = await replayLoader.getReplayEvents(sessionId);
  } catch {
    return { transcript: emptyTranscript(source, scope), error: 'Failed to load OpenCode history' };
  }

  if (replayEvents.length === 0) {
    return { transcript: emptyTranscript(source, scope), error: 'Nothing visible to transfer' };
  }

  const items = replayEventsToVisibleItems(replayEvents);

  if (items.length === 0) {
    return { transcript: emptyTranscript(source, scope), error: 'Nothing visible to transfer' };
  }

  return { transcript: buildVisibleTranscript(items, source, scope) };
}

function emptyTranscript(source: VisibleTranscriptSource, scope: TransferScope): VisibleTranscript {
  return { source, scope, itemCount: 0, truncated: false, items: [] };
}
