import { describe, it, expect } from 'vitest';
import { buildTransferHeader, formatTranscriptBody, buildHandoffPayload } from '../../../src/session-transfer/transfer-framing.js';
import type { VisibleTranscript } from '../../../src/session-transfer/types.js';

function makeTranscript(overrides: Partial<VisibleTranscript> = {}): VisibleTranscript {
  return {
    source: {
      sessionId: 'src-1',
      displayName: 'Test Session',
      sdkType: 'pi',
      cwd: '/home/user/project',
      createdAt: '2025-01-01T00:00:00.000Z',
      lastActivity: '2025-01-02T00:00:00.000Z',
    },
    scope: 'visible_full',
    itemCount: 2,
    truncated: false,
    items: [
      { kind: 'user', text: 'Hello', timestamp: 1700000000000 },
      { kind: 'assistant', text: 'Hi there!', timestamp: 1700000001000 },
    ],
    ...overrides,
  };
}

describe('buildTransferHeader', () => {
  it('includes source metadata', () => {
    const header = buildTransferHeader({
      sourceDisplayName: 'My Session',
      sourceSdkType: 'claude',
      sourceCwd: '/home/user/project',
      scope: 'visible_full',
    });

    expect(header).toContain('My Session');
    expect(header).toContain('claude');
    expect(header).toContain('/home/user/project');
  });

  it('includes do-not-act instruction', () => {
    const header = buildTransferHeader({
      sourceDisplayName: 'S',
      sourceSdkType: 'pi',
      sourceCwd: '/cwd',
      scope: 'visible_recent',
    });

    expect(header).toContain('Do not act on this yet');
    expect(header).toContain('Wait for my next instruction');
  });

  it('includes scope label for recent', () => {
    const header = buildTransferHeader({
      sourceDisplayName: 'S',
      sourceSdkType: 'pi',
      sourceCwd: '/cwd',
      scope: 'visible_recent',
    });

    expect(header).toContain('Recent visible context');
  });

  it('includes scope label for full', () => {
    const header = buildTransferHeader({
      sourceDisplayName: 'S',
      sourceSdkType: 'pi',
      sourceCwd: '/cwd',
      scope: 'visible_full',
    });

    expect(header).toContain('Full visible context');
  });

  it('includes timestamp', () => {
    const header = buildTransferHeader({
      sourceDisplayName: 'S',
      sourceSdkType: 'pi',
      sourceCwd: '/cwd',
      scope: 'visible_full',
    });

    expect(header).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('states context may be omitted', () => {
    const header = buildTransferHeader({
      sourceDisplayName: 'S',
      sourceSdkType: 'pi',
      sourceCwd: '/cwd',
      scope: 'visible_full',
    });

    expect(header).toContain('Hidden reasoning');
    expect(header).toContain('may be omitted');
  });
});

describe('formatTranscriptBody', () => {
  it('formats user messages', () => {
    const body = formatTranscriptBody(makeTranscript({
      items: [{ kind: 'user', text: 'Hello world' }],
    }));

    expect(body).toContain('[User]: Hello world');
  });

  it('formats assistant messages', () => {
    const body = formatTranscriptBody(makeTranscript({
      items: [{ kind: 'assistant', text: 'Response here' }],
    }));

    expect(body).toContain('[Assistant]: Response here');
  });

  it('formats tool calls with name and primary arg', () => {
    const body = formatTranscriptBody(makeTranscript({
      items: [{
        kind: 'tool',
        text: 'file contents...',
        toolName: 'read',
        toolPrimaryArg: '/foo/bar.ts',
      }],
    }));

    expect(body).toContain('[Tool read: /foo/bar.ts]');
    expect(body).toContain('Result: file contents...');
  });

  it('formats tool calls without primary arg', () => {
    const body = formatTranscriptBody(makeTranscript({
      items: [{ kind: 'tool', text: '', toolName: 'bash' }],
    }));

    expect(body).toContain('[Tool bash]');
  });

  it('separates items with double newlines', () => {
    const body = formatTranscriptBody(makeTranscript({
      items: [
        { kind: 'user', text: 'A' },
        { kind: 'assistant', text: 'B' },
      ],
    }));

    expect(body).toContain('[User]: A\n\n[Assistant]: B');
  });
});

describe('buildHandoffPayload', () => {
  it('produces full text with markers', () => {
    const payload = buildHandoffPayload(makeTranscript());

    expect(payload.fullText).toContain('--- BEGIN TRANSFERRED CONTEXT ---');
    expect(payload.fullText).toContain('--- END TRANSFERRED CONTEXT ---');
  });

  it('includes header and body', () => {
    const payload = buildHandoffPayload(makeTranscript());

    expect(payload.fullText).toContain(payload.header);
    expect(payload.fullText).toContain(payload.body);
  });

  it('populates metadata from transcript source', () => {
    const payload = buildHandoffPayload(makeTranscript());

    expect(payload.metadata.sourceDisplayName).toBe('Test Session');
    expect(payload.metadata.sourceSdkType).toBe('pi');
    expect(payload.metadata.sourceCwd).toBe('/home/user/project');
    expect(payload.metadata.scope).toBe('visible_full');
  });

  it('includes transfer timestamp', () => {
    const payload = buildHandoffPayload(makeTranscript());

    expect(payload.metadata.transferTimestamp).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('reflects truncated flag in scope', () => {
    const payload = buildHandoffPayload(makeTranscript({ truncated: true, scope: 'visible_recent' }));

    expect(payload.metadata.scope).toBe('visible_recent');
  });
});
