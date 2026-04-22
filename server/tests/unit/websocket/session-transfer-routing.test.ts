import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isTransferSessionContext, type TransferSessionContext, type SessionTransferCompleted, type SessionTransferFailed } from '../../../src/websocket/protocol.js';

describe('isTransferSessionContext', () => {
  it('validates correct transfer message', () => {
    const msg: TransferSessionContext = {
      type: 'transfer_session_context',
      sourceSessionId: 'src-1',
      targetSessionId: 'tgt-1',
      scope: 'visible_full',
    };

    expect(isTransferSessionContext(msg)).toBe(true);
  });

  it('validates transfer with createNew', () => {
    const msg = {
      type: 'transfer_session_context',
      sourceSessionId: 'src-1',
      createNew: true,
      targetSdkType: 'claude',
      targetCwd: '/home/user',
      scope: 'visible_recent',
    };

    expect(isTransferSessionContext(msg)).toBe(true);
  });

  it('validates transfer with sourceDisplayName', () => {
    const msg = {
      type: 'transfer_session_context',
      sourceSessionId: 'src-1',
      targetSessionId: 'tgt-1',
      scope: 'visible_full',
      sourceDisplayName: 'My Session',
    };

    expect(isTransferSessionContext(msg)).toBe(true);
  });

  it('rejects non-transfer message', () => {
    expect(isTransferSessionContext({ type: 'prompt', sessionId: 's1', message: 'hi' })).toBe(false);
  });

  it('rejects null', () => {
    expect(isTransferSessionContext(null)).toBe(false);
  });

  it('rejects missing sourceSessionId', () => {
    expect(isTransferSessionContext({
      type: 'transfer_session_context',
      targetSessionId: 'tgt-1',
      scope: 'visible_full',
    })).toBe(false);
  });

  it('rejects invalid scope', () => {
    expect(isTransferSessionContext({
      type: 'transfer_session_context',
      sourceSessionId: 'src-1',
      scope: 'everything',
    })).toBe(false);
  });
});

describe('Transfer protocol message shapes', () => {
  it('SessionTransferCompleted has correct shape', () => {
    const msg: SessionTransferCompleted = {
      type: 'session_transfer_completed',
      sourceSessionId: 'src-1',
      targetSessionId: 'tgt-1',
      createdNewSession: false,
    };

    expect(msg.type).toBe('session_transfer_completed');
    expect(msg.sourceSessionId).toBe('src-1');
    expect(msg.targetSessionId).toBe('tgt-1');
    expect(msg.createdNewSession).toBe(false);
  });

  it('SessionTransferFailed has correct shape', () => {
    const msg: SessionTransferFailed = {
      type: 'session_transfer_failed',
      sourceSessionId: 'src-1',
      targetSessionId: 'tgt-1',
      message: 'Target is busy',
      code: 'TRANSFER_TARGET_BUSY',
    };

    expect(msg.type).toBe('session_transfer_failed');
    expect(msg.code).toBe('TRANSFER_TARGET_BUSY');
    expect(msg.message).toBe('Target is busy');
  });

  it('SessionTransferFailed can omit targetSessionId', () => {
    const msg: SessionTransferFailed = {
      type: 'session_transfer_failed',
      sourceSessionId: 'src-1',
      message: 'Source not found',
      code: 'TRANSFER_SOURCE_NOT_FOUND',
    };

    expect(msg.targetSessionId).toBeUndefined();
  });
});
