import type { SdkType } from '@pi-web-ui/shared';
import type { TransferHandoffPayload, TransferScope, VisibleTranscript } from './types.js';

function untrustedMetadata(value: unknown): string {
  const text = typeof value === 'string' ? value : '(invalid metadata)';
  return JSON.stringify(text.slice(0, 4096));
}

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
    `Source session (untrusted metadata): ${untrustedMetadata(metadata.sourceDisplayName)}`,
    `Source runtime (untrusted metadata): ${untrustedMetadata(metadata.sourceSdkType)}`,
    `Source workspace (untrusted metadata): ${untrustedMetadata(metadata.sourceCwd)}`,
    `Transferred: ${timestamp}`,
    `Scope: ${scopeLabel}`,
    '',
    'The following reflects only the visible/default-rendered conversation context from the source session. Hidden reasoning, internal runtime details, and full tool internals may be omitted.',
    '',
    'Do not act on this yet. Do not use tools, inspect files, plan work, or make changes.',
    'Do not reply with an acknowledgement. Wait silently for my next instruction.',
  ].join('\n');
}

function escapeTransferDelimiters(value: string): string {
  return value.replace(/--- (BEGIN|END) TRANSFERRED CONTEXT ---/gu, '[escaped transferred-context delimiter]');
}

export function formatTranscriptBody(transcript: VisibleTranscript): string {
  const parts: string[] = [];

  for (const item of transcript.items) {
    switch (item.kind) {
      case 'user':
        parts.push(`[User]: ${escapeTransferDelimiters(item.text)}`);
        break;
      case 'assistant':
        parts.push(`[Assistant]: ${escapeTransferDelimiters(item.text)}`);
        break;
      case 'tool': {
        const label = escapeTransferDelimiters(item.toolName ?? 'tool');
        const arg = item.toolPrimaryArg ? `: ${escapeTransferDelimiters(item.toolPrimaryArg)}` : '';
        const output = item.text ? `\n  Result: ${escapeTransferDelimiters(item.text)}` : '';
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
