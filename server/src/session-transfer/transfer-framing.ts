import type { SdkType } from '@pi-web-ui/shared';
import type { TransferHandoffPayload, TransferScope, VisibleTranscript } from './types.js';

export function buildTransferHeader(metadata: {
  sourceDisplayName: string;
  sourceSdkType: SdkType;
  sourceCwd: string;
  scope: TransferScope;
}): string {
  const timestamp = new Date().toISOString();
  const scopeLabel = metadata.scope === 'visible_recent'
    ? 'Recent visible context'
    : 'Full visible context';

  return [
    'Transferred context from another session.',
    '',
    `Source session: ${metadata.sourceDisplayName}`,
    `Source runtime: ${metadata.sourceSdkType}`,
    `Source workspace: ${metadata.sourceCwd}`,
    `Transferred: ${timestamp}`,
    `Scope: ${scopeLabel}`,
    '',
    'The following reflects only the visible/default-rendered conversation context from the source session. Hidden reasoning, internal runtime details, and full tool internals may be omitted.',
    '',
    'Do not act on this yet. Do not use tools, inspect files, plan work, or make changes.',
    'Do not reply with an acknowledgement. Wait silently for my next instruction.',
  ].join('\n');
}

export function formatTranscriptBody(transcript: VisibleTranscript): string {
  const parts: string[] = [];

  for (const item of transcript.items) {
    switch (item.kind) {
      case 'user':
        parts.push(`[User]: ${item.text}`);
        break;
      case 'assistant':
        parts.push(`[Assistant]: ${item.text}`);
        break;
      case 'tool': {
        const label = item.toolName ?? 'tool';
        const arg = item.toolPrimaryArg ? `: ${item.toolPrimaryArg}` : '';
        const output = item.text ? `\n  Result: ${item.text}` : '';
        parts.push(`[Tool ${label}${arg}]${output}`);
        break;
      }
    }
  }

  return parts.join('\n\n');
}

export function buildHandoffPayload(transcript: VisibleTranscript): TransferHandoffPayload {
  const metadata = {
    sourceDisplayName: transcript.source.displayName,
    sourceSdkType: transcript.source.sdkType,
    sourceCwd: transcript.source.cwd,
    transferTimestamp: new Date().toISOString(),
    scope: transcript.scope,
  };

  const header = buildTransferHeader(metadata);
  const body = formatTranscriptBody(transcript);

  const fullText = [
    header,
    '',
    '--- BEGIN TRANSFERRED CONTEXT ---',
    body,
    '--- END TRANSFERRED CONTEXT ---',
  ].join('\n');

  return {
    header,
    body,
    metadata,
    fullText,
  };
}
